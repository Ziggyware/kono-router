// engine/dispatch.ts — dispatch subsystem, partitioned from engine.ts (originally main.ts).

import { emptyToolSkill, observeToolSkill, normalizeToolName, resolveTool, TEXT_CALL_OPENERS, parseTextToolCalls, executeTool } from "../tools.ts";
import type { ToolSkillRecord, ToolExecution, ToolCaps } from "../tools.ts";
import { TOOL_SKILLS, kv, UNIVERSAL_MODEL_ALIAS } from "../state.ts";
import { VALID_ROLES } from "../main.ts";
import type { Json, Delta, ToolCallDelta, UpstreamStream, CompletionResult } from "../main.ts";
import { buildRotatedHeaders, errText, mergeToolCalls, toolNamespace, traceAttrs, logErr } from "../util.ts";
import { currentSpan } from "../trace.ts";
import type { Span } from "../trace.ts";
import type { Context } from "hono";
import type { SubagentTask } from "../toolbox/types.ts";
import { runSubagent } from "./mesh.ts";
import { timingSafeCompare } from "./core.ts";





// ---------------------------------------------------------------------------
// TOOL SKILL MEMORY (ASCK-T). One record per registered tool, holding the
// Beta-Bernoulli success posterior and the Kalman posterior over ln(latency).
// Every execution — from a model's tool call, the agent loop or a direct
// POST /v1/tools/execute — updates it, so knowledge of which tools are fast
// and reliable compounds across requests instead of being rebuilt per call.
// Same CAS + stale-while-revalidate discipline as the model catalog above.
// ---------------------------------------------------------------------------

export const TOOL_SKILL_PREFIX = "mesh_tool_skills_v1";





/** CAS-update one tool's skill record, with the same optimistic L1 write. */
export async function atomicUpdateToolSkill(
  tool: string,
  mutator: (current: ToolSkillRecord) => ToolSkillRecord,
  maxRetries = 3,
): Promise<void> {
  const key = [TOOL_SKILL_PREFIX, tool];
  const now = Date.now();
  const cached = TOOL_SKILLS.get(tool);
  const seeded = cached ?? emptyToolSkill(tool, now);
  const optimistic = mutator(seeded);
  TOOL_SKILLS.set(tool, optimistic);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const entry = await kv.get<ToolSkillRecord>(key);
    const updated = mutator(entry.value ?? emptyToolSkill(tool, now));
    const res = await kv.atomic().set(key, updated).commit();
    if (res.ok) {
      TOOL_SKILLS.set(tool, updated);
      return;
    }
    await new Promise((r) => setTimeout(r, 10 * (attempt + 1) + Math.random() * 15));
  }
  console.warn(`[tools] skill CAS gave up for ${tool} after ${maxRetries} attempts`);
}





export async function recordToolExecution(tool: string, exec: ToolExecution): Promise<void> {
  try {
    await atomicUpdateToolSkill(tool, (rec) =>
      observeToolSkill(rec, {
        ok: exec.ok,
        ms: exec.ms,
        repaired: exec.repaired ?? false,
        error: exec.ok ? null : exec.error,
        code: exec.ok ? null : exec.code,
      }, Date.now()));
  } catch (err) {
    console.error("[tools] skill update failed:", err);
  }
}





export const POISON_REGEX =
  /rate limit exceeded|too many requests|cloudflare ray id|just a moment\.\.\.|api key is required|insufficient_quota|error code: 1020|visit https:\/\/|upgrade your plan|free tier limit|model is overloaded|service unavailable|provider returned error|<\s*!doctype|<\s*html|access denied|captcha|bad gateway|upstream connect error|service temporarily unavailable|enable javascript|origin (?:is|not) allowed/i;





export function computeShannonEntropy(str: string): number {
  const len = str.length;
  if (len === 0) return 0;
  const freq = new Map<string, number>();
  for (let i = 0; i < len; i++) {
    const ch = str[i];
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}





export function verifyCleanText(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("POISON_EMPTY: Zero content tokens");
  if (POISON_REGEX.test(trimmed.slice(0, 400))) {
    throw new Error("POISON_SOFTBLOCK: Upstream proxy error disguised as 200 OK");
  }
  if (trimmed.length >= 32 && computeShannonEntropy(trimmed.slice(0, 128)) < 1.15) {
    throw new Error("POISON_DEGENERATE: Low-entropy token collapse detected");
  }
}





export function firstString(...xs: unknown[]): string | undefined {
  for (const x of xs) {
    if (typeof x === "string" && x.length > 0) return x;
    if (Array.isArray(x)) {
      const joined = x
        .map((b) => (b && typeof b === "object" && typeof (b as Json).text === "string"
          ? String((b as Json).text)
          : typeof b === "string" ? b : ""))
        .join("")
        .trim();
      if (joined) return joined;
    }
  }
  return undefined;
}





// Normalises the ~8 response shapes seen across the 100-endpoint keyless
// registry: OpenAI chat completion, {response}, {content}, {output}, plain
// {message:{content}}, arrays of chunks, and provider-specific wrappers.
export function extractJsonDelta(data: unknown): Delta | null {
  if (Array.isArray(data)) {
    let content = "";
    for (const item of data) {
      const d = extractJsonDelta(item);
      if (d?.content) content += d.content;
    }
    return content ? { content } : null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Json;
  if (obj.error) {
    const e = obj.error as Json;
    throw new Error(`UPSTREAM_ERR: ${String(e.message ?? JSON.stringify(e))}`);
  }
  const choice = (Array.isArray(obj.choices) ? obj.choices[0] : obj.choices) as Json | undefined;
  const msg = (choice?.message ?? choice?.delta ?? obj.message ?? obj.delta ?? {}) as Json;
  const content = firstString(
    msg.content, choice?.text, choice?.content, obj.response, obj.content,
    obj.output, obj.output_text, obj.answer, obj.completion, obj.generated_text,
    obj.text, obj.data,
  );
  const reasoning = firstString(msg.reasoning_content, msg.reasoning, msg.thinking, obj.reasoning_content, obj.reasoning, obj.thinking);
  const rawTools = (msg.tool_calls ?? obj.tool_calls) as unknown;
  const toolCalls = Array.isArray(rawTools) && rawTools.length > 0 ? rawTools as ToolCallDelta[] : undefined;
  const finish = typeof choice?.finish_reason === "string"
    ? choice.finish_reason
    : typeof obj.finish_reason === "string" ? obj.finish_reason : undefined;
  if (!content && !reasoning && !toolCalls && !finish) return null;
  return { content, reasoning, toolCalls, finish };
}





export function sseLineDelta(line: string): Delta | null {
  if (!line.startsWith("data:")) return null;
  const slice = line.slice(5).trim();
  if (!slice || slice === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    // Some keyless relays stream raw text behind a `data:` prefix rather than JSON.
    return { content: slice };
  }
  return extractJsonDelta(parsed);
}





export const THINK_OPEN = "<think>";




export const THINK_CLOSE = "</think>";





/** Length of the longest suffix of s that is a proper prefix of tag (a tag split across chunks). */
export function partialTagSuffix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(s.slice(-n).toLowerCase())) return n;
  }
  return 0;
}





// Wire-level normalisation applied to every upstream, in real time:
//  - a leading <think>…</think> block is routed to `reasoning` as it streams
//    (tags may be split across chunks; only a leading block counts, so literal
//    tags later in an answer stay content);
//  - tool-call deltas get a stable `index` (relays that omit it would otherwise
//    collapse parallel calls into one), plus `id`/`type` on first sight and
//    string `arguments`, which OpenAI clients require to answer each call.
export async function* refineDeltas(src: AsyncIterable<Delta>): AsyncGenerator<Delta> {
  let phase: "lead" | "think" | "body" = "lead";
  let buf = "";
  let trimNext = false;
  let nextIndex = 0;
  let lastIndex = -1;
  const idToIndex = new Map<string, number>();
  const seen = new Set<number>();

  const tools = (calls: ToolCallDelta[]): ToolCallDelta[] =>
    calls.map((t) => {
      let index: number;
      if (typeof t.index === "number") index = t.index;
      else if (t.id && idToIndex.has(t.id)) index = idToIndex.get(t.id)!;
      else if (t.id || t.function?.name || lastIndex < 0) index = nextIndex;
      else index = lastIndex;
      nextIndex = Math.max(nextIndex, index + 1);
      lastIndex = index;
      const out: ToolCallDelta = { ...t, index };
      const args = t.function?.arguments;
      if (t.function) out.function = { ...t.function, ...(args !== undefined && typeof args !== "string" ? { arguments: JSON.stringify(args) } : {}) };
      if (!seen.has(index)) {
        seen.add(index);
        out.id = t.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        out.type = t.type || "function";
      }
      if (out.id) idToIndex.set(out.id, index);
      return out;
    });

  for await (const d of src) {
    const out: Delta = { ...d, ...(d.toolCalls ? { toolCalls: tools(d.toolCalls) } : {}) };
    if (!d.content || (phase === "body" && !trimNext)) {
      yield out;
      continue;
    }
    let text = buf + d.content;
    buf = "";
    let reasoning = "";
    let content = "";
    if (phase === "lead") {
      const t = text.trimStart();
      const head = t.slice(0, THINK_OPEN.length).toLowerCase();
      if (t.length < THINK_OPEN.length && THINK_OPEN.startsWith(head)) {
        buf = text; // undecided: may still become <think>
        text = "";
      } else if (head === THINK_OPEN) {
        phase = "think";
        text = t.slice(THINK_OPEN.length);
      } else {
        phase = "body";
      }
    }
    if (phase === "think") {
      const i = text.toLowerCase().indexOf(THINK_CLOSE);
      if (i >= 0) {
        reasoning = text.slice(0, i);
        text = text.slice(i + THINK_CLOSE.length);
        phase = "body";
        trimNext = true;
      } else {
        const keep = partialTagSuffix(text, THINK_CLOSE);
        reasoning = text.slice(0, text.length - keep);
        buf = text.slice(text.length - keep);
        text = "";
      }
    }
    if (phase === "body" && text) {
      if (trimNext) text = text.trimStart();
      if (text) trimNext = false;
      content = text;
    }
    out.content = content || undefined;
    out.reasoning = (out.reasoning ?? "") + reasoning || undefined;
    if (out.content || out.reasoning || out.toolCalls || out.finish) yield out;
  }
  if (buf) yield phase === "think" ? { reasoning: buf } : { content: buf };
}





// Lifts text-format tool calls (see parseTextToolCalls) into structured
// deltas when the request declared tools. Content streams through until an
// opener appears; from there it is held to the end and parsed. Calls naming a
// declared tool (directly or by alias) become tool_calls with finish
// "tool_calls"; anything else is released as the content it was.
export async function* liftTextToolCalls(src: AsyncIterable<Delta>, declared: Set<string>): AsyncGenerator<Delta> {
  const owns = (name: string) => declared.has(normalizeToolName(name)) || declared.has(normalizeToolName(resolveTool(name).tool?.name ?? ""));
  let held = "";
  let holding = false;
  let finish: string | undefined;
  let nextIndex = 0;
  for await (const d of src) {
    for (const t of d.toolCalls ?? []) nextIndex = Math.max(nextIndex, t.index + 1);
    if (holding && d.finish) finish = d.finish;
    const pass: Delta = { ...d, content: undefined, ...(holding ? { finish: undefined } : {}) };
    if (d.content) {
      let text = held + d.content;
      held = "";
      if (!holding) {
        const lower = text.toLowerCase();
        const at = Math.min(...TEXT_CALL_OPENERS.map((o) => { const i = lower.indexOf(o); return i < 0 ? Infinity : i; }));
        if (at !== Infinity) {
          holding = true;
          held = text.slice(at);
          text = text.slice(0, at);
          if (d.finish) { finish = d.finish; pass.finish = undefined; }
        } else {
          const keep = Math.max(...TEXT_CALL_OPENERS.map((o) => partialTagSuffix(text, o)));
          held = text.slice(text.length - keep);
          text = text.slice(0, text.length - keep);
        }
        pass.content = text || undefined;
      } else held = text;
    }
    if (pass.content || pass.reasoning || pass.toolCalls || pass.finish) yield pass;
  }
  if (!holding) { if (held) yield { content: held }; return; }
  const parsed = parseTextToolCalls(held);
  if (!parsed || !parsed.calls.every((c) => owns(c.name))) { yield { content: held, finish }; return; }
  if (parsed.rest) yield { content: parsed.rest };
  yield {
    toolCalls: parsed.calls.map((c, i) => ({
      index: nextIndex + i,
      id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    })),
    finish: "tool_calls",
  };
}





// Incremental, self-sniffing response decoder. It handles SSE, a single JSON
// document (bodies that ignore stream:true), JSON arrays, and plain text —
// every shape the heterogeneous keyless registry emits.
export async function* parseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<Delta> {
  let buf = "";
  let mode: "unknown" | "json" | "sse" | "text" = "unknown";
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    if (mode === "text") {
      if (text) yield { content: text };
      continue;
    }
    buf += text;
    if (mode === "unknown") {
      const head = buf.trimStart();
      if (!head) continue;
      if (head[0] === "{" || head[0] === "[") mode = "json";
      else if (head.startsWith("data:") || head.startsWith("event:") || head.startsWith("id:") || head.startsWith(":")) mode = "sse";
      else if (buf.length >= 24 || head.includes("\n")) mode = "text";
      else continue; // wait for a little more evidence before deciding
      if (mode === "text") {
        const chunk = buf;
        buf = "";
        if (chunk.trim()) yield { content: chunk };
        continue;
      }
    }
    if (mode === "sse") {
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const d = sseLineDelta(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
        if (d) yield d;
      }
    }
  }
  if (mode === "json") {
    let data: unknown;
    try {
      data = JSON.parse(buf.replace(/^\uFEFF/, "").trim());
    } catch {
      // A truncated JSON document still often contains usable text.
      const salvage = buf.match(/"(?:content|response|text|output)"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (salvage) yield { content: salvage[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') };
      return;
    }
    const d = extractJsonDelta(data);
    if (d) yield d;
    return;
  }
  if (mode === "sse") {
    const d = sseLineDelta(buf.trim());
    if (d) yield d;
    return;
  }
  if (buf.trim()) yield { content: buf };
}





// Enough text for POISON_REGEX phrases and the 32-char entropy floor to be decidable.
export const COMMIT_CHARS = 64;





// Resolves at the first validated tokens (or a tool call), not at completion: the race is decided
// on time-to-first-token and the winner's remainder is piped, never buffered.
export async function openUpstream(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  stream = true,
): Promise<UpstreamStream> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: buildRotatedHeaders(headers),
    body: JSON.stringify({ ...payload, stream }),
    signal,
  });

  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 429) throw new Error("HTTP_429: Rate limit");
    if (res.status === 401 || res.status === 403) throw new Error(`HTTP_${res.status}: Blocked`);
    // 4xx/501 here almost always means "this relay does not accept stream:true"
    // or "does not understand one of the optional params". Tagged as negotiable
    // so openUpstreamAdaptive can retry a simpler wire shape.
    if ([400, 404, 405, 415, 422, 501].includes(res.status)) {
      throw new Error(`PROTOCOL_HTTP_${res.status}: retry with a simpler payload`);
    }
    throw new Error(`HTTP_${res.status}: Upstream error`);
  }

  const declared = Array.isArray(payload.tools)
    ? new Set((payload.tools as Json[]).map((t) => normalizeToolName(String(((t?.function ?? t) as Json)?.name ?? ""))).filter(Boolean))
    : null;
  const refined = refineDeltas(parseDeltas(res.body));
  const tail = declared?.size ? liftTextToolCalls(refined, declared) : refined;
  const head: Delta[] = [];
  let ttftMs = 0;
  let content = "";
  let text = "";
  while (true) {
    const r = await tail.next();
    if (r.done) {
      // Reasoning-only completions are salvaged downstream, so they are judged on their reasoning.
      verifyCleanText(content.trim() ? content : text);
      break;
    }
    const d = r.value;
    if (!ttftMs) ttftMs = Math.max(1, Math.round(performance.now() - t0));
    head.push(d);
    if (d.toolCalls) break;
    content += d.content ?? "";
    text += (d.reasoning ?? "") + (d.content ?? "");
    if (text.length >= COMMIT_CHARS) {
      verifyCleanText(text);
      break;
    }
  }
  return { t0, ttftMs: ttftMs || Math.round(performance.now() - t0), head, tail };
}





export function isNegotiableFailure(e: unknown): boolean {
  if (e instanceof Error && /abort/i.test(e.name) && /HEDGE_LOST|CLIENT_DISCONNECTED|TIMEOUT/.test(e.message)) return false;
  const m = e instanceof Error ? e.message : String(e);
  return /^(PROTOCOL_|HTTP_400|HTTP_404|HTTP_405|HTTP_415|HTTP_422|HTTP_501|POISON_EMPTY|POISON_DEGENERATE|UPSTREAM_ERR)/.test(m) ||
    /^Unexpected|JSON|SyntaxError/i.test(m);
}





// Adaptive wire-protocol negotiation. A keyless relay that rejects streaming,
// optional params, or the requested model name is retried with progressively
// simpler payloads instead of being written off as dead. This is what lets the
// exhaustive sweep actually use heterogeneous endpoints.
export async function openUpstreamAdaptive(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<UpstreamStream> {
  const model = String(payload.model ?? "");
  const messages = payload.messages;
  // Tool fields are semantic, not optional tuning: simpler rungs keep them.
  const toolFields = Object.fromEntries(
    ["tools", "tool_choice", "parallel_tool_calls"].filter((k) => payload[k] !== undefined).map((k) => [k, payload[k]]),
  );
  const minimal: Record<string, unknown> = { model, messages, ...toolFields };
  const alias: Record<string, unknown> = { model: UNIVERSAL_MODEL_ALIAS, messages, ...toolFields };
  const rungs: Array<{ p: Record<string, unknown>; stream: boolean }> = [
    { p: payload, stream: true },
    { p: minimal, stream: true },
  ];
  if (model.toLowerCase() !== UNIVERSAL_MODEL_ALIAS) rungs.push({ p: alias, stream: true });
  rungs.push({ p: minimal, stream: false }, { p: alias, stream: false });

  let lastErr: unknown = null;
  for (let i = 0; i < rungs.length; i++) {
    if (signal.aborted) throw signal.reason ?? new Error("ABORTED_BY_RACE");
    try {
      return await openUpstream(url, headers, rungs[i].p, signal, rungs[i].stream);
    } catch (e) {
      lastErr = e;
      if (!isNegotiableFailure(e) || signal.aborted || i === rungs.length - 1) throw e;
      currentSpan()?.event("negotiate", { rung: i, stream: rungs[i].stream, error: errText(e).slice(0, 200) });
    }
  }
  throw lastErr ?? new Error("Upstream protocol negotiation exhausted");
}





// Drains a committed upstream into the buffered (non-stream) completion shape.
export async function collectUpstream(up: UpstreamStream): Promise<CompletionResult & { finish?: string }> {
  let content = "";
  let rawReasoning = "";
  let finish: string | undefined;
  const tools = new Map<number, ToolCallDelta>();
  const take = (d: Delta) => {
    content += d.content ?? "";
    rawReasoning += d.reasoning ?? "";
    if (d.toolCalls) mergeToolCalls(tools, d.toolCalls);
    finish = d.finish ?? finish;
  };
  up.head.forEach(take);
  for await (const d of up.tail) take(d);

  content = content.trim();
  const reasoningContent = rawReasoning.trim() || null;
  const toolCalls = tools.size > 0 ? [...tools.values()].sort((a, b) => a.index - b.index) : undefined;
  // Salvage: a reasoning model that spent its whole budget thinking still answered.
  let finalContent = content;
  if (!toolCalls && !content.trim() && reasoningContent) {
    console.log(`[salvage] reasoning-only completion accepted (${reasoningContent.length} reasoning chars)`);
    finalContent = reasoningContent;
  } else if (!toolCalls) {
    verifyCleanText(content);
  }
  return {
    content: finalContent,
    reasoningContent,
    toolCalls,
    finish,
    ttftMs: up.ttftMs,
    totalMs: Math.max(up.ttftMs + 1, Math.round(performance.now() - up.t0)),
    estTokens: Math.max(1, Math.ceil((content.length + (reasoningContent?.length ?? 0)) / 4)),
  };
}





/** Tool capabilities for a request: its session's store, and — one level deep
 *  only — the sub-agent runner behind agent_team. */
export function toolCaps(c: Context, model?: string, runner = false): ToolCaps {
  const depth = Number(c.req.header("x-kono-depth") ?? c.req.header("x-nokey-depth") ?? 0) || 0;
  return {
    kv,
    namespace: toolNamespace(c),
    ...(runner ? { runner: true } : {}),
    ...(depth < 1 ? { subagent: (t: SubagentTask, signal: AbortSignal) => runSubagent(c, t, depth + 1, model, runner, signal) } : {}),
  };
}





/** Admin context for tool routes: same semantics as the requireAdmin guard
 *  (an unset ADMIN_SECRET means the deployment has no admin tier at all). */
export function isAdminContext(c: Context): boolean {
  const secret = Deno.env.get("ADMIN_SECRET");
  if (!secret) return true;
  const provided = c.req.header("x-admin-secret") || "";
  return Boolean(provided) && timingSafeCompare(provided, secret);
}





export function normalizeMessages(raw: unknown, promptFallback?: unknown): Array<{ role: string; content: unknown }> {
  const out: Array<{ role: string; content: unknown }> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const m = item as Json;
      const role = typeof m.role === "string" && VALID_ROLES.has(m.role.toLowerCase())
        ? m.role.toLowerCase()
        : "user";
      let content: unknown = m.content;
      if (content === undefined || content === null) {
        content = typeof m.text === "string" ? m.text : "";
      }
      if (content && typeof content === "object" && !Array.isArray(content)) {
        content = JSON.stringify(content);
      }
      const msg: { role: string; content: unknown } & Json = { role, content: typeof content === "string" ? content : content ?? "" };
      // Tool round-trips: every tool result must still pair with its assistant call.
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        msg.tool_calls = (m.tool_calls as Json[]).map((t) => {
          const fn = (t.function ?? {}) as Json;
          return { ...t, type: t.type ?? "function", function: { ...fn, arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) } };
        });
        if (msg.content === "") msg.content = null;
      }
      if (typeof m.tool_call_id === "string") msg.tool_call_id = m.tool_call_id;
      if (typeof m.name === "string") msg.name = m.name;
      out.push(msg);
    }
  }
  if (out.length === 0) {
    const fallback = typeof promptFallback === "string" && promptFallback.trim()
      ? promptFallback
      : "Please reply with a short acknowledgement.";
    out.push({ role: "user", content: fallback });
  }
  return out;
}





/** One direct tool execution: traced, executed with the caller's admin and
 *  session scope, and recorded (awaited, so a response's `totals` include it). */
export async function runTracedTool(
  c: Context,
  parent: Span,
  call: { id: string; name: string; arguments: unknown },
  o: { locals: Json; timeoutMs?: number; signal?: AbortSignal },
): Promise<ToolExecution> {
  const span = parent.child("tool", { name: call.name, id: call.id });
  const execution = await executeTool(call.name, call.arguments, {
    admin: isAdminContext(c),
    locals: o.locals,
    caps: toolCaps(c),
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    now: Date.now(),
    event: (name, attrs) => span.event(name, traceAttrs(attrs ?? {})),
  });
  span.end(execution.ok ? "ok" : "error", {
    ms: execution.ms,
    strategy: execution.strategy ?? "",
    repairs: (execution.repairs ?? []).join(",").slice(0, 160),
    ...(execution.ok ? { bytes: execution.bytes, truncated: execution.truncated } : { code: execution.code }),
  });
  // app_runner is internal housekeeping (the dashboard's job pump), not a
  // model-chosen tool: its executions never enter skill telemetry, where
  // polling would otherwise drown the real signal.
  if ((execution.tool ?? call.name) !== "app_runner") {
    await recordToolExecution(execution.tool ?? call.name, execution).catch(logErr);
  }
  return execution;
}
