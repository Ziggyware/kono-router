// routes/tools.ts — ToolsRoutes route registrations extracted from main.ts.
// main.ts calls registerToolsRoutes() at the position of this area's first route, preserving registration order.

import { listTools, defaultAutoToolNames, toToolSpecs, isStatefulTool, normalizeToolName } from "../tools.ts";
import type { ToolFlavor } from "../tools.ts";
import { startTrace } from "../trace.ts";
import { clamp as clampNum } from "../math.ts";
import { honoApp, TOOL_SKILLS } from "../state.ts";
import { hydrateToolSkills, hydrateForgedTools } from "../main.ts";
import type { Json } from "../main.ts";
import { isAdminContext, runTracedTool } from "../engine/dispatch.ts";
import { requireAdmin } from "../engine/core.ts";
import { forgeTool, retireForgedTool } from "../engine/mesh.ts";
import { lineageView, speciationOverview, runEvolutionCycle, promoteVariantManual, retireVariantById, setPin } from "../engine/speciation.ts";
import { toolSkillsSnapshot, toolPlaneEnabled, maxToolRounds, toolNamespace, toolPlaneTotals, logErr, errText } from "../util.ts";



// ---------------------------------------------------------------------------
// TOOL PLANE HTTP SURFACE
// GET  /v1/tools          the registry, its learned skill memory, and a
//                         ready-to-paste projection for any vendor wire format
// POST /v1/tools/execute  run tool calls directly (client-side agent loops,
//                         the workspace console, or a model with no tools)
// ---------------------------------------------------------------------------

export const TOOL_FLAVORS = ["openai", "openai-strict", "anthropic", "gemini"] as const;

export function registerToolsRoutes() {


honoApp.get("/v1/tools", async (c) => {
  const now = Date.now();
  await hydrateToolSkills().catch((err) => console.error("tool skill hydrate:", err));
  await hydrateForgedTools().catch((err) => console.error("forged tool hydrate:", err));
  const admin = isAdminContext(c);
  const flavorRaw = (c.req.query("flavor") ?? "openai").toLowerCase();
  const flavor = (TOOL_FLAVORS.includes(flavorRaw as typeof TOOL_FLAVORS[number]) ? flavorRaw : "openai") as ToolFlavor;
  const withSchemas = c.req.query("schemas") !== "0";
  const skills = toolSkillsSnapshot(now);
  const registry = listTools()
    .filter((t) => admin || !t.admin)
    .map((t) => ({
      name: t.name,
      kind: t.kind,
      description: t.description,
      aliases: t.aliases ?? [],
      deterministic: t.deterministic ?? false,
      admin: t.admin ?? false,
      dynamic: t.dynamic ?? false,
      ...(withSchemas ? { parameters: t.parameters } : {}),
      skill: skills[t.name] ?? null,
    }));
  return c.json({
    object: "list",
    plane: "asck-t-v2",
    enabled: toolPlaneEnabled(),
    agent: { max_rounds: maxToolRounds(), auto_tools: defaultAutoToolNames() },
    session: { namespace: toolNamespace(c), scope_header: "x-nokey-session", storage: "deno-kv" },
    count: registry.length,
    totals: toolPlaneTotals(now),
    data: registry,
    skills,
    wire: { flavor, tools: toToolSpecs({ flavor, includeAdmin: admin }) },
  });
});


honoApp.post("/v1/tools/execute", async (c) => {
  const root = startTrace("tools.execute", {}, c.req.header("traceparent"));
  const traceHeaders = { traceparent: root.traceparent };
  try {
    const body = await c.req.json().catch(() => ({} as Json)) as Json;
    root.io("request", body);
    const rawCalls = Array.isArray(body.calls) ? body.calls : [body];
    const calls = rawCalls
      .filter((entry) => entry && typeof entry === "object")
      .slice(0, 16)
      .map((entry, i) => {
        const e = entry as Json;
        const fn = (e.function ?? e) as Json;
        const args = fn.arguments ?? e.arguments ?? e.args ?? {};
        return {
          id: typeof e.id === "string" && e.id ? e.id : `call_${i}`,
          // OpenAI nests name/arguments under `function`; Anthropic and direct
          // callers put them at the top level. Accept both.
          name: String(fn.name ?? e.name ?? e.tool ?? ""),
          arguments: args,
        };
      });

    await hydrateToolSkills().catch(logErr);
    await hydrateForgedTools().catch(logErr);
    const locals: Json = { tool_skills: Object.fromEntries([...TOOL_SKILLS.entries()]) as Json };
    const timeoutMs = body.timeout_ms === undefined ? undefined : Math.round(clampNum(Number(body.timeout_ms) || 4000, 50, 10_000_000));

    // Stateful calls run in order (write-then-read in one batch), pure ones in
    // parallel. The scheduler lives in the kernel so both entry points agree.
    let batchTail: Promise<unknown> = Promise.resolve();
    const results = await Promise.all(calls.map((call) => {
      const run = async () => {
      const execution = await runTracedTool(c, root, call, { locals, timeoutMs });
      return {
        id: call.id,
        name: execution.tool ?? call.name,
        ok: execution.ok,
        ms: execution.ms,
        ...(execution.ok
          ? { result: execution.result, strategy: execution.strategy, repairs: execution.repairs, truncated: execution.truncated, bytes: execution.bytes }
          : { error: execution.error, code: execution.code, suggestions: execution.suggestions ?? [], issues: execution.issues ?? [] }),
      };
      };
      if (!isStatefulTool(call.name)) return run();
      const ordered = batchTail.then(run);
      batchTail = ordered.catch(() => undefined);
      return ordered;
    }));

    const ok = results.every((r) => r.ok);
    root.io("response", results);
    root.end(ok ? "ok" : "error", { calls: results.length, failures: results.filter((r) => !r.ok).length });
    return c.json({
      object: "list",
      count: results.length,
      ok,
      results,
      totals: toolPlaneTotals(),
      trace_id: root.traceId,
    }, 200, traceHeaders);
  } catch (err) {
    root.end("error", { error: errText(err).slice(0, 200) });
    return c.json({ object: "list", count: 0, ok: false, error: errText(err), results: [] }, 200, traceHeaders);
  }
});



honoApp.post("/v1/tools/forge", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({} as Json)) as Json;
  try {
    const def = await forgeTool(body);
    return c.json({ forged: def.name, kind: def.kind, description: def.description, parameters: def.parameters, admin: def.admin ?? false, dynamic: true, updated_at: def.updated_at, tools_total: listTools().length });
  } catch (err) {
    return c.json({ error: { message: errText(err) } }, 400);
  }
});


honoApp.delete("/v1/tools/forge/:name", requireAdmin, async (c) => {
  const gone = await retireForgedTool(c.req.param("name"));
  return gone
    ? c.json({ retired: normalizeToolName(c.req.param("name")) })
    : c.json({ error: { message: "not a forged tool" } }, 404);
});


// ---------------------------------------------------------------------------
// TOOL SPECIATION — populations of forged-tool variants under one name.
// All admin: evolution changes what production traffic executes.
// ---------------------------------------------------------------------------

honoApp.get("/v1/tools/speciation", requireAdmin, async (c) => {
  return c.json(await speciationOverview());
});


honoApp.get("/v1/tools/:name/lineage", requireAdmin, async (c) => {
  const view = await lineageView(c.req.param("name"), true);
  return view ? c.json(view) : c.json({ error: { message: "no lineage for that tool" } }, 404);
});


honoApp.post("/v1/tools/:name/evolve", requireAdmin, async (c) => {
  const report = await runEvolutionCycle({ toolName: c.req.param("name") });
  return c.json(report);
});


honoApp.post("/v1/tools/:name/variants/:variant_id/promote", requireAdmin, async (c) => {
  const result = await promoteVariantManual(c.req.param("name"), c.req.param("variant_id"));
  return c.json(result, result.ok ? 200 : 400);
});


honoApp.post("/v1/tools/:name/variants/:variant_id/retire", requireAdmin, async (c) => {
  const gone = await retireVariantById(c.req.param("name"), c.req.param("variant_id"));
  return gone ? c.json({ retired: c.req.param("variant_id") }) : c.json({ error: { message: "variant not found or is champion" } }, 404);
});


honoApp.post("/v1/tools/:name/pin", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({} as Json)) as Json;
  const pinned = body.pinned !== false;
  const ok = await setPin(c.req.param("name"), pinned);
  return ok ? c.json({ pinned }) : c.json({ error: { message: "no lineage for that tool" } }, 404);
});
}
