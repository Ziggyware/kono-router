// routes/ops.ts — Ops route registrations extracted from main.ts.
// main.ts calls registerOps() at the position of this area's first route, preserving registration order.

import { startTrace } from "../trace.ts";
import { compile } from "../compiler/index.ts";
import type { Complete } from "../compiler/index.ts";
import { defaultAutoToolNames } from "../tools.ts";
import { honoApp, TOOL_SKILLS, L1_CACHE } from "../state.ts";
import { hydrateToolSkills, hydrateForgedTools, ensureCatalogSynced, hydrateL1Cache } from "../main.ts";
import type { Json, RoutingMode } from "../main.ts";
import { normalizeMessages, runTracedTool, isAdminContext } from "../engine/dispatch.ts";
import { requireAdmin } from "../engine/core.ts";
import { runCanaryProbeOnTopCandidates, runResurrectionProbe } from "../engine/providers.ts";
import { logErr, toolSkillsSnapshot, errText } from "../util.ts";

export function registerOps() {


// ---------------------------------------------------------------------------
// POST /v1/agent/compile  LLMCompiler-style agent over the tool plane:
// BM25 tool retrieval → K sampled DAG plans → MBR selection → HEFT-ordered
// parallel execution → join (answer | replan). Sub-calls run in-process
// through this router, so they inherit routing, learning, quota and traces.
// ---------------------------------------------------------------------------

honoApp.post("/v1/agent/compile", async (c) => {
  const root = startTrace("agent.compile", {}, c.req.header("traceparent"));
  const traceHeaders = { traceparent: root.traceparent };
  const body = await c.req.json().catch(() => ({} as Json)) as Json;
  root.io("request", body);
  const messages = normalizeMessages(body.messages, body.prompt);
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
  const question = (typeof body.question === "string" ? body.question : String(lastUser?.content ?? "")).trim();
  if (!question) {
    root.end("error", { error: "no question" });
    return c.json({ error: { message: "question (or a user message) is required" } }, 400, traceHeaders);
  }
  const model = typeof body.model === "string" && body.model ? body.model : "free:smart";
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    (c.env as Deno.ServeHandlerInfo<Deno.NetAddr> | undefined)?.remoteAddr?.hostname || "anon";
  // Forward the caller's identity so sub-calls are billed, scoped and rate-limited as the caller, not as the isolate.
  const forward: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip, traceparent: root.traceparent };
  for (const h of ["authorization", "x-admin-secret", "x-kono-session", "x-session-id"]) {
    const v = c.req.header(h);
    if (v) forward[h] = v;
  }
  // Samples rotate across lanes: independent models make MBR's errors less correlated than one model at K temperatures.
  const lanes = model.startsWith("free:") ? [model, ...["free:smart", "free:fast", "free:code"].filter((l) => l !== model)] : [model];
  const laneFor = (attempt: number) => lanes[attempt % lanes.length];
  const complete: Complete = async (msgs, o) => {
    const res = await honoApp.request("/v1/chat/completions", {
      method: "POST",
      headers: forward,
      signal: o.signal,
      body: JSON.stringify({ model: laneFor(o.attempt), messages: msgs, temperature: o.temperature, max_tokens: o.max_tokens, stream: false }),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (res.headers.get("x-kono-degraded")) throw new Error("no upstream answered (degraded)");
    const j = await res.json() as Json;
    const msg = ((j.choices as Json[] | undefined)?.[0]?.message ?? {}) as Json;
    return { content: typeof msg.content === "string" ? msg.content : "", model: typeof j.model === "string" ? j.model : undefined };
  };

  await hydrateToolSkills().catch(logErr);
  await hydrateForgedTools().catch(logErr);
  const skills = toolSkillsSnapshot();
  const locals: Json = { tool_skills: Object.fromEntries([...TOOL_SKILLS.entries()]) as Json };
  let seq = 0;
  try {
    const out = await compile({
      question,
      complete,
      exec: async (tool, args, signal) => {
        const x = await runTracedTool(c, root, { id: `node_${++seq}`, name: tool, arguments: args }, { locals, signal });
        return x.ok ? { ok: true, result: x.result, ms: x.ms } : { ok: false, error: x.error, code: x.code, ms: x.ms };
      },
      samples: body.samples as number | undefined,
      rounds: body.rounds as number | undefined,
      concurrency: body.concurrency as number | undefined,
      k: body.k as number | undefined,
      tools: Array.isArray(body.tools) ? body.tools.filter((t): t is string => typeof t === "string") : undefined,
      admin: isAdminContext(c),
      fallbackTools: defaultAutoToolNames(),
      estimateMs: (tool) => (skills[tool]?.calls ? Math.max(1, skills[tool].p50_ms) : 50),
      budgetMs: body.budget_ms as number | undefined,
      signal: c.req.raw.signal,
    });
    root.io("response", out);
    root.end("ok", { rounds: out.rounds.length, llm_calls: out.usage.llm_calls, tool_calls: out.usage.tool_calls });
    return c.json({ object: "agent.compile", model, ...out, trace_id: root.traceId }, 200, traceHeaders);
  } catch (err) {
    root.end("error", { error: errText(err).slice(0, 200) });
    return c.json({ error: { message: errText(err) }, trace_id: root.traceId }, 502, traceHeaders);
  }
});


honoApp.post("/v1/probe", requireAdmin, async (c) => {
  // Honors the requested lane: { mode: "fast" | "smart" | "code" |
  // "reasoning", limit: 1..12 }. Unknown modes fall back to smart rather
  // than failing, and the response reports the lane actually probed —
  // the dashboard has been sending { mode } all along.
  let mode: RoutingMode = "smart";
  let limit = 4;
  try {
    const b = await c.req.json();
    if (["fast", "smart", "code", "reasoning"].includes(b?.mode)) mode = b.mode as RoutingMode;
    if (typeof b?.limit === "number") limit = Math.min(12, Math.max(1, Math.floor(b.limit)));
  } catch {
    // no body: defaults apply
  }
  const probeResults = await runCanaryProbeOnTopCandidates(limit, mode);
  const results = probeResults
    .map((r) => {
      if (r.status === "fulfilled" && r.value) {
        return { tupleId: r.value.tupleId, ok: true, passed: r.value.passed, ms: r.value.ttftMs };
      }
      if (r.status === "rejected") {
        const reason = r.reason as { tupleId?: string; message?: string } | undefined;
        return { tupleId: reason?.tupleId ?? "unknown", ok: false, error: reason?.message ?? "probe failed" };
      }
      return null;
    })
    .filter((x) => x !== null);
  return c.json({ status: "probe_complete", mode, results });
});


honoApp.post("/v1/sync", requireAdmin, async (c) => {
  await ensureCatalogSynced(true);
  await hydrateL1Cache(true);
  return c.json({ status: "catalog_synced", total_models: L1_CACHE.size });
});


honoApp.post("/v1/resurrect", requireAdmin, async (c) => {
  let limit = 6;
  try {
    const b = await c.req.json();
    if (typeof b?.limit === "number") limit = b.limit;
  } catch {
    // no body: defaults apply
  }
  const results = await runResurrectionProbe(limit);
  return c.json({
    status: "resurrection_complete",
    probed: results.length,
    promoted: results.filter((r) => r.ok).length,
    results,
  });
});
}
