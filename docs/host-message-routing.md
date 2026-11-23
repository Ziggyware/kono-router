# Host-side message routing — inventory, then a re-cut

This is the routing spine of `kono-router` as it exists on this branch (gathered
in **Part A**: real paths, real code), followed by a re-cut of that spine
(**Part B**): the interfaces a host-side router needs, and the minimum
implementation that can *take a simple request, build the request up, and break
it into tiny chunks the AI writes* — with every decision visible.

"Host side" means the server process that owns a chat request: it accepts the
body, decides who could answer, speaks the upstream wire, and decides when to
hedge, stop, run a tool, or degrade. It is everything downstream of
`POST /v1/chat/completions` and upstream of the client's connection.

## What the existing spine actually is

| Stage | Today | Where |
| --- | --- | --- |
| accept + tame the body | `normalizeMessages`, the alias loop, param clamps | `routes/chat.ts` (inside the handler), `engine/dispatch.ts` |
| pick who answers | `getRankedCandidates` → `scoreRecord` → `interleaveByProvider` | `engine/providers.ts`, `engine/ranking.ts` |
| speak the wire | `openUpstream` / `openUpstreamAdaptive` / `parseDeltas` / `refineDeltas` / `liftTextToolCalls` / `collectUpstream` | `engine/dispatch.ts` |
| decide when to stop | four-tier `hedgedDispatch` with `HEDGE` / `ESCALATION` / `WIDE` / `SWEEP` policies | `routes/chat-dispatch.ts`, `routes/chat.ts` |
| run the model's tools | `executeOwnedToolCalls`, `gradeToolCalls`, `learnToolVerdict` | `routes/chat-dispatch.ts` |
| split work into steps | `samplePlans` → MBR → `runPlan` DAG (compiler); `plan → workers → verify → synthesize` (`/v1/agent/run`) | `compiler/*.ts`, `routes/agent-run.ts` |
| say what happened | `startTrace`, `span.io`, `root.set`, `console.warn` | `trace.ts`, called from all over the handler |

Three things make the current cut hard to reason about, and they are what the
re-cut targets:

1. **One 1,035-line handler.** `registerChat`'s callback (`routes/chat.ts`
   lines 106-1140) interleaves intake, the tool plane, ASCK-L context, ranking,
   four dispatch tiers, tool rounds, the build gate, verifier retries, SSE
   writing and learning updates. There is no seam where you can observe or test
   "what did the router decide" without the network and a KV.
2. **Visibility is a side effect.** Spans record some fields, `console.warn`
   records others, and the degraded path is a separate renderer
   (`degradedSse` / `degradedCompletion`). Nothing returns a per-decision
   record, so "why did this request take 41s and answer on the third model" is
   archaeology.
3. **The AI-authored part is untrusted but unvalidated.** The compiler's
   `parsePlan` checks node shape, but the chat path has no equivalent, and the
   model's own prose can name tools.

## What the re-cut changes

A fixed five-stage spine, six ports, and one ledger:

```
intake -> build -> decompose -> execute -> assemble
```

- every stage is a function of `(previous value, ports, ledger)`;
- every stage can only throw when the *caller* aborts — a bad body, a dead
  planner, a hostile plan and a broken tool are all values;
- the planner is the only AI-written control flow, so it is the only thing with
  a full validation pass (ids, kinds, declared tools only, backward-only
  dependencies, `$chunk.path` refs) plus one bounded repair call;
- `Ledger` is the single writer of events: monotonic `seq`, relative `at`,
  epoch `wall`, `stage`/`phase`/`chunkId`, and a `RouteReport` that ships back
  to the caller with `explain()`;
- the model layer is one buffered `complete()` call, so hedging, SSE framing
  and provider negotiation stay adapters — they are *not* in the spine.

Verified on this branch: `tsc --strict --noEmit` is clean, and
`tests/host_routing_test.ts` — **10 passed, 0 failed**:

```bash
node --experimental-strip-types tests/host_routing_test.ts   # 10 passed, 0 failed
deno run -A tests/host_routing_test.ts                       # same file, same result
```

The test imports nothing outside `host/` and uses neither `Deno.test` nor
`node:test` (both are replaced by a 30-line harness, because the spine should be
provable in any runtime it might be deployed to).

Real output of the minimum spine on the simplest possible request:

```
=== content ===
[polish] answered

=== explain() ===
req_25ngxsza free:auto -> fast/chat | plan planner (3 chunks, 3 ok) | calls model 3 / tool 1, retries 0, errors 0 | 8ms of 60000ms | finish stop
  facts [tool tool=web_lookup] -> ok 1ms 52c
  draft [answer] -> ok 1ms via memory-answer 16c
  polish [answer] -> ok 0ms via memory-answer 17c

stages: intake 2ms - build 1ms - rank 0ms - decompose 2ms - chunk 4ms - assemble 0ms - done 0ms
```

---

# Part A — the code that is there today

Gathered from the working tree. Excerpts are marked with the line ranges they
came from; everything else is the complete file, unchanged.

// main.ts — excerpt, lines 470-556 and 714-761.
// The contracts the whole spine speaks: lanes, delta shapes, the upstream
// stream handle, the scored candidate, the rank options. Every module in Part A
// imports at least one of these.

main.ts
```ts



// ============================================================================
// 4. EPISTEMIC THOMPSON SAMPLING + MULTIMODAL INTENT AUTO-CLASSIFIER
// ============================================================================

export type RoutingMode = "fast" | "smart" | "code" | "reasoning";




export interface CompletionResult {
  content: string;
  reasoningContent: string | null;
  toolCalls?: unknown[];
  ttftMs: number;
  totalMs: number;
  estTokens: number;
}



export interface CompletionOptions {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  reasoning_effort?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: unknown;
  response_format?: unknown;
}



export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}



export interface Delta {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  finish?: string;
}



// An upstream generation whose first tokens already passed the poison guard.
export interface UpstreamStream {
  t0: number;
  ttftMs: number;
  head: Delta[];
  tail: AsyncGenerator<Delta>;
}



export interface ProviderSpec {
  id: string;
  name: string;
  /** Chat completions URL, exposed for coverage reporting. */
  chatUrl?: string;
  /** OpenAI-standard images URL and headers, when the endpoint follows the /v1 layout. */
  imagesUrl?: string;
  imageHeaders?: Record<string, string>;
  isConfigured: () => boolean;
  discoverModels: (signal: AbortSignal) => Promise<Array<{ id: string, context?: number; }>>;
  executeCompletion: (
    modelId: string,
    messages: Array<{ role: string; content: unknown }>,
    signal: AbortSignal,
    options?: CompletionOptions,
  ) => Promise<UpstreamStream>;
}



export type Json = Record<string, unknown>;


// … lines 557-713 omitted: the rate limiter and the services.json provider registry …

export interface ScoredCandidate {
  tupleId: string;
  providerId: string;
  modelId: string;
  iqEffective: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  isCodingSpecialist: boolean;
  contextWindow: number;
  reliabilityDraw: number;
  ewmaTtftMs: number;
  ewmaTps: number;
  logTtftMu: number;
  logTtftSigma: number;
  expectedFastMs: number;
  smartScore: number;
  /** Wilson floor on this tuple's learned ability to emit valid tool calls.
   *  0 while unproven — no evidence is not evidence of incompetence. */
  toolCompetence: number;
  toolPulls: number;
  /** ASCK-L contextual posterior mean for this request's task class. */
  learningMean?: number;
  learningPulls?: number;
}



export const PROVIDER_BREAKER = new Map<string, { fails: number; openUntil: number }>();



export interface RankOptions {
  includeCoolingDown?: boolean;
  verifiedOnly?: boolean;
  /** ASCK-L: rank with the contextual (tuple, task class) posterior. */
  taskClass?: TaskClass;
  tenant?: string;
  /** Exhaustive mode: ignore breaker, tuple cooldown, vision and IQ gates. */
  unrestricted?: boolean;
  /** Tool-bearing request: fold each tuple's learned tool competence into the
   *  score and rank on it even in the latency-ordered `fast` lane, because a
   *  malformed tool call costs a whole extra round-trip. */
  toolAware?: boolean;
}



let modelHintsCache: Map<string, string[]> | null = null;
```

// engine/dispatch.ts — the wire layer, whole file (699 lines).
// normalizeMessages (intake), openUpstream / openUpstreamAdaptive
// (negotiation), parseDeltas / refineDeltas / liftTextToolCalls (decoding SSE,
// JSON and text-shaped tool calls), verifyCleanText (poison guard),
// collectUpstream (buffered completion), toolCaps / isAdminContext (request
// scope), runTracedTool (a tool with a span around it), plus the ASCK-T tool
// skill memory at the top.

engine/dispatch.ts
```ts
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
```

// engine/ranking.ts — candidate scoring, whole file (186 lines).
// scoreRecord folds IQ, reliability draw, the TTFT posterior, learned tool
// competence and the contextual learning posterior into one number;
// interleaveByProvider keeps one provider from owning the head of the list;
// breakerProviderId keys the circuit breaker.

engine/ranking.ts
```ts
// engine/ranking.ts — candidate scoring and ranking, extracted from engine/providers.ts.

import type { MeshModelRecord, ScoredCandidate, RoutingMode } from "../main.ts";
import { posteriorLowerBound } from "../learning.ts";
import type { TaskClass } from "../learning.ts";
import { clamp as clampNum, predictiveSigma, discountedPosterior, wilsonLowerBound, sampleBeta, ucbBonus, gumbelNoise } from "../math.ts";
import { toolRoutingBonus, tupleToolCompetence } from "../tools.ts";
import { contextualPosterior } from "./learning.ts";





// ---------------------------------------------------------------------------
// Provider diversity + circuit breaker.
// Dispatch races waves of 3 candidates drawn from the head of the ranked
// list, 9 attempts max. If one provider's tuples fill the head (a big free
// catalog with optimistic latency priors does exactly this), a provider-level
// outage -- dead key, exhausted quota -- fails every wave and the request
// returns 502 even while other providers are healthy. Two guards:
//  1. interleaveByProvider round-robins the ranked list across providers so
//     every wave spans multiple providers, preserving per-provider order.
//  2. PROVIDER_BREAKER excludes a provider from ranking for 5 minutes after
//     6 consecutive tuple failures, and clears on its next success.
// ---------------------------------------------------------------------------
export function interleaveByProvider(sorted: ScoredCandidate[]): ScoredCandidate[] {
  const byProvider = new Map<string, ScoredCandidate[]>();
  for (const cand of sorted) {
    const bucket = byProvider.get(cand.providerId);
    if (bucket) bucket.push(cand);
    else byProvider.set(cand.providerId, [cand]);
  }
  const queues = [...byProvider.values()];
  const out: ScoredCandidate[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        progressed = true;
      }
    }
  }
  return out;
}





export function breakerProviderId(tupleId: string): string {
  return tupleId.split("::")[0] || "";
}





// ---------------------------------------------------------------------------
// ASCK v1 scoring: discounted Thompson sampling + Kalman predictive quantiles
// + UCB exploration + Plackett–Luce (Gumbel) rank sampling. Pure function of
// one catalog record, reused by the lane ranker and the exhaustive sweep.
// ---------------------------------------------------------------------------
/** Population mean of the capability prior (the untiered base score). */
export const IQ_POPULATION_MEAN = 0.56;




/** Share of a claimed prior believed before any evidence. */
export const IQ_CREDIBILITY_FLOOR = 0.4;




export function scoreRecord(
  r: MeshModelRecord,
  mode: RoutingMode,
  deterministic: boolean,
  totalPulls: number,
  now: number,
  toolAware = false,
  learning?: { taskClass: TaskClass; tenant: string },
): ScoredCandidate {
  const iqPrior = Number(r.iq_prior);
  // Capability estimate on the prior's own scale: the model-name prior is a
  // claim, shrunk toward the population mean by how much this tuple has
  // earned trust. iq_verified runs 0.55 (unproven, or a failed canary) to 1.0
  // (canary passed / repeated completions); a tuple that never completed a
  // request is unproven whatever sync stored. Unproven keeps 40% of its
  // distance from the mean, fully trusted keeps all of it, so an unverified
  // headline name no longer outranks a proven workhorse and mode bonuses
  // (code, reasoning) decide within the unproven pack.
  const trust = r.success_count > 0 ? clampNum((Number(r.iq_verified) - 0.55) / 0.45, 0, 1) : 0;
  const credibility = IQ_CREDIBILITY_FLOOR + (1 - IQ_CREDIBILITY_FLOOR) * trust;
  const iqEffective = Number((IQ_POPULATION_MEAN + credibility * (iqPrior - IQ_POPULATION_MEAN)).toFixed(3));
  const ewmaTtftMs = Number(r.ewma_ttft_ms);
  const ewmaTps = Math.max(1.0, Number(r.ewma_tps));

  // Kalman posterior over ln(TTFT); staleness inflates predictive sigma.
  const logTtftMu = r.ewma_log_ttft ?? Math.log(Math.max(1, ewmaTtftMs));
  const logTtftSigma = predictiveSigma({
    mu: logTtftMu,
    variance: clampNum(r.ewmv_log_ttft ?? 0.25, 0.01, 2.5),
    updatedAtMs: r.log_ttft_updated_at ?? 0,
  }, now);

  // Discounted Beta-Bernoulli posterior (6 h half-life). Stale glory decays
  // back to the uniform prior, so a dead key cannot coast for weeks.
  const post = discountedPosterior(
    Number(r.alpha_success || 2.0),
    Number(r.beta_failure || 1.0),
    r.last_success_at ?? r.last_probed ?? now,
    now,
  );
  const pulls = Math.max(0, r.success_count + r.failure_streak);
  const reliabilityDraw = deterministic
    ? wilsonLowerBound(Math.max(0, post.alpha - 1), Math.max(1, post.alpha + post.beta - 2))
    : sampleBeta(post.alpha, post.beta);
  const exploration = deterministic ? 0 : ucbBonus(pulls, totalPulls);
  const plackettLuce = deterministic ? 0 : 0.012 * gumbelNoise();

  const expectedFastMs = Math.round(
    (ewmaTtftMs + (250 / ewmaTps) * 1000) / Math.max(0.35, reliabilityDraw),
  );
  const latencyPenalty = Math.max(0, (expectedFastMs - 8500) / 42000);
  const isLfmSmall = /lfm-2\.5-2\.6b/i.test(r.model_id);
  const codeBonus = mode === "code"
    ? (r.is_coding_specialist ? 0.085 : isLfmSmall ? -0.25 : 0)
    : 0;
  const reasoningBonus = mode === "reasoning" && r.supports_reasoning ? 0.095 : 0;
  const thompsonBonus = (reliabilityDraw - 0.5) * 0.12;
  // Compounding tool intelligence: a Thompson draw over this tuple's own
  // tool-call posterior (0 with no evidence, so exploration still wins there).
  const toolBonus = toolAware ? toolRoutingBonus(r, { deterministic, now }) : 0;
  // ASCK-L: the contextual (tuple, task class) posterior, shrunk toward this
  // tuple's global posterior — the router learns which tuple is best *for
  // this kind of task*, not just which tuple answers at all.
  let learningBonus = 0;
  let learningMean: number | undefined;
  let learningPulls: number | undefined;
  if (learning) {
    const ctxPost = contextualPosterior(r, learning.taskClass, learning.tenant, now);
    const draw = deterministic ? posteriorLowerBound(ctxPost.alpha, ctxPost.beta) : sampleBeta(ctxPost.alpha, ctxPost.beta);
    learningBonus = (draw - 0.5) * 0.10;
    learningMean = Number(ctxPost.mean.toFixed(4));
    learningPulls = ctxPost.pulls;
  }
  const smartScore = Number(
    (iqEffective + codeBonus + reasoningBonus + thompsonBonus + toolBonus + learningBonus + exploration + plackettLuce - latencyPenalty)
      .toFixed(4),
  );

  return {
    tupleId: r.tuple_id,
    providerId: r.provider_id,
    modelId: r.model_id,
    iqEffective,
    supportsReasoning: Boolean(r.supports_reasoning),
    supportsVision: Boolean(r.supports_vision),
    isCodingSpecialist: Boolean(r.is_coding_specialist),
    contextWindow: Number(r.context_window || 128000),
    reliabilityDraw: Number(reliabilityDraw.toFixed(3)),
    ewmaTtftMs: Math.round(ewmaTtftMs),
    ewmaTps: Number(ewmaTps.toFixed(1)),
    logTtftMu,
    logTtftSigma,
    expectedFastMs,
    smartScore,
    toolCompetence: toolAware || (r.tool_pulls ?? 0) > 0 ? tupleToolCompetence(r, now) : 0,
    toolPulls: r.tool_pulls ?? 0,
    ...(learningMean !== undefined ? { learningMean, learningPulls } : {}),
  };
}





export function totalCatalogPulls(catalog: Map<string, MeshModelRecord>): number {
  let n = 0;
  for (const r of catalog.values()) n += Math.max(1, r.success_count + r.failure_streak);
  return n;
}
```

// engine/providers.ts — excerpt, lines 434-475 and 516-557.
// getRankedCandidates is the one function the handler calls to ask "who could
// answer this"; allSweepCandidates is the tier-4 pool that ignores the catalog
// and hits every configured endpoint.

engine/providers.ts
```ts
export async function getRankedCandidates(
  mode: RoutingMode,
  deterministic = false,
  requireVision = false,
  opts: RankOptions = {},
): Promise<ScoredCandidate[]> {
  // Hydrate first: a cold isolate whose catalog already lives in KV must not await a full provider sweep.
  const catalog = await hydrateL1Cache(false);
  await ensureCatalogSynced(false);
  const now = Date.now();

  const activeProviderIds = new Set((await activeProviderList()).map((p) => p.id));

  if (!opts.includeCoolingDown && !opts.unrestricted) {
    for (const [pid, state] of PROVIDER_BREAKER) {
      if (state.openUntil > now) activeProviderIds.delete(pid);
    }
  }
  const totalPulls = totalCatalogPulls(catalog);
  if (opts.taskClass) await hydrateLearning().catch((e) => console.error("learning hydrate:", e));
  const learning = opts.taskClass ? { taskClass: opts.taskClass, tenant: opts.tenant ?? "global" } : undefined;

  const candidates: ScoredCandidate[] = [];
  for (const r of catalog.values()) {
    if (!activeProviderIds.has(r.provider_id)) continue;
    if (!opts.includeCoolingDown && !opts.unrestricted && r.cooldown_until > now) continue;
    if (opts.verifiedOnly && !opts.unrestricted && r.success_count <= 0) continue;
    if (requireVision && !opts.unrestricted && !r.supports_vision) continue;
    candidates.push(scoreRecord(r, mode, deterministic, totalPulls, now, opts.toolAware ?? false, learning));
  }

  if (mode === "fast" && !opts.unrestricted && !opts.toolAware) {
    return interleaveByProvider(
      candidates
        .filter((c) => c.iqEffective >= 0.50)
        .sort((a, b) => a.expectedFastMs - b.expectedFastMs),
    );
  }

  return interleaveByProvider(candidates.sort((a, b) => b.smartScore - a.smartScore));
}


// … lines 476-515 omitted: the synthetic-record helper …

export async function allSweepCandidates(mode: RoutingMode): Promise<ScoredCandidate[]> {
  const now = Date.now();
  let catalog = new Map<string, MeshModelRecord>();
  try {
    catalog = await hydrateL1Cache(false);
  } catch (err) {
    console.error("sweep catalog hydrate failed:", err);
  }
  let providers: ProviderSpec[];
  try {
    providers = await activeProviderList();
  } catch (err) {
    console.error("sweep provider list failed:", err);
    providers = PROVIDERS.filter((p) => p.isConfigured());
  }
  const ids = new Set(providers.map((p) => p.id));
  const hints = await providerModelHints();
  const perProvider = Math.round(clampNum(
    Number(Deno.env.get("MESH_SWEEP_MODELS_PER_ENDPOINT")) || 3, 1, 12,
  ));
  const totalPulls = Math.max(1, totalCatalogPulls(catalog));
  const buckets = new Map<string, ScoredCandidate[]>();

  for (const r of catalog.values()) {
    if (!ids.has(r.provider_id)) continue;
    const bucket = buckets.get(r.provider_id) ?? [];
    bucket.push(scoreRecord(r, mode, true, totalPulls, now));
    buckets.set(r.provider_id, bucket);
  }
  for (const p of providers) {
    const bucket = buckets.get(p.id) ?? [];
    for (const model of hints.get(p.id) ?? [UNIVERSAL_MODEL_ALIAS]) {
      const tupleId = `${p.id}::${model}`;
      if (bucket.some((c) => c.tupleId === tupleId)) continue;
      bucket.push(scoreRecord(syntheticRecord(p.id, model), mode, true, totalPulls, now));
    }
    bucket.sort((a, b) => b.smartScore - a.smartScore);
    buckets.set(p.id, bucket.slice(0, perProvider));
  }
  return interleaveByProvider([...buckets.values()].flat());
}
```

// routes/chat-dispatch.ts — hedged dispatch and tool rounds, whole file (590 lines).
// The HedgePolicy vocabulary and its four tiers (HEDGE, ESCALATION_POLICY,
// WIDE_POLICY, SWEEP_POLICY), hedgedDispatch (first-token race, staggered
// hedges, p99.9 kill), executeOwnedToolCalls (the host runs the model's calls),
// gradeToolCalls / learnToolVerdict / toolVerdictLessons (grading back into
// ASCK-T), and the degraded renderer.

routes/chat-dispatch.ts
```ts
// routes/chat-dispatch.ts — Hedge/dispatch and tool-round machinery extracted
// from routes/chat.ts: adaptive hedged first-token dispatch (ASCK), owned
// tool-call execution and grading, and the degraded-answer path.
// (Verbatim code motion from chat.ts — no behavior change.)

import { parseToolArguments, partitionToolCalls, executeToolCalls, toolResultContent, normalizeToolCalls, listTools, observeTupleToolStats, isStatefulTool, skillSummary } from "../tools.ts";
import type { ToolCaps, ToolExecution } from "../tools.ts";
import type { Span } from "../trace.ts";
import { hedgePlan } from "../math.ts";
import type { Context } from "hono";
import { hydrateToolSkills } from "../main.ts";
import type { ScoredCandidate, Json, RoutingMode, UpstreamStream, CompletionOptions } from "../main.ts";
import { TOOL_SKILLS, SSE_HEADERS } from "../state.ts";
import { logErr, errText, traceAttrs } from "../util.ts";
import { recordTupleFailure, writeLesson } from "../engine/learning.ts";
import { failureSignature } from "../learning.ts";
import { resolveProviderById } from "../engine/providers.ts";
import { recordToolExecution } from "../engine/dispatch.ts";
import { atomicUpdateModelOrCreate } from "../engine/core.ts";
import { modelSeedFor } from "../engine/learning.ts";

// ============================================================================
// 7b. ADAPTIVE HEDGED FIRST-TOKEN DISPATCH (ASCK v1 / TAIL-AT-SCALE)
// ============================================================================

// TTFT is modelled log-normal with a Kalman posterior mean/variance. hedgePlan()
// solves the survival-based stopping rule: with k spare endpoints, hedge at the
// (1 - θ0^(1/(1+η·ln(1+k)))) quantile; kill at the p99.9 predictive quantile.
// Tiers 1-3 are staggered hedges; tier 4 (exhaustive sweep) bursts every
// configured endpoint at once with a short, bounded first-token deadline.
export interface HedgePolicy {
  maxInflight: number;
  tailProbability: number;
  hedgeMinMs: number;
  hedgeMaxMs: number;
  killFloorMs: number;
  killCeilMs: number;
  burst: boolean;
}



export const HEDGE: Record<RoutingMode, HedgePolicy> = {
  fast: { maxInflight: 4, tailProbability: 0.20, hedgeMinMs: 120, hedgeMaxMs: 8_000, killFloorMs: 4_000, killCeilMs: 300_000, burst: false },
  code: { maxInflight: 3, tailProbability: 0.10, hedgeMinMs: 150, hedgeMaxMs: 8_000, killFloorMs: 25_000, killCeilMs: 300_000, burst: false },
  smart: { maxInflight: 3, tailProbability: 0.10, hedgeMinMs: 150, hedgeMaxMs: 8_000, killFloorMs: 25_000, killCeilMs: 300_000, burst: false },
  reasoning: { maxInflight: 3, tailProbability: 0.05, hedgeMinMs: 200, hedgeMaxMs: 8_000, killFloorMs: 90_000, killCeilMs: 300_000, burst: false },
};



// Tier 2: widen across lanes with more concurrency and a tighter deadline.
export const ESCALATION_POLICY: HedgePolicy = {
  maxInflight: 6,
  tailProbability: 0.25,
  hedgeMinMs: 120,
  hedgeMaxMs: 3_000,
  killFloorMs: 10_000,
  killCeilMs: 30_000,
  burst: false,
};



// Tier 3: burst the whole catalog with a hard, short first-token deadline.
export const WIDE_POLICY: HedgePolicy = {
  maxInflight: 32,
  tailProbability: 0.35,
  hedgeMinMs: 100,
  hedgeMaxMs: 1_500,
  killFloorMs: 8_000,
  killCeilMs: 20_000,
  burst: true,
};



// Tier 4: every configured endpoint at once; bounded so an outage resolves
// into a graceful degraded answer in seconds, not minutes.
export const SWEEP_POLICY: HedgePolicy = {
  maxInflight: 128,
  tailProbability: 0.45,
  hedgeMinMs: 60,
  hedgeMaxMs: 1_000,
  killFloorMs: 6_000,
  killCeilMs: 15_000,
  burst: true,
};



/** Portable AbortSignal.any: a tier can be cut without killing the request. */
export function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  a.addEventListener("abort", () => ctrl.abort(a.reason), { once: true });
  b.addEventListener("abort", () => ctrl.abort(b.reason), { once: true });
  return ctrl.signal;
}



export interface Dispatched {
  cand: ScoredCandidate;
  up: UpstreamStream;
}



export async function hedgedDispatch(
  order: ScoredCandidate[],
  mode: RoutingMode,
  messages: Array<{ role: string; content: unknown }>,
  options: CompletionOptions,
  master: AbortSignal,
  tried: Set<string>,
  maxAttempts: number,
  span: Span,
  policyOverride?: HedgePolicy,
): Promise<Dispatched> {
  const policy = policyOverride ?? HEDGE[mode];
  const pending = order.filter((c) => !tried.has(c.tupleId)).slice(0, maxAttempts);
  // One in-flight attempt per provider: forces provider diversity and avoids self-inflicted 429s.
  const busy = new Set<string>();
  const live = new Set<AbortController>();
  let lastErr: unknown = null;
  let settled = false;
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  let hedgeDelayMs = policy.hedgeMinMs;

  return await new Promise<Dispatched>((resolve, reject) => {
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      for (const ctrl of live) ctrl.abort(new Error("HEDGE_LOST"));
      reject(e);
    };
    master.addEventListener("abort", () => fail(master.reason), { once: true });

    const start = (cand: ScoredCandidate) => {
      tried.add(cand.tupleId);
      const ctrl = new AbortController();
      const onMaster = () => ctrl.abort(master.reason);
      master.addEventListener("abort", onMaster, { once: true });
      live.add(ctrl);
      busy.add(cand.providerId);

      const plan = hedgePlan({
        mu: cand.logTtftMu,
        sigma: cand.logTtftSigma,
        tailProbability: policy.tailProbability,
        alternatives: pending.length,
        minMs: policy.hedgeMinMs,
        maxMs: policy.hedgeMaxMs,
        killFloorMs: policy.killFloorMs,
        killCeilMs: policy.killCeilMs,
      });
      // Waiting past the best pending alternative's median TTFT is dominated: hedge then.
      let altMedianMs = Number.POSITIVE_INFINITY;
      for (const p of pending) {
        const median = Math.exp(p.logTtftMu);
        if (median < altMedianMs) altMedianMs = median;
      }
      hedgeDelayMs = Math.max(policy.hedgeMinMs, Math.min(plan.hedgeMs, altMedianMs));
      const killMs = plan.killMs;
      const killer = setTimeout(() => ctrl.abort(new Error(`TIMEOUT_FIRST_TOKEN: ${killMs}ms`)), killMs);
      const attempt = span.child("attempt", {
        tuple: cand.tupleId,
        provider: cand.providerId,
        model: cand.modelId,
        hedge_ms: Math.round(hedgeDelayMs),
        kill_ms: Math.round(killMs),
        p50_ms: Math.round(Math.exp(cand.logTtftMu)),
        reliability: cand.reliabilityDraw,
      });

      attempt.run(() =>
        resolveProviderById(cand.providerId).then((p) => {
          if (!p || !p.isConfigured()) throw new Error(`Provider missing or unconfigured: ${cand.providerId}`);
          return p.executeCompletion(cand.modelId, messages, ctrl.signal, options);
        })
      )
        .then((up) => {
          clearTimeout(killer);
          if (settled) {
            attempt.end("unset", { outcome: "late", ttft_ms: up.ttftMs });
            ctrl.abort(new Error("HEDGE_LOST"));
            master.removeEventListener("abort", onMaster);
            return;
          }
          settled = true;
          attempt.end("ok", { outcome: "won", ttft_ms: up.ttftMs });
          clearTimeout(hedgeTimer);
          for (const other of live) if (other !== ctrl) other.abort(new Error("HEDGE_LOST"));
          resolve({ cand, up });
        }, (err) => {
          clearTimeout(killer);
          master.removeEventListener("abort", onMaster);
          live.delete(ctrl);
          busy.delete(cand.providerId);
          if (settled || master.aborted) {
            attempt.end("unset", { outcome: "cancelled" });
            return;
          }
          lastErr = ctrl.signal.aborted ? ctrl.signal.reason : err;
          attempt.end("error", {
            outcome: /TIMEOUT/.test(errText(lastErr)) ? "timeout" : "failed",
            error: errText(lastErr).slice(0, 200),
          });
          recordTupleFailure(cand.tupleId, errText(lastErr)).catch(logErr);
          launch();
        });
    };

    const launch = () => {
      clearTimeout(hedgeTimer);
      if (settled) return;
      // Burst mode fills the whole pipeline immediately: every configured
      // endpoint is attempted rather than only the head of the ranking.
      const target = policy.burst
        ? policy.maxInflight
        : (live.size < policy.maxInflight ? live.size + 1 : live.size);
      while (live.size < target) {
        const i = pending.findIndex((c) => !busy.has(c.providerId));
        if (i < 0) break;
        start(pending.splice(i, 1)[0]);
      }
      if (live.size === 0) return fail(lastErr ?? new Error("No candidate produced a valid first token"));
      if (pending.length > 0) hedgeTimer = setTimeout(launch, hedgeDelayMs);
    };

    launch();
  });
}



/** Look up a client-declared tool's schema so its arguments can be graded. */
export function declaredToolSchema(declared: unknown[], name: string): unknown {
  for (const entry of declared ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const holder = entry as Json;
    const fn = (holder.function ?? holder) as Json;
    if (typeof fn.name !== "string") continue;
    if (fn.name === name || fn.name.toLowerCase() === name.toLowerCase()) {
      return fn.parameters ?? fn.input_schema ?? true;
    }
  }
  return undefined;
}



// ---------------------------------------------------------------------------
// AGENT LOOP PLUMBING
// ---------------------------------------------------------------------------

export interface ToolRoundOutcome {
  /** True when the router owned every call and executed them itself. */
  loop: boolean;
  /** `role:"tool"` messages to append, one per executed call, in call order. */
  messages: Array<{ role: string; content: unknown } & Json>;
  executed: Array<{ id: string; name: string; ok: boolean; ms: number; repaired: boolean; error?: string; code?: string }>;
}



/** Execute a completion's tool calls when — and only when — the plane owns all
 *  of them. Client-declared tools are handed straight back to the caller. */
// ---------------------------------------------------------------------------
// Per-request call guard: identical-call memory for one agent request, keyed
// by the request's AbortSignal (WeakMap — the state dies with the request).
// Three rules make the loop smarter without changing any tool's contract:
//  1. An exact repeat of a call that already FAILED, with no successful
//     stateful call since (the world has not changed), is not executed again
//     — the model gets an escalated REPEATED_CALL error instead of burning a
//     round on a guaranteed-identical failure.
//  2. An exact repeat of a SUCCESSFUL call to a tool declared `deterministic`
//     replays the first result, until a stateful call succeeds and may have
//     changed the world. Replays never double-count skill telemetry.
//  3. Identical calls inside one round execute once; the twins share the
//     outcome. And the third failure of the same tool in one request appends
//     a router note carrying that tool's measured historical failure mode.
// ---------------------------------------------------------------------------

interface GuardEntry { ok: boolean; world: number; content?: string; error?: string; code?: string }
interface CallGuard { world: number; seen: Map<string, GuardEntry>; toolFailures: Map<string, number> }
const CALL_GUARDS = new WeakMap<object, CallGuard>();

function guardFor(signal?: AbortSignal): CallGuard {
  if (!signal) return { world: 0, seen: new Map(), toolFailures: new Map() };
  let g = CALL_GUARDS.get(signal);
  if (!g) { g = { world: 0, seen: new Map(), toolFailures: new Map() }; CALL_GUARDS.set(signal, g); }
  return g;
}

function stableArgsKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableArgsKey).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableArgsKey(obj[k])}`).join(",")}}`;
}

/** Canonical per-call key: JSON argument strings are parsed first, so the
 *  same call emitted with different key order still keys identically. */
function callKeyFor(name: string, args: unknown): string {
  let a = args;
  if (typeof args === "string") { try { a = JSON.parse(args); } catch { /* keep the raw string */ } }
  return `${name}\n${stableArgsKey(a)}`;
}

export async function executeOwnedToolCalls(
  calls: unknown[],
  opts: { span?: Span; admin?: boolean; signal?: AbortSignal; now?: number; clientNames?: string[]; caps?: ToolCaps } = {},
): Promise<ToolRoundOutcome> {
  const { mine } = partitionToolCalls(calls, { clientNames: opts.clientNames });
  if (mine.length === 0) return { loop: false, messages: [], executed: [] };

  const guard = guardFor(opts.signal);
  const skills = await hydrateToolSkills().catch(() => TOOL_SKILLS);
  const locals: Json = { tool_skills: Object.fromEntries([...skills.entries()]) as Json };
  const specs = new Map(listTools().map((t) => [t.name, t]));

  type NormCall = (typeof mine)[number];
  type Plan =
    | { kind: "run"; call: NormCall }
    | { kind: "replay"; call: NormCall; content: string }
    | { kind: "blocked"; call: NormCall; entry: GuardEntry }
    | { kind: "twin"; call: NormCall; of: string };
  const plans: Plan[] = [];
  const toRun: NormCall[] = [];
  const roundKeys = new Map<string, string>();
  for (const call of mine) {
    const name = call.resolved ?? call.name;
    const key = callKeyFor(name, call.arguments);
    const twinOf = roundKeys.get(key);
    if (twinOf !== undefined) { plans.push({ kind: "twin", call, of: twinOf }); continue; }
    const prev = guard.seen.get(key);
    if (prev && prev.world === guard.world) {
      if (!prev.ok) { plans.push({ kind: "blocked", call, entry: prev }); continue; }
      if (specs.get(name)?.deterministic && prev.content !== undefined) { plans.push({ kind: "replay", call, content: prev.content }); continue; }
    }
    roundKeys.set(key, call.id);
    plans.push({ kind: "run", call });
    toRun.push(call);
  }

  const results = toRun.length > 0
    ? await executeToolCalls(
      toRun.map((call) => ({ id: call.id, name: call.resolved ?? call.name, arguments: call.arguments })),
      {
        admin: opts.admin ?? false,
        caps: opts.caps,
        locals,
        signal: opts.signal,
        now: opts.now,
        event: (name, attrs) => opts.span?.event(name, traceAttrs(attrs ?? {})),
      },
    )
    : [];
  const byId = new Map(results.map((r) => [r.id, r]));

  const messages: Array<{ role: string; content: unknown } & Json> = [];
  const executed: ToolRoundOutcome["executed"] = [];
  const contentById = new Map<string, string>();
  for (const plan of plans) {
    const call = plan.call;
    const name = call.resolved ?? call.name;
    if (plan.kind === "replay") {
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: plan.content });
      contentById.set(call.id, plan.content);
      executed.push({ id: call.id, name, ok: true, ms: 0, repaired: false });
      continue;
    }
    if (plan.kind === "blocked") {
      const content = JSON.stringify({
        error: `This exact ${name} call already failed in this request (${plan.entry.code ?? "error"}: ${plan.entry.error ?? "unknown error"}). Nothing has changed since, so running it again would fail identically. Change the arguments, fix the cause first, or use a different approach.`,
        code: "REPEATED_CALL",
      });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
      contentById.set(call.id, content);
      executed.push({ id: call.id, name, ok: false, ms: 0, repaired: false, error: "identical call already failed in this request", code: "REPEATED_CALL" });
      continue;
    }
    if (plan.kind === "twin") {
      const content = contentById.get(plan.of) ?? JSON.stringify({ error: "tool execution was skipped" });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
      const src = executed.find((e) => e.id === plan.of);
      executed.push({ id: call.id, name, ok: src?.ok ?? false, ms: 0, repaired: src?.repaired ?? false, ...(src && !src.ok ? { error: src.error, code: src.code } : {}) });
      continue;
    }
    const result = byId.get(call.id);
    const execution: ToolExecution | undefined = result?.execution;
    let content = execution ? toolResultContent(execution) : JSON.stringify({ error: "tool execution was skipped" });
    if (execution) {
      const key = callKeyFor(name, call.arguments);
      if (execution.ok) {
        guard.seen.set(key, { ok: true, world: guard.world, content });
        if (isStatefulTool(name)) guard.world++; // the world may have changed: cached entries go stale
      } else {
        guard.seen.set(key, { ok: false, world: guard.world, error: execution.error.slice(0, 200), code: execution.code });
        const fails = (guard.toolFailures.get(name) ?? 0) + 1;
        guard.toolFailures.set(name, fails);
        if (fails === 3) {
          const rec = skills.get(name);
          const summary = rec ? skillSummary(rec, Date.now()) : null;
          const top = summary?.top_errors?.[0];
          content += `\n[router] ${name} has failed 3 times in this request.${top ? ` Its most common measured failure is ${top.code} (×${top.count})${summary?.last_error ? ` — last: ${summary.last_error.slice(0, 120)}` : ""}.` : ""} Stop retrying the same approach: change the arguments materially, pick a different tool, or state the blocker.`;
        }
      }
      executed.push({
        id: call.id,
        name: execution.tool ?? call.name,
        ok: execution.ok,
        ms: execution.ms,
        repaired: execution.repaired ?? false,
        ...(execution.ok ? {} : { error: execution.error.slice(0, 200), code: execution.code }),
      });
      // Skill memory compounds in the background; a KV hiccup never fails a request.
      recordToolExecution(execution.tool ?? call.name, execution).catch(logErr);
    }
    messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
    contentById.set(call.id, content);
  }
  return { loop: true, messages, executed };
}



export interface ToolCallVerdict {
  /** Nothing to learn: no tool calls and no forced tool choice. */
  neutral: boolean;
  valid: boolean;
  repaired: boolean;
  calls: number;
  problems: string[];
}



/**
 * Grade a completion's tool calls against the tools that were declared for it.
 * A call is valid when it names a declared tool and its arguments survive the
 * repair ladder and validate against that tool's schema. This verdict is what
 * the tuple's tool posterior learns from, so it is deliberately strict about
 * hallucinated names and lenient about wire-format damage.
 */
export function gradeToolCalls(
  calls: unknown[],
  declared: unknown[],
  toolChoice: unknown,
): ToolCallVerdict {
  const forced = toolChoice === "required" || toolChoice === "any" ||
    (toolChoice && typeof toolChoice === "object" && typeof (toolChoice as Json).type === "string");
  const normalized = normalizeToolCalls(calls);
  if (normalized.length === 0) {
    return forced
      ? { neutral: false, valid: false, repaired: false, calls: 0, problems: ["tool_choice required a call but none was produced"] }
      : { neutral: true, valid: false, repaired: false, calls: 0, problems: [] };
  }
  const problems: string[] = [];
  let repaired = false;
  for (const call of normalized) {
    // The caller's own declaration wins: a client tool that shadows a built-in
    // is graded against the client's schema, never the registry's.
    const declaredSchema = declaredToolSchema(declared, call.name) ??
      (call.resolved ? declaredToolSchema(declared, call.resolved) : undefined);
    const builtin = call.builtin ? listTools().find((t) => t.name === call.resolved) : undefined;
    const schema = declaredSchema ?? builtin?.parameters;
    if (schema === undefined) {
      problems.push(`${call.name}: not a declared tool`);
      continue;
    }
    const parsed = parseToolArguments(call.arguments, schema, { coerce: true });
    if (parsed.repaired) repaired = true;
    if (!parsed.ok) problems.push(`${call.name}: ${parsed.error ?? "invalid arguments"}`.slice(0, 200));
  }
  return { neutral: false, valid: problems.length === 0, repaired, calls: normalized.length, problems };
}



/** Fold a verdict into the tuple's stored tool posterior (CAS, best effort). */
export async function learnToolVerdict(tupleId: string, verdict: ToolCallVerdict): Promise<void> {
  if (verdict.neutral) return;
  const now = Date.now();
  try {
    await atomicUpdateModelOrCreate(tupleId, modelSeedFor(tupleId), (r) => ({
      ...r,
      ...observeTupleToolStats(r, { valid: verdict.valid, repaired: verdict.repaired }, now),
    }));
  } catch (err) {
    console.error("[tools] tuple competence update failed:", err);
  }
}

/** Turn an invalid tool verdict into learning-loop lessons. The correction
 *  texts for these signatures have existed in the lesson table since the
 *  loop was built, but nothing ever wrote them — so the lesson injector
 *  could never surface tool discipline. Now a model that invents a tool or
 *  mangles a schema teaches the class-level lesson the injector already
 *  knows how to deliver. Fire-and-forget, like every learning write. */
export function toolVerdictLessons(verdict: ToolCallVerdict, taskClass: Parameters<typeof writeLesson>[0]): void {
  if (verdict.neutral || verdict.valid) return;
  const sigs = new Set<string>();
  for (const p of verdict.problems.slice(0, 3)) {
    sigs.add(p.includes("not a declared tool")
      ? failureSignature("tool_not_declared")
      : failureSignature("tool_invalid_schema"));
  }
  for (const sig of sigs) writeLesson(taskClass, sig).catch(logErr);
}



export function degradationMessage(attempts: number, endpoints: number, lastErr: string): string {
  const tail = lastErr ? ` Last upstream error: ${lastErr.slice(0, 160)}.` : "";
  return `[kono-router] No upstream model endpoint returned a valid completion for this request. ` +
    `All ${endpoints} configured endpoints were attempted (${attempts} dispatch attempts, including ` +
    `cross-lane fallbacks, protocol negotiation and a full endpoint sweep).${tail} ` +
    `No answer was fabricated — please retry shortly. GET /health and GET /v1/endpoints show live coverage.`;
}



export interface DegradedOpts {
  id: string;
  created: number;
  requestedModel: string;
  attempts: number;
  endpoints: number;
  lastErr: string;
  stream: boolean;
  traceId: string;
}



export function degradedMeta(o: DegradedOpts) {
  return {
    degraded: true,
    endpoints_available: o.endpoints,
    endpoints_attempted: o.attempts,
    attempts: o.attempts,
    requested_model: o.requestedModel,
    reason: "all_upstreams_failed",
    trace_id: o.traceId,
  };
}



/** The degraded answer as SSE frames; also emitted in-band once a stream's headers are out. */
export function degradedSse(o: DegradedOpts): string {
  const meta = degradedMeta(o);
  const frame = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: o.id,
      object: "chat.completion.chunk",
      created: o.created,
      model: o.requestedModel,
      provider: "kono-router",
      kono: meta,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return frame({ role: "assistant" }, null) +
    frame({ content: degradationMessage(o.attempts, o.endpoints, o.lastErr) }, null) +
    frame({}, "stop") +
    "data: [DONE]\n\n";
}



export function degradedCompletion(c: Context, o: DegradedOpts, headers: Record<string, string>): Response {
  if (o.stream) return new Response(degradedSse(o), { status: 200, headers: { ...SSE_HEADERS, ...headers, "X-Kono-Degraded": "1" } });
  return c.json({
    id: o.id,
    object: "chat.completion",
    created: o.created,
    model: o.requestedModel,
    provider: "kono-router",
    kono: degradedMeta(o),
    choices: [{
      index: 0,
      message: { role: "assistant", content: degradationMessage(o.attempts, o.endpoints, o.lastErr) },
      finish_reason: "stop",
    }],
  }, 200, { ...headers, "X-Kono-Degraded": "1" });
}
```

// routes/chat.ts — POST /v1/chat/completions, whole file (1,141 lines).
// This is the host side as it exists: one function from line 106 to 1140.
// Intake and legacy aliasing -> tool plane selection -> ASCK-L task context,
// strategy arm and lesson injection -> prompt assembly (variant, lessons,
// workspace brief, tool preamble) -> ranking with model-agnostic reordering ->
// four-tier dispatch with per-tier budgets and bench resets -> owned tool
// rounds -> build gate and verifiers -> SSE commit / keepalive / finalisation.
// It is included whole because there is no seam to cut without losing the
// control flow that the re-cut is arguing about.

routes/chat.ts
```ts
// routes/chat.ts — Chat route registrations extracted from main.ts.
// main.ts calls registerChat() at the position of this area's first route, preserving registration order.
// Learning-loop glue lives in ./chat-learning.ts; hedge/dispatch and tool-round
// machinery lives in ./chat-dispatch.ts (both extracted verbatim).

import { classifyTask, DEFAULT_STRATEGY_ARMS, armsForClass, emptyCell, effectivePosterior, chooseThompson, PROMPT_VARIANTS, rankLessons, decideCompute, failureSignature } from "../learning.ts";
import type { RewardSignal, BanditCandidate } from "../learning.ts";
import { resolveAutoToolNames, autoToolsForClass, mergeToolDeclarations, toToolSpecs, toolPreamble } from "../tools.ts";
import { startTrace } from "../trace.ts";
import { clamp as clampNum, modelSimilarity } from "../math.ts";
import { workspaceBrief, workspaceSigFor } from "../toolbox/project.ts";
import { buildGate } from "../toolbox/testing.ts";
import type { GateVerdict } from "../toolbox/testing.ts";
import { hydrateLearning, hydrateForgedTools, learningKappa } from "../main.ts";
import type { ScoredCandidate, Json, RoutingMode, CompletionOptions, RankOptions, CompletionResult, ToolCallDelta, Delta } from "../main.ts";
import { ARM_CELLS, kv, L1_CACHE, SSE_HEADERS, honoApp, LESSONS } from "../state.ts";
import { logErr, errText, toolPlaneEnabled, maxToolRounds, toolNamespace, armCellKey, extractMessageText, classifyPromptIntent, strictErrors, mergeToolCalls } from "../util.ts";
import { contextualPosterior, recordTupleFailure, recordTupleSuccess, writeLesson, resetBenchedEndpoints } from "../engine/learning.ts";
import { activeProviderList, PROVIDERS, getRankedCandidates, allSweepCandidates } from "../engine/providers.ts";
import { normalizeMessages, isAdminContext, toolCaps, collectUpstream } from "../engine/dispatch.ts";
import { loadStrategyArms, armGlobalPosterior, finalizeLearning, verifyMathAnswer, verifyJsonAnswer } from "./chat-learning.ts";
import type { LearnCtx } from "./chat-learning.ts";
import { ESCALATION_POLICY, WIDE_POLICY, SWEEP_POLICY, combineSignals, hedgedDispatch, executeOwnedToolCalls, gradeToolCalls, learnToolVerdict, toolVerdictLessons, degradedSse, degradedCompletion } from "./chat-dispatch.ts";
import type { HedgePolicy, Dispatched, ToolCallVerdict, DegradedOpts } from "./chat-dispatch.ts";
export type { ToolRoundOutcome, ToolCallVerdict } from "./chat-dispatch.ts";

// Comment frames keep proxies and clients alive while the race is still routing.
export const HEARTBEAT_MS = 5_000;


// Longest a response may go without sending a byte. Edge proxies and idle-bounded
// clients drop silent connections; this keeps slow generations and long tool
// rounds alive end to end.
export const idleMs = () => clampNum(Number((Deno.env.get("KONO_IDLE_MS") ?? Deno.env.get("NOKEY_IDLE_MS"))) || 15_000, 50, 60_000);



/** Interleave `: keepalive` SSE comments whenever `src` stays silent for `idle` ms. */
export async function* keepalive(src: AsyncGenerator<string>, idle: number): AsyncGenerator<string> {
  let next = src.next();
  try {
    for (;;) {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([next, new Promise<null>((res) => quiet = setTimeout(() => res(null), idle))]);
      clearTimeout(quiet);
      if (r === null) {
        yield ": keepalive\n\n";
        continue;
      }
      if (r.done) return;
      next = src.next();
      yield r.value;
    }
  } finally {
    // Client gone: let the source run its own cleanup without blocking on a pending read.
    src.return(undefined).catch(() => {});
  }
}



/** A buffered response that is still unfinished after the idle window commits its
 *  200 and sends whitespace (valid before any JSON value) until the body is ready.
 *  A failure inside the window rethrows to the caller's normal error handling;
 *  after it, `onError` supplies the body. */
export async function idleBuffered(pending: Promise<Response>, onError: (e: unknown) => Promise<Response>, headers: Record<string, string>): Promise<Response> {
  const settled = pending.then((v) => ({ v }), (e: unknown) => ({ e }));
  const idle = idleMs();
  let hold: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([settled, new Promise<undefined>((res) => hold = setTimeout(() => res(undefined), idle))]);
  clearTimeout(hold);
  if (early) {
    if ("v" in early) return early.v;
    throw early.e;
  }
  const enc = new TextEncoder();
  let tick: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (s: string) => {
        try {
          ctrl.enqueue(enc.encode(s));
        } catch { /* client gone */ }
      };
      send(" ");
      tick = setInterval(() => send(" "), idle);
      settled
        .then((r) => ("v" in r ? r.v : onError(r.e)))
        .then((res) => res.text(), (e: unknown) => JSON.stringify({ error: { message: errText(e) } }))
        .then((text) => {
          clearInterval(tick);
          send(text);
          try {
            ctrl.close();
          } catch { /* client gone */ }
        });
    },
    cancel: () => clearInterval(tick),
  });
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", ...headers } });
}

export function registerChat() {


honoApp.post("/v1/chat/completions", async (c) => {
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const tried = new Set<string>();
  const root = startTrace("chat.completions", {}, c.req.header("traceparent"));
  const traceHeaders = { traceparent: root.traceparent };
  let reqModel = "free:auto";
  let wantsStream = false;
  let endpointsAvailable = 0;
  let lastErr: unknown = null;
  let globalTimeout: ReturnType<typeof setTimeout> | undefined;

  const degradedOpts = (err: unknown): DegradedOpts => ({
    id: completionId,
    created,
    requestedModel: reqModel,
    attempts: tried.size,
    endpoints: endpointsAvailable,
    lastErr: errText(err),
    stream: wantsStream,
    traceId: root.traceId,
  });
  const endDegraded = (err: unknown) => {
    console.error(`[chat] exhausted all tiers (${tried.size} attempts across ${endpointsAvailable} endpoints):`, errText(err));
    root.end("error", { degraded: true, attempts: tried.size, error: errText(err).slice(0, 300) });
  };

  try {
    // Never 400 on a malformed body: normalise it and keep routing.
    const body = await c.req.json().catch(() => ({} as Json)) as Json;
    // Rebrand compat: pre-rename clients send nokey_* fields. Alias them onto
    // the kono_* names so existing integrations keep working unchanged.
    for (const k of ["tools", "rounds", "builder", "gate", "gate_rounds", "runner", "tests", "preamble"]) {
      const legacy = `nokey_${k}`;
      if (body[`kono_${k}`] === undefined && body[legacy] !== undefined) body[`kono_${k}`] = body[legacy];
    }
    root.io("request", body);
    const messages = normalizeMessages(body.messages, body.prompt);
    reqModel = String(body.model || "free:auto");
    const reqModelLower = reqModel.toLowerCase();
    wantsStream = Boolean(body.stream);

    // ---- Tool Plane: what this request may call ---------------------------
    // A client can bring its own tools, ask the router for its built-ins
    // ("tools": "auto" | "kono_tools" | header x-kono-tools), or both. Built-ins
    // are appended, never substituted: a client tool that shadows a built-in name
    // always wins, so the plane cannot hijack a caller's own API.
    const clientTools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
    // App Builder profile (kono_builder): deterministic, quality-first
    // routing — no strategy-arm lottery, no sampled ranking, sticky winner,
    // gate always on. Each behavior is flagged at its site below.
    const builder = body.kono_builder === true;
    let autoRequest = body.tools === "auto" || body.tools === true
      ? "auto"
      : body.kono_tools ?? c.req.header("x-kono-tools") ?? c.req.header("x-nokey-tools") ?? undefined;
    // A builder request implies the router's tool plane when the client did
    // not declare tools of its own: the build gate and the fs_* discipline in
    // the preamble are part of the profile. Explicit client tools win.
    if (builder && autoRequest === undefined && clientTools.length === 0) autoRequest = "auto";
    if (toolPlaneEnabled()) await hydrateForgedTools().catch(logErr);
    // Sub-agents (x-kono-depth ≥ 1) get every tool but agent_team: teams do not nest.
    let autoTools = toolPlaneEnabled() ? resolveAutoToolNames(autoRequest)?.filter((n) => n !== "agent_team" || !(Number(c.req.header("x-kono-depth") ?? c.req.header("x-nokey-depth") ?? 0) >= 1)) ?? null : null;
    // Intent-shaped exposure: a bare "auto" request gets the tool subset its
    // task class can actually use, not all ~30 schemas on every attempt.
    // Explicit name lists, "all", and builder requests keep exactly what
    // they asked for. The canonical taskCtx below still governs learning
    // and ranking; this early classification only shapes the wire set.
    if (autoTools && !builder && (autoRequest === "auto" || autoRequest === true || autoRequest === "*")) {
      const earlyCtx = classifyTask({
        messages,
        hasTools: true,
        toolChoice: body.tool_choice,
        responseFormat: body.response_format,
        reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
      });
      autoTools = autoToolsForClass(earlyCtx.taskClass, autoTools);
    }
    const declaredTools = autoTools ? mergeToolDeclarations(clientTools, { names: autoTools }) : clientTools;
    // forge_tool rides the normal auto set; retire_tool stays admin-only,
    // so admin sessions get it appended on the wire (the merge drops admin
    // tools by design).
    if (autoTools && isAdminContext(c)) {
      if (!autoTools.includes("retire_tool")) autoTools.push("retire_tool");
      declaredTools.push(...(toToolSpecs({ names: ["retire_tool"], includeAdmin: true }) as Json[]));
    }
    const hasTools = declaredTools.length > 0;
    // Names the caller declared itself. A client tool that shadows a built-in
    // stays the client's, so the plane never hijacks the caller's own API.
    const clientToolNames = clientTools
      .map((t) => {
        const entry = (t ?? {}) as Json;
        const fn = (entry.function && typeof entry.function === "object" ? entry.function : entry) as Json;
        return typeof fn.name === "string" ? fn.name : "";
      })
      .filter(Boolean);
    // Self-execution is opt-in: only when the router supplied the tools does it
    // run the agentic loop. Otherwise tool_calls go straight back to the caller.
    // let: the build gate extends the budget when it sends the agent back to work.
    // Builder requests get a deeper default tool budget (24 rounds) when the
    // client did not ask for a specific count; the 0–32 clamp still applies.
    const roundsRequest = builder && typeof body.kono_rounds !== "number" ? 24 : body.kono_rounds;
    let agentRounds = autoTools ? maxToolRounds(roundsRequest) : 0;
    // ---- ASCK-L: task context, strategy arm, lesson injection -------------
    // The class is computed from the caller's messages before any router
    // system text is added, so the classifier sees the request as sent.
    const tenant = toolNamespace(c);
    const taskCtx = classifyTask({
      messages,
      hasTools,
      toolChoice: body.tool_choice,
      responseFormat: body.response_format,
      reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
    });
    const originalUserText = (() => {
      const m = [...messages].reverse().find((x) => x.role === "user");
      return typeof m?.content === "string" ? m.content : "";
    })();
    const hasTests = Array.isArray(body.kono_tests) && body.kono_tests.length > 0;
    const hasVerifier = taskCtx.taskClass === "math" || taskCtx.taskClass === "json" ||
      taskCtx.taskClass === "tool" || (taskCtx.taskClass === "code" && hasTests);
    await hydrateLearning().catch(logErr);
    const armDefs = await loadStrategyArms().catch(() => DEFAULT_STRATEGY_ARMS);
    const armCands: BanditCandidate[] = armsForClass(armDefs, taskCtx.taskClass, hasVerifier).map((a) => {
      const cell = ARM_CELLS.get(armCellKey(a.id, taskCtx.taskClass)) ?? emptyCell();
      const eff = effectivePosterior(cell, armGlobalPosterior(a.id), learningKappa());
      return { id: a.id, alpha: eff.alpha, beta: eff.beta, pulls: cell.pulls };
    });
    const baselineArm = armDefs.find((a) => a.id === "baseline") ?? DEFAULT_STRATEGY_ARMS[0];
    // Builder profile: strategy-arm selection is skipped outright — no
    // Thompson draw, no variant prompt, no temperature delta downstream.
    // The baseline arm is what the decision log records, truthfully.
    const armChoice = builder ? null : chooseThompson(armCands, Math.random, { epsilon: 0.05, resamples: 120 });
    const arm = builder ? baselineArm : (armDefs.find((a) => a.id === armChoice?.id) ?? DEFAULT_STRATEGY_ARMS[0]);
    // Pure-passthrough modes (tool plane off: KONO_TOOLS=0,
    // KONO_TOOL_ROUNDS=0, or no auto tools on this request) must not mutate
    // the request — no prompt variant, no lessons, no temperature shift, no
    // verify-retry. The strategy in effect is then the baseline, and the
    // baseline is what the decision log records.
    const planeActive = Boolean(autoTools && agentRounds > 0);
    const effArm = builder ? baselineArm : (planeActive ? arm : baselineArm);
    const variantText = !builder && planeActive ? PROMPT_VARIANTS[effArm.promptVariant] : null;
    if (variantText) messages.unshift({ role: "system", content: variantText });
    const injectedLessons = planeActive ? rankLessons([...LESSONS.values()], taskCtx.taskClass, 2, Math.random) : [];
    if (injectedLessons.length > 0) {
      messages.unshift({
        role: "system",
        content: "Lessons learned from verified failures on similar tasks:\n" +
          injectedLessons.map((l) => `- ${l.correction}`).join("\n"),
      });
    }
    const learnCtx: LearnCtx = {
      traceId: root.traceId,
      taskCtx,
      arm: effArm,
      armPropensity: planeActive ? (armChoice?.propensity ?? 1) : 1,
      tenant,
      lessons: injectedLessons,
      hasVerifier,
      planeActive,
      compute: { mode: "single", n: 1, variance: 0, reason: "not yet decided" },
    };
    const toolAware = hasTools || reqModel.toLowerCase().includes("tools");
    // One line of instruction materially raises tool-use rates on small free
    // models, which otherwise answer from memory. Only added when the router
    // will actually execute the calls; opt out with kono_preamble: false.
    if (autoTools && agentRounds > 0 && body.kono_preamble !== false) {
      // The session's workspace, so the model knows what project exists, what
      // the preview runs and what is broken, before deciding how to answer.
      let briefTimer: ReturnType<typeof setTimeout> | undefined;
      const brief = autoTools.includes("fs_read")
        ? await Promise.race([
          workspaceBrief({ kv, namespace: toolNamespace(c) }).catch(() => null),
          new Promise<null>((r) => { briefTimer = setTimeout(() => r(null), 1200); }),
        ]).finally(() => clearTimeout(briefTimer))
        : null;
      if (brief) messages.unshift({ role: "system", content: brief });
      messages.unshift({ role: "system", content: toolPreamble(autoTools) });
    }
    const { hasVisionPayload } = extractMessageText(messages);

    try {
      endpointsAvailable = (await activeProviderList()).length;
    } catch {
      endpointsAvailable = PROVIDERS.filter((p) => p.isConfigured()).length;
    }

    const completionOptions: CompletionOptions = {
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      max_tokens: typeof body.max_tokens === "number"
        ? body.max_tokens
        : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : undefined,
      top_p: typeof body.top_p === "number" ? body.top_p : undefined,
      reasoning_effort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
      tools: hasTools ? declaredTools : undefined,
      tool_choice: body.tool_choice,
      parallel_tool_calls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
      reasoning: body.reasoning,
      response_format: body.response_format,
    };
    // Builder profile: the request temperature is used exactly as sent.
    if (!builder && learnCtx.arm.temperatureDelta !== 0) {
      completionOptions.temperature = Number(
        clampNum((completionOptions.temperature ?? 0.7) + learnCtx.arm.temperatureDelta, 0, 2).toFixed(2),
      );
    }

    // free:tools ranks the smart lane by learned tool-call competence.
    const mode: RoutingMode = reqModelLower.includes("auto")
      ? classifyPromptIntent(messages, hasTools, completionOptions.reasoning_effort)
      : reqModelLower.includes("fast")
      ? "fast"
      : reqModelLower.includes("code")
      ? "code"
      : reqModelLower.includes("reason") || reqModelLower.includes("think")
      ? "reasoning"
      : "smart";

    root.set({
      "model.requested": reqModel,
      mode,
      builder,
      stream: wantsStream,
      messages: messages.length,
      tools: declaredTools.length,
      auto_tools: autoTools?.length ?? 0,
      agent_rounds: agentRounds,
      parallel_tool_calls: completionOptions.parallel_tool_calls,
      vision: hasVisionPayload,
      endpoints: endpointsAvailable,
      task_class: taskCtx.taskClass,
      strategy_arm: learnCtx.arm.id,
      arm_propensity: learnCtx.armPropensity,
      lessons_injected: injectedLessons.length,
    });

    const safeRanked = async (m: RoutingMode, o: RankOptions = {}): Promise<ScoredCandidate[]> => {
      try {
        // Builder profile: deterministic scoring (Wilson/posterior lower
        // bounds, no Thompson draw, no UCB bonus, no Gumbel noise).
        return await getRankedCandidates(m, builder, false, { ...o, toolAware });
      } catch (err) {
        console.error(`[rank] ${m} ranking failed:`, err);
        return [];
      }
    };

    const rankSpan = root.child("rank", { mode });
    // Builder tier 1 ranks verified tuples only. If that pool is empty the
    // widening fallbacks below still apply, exactly as exhaustion works for
    // any other request — tier 1 itself never samples unverified tuples.
    let ranked = await safeRanked(mode, builder
      ? { taskClass: taskCtx.taskClass, tenant, verifiedOnly: true }
      : { taskClass: taskCtx.taskClass, tenant });
    // Vision lanes must not filter themselves into an empty pool.
    if (ranked.length === 0 && hasVisionPayload) ranked = await getRankedCandidates(mode, builder, hasVisionPayload, { toolAware }).catch(() => []);
    if (ranked.length === 0) ranked = await safeRanked(mode, { unrestricted: true });
    if (ranked.length === 0) ranked = await allSweepCandidates(mode).catch(() => []);

    // MODEL-AGNOSTIC ROUTING: an arbitrary requested model id never aborts the
    // request. Exact/near matches (trigram-Dice + token-Jaccard similarity) are
    // tried first; everything else keeps its Bayesian rank order as fallback.
    const isVirtualModel = reqModelLower.startsWith("free:") || reqModelLower.startsWith("kono-image");
    let nearMatches = 0;
    if (!isVirtualModel && ranked.length > 1) {
      // Treat provider-qualified ids (e.g. company/model-name) as aliases for
      // their model name in the chat picker. Put every exact-name endpoint
      // first so a failed request can fall through to another provider serving
      // the same model before trying a merely similar model.
      const modelName = (id: string) => id.toLowerCase().split("/").filter(Boolean).at(-1) ?? id.toLowerCase();
      const requestedName = modelName(reqModelLower);
      const scored = ranked.map((cand, i) => ({
        cand,
        i,
        exactName: modelName(cand.modelId) === requestedName,
        sim: Math.max(
          modelSimilarity(reqModelLower, cand.modelId.toLowerCase()),
          modelSimilarity(reqModelLower, cand.tupleId.toLowerCase()),
          modelSimilarity(requestedName, modelName(cand.modelId)),
        ),
      }));
      const exact = scored.filter((x) => x.exactName).map((x) => x.cand);
      const near = scored.filter((x) => !x.exactName && x.sim >= 0.30)
        .sort((a, b) => b.sim - a.sim || a.i - b.i)
        .map((x) => x.cand);
      const rest = scored.filter((x) => !x.exactName && x.sim < 0.30).map((x) => x.cand);
      nearMatches = exact.length + near.length;
      ranked = [...exact, ...near, ...rest];
    }
    rankSpan.end("ok", { candidates: ranked.length, near_matches: nearMatches, head: ranked[0]?.tupleId });

    // ---- ASCK-L: compute allocation by value of information ---------------
    {
      const headRec = ranked[0] ? L1_CACHE.get(ranked[0].tupleId) : undefined;
      const headPost = headRec
        ? contextualPosterior(headRec, taskCtx.taskClass, tenant, Date.now())
        : { alpha: 2, beta: 1 };
      learnCtx.compute = decideCompute({
        taskClass: taskCtx.taskClass,
        alpha: headPost.alpha,
        beta: headPost.beta,
        hasVerifier,
        armCompute: learnCtx.arm.compute,
        stream: wantsStream,
      });
      root.set({ compute_mode: learnCtx.compute.mode, compute_reason: learnCtx.compute.reason });
    }

    // Total budget covers full generations; first-token latency is governed by the hedge policy.
    const timeoutMs = mode === "reasoning" ? 1800000 : mode === "fast" ? 450000 : 1200000;
    const master = new AbortController();
    globalTimeout = setTimeout(() => master.abort(new Error(`TIMEOUT_GLOBAL: ${timeoutMs}ms`)), timeoutMs);
    c.req.raw.signal.addEventListener("abort", () => master.abort(new Error("CLIENT_DISCONNECTED")), { once: true });
    const untried = (xs: ScoredCandidate[]) => xs.filter((cand) => !tried.has(cand.tupleId));
    const dedupe = (xs: ScoredCandidate[]): ScoredCandidate[] => {
      const seen = new Set<string>();
      const out: ScoredCandidate[] = [];
      for (const x of xs) {
        if (seen.has(x.tupleId) || tried.has(x.tupleId)) continue;
        seen.add(x.tupleId);
        out.push(x);
      }
      return out;
    };

    // FOUR-TIER EXHAUSTION. Tiers 1-3 widen the ranking (cross-lane proven,
    // then the whole catalog with all gates lifted). Tier 4 is the universal
    // endpoint sweep: every configured endpoint/relay, including ones with no
    // catalog tuples, with short bounded deadlines and a burst launch. No tier
    // can end the request with an error — only the final degraded response can.
    const tiers: Array<{
      label: string;
      cap: number;
      pool: () => Promise<ScoredCandidate[]>;
      allowRetried?: boolean;
      policy?: HedgePolicy;
      budgetMs: number;
    }> = [
      {
        label: "mode-ranked",
        cap: Math.round(clampNum(Number(Deno.env.get("MESH_RACE_TIER1_ATTEMPTS")) || 12, 1, 500)),
        pool: () => Promise.resolve(ranked),
        budgetMs: mode === "fast" ? 15_000 : mode === "reasoning" ? 60_000 : 30_000,
      },
      {
        label: "cross-lane-proven",
        cap: 32,
        policy: ESCALATION_POLICY,
        budgetMs: 25_000,
        pool: async () => {
          const proven: RankOptions = { includeCoolingDown: true, verifiedOnly: true };
          const lanes: RoutingMode[] = ["fast", "smart", "code", "reasoning"];
          const ordered = [mode, ...lanes.filter((m) => m !== mode)];
          const parts: ScoredCandidate[] = [];
          for (const lane of ordered) parts.push(...await safeRanked(lane, proven));
          return dedupe(parts);
        },
      },
      {
        label: "full-catalog",
        cap: 256,
        policy: WIDE_POLICY,
        budgetMs: 25_000,
        pool: async () => untried(await safeRanked(mode, { unrestricted: true })),
      },
      {
        label: "exhaustive-endpoint-sweep",
        cap: 10_000,
        allowRetried: true,
        policy: SWEEP_POLICY,
        budgetMs: 25_000,
        pool: async () => {
          try {
            return await allSweepCandidates(mode);
          } catch (err) {
            console.error("[sweep] candidate build failed:", err);
            return [];
          }
        },
      },
    ];

    // Builder profile: the tuple that won the previous dispatch of THIS
    // request is moved to the head of every later pool, so a continuation
    // (tool round, gate round, verify retry) is tried on the winning model
    // first instead of merely keeping it eligible somewhere in the pool.
    let stickyTupleId: string | null = null;
    const dispatchOnce = async (): Promise<Dispatched> => {
      let err: unknown = null;
      for (const [i, tier] of tiers.entries()) {
        let candidates: ScoredCandidate[] = [];
        try {
          const poolList = await tier.pool();
          if (builder && stickyTupleId) {
            const si = poolList.findIndex((x) => x.tupleId === stickyTupleId);
            if (si > 0) poolList.unshift(poolList.splice(si, 1)[0]);
          }
          candidates = poolList.slice(0, tier.cap);
        } catch (e) {
          console.error(`[race] tier ${i + 1} pool failed:`, e);
          continue;
        }
        if (candidates.length === 0) continue;
        // The sweep intentionally re-attempts tuples tried in earlier tiers
        // (transient errors + fresh protocol negotiation), tracked separately.
        const tierTried = tier.allowRetried ? new Set<string>() : tried;
        // Anytime control: every tier has a hard budget. When it expires only
        // THIS tier is cut (not the request), so escalation always progresses.
        const tierCtrl = new AbortController();
        const tierSignal = combineSignals(master.signal, tierCtrl.signal);
        const tierDeadline = setTimeout(
          () => tierCtrl.abort(new Error(`TIER_BUDGET: ${tier.label} exceeded ${tier.budgetMs}ms`)),
          tier.budgetMs,
        );
        const tierSpan = root.child("tier", { tier: i + 1, label: tier.label, candidates: candidates.length, budget_ms: tier.budgetMs });
        try {
          const won = await hedgedDispatch(
            candidates, mode, messages, completionOptions, tierSignal,
            tierTried, tier.cap, tierSpan, tier.policy,
          );
          clearTimeout(tierDeadline);
          if (tier.allowRetried) for (const id of tierTried) tried.add(id);
          tierSpan.end("ok", { winner: won.cand.tupleId, attempted: tierTried.size });
          if (builder) stickyTupleId = won.cand.tupleId;
          return won;
        } catch (e) {
          clearTimeout(tierDeadline);
          if (tier.allowRetried) for (const id of tierTried) tried.add(id);
          err = e;
          lastErr = e;
          tierSpan.end("error", { attempted: tierTried.size, error: errText(e).slice(0, 200) });
          console.warn(`[race] tier ${i + 1} (${tier.label}) exhausted: ${errText(e)}`);
          if (master.signal.aborted) break;
        }
      }
      throw err ?? new Error("All configured endpoints exhausted");
    };

    // Bench-reset retry: when every endpoint has rate-limited (429) its way
    // onto the bench, erroring out wastes a wall that usually clears in
    // seconds. Instead: lift every bench, wait, and run the full tier race
    // again — up to 10 times, waiting 1s, then 5s, then doubling to a 60s
    // cap. A failure with nothing benched and no 429 in sight is a real
    // failure and throws immediately; the client's abort cancels the wait.
    const BENCH_RESET_WAITS_MS = [1_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000];
    const dispatch = async (): Promise<Dispatched> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await dispatchOnce();
        } catch (e) {
          if (master.signal.aborted || attempt >= BENCH_RESET_WAITS_MS.length) throw e;
          const text = errText(e);
          const rateLimited = /429|rate.?limit|too many requests/i.test(text);
          const lifted = rateLimited || /exhausted/i.test(text)
            ? await resetBenchedEndpoints().catch(() => 0)
            : 0;
          if (!rateLimited && lifted === 0) throw e;
          const waitMs = BENCH_RESET_WAITS_MS[attempt];
          root.event("bench_reset_retry", { attempt: attempt + 1, lifted, wait_ms: waitMs, error: text.slice(0, 160) });
          console.warn(`[race] rate-limit wall: lifted ${lifted} bench(es); retry ${attempt + 1}/${BENCH_RESET_WAITS_MS.length} in ${waitMs}ms`);
          tried.clear();
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, waitMs);
            master.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
          });
          if (master.signal.aborted) throw e;
        }
      }
    };

    const meta = (cand: ScoredCandidate) => ({
      degraded: false,
      requested_model: reqModel,
      endpoints_available: endpointsAvailable,
      attempts: tried.size,
      routing_kernel: "asck-v1",
      tuple_id: cand.tupleId,
      trace_id: root.traceId,
    });

    // ---- Build gate --------------------------------------------------------
    // An agent that changed the workspace is not done when it says so: the
    // gate checks the project (static, runtime, tests) and, while anything is
    // unmet, hands the findings back as the next user turn with more rounds.
    // Builder profile: the gate cannot be opted out of (a client-sent
    // kono_gate: false is ignored) and its default budget is 10 rounds
    // instead of 6; an explicit kono_gate_rounds still wins.
    const gateMax = planeActive && (builder || body.kono_gate !== false) && autoTools?.includes("fs_write") ? Math.round(clampNum(Number(body.kono_gate_rounds) || (builder ? 10 : 6), 1, 12)) : 0;
    let gateRounds = 0;
    const gateCaps = toolCaps(c, reqModel, body.kono_runner === true);
    const baseToolChoice = completionOptions.tool_choice;
    const startSig = gateMax ? await workspaceSigFor(gateCaps).catch(() => "") : "";
    const runGate = async (round: number, waitRuntimeMs: number): Promise<GateVerdict | null> => {
      if (!gateMax || gateRounds >= gateMax || master.signal.aborted) return null;
      // Sub-agents answer for their own part; testing the whole app is the lead agent's (or a tester's) job.
      const v = await buildGate(gateCaps, { startSig, force: body.kono_gate === "always", tests: !(Number(c.req.header("x-kono-depth") ?? c.req.header("x-nokey-depth") ?? 0) >= 1), waitRuntimeMs, signal: master.signal })
        .catch((e) => { root.event("build_gate_error", { error: errText(e).slice(0, 200) }); return null; });
      if (!v || v.done) {
        if (v && v.summary.reason !== "unchanged" && v.summary.reason !== "empty") root.event("build_gate", { pass: true, rounds: gateRounds });
        return null;
      }
      gateRounds += 1;
      agentRounds = Math.max(agentRounds, Math.min(64, round + 10));
      if (clientToolNames.length === 0) completionOptions.tool_choice = baseToolChoice;
      root.event("build_gate", { pass: false, gate_round: gateRounds, static_errors: Number(v.summary.static_errors ?? 0), runtime_errors: Number(v.summary.runtime_errors ?? 0) });
      return v;
    };

    if (!wantsStream) {
      const buffered = async (): Promise<Response> => {
        try {
          // Outer loop = server-side agent rounds (only when the plane supplied the
          // tools). Inner loop = the existing post-first-token failover: a
          // generation that dies after its first token re-dispatches once over the
          // untried pool.
          let toolRound = 0;
          let verifyRetries = 0;
          let extraTokens = 0;
          let a2aTaskDone = false;
          let lastToolVerdict: ToolCallVerdict | null = null;
          const toolLog: Array<{ round: number; tool: string; ok: boolean; ms: number; repaired: boolean; code?: string; error?: string }> = [];
          for (;;) {
            let produced: { cand: ScoredCandidate; res: CompletionResult & { finish?: string } } | null = null;
            for (let round = 0; round < 2; round++) {
              const { cand, up } = await dispatch();
              try {
                const res = await collectUpstream(up);
                recordTupleSuccess(cand.tupleId, res.ttftMs, res.totalMs, res.estTokens).catch(logErr);
                produced = { cand, res };
                break;
              } catch (e) {
                if (master.signal.aborted) break;
                lastErr = e;
                root.event("generation_failed", { tuple: cand.tupleId, error: errText(e).slice(0, 200) });
                recordTupleFailure(cand.tupleId, errText(e)).catch(logErr);
              }
            }
            if (!produced) throw lastErr ?? new Error("No endpoint completed a full generation");
            const { cand, res } = produced;

            // ---- Tool Plane: grade what the model emitted, then learn --------
            if (declaredTools.length > 0) {
              const verdict = gradeToolCalls(res.toolCalls ?? [], declaredTools, completionOptions.tool_choice);
              lastToolVerdict = verdict;
              if (!verdict.neutral) {
                learnToolVerdict(cand.tupleId, verdict).catch(logErr);
                toolVerdictLessons(verdict, taskCtx.taskClass);
                root.event("tool_verdict", {
                  tuple: cand.tupleId,
                  valid: verdict.valid,
                  repaired: verdict.repaired,
                  calls: verdict.calls,
                  problems: verdict.problems.slice(0, 2).join(" | ").slice(0, 200),
                });
              }
            }

            // ---- Agent loop: execute the plane's own calls and continue ------
            const wantLoop = agentRounds > 0 && toolRound < agentRounds &&
              (res.toolCalls?.length ?? 0) > 0 && !master.signal.aborted;
            if (wantLoop) {
              const roundSpan = root.child("tool_round", { round: toolRound + 1, calls: res.toolCalls!.length, tuple: cand.tupleId });
              const outcome = await executeOwnedToolCalls(res.toolCalls!, { span: roundSpan, signal: master.signal, admin: isAdminContext(c), clientNames: clientToolNames, caps: toolCaps(c, reqModel, body.kono_runner === true) });
              if (outcome.loop) {
                for (const e of outcome.executed) {
                  toolLog.push({
                    round: toolRound + 1,
                    tool: e.name,
                    ok: e.ok,
                    ms: e.ms,
                    repaired: e.repaired,
                    ...(e.code ? { code: e.code, error: e.error } : {}),
                  });
                }
                roundSpan.end("ok", {
                  executed: outcome.executed.length,
                  failures: outcome.executed.filter((e) => !e.ok).length,
                  tools: outcome.executed.map((e) => e.name).join(",").slice(0, 200),
                });
                if (outcome.messages.some((m) => m.name === "task" && /"status"\s*:\s*"done"/.test(String(m.content)))) a2aTaskDone = true;
                // The conversation continues: assistant call, then one tool
                // message per call, in order, exactly as the protocol requires.
                messages.push({
                  role: "assistant",
                  content: res.content ? res.content : null,
                  tool_calls: res.toolCalls,
                } as unknown as { role: string; content: unknown });
                for (const m of outcome.messages) messages.push(m);
                toolRound += 1;
                // Budget spent and every tool is the router's: the last turn answers instead of handing calls to the user.
                if (toolRound >= agentRounds && clientToolNames.length === 0) completionOptions.tool_choice = "none";
                // Keep the winner available for its own continuation; tuples that
                // already failed this request stay excluded.
                tried.delete(cand.tupleId);
                root.event("tool_round_done", { round: toolRound, messages: messages.length });
                continue;
              }
              roundSpan.end("ok", { executed: 0, reason: "tool calls belong to the client" });
            }

            if (!res.toolCalls?.length) {
              const gate = await runGate(toolRound, 8_000);
              if (gate) {
                messages.push({ role: "assistant", content: res.content || "(continuing)" });
                messages.push({ role: "user", content: gate.message! });
                toolLog.push({ round: toolRound, tool: "build_gate", ok: false, ms: 0, repaired: false });
                tried.delete(cand.tupleId);
                continue;
              }
            }

            // ---- ASCK-L: independent verification + graded reward ----------
            {
              const signals: RewardSignal[] = [{
                kind: "completion",
                value: res.content || res.toolCalls ? 1 : 0.4,
                source: "router",
                weight: 1,
              }];
              if (lastToolVerdict && !lastToolVerdict.neutral) {
                signals.push({ kind: "verifier_tool", value: lastToolVerdict.valid ? 1 : 0, source: "verifier:tool_schema", weight: 1.2 });
              }
              if (a2aTaskDone) {
                signals.push({ kind: "verifier_a2a", value: 1, source: "verifier:a2a_task", weight: 0.8 });
              }
              let verifierFailed: { signature: string } | null = null;
              if (taskCtx.taskClass === "math") {
                const v = verifyMathAnswer(originalUserText, res.content ?? "");
                if (v) {
                  signals.push({ kind: "verifier_math", value: v.pass ? 1 : 0, source: "verifier:calculate", weight: 1.5 });
                  if (!v.pass) verifierFailed = { signature: failureSignature("verifier_math", "mismatch") };
                }
              }
              if (taskCtx.taskClass === "json" || body.response_format) {
                const v = verifyJsonAnswer(res.content ?? "", body.response_format);
                if (v) {
                  signals.push({ kind: "verifier_json", value: v.pass ? 1 : 0, source: "verifier:json_schema", weight: 1.5 });
                  if (!v.pass) verifierFailed = { signature: failureSignature("verifier_json", v.signature || "invalid") };
                }
              }
              if (verifierFailed && learnCtx.planeActive && (learnCtx.compute.mode === "verify_retry" || learnCtx.compute.mode === "best_of_n") && verifyRetries < 1 && !(res.toolCalls?.length)) {
                verifyRetries++;
                extraTokens += res.estTokens;
                writeLesson(taskCtx.taskClass, verifierFailed.signature).catch(logErr);
                messages.push({ role: "assistant", content: res.content });
                messages.push({
                  role: "user",
                  content: `Independent verification failed (${verifierFailed.signature}). Recompute carefully, verify the result, and answer again.`,
                });
                tried.delete(cand.tupleId);
                root.event("verify_retry", { tuple: cand.tupleId, signature: verifierFailed.signature });
                continue;
              }
              if (verifierFailed) writeLesson(taskCtx.taskClass, verifierFailed.signature).catch(logErr);
              finalizeLearning({
                ctx: learnCtx, cand, ranked, signals,
                tokens: res.estTokens, extraTokens, now: Date.now(),
              }).catch(logErr);
            }

            root.io("response", { model: cand.modelId, provider: cand.providerId, finish: res.finish ?? (res.toolCalls ? "tool_calls" : "stop"), content: res.content, ...(res.reasoningContent ? { reasoning_content: res.reasoningContent } : {}), ...(res.toolCalls ? { tool_calls: res.toolCalls } : {}), ...(toolRound > 0 ? { tools_executed: toolLog } : {}) });
            root.end("ok", {
              tuple: cand.tupleId,
              provider: cand.providerId,
              ttft_ms: res.ttftMs,
              total_ms: res.totalMs,
              attempts: tried.size,
              finish: res.finish ?? (res.toolCalls ? "tool_calls" : "stop"),
              tool_calls: res.toolCalls?.length ?? 0,
              tool_rounds: toolRound,
              content_chars: res.content.length,
              reasoning_chars: res.reasoningContent?.length ?? 0,
            });
            return c.json({
              id: completionId,
              object: "chat.completion",
              created,
              model: cand.modelId,
              provider: cand.providerId,
              kono: {
                ...meta(cand),
                ...(toolRound > 0 ? { tool_rounds: toolRound, tools_executed: toolLog } : {}),
              },
              telemetry: {
                mode_selected: mode,
                iq_effective: cand.iqEffective,
                supports_reasoning: cand.supportsReasoning,
                is_coding_specialist: cand.isCodingSpecialist,
                reliability_draw: cand.reliabilityDraw,
                tool_competence: cand.toolCompetence,
                tool_pulls: cand.toolPulls,
                tool_rounds: toolRound,
                observed_ttft_ms: res.ttftMs,
                observed_total_ms: res.totalMs,
                ewma_tps: cand.ewmaTps,
                attempts: tried.size,
              },
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: res.toolCalls && !res.content ? null : res.content,
                    ...(res.reasoningContent ? { reasoning_content: res.reasoningContent } : {}),
                    ...(res.toolCalls ? { tool_calls: res.toolCalls } : {}),
                  },
                  finish_reason: res.finish ?? (res.toolCalls ? "tool_calls" : "stop"),
                },
              ],
            }, 200, {
              ...traceHeaders,
              "Server-Timing": `ttft;dur=${res.ttftMs}, total;dur=${Math.round(root.ms)}`,
              "X-Kono-Attempts": String(tried.size),
              "X-Kono-Endpoints": String(endpointsAvailable),
              ...(toolRound > 0 ? { "X-Kono-Tool-Rounds": String(toolRound) } : {}),
            });
          }
        } finally {
          clearTimeout(globalTimeout);
        }
      };
      return await idleBuffered(buffered(), async (e) => {
        endDegraded(e);
        return strictErrors() ? c.json({ error: { message: errText(e) } }, 502) : degradedCompletion(c, degradedOpts(e), {});
      }, { ...traceHeaders, "X-Kono-Endpoints": String(endpointsAvailable) });
    }

    // Headers leave immediately; routing proceeds behind heartbeat comments and the
    // committed winner is piped token-by-token (post-commit failover is impossible).
    // Headers leave immediately; routing proceeds behind heartbeat comments and the
    // committed winner is piped token-by-token (post-commit failover is impossible).
    // When the plane supplied the tools, a round that only produces tool calls is
    // drained quietly, executed server-side and re-dispatched: the client sees
    // `kono` status frames instead of intermediate assistant chatter, then the
    // final answer streams normally.
    const sse = async function* (): AsyncGenerator<string> {
      let ok = false;
      let toolRound = 0;
      let quietFails = 0;
      let streamToolVerdict: ToolCallVerdict | null = null;
      try {
        yield `: trace ${root.traceId}\n\n`;
        for (;;) {
          const settled = dispatch().then((v) => ({ v }), (e: unknown) => ({ e }));
          let r: { v: Dispatched } | { e: unknown } | undefined;
          while (true) {
            let hb: ReturnType<typeof setTimeout> | undefined;
            r = await Promise.race([settled, new Promise<undefined>((res) => hb = setTimeout(() => res(undefined), HEARTBEAT_MS))]);
            clearTimeout(hb);
            if (r) break;
            yield `: routing attempts=${tried.size} round=${toolRound}\n\n`;
          }
          if ("e" in r) {
            endDegraded(r.e);
            ok = true;
            if (strictErrors()) {
              yield `data: ${JSON.stringify({ error: { message: errText(r.e) } })}\n\ndata: [DONE]\n\n`;
            } else {
              yield degradedSse(degradedOpts(r.e));
            }
            return;
          }
          const { cand, up } = r.v;
          root.event("first_token", { tuple: cand.tupleId, ttft_ms: up.ttftMs, round: toolRound });
          const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Json = {}) =>
            `data: ${JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: cand.modelId,
              provider: cand.providerId,
              ...extra,
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`;
          // Router bookkeeping travels with an empty `choices` array, so strict
          // OpenAI clients never mistake it for assistant output.
          const status = (payload: Json) =>
            `data: ${JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: cand.modelId,
              provider: "kono-router",
              kono: payload,
              choices: [],
            })}\n\n`;

          const headHasTools = up.head.some((d) => d.toolCalls);
          if (agentRounds > 0 && headHasTools && toolRound < agentRounds && !master.signal.aborted) {
            let quiet: CompletionResult & { finish?: string };
            try {
              quiet = await collectUpstream(up);
            } catch (e) {
              if (!master.signal.aborted) recordTupleFailure(cand.tupleId, errText(e)).catch(logErr);
              root.event("tool_round_failed", { tuple: cand.tupleId, error: errText(e).slice(0, 200) });
              if (++quietFails >= 2) {
                root.end("error", { tuple: cand.tupleId, error: errText(e).slice(0, 300) });
                yield `data: ${JSON.stringify({ error: { message: errText(e) } })}\n\n`;
                yield "data: [DONE]\n\n";
                ok = true;
                return;
              }
              continue;
            }
            const quietTotalMs = Math.max(quiet.ttftMs + 1, Math.round(performance.now() - up.t0));
            recordTupleSuccess(cand.tupleId, quiet.ttftMs, quietTotalMs, quiet.estTokens).catch(logErr);

            if (declaredTools.length > 0) {
              const verdict = gradeToolCalls(quiet.toolCalls ?? [], declaredTools, completionOptions.tool_choice);
              streamToolVerdict = verdict;
              if (!verdict.neutral) {
                learnToolVerdict(cand.tupleId, verdict).catch(logErr);
                toolVerdictLessons(verdict, taskCtx.taskClass);
                root.event("tool_verdict", {
                  tuple: cand.tupleId,
                  valid: verdict.valid,
                  repaired: verdict.repaired,
                  calls: verdict.calls,
                  problems: verdict.problems.slice(0, 2).join(" | ").slice(0, 200),
                });
              }
            }

            const roundSpan = root.child("tool_round", { round: toolRound + 1, calls: quiet.toolCalls?.length ?? 0, tuple: cand.tupleId });
            const outcome = await executeOwnedToolCalls(quiet.toolCalls ?? [], { span: roundSpan, signal: master.signal, admin: isAdminContext(c), clientNames: clientToolNames, caps: toolCaps(c, reqModel, body.kono_runner === true) });
            if (outcome.loop) {
              roundSpan.end("ok", {
                executed: outcome.executed.length,
                failures: outcome.executed.filter((e) => !e.ok).length,
                tools: outcome.executed.map((e) => e.name).join(",").slice(0, 200),
              });
              messages.push({
                role: "assistant",
                content: quiet.content ? quiet.content : null,
                tool_calls: quiet.toolCalls,
              } as unknown as { role: string; content: unknown });
              for (const m of outcome.messages) messages.push(m);
              toolRound += 1;
              if (toolRound >= agentRounds && clientToolNames.length === 0) completionOptions.tool_choice = "none";
              tried.delete(cand.tupleId);
              yield status({
                type: "tool_round",
                round: toolRound,
                tuple: cand.tupleId,
                trace_id: root.traceId,
                ...(quiet.content ? { interim_content: quiet.content.slice(0, 500) } : {}),
                tools: outcome.executed.map((e) => ({ name: e.name, ok: e.ok, ms: e.ms, repaired: e.repaired, ...(e.error ? { error: e.error } : {}) })),
              });
              continue;
            }
            // The calls belong to the client: hand them over in one buffered delta,
            // which is a legal SSE shape for tool_calls.
            roundSpan.end("ok", { executed: 0, reason: "tool calls belong to the client" });
            const clientDelta: Record<string, unknown> = { role: "assistant", tool_calls: quiet.toolCalls };
            if (quiet.content) clientDelta.content = quiet.content;
            if (quiet.reasoningContent) clientDelta.reasoning_content = quiet.reasoningContent;
            yield chunk(clientDelta, null);
            ok = true;
            const clientFinish = quiet.finish ?? "tool_calls";
            root.io("response", { model: cand.modelId, provider: cand.providerId, finish: clientFinish, content: quiet.content, tool_calls: quiet.toolCalls });
            yield chunk({}, clientFinish, { kono: { ...meta(cand), ...(toolRound > 0 ? { tool_rounds: toolRound } : {}) } });
            root.end("ok", {
              tuple: cand.tupleId,
              provider: cand.providerId,
              ttft_ms: quiet.ttftMs,
              total_ms: quietTotalMs,
              attempts: tried.size,
              finish: clientFinish,
              tool_calls: quiet.toolCalls?.length ?? 0,
              tool_rounds: toolRound,
              content_chars: quiet.content.length,
              reasoning_chars: quiet.reasoningContent?.length ?? 0,
            });
            break;
          }

          let first = true;
          const toolCalls = new Set<number>();
          const streamedCalls = new Map<number, ToolCallDelta>();
          let contentChars = 0;
          let streamedText = "";
          let reasoning = "";
          let finish: string | undefined;
          // Calls that surface after the head committed are held, not streamed: the plane may still own them.
          const holdCalls = agentRounds > 0 && toolRound < agentRounds;
          const wire = (d: Delta): string | null => {
            const out: Record<string, unknown> = {};
            if (d.reasoning) out.reasoning_content = d.reasoning;
            if (d.content) out.content = d.content;
            if (d.toolCalls) {
              if (!holdCalls) out.tool_calls = d.toolCalls;
              mergeToolCalls(streamedCalls, d.toolCalls);
              for (const t of d.toolCalls) toolCalls.add(t.index);
            }
            contentChars += d.content?.trim() ? d.content.length : 0;
            streamedText += d.content ?? "";
            reasoning += d.reasoning ?? "";
            finish = d.finish ?? finish;
            if (Object.keys(out).length === 0) return null;
            if (first) out.role = "assistant";
            first = false;
            return chunk(out, null);
          };
          try {
            for (const d of up.head) {
              const f = wire(d);
              if (f) yield f;
            }
            for await (const d of up.tail) {
              const f = wire(d);
              if (f) yield f;
            }
            if (holdCalls && streamedCalls.size > 0) {
              const late = [...streamedCalls.values()].sort((a, b) => a.index - b.index)
                .map((t) => ({ id: t.id ?? `call_${t.index}`, type: "function", function: { name: t.function?.name ?? "", arguments: t.function?.arguments ?? "" } }));
              const roundSpan = root.child("tool_round", { round: toolRound + 1, calls: late.length, tuple: cand.tupleId, late: true });
              const outcome = await executeOwnedToolCalls(late, { span: roundSpan, signal: master.signal, admin: isAdminContext(c), clientNames: clientToolNames, caps: toolCaps(c, reqModel, body.kono_runner === true) });
              if (outcome.loop) {
                roundSpan.end("ok", { executed: outcome.executed.length, failures: outcome.executed.filter((e) => !e.ok).length });
                messages.push({ role: "assistant", content: streamedText || null, tool_calls: late } as unknown as { role: string; content: unknown });
                for (const m of outcome.messages) messages.push(m);
                toolRound += 1;
                if (toolRound >= agentRounds && clientToolNames.length === 0) completionOptions.tool_choice = "none";
                tried.delete(cand.tupleId);
                yield status({
                  type: "tool_round",
                  round: toolRound,
                  tuple: cand.tupleId,
                  trace_id: root.traceId,
                  tools: outcome.executed.map((e) => ({ name: e.name, ok: e.ok, ms: e.ms, repaired: e.repaired, ...(e.error ? { error: e.error } : {}) })),
                });
                continue;
              }
              roundSpan.end("ok", { executed: 0, reason: "tool calls belong to the client" });
              const handoff: Record<string, unknown> = { tool_calls: late };
              if (first) handoff.role = "assistant";
              first = false;
              yield chunk(handoff, null);
            }
            if (!toolCalls.size && !master.signal.aborted) {
              const gate = await runGate(toolRound, 8_000);
              if (gate) {
                messages.push({ role: "assistant", content: streamedText || reasoning.trim() || "(continuing)" });
                messages.push({ role: "user", content: gate.message! });
                tried.delete(cand.tupleId);
                yield chunk({ content: "\n\n" }, null);
                yield status({ type: "build_gate", gate_round: gateRounds, trace_id: root.traceId, ...gate.summary, message: gate.message!.slice(0, 2000) });
                continue;
              }
            }
            // Salvage parity with the buffered path: a reasoning-only stream also surfaces as content.
            if (!contentChars && !toolCalls.size && reasoning.trim()) yield chunk({ content: reasoning.trim() }, null);
            ok = true;
            const fin = finish ?? (toolCalls.size ? "tool_calls" : "stop");
            root.io("response", { model: cand.modelId, provider: cand.providerId, finish: fin, content: streamedText, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(streamedCalls.size ? { tool_calls: [...streamedCalls.values()] } : {}) });
            yield chunk({}, fin, { kono: { ...meta(cand), ...(toolRound > 0 ? { tool_rounds: toolRound } : {}) } });
            const totalMs = Math.max(up.ttftMs + 1, Math.round(performance.now() - up.t0));
            recordTupleSuccess(cand.tupleId, up.ttftMs, totalMs, Math.max(1, Math.ceil((contentChars + reasoning.length) / 4))).catch(logErr);
            if (declaredTools.length > 0 && streamedCalls.size > 0) {
              // Streaming traffic teaches the mesh too: grade the reassembled
              // calls exactly as the buffered path does.
              const calls = [...streamedCalls.values()].sort((a, b) => a.index - b.index);
              const verdict = gradeToolCalls(calls, declaredTools, completionOptions.tool_choice);
              streamToolVerdict = verdict;
              if (!verdict.neutral) {
                learnToolVerdict(cand.tupleId, verdict).catch(logErr);
                toolVerdictLessons(verdict, taskCtx.taskClass);
                root.event("tool_verdict", {
                  tuple: cand.tupleId,
                  valid: verdict.valid,
                  repaired: verdict.repaired,
                  calls: verdict.calls,
                  problems: verdict.problems.slice(0, 2).join(" | ").slice(0, 200),
                });
              }
            }
            {
              const signals: RewardSignal[] = [{
                kind: "completion",
                value: contentChars > 0 || toolCalls.size > 0 ? 1 : 0.4,
                source: "router",
                weight: 1,
              }];
              if (streamToolVerdict && !streamToolVerdict.neutral) {
                signals.push({ kind: "verifier_tool", value: streamToolVerdict.valid ? 1 : 0, source: "verifier:tool_schema", weight: 1.2 });
              }
              finalizeLearning({
                ctx: learnCtx, cand, ranked, signals,
                tokens: Math.max(1, Math.ceil((contentChars + reasoning.length) / 4)),
                extraTokens: 0, now: Date.now(),
              }).catch(logErr);
            }
            root.end("ok", {
              tuple: cand.tupleId,
              provider: cand.providerId,
              ttft_ms: up.ttftMs,
              total_ms: totalMs,
              attempts: tried.size,
              finish: fin,
              tool_calls: toolCalls.size,
              tool_rounds: toolRound,
              content_chars: contentChars,
              reasoning_chars: reasoning.length,
            });
          } catch (e) {
            if (!master.signal.aborted) recordTupleFailure(cand.tupleId, errText(e)).catch(logErr);
            root.end("error", { tuple: cand.tupleId, error: errText(e).slice(0, 300), content_chars: contentChars });
            yield `data: ${JSON.stringify({ error: { message: errText(e) } })}\n\n`;
        }
          break;
        }
          yield "data: [DONE]\n\n";
      } finally {
        clearTimeout(globalTimeout);
        if (!ok) {
          master.abort(new Error("STREAM_CLOSED"));
          root.end("error", { error: "stream closed before completion" });
        }
      }
    };

    return new Response(ReadableStream.from(keepalive(sse(), idleMs())).pipeThrough(new TextEncoderStream()), {
      headers: { ...SSE_HEADERS, ...traceHeaders, "X-Kono-Endpoints": String(endpointsAvailable) },
    });
  } catch (err: unknown) {
    clearTimeout(globalTimeout);
    endDegraded(err);
    // Opt-out for operators who prefer the legacy hard failure while debugging.
    if (strictErrors()) {
      return c.json({ error: { message: errText(err) } }, 502, traceHeaders);
    }
    return degradedCompletion(c, degradedOpts(err), traceHeaders);
  }
});
}
```

// compiler/types.ts — the compiler's contracts, whole file.
// NodeRun / RunMetrics / CompileOptions / CompileResult: the shapes the
// plan-DAG execution reports back.

compiler/types.ts
```ts
// Compiler contracts shared by the kernel, the HTTP route and the tests.
import type { Json } from "../toolbox/types.ts";
import type { Candidate, Complete } from "./sample.ts";

export type { Candidate, Complete };

export interface ExecResult { ok: boolean; result?: unknown; error?: string; code?: string; ms: number }
export type Exec = (tool: string, args: Json, signal: AbortSignal) => Promise<ExecResult>;

export interface NodeRun {
  id: string;
  tool: string;
  args: Json;
  deps: string[];
  rank_ms: number;
  status: "ok" | "error" | "skipped";
  start_ms: number;
  end_ms: number;
  ms: number;
  result?: unknown;
  error?: string;
  code?: string;
}

export interface RunMetrics {
  makespan_ms: number;
  work_ms: number;
  critical_path_ms: number;
  parallelism: number;
  depth: number;
}

export interface RunOptions {
  exec: Exec;
  concurrency: number;
  estimateMs: (tool: string) => number;
  stateful: (tool: string) => boolean;
  signal: AbortSignal;
}

export interface CompileOptions {
  question: string;
  complete: Complete;
  exec: Exec;
  samples?: number;
  rounds?: number;
  concurrency?: number;
  k?: number;
  tools?: string[];
  admin?: boolean;
  fallbackTools?: string[];
  estimateMs?: (tool: string) => number;
  budgetMs?: number;
  signal?: AbortSignal;
}

export interface Round {
  candidates: Candidate[];
  selected: number | null;
  consensus: number | null;
  runs: NodeRun[];
  metrics: RunMetrics | null;
  join: { action: "finish" | "replan"; reason?: string; model?: string };
}
export interface CompileResult {
  answer: string;
  tools: string[];
  rounds: Round[];
  usage: { llm_calls: number; tool_calls: number; react_round_trips: number; compiler_round_trips: number };
  ms: number;
}
```

// compiler/plan.ts — Plan / PlanNode / parsePlan, whole file.
// MAX_NODES is the first hard bound on AI-authored work; parsePlan is the
// first validator (node shape, known ids, tool present).

compiler/plan.ts
```ts
// Plan grammar (LLMCompiler, Kim et al. 2023): a DAG of tool calls whose
// arguments reference upstream results (see refs.ts).
import { parseToolArguments, resolveTool, validateJson } from "../tools.ts";
import { arr, isObj, str } from "../toolbox/util.ts";
import { ID_RE, walkRefs } from "./refs.ts";
import { lastJson, stripThinking } from "./json.ts";
import type { Json } from "../toolbox/types.ts";

export interface PlanNode {
  id: string;
  tool: string;
  args: Json;
  deps: string[];
  issues: string[];
}
export interface Plan { nodes: PlanNode[]; order: string[] }
export interface PlanParse { ok: boolean; plan?: Plan; errors: string[] }

export const MAX_NODES = 24;
// The planner is told to use n1…nK; an unknown id of that shape is a dangling ref, anything else is literal text.
const CONVENTIONAL = /^n\d+$/;

const listOf = (v: Json): unknown[] => arr(v.nodes ?? v.plan ?? v.steps ?? v.calls);
const isNode = (e: unknown) => isObj(e) && (typeof e.tool === "string" || typeof e.name === "string" || isObj(e.function));
/** A plan is an array of nodes or an object holding one; an empty array is the explicit "no tools needed". */
function isPlanShape(v: unknown): boolean {
  const list = Array.isArray(v) ? (v.length ? v : null) : isObj(v) && Array.isArray(v.nodes ?? v.plan ?? v.steps ?? v.calls) ? listOf(v) : null;
  return list !== null && list.every(isNode);
}

/** Parses a planner reply into a validated, topologically ordered DAG. `prior` = ids with results from earlier rounds. */
export function parsePlan(raw: string, prior: ReadonlySet<string>): PlanParse {
  const v = lastJson(raw, isPlanShape);
  if (v === undefined) return { ok: false, errors: [`no JSON plan in reply: ${JSON.stringify(stripThinking(raw).slice(0, 160))}`] };
  const list = Array.isArray(v) ? v : listOf(v as Json);
  if (list.length > MAX_NODES) return { ok: false, errors: [`plan has ${list.length} nodes; max ${MAX_NODES}`] };
  const errors: string[] = [];
  const drafts = list.filter(isObj).map((e, i) => {
    const id = str(e.id) ?? `n${i + 1}`;
    const fn = isObj(e.function) ? e.function : e;
    const name = str(e.tool ?? fn.name) ?? "";
    let args: unknown = e.args ?? e.arguments ?? fn.arguments ?? e.parameters ?? {};
    if (typeof args === "string") args = parseToolArguments(args).value;
    const { tool, suggestions } = resolveTool(name);
    if (!ID_RE.test(id)) errors.push(`${id}: invalid id`);
    if (!tool) errors.push(`${id}: unknown tool "${name}"${suggestions.length ? ` (did you mean ${suggestions.map((s) => s.name).join(", ")}?)` : ""}`);
    if (!isObj(args)) errors.push(`${id}: args must be an object`);
    return { id, tool: tool?.name ?? name, schema: tool?.parameters, args: (isObj(args) ? args : {}) as Json, explicit: arr(e.deps ?? e.depends_on).filter((d): d is string => typeof d === "string") };
  });
  const ids = new Set<string>();
  for (const d of drafts) {
    if (ids.has(d.id) || prior.has(d.id)) errors.push(`${d.id}: duplicate id`);
    ids.add(d.id);
  }
  const nodes: PlanNode[] = drafts.map((d) => {
    const deps = new Set<string>();
    const add = (id: string) => {
      if (ids.has(id) && id !== d.id) deps.add(id);
      else if (id === d.id) errors.push(`${d.id}: references itself`);
      else if (!prior.has(id) && CONVENTIONAL.test(id)) errors.push(`${d.id}: unknown reference $${id}`);
    };
    walkRefs(d.args, add);
    d.explicit.forEach(add);
    let refs = 0;
    walkRefs(d.args, (id) => { if (ids.has(id) || prior.has(id)) refs++; });
    const issues = refs === 0 && d.schema
      ? validateJson(d.args, d.schema, { coerce: true }).issues.filter((i) => i.severity === "error").map((i) => `${i.path || "/"} ${i.message}`)
      : [];
    return { id: d.id, tool: d.tool, args: d.args, deps: [...deps], issues };
  });
  // Kahn's algorithm: emits a topological order or exposes the cycle.
  const indeg = new Map(nodes.map((n) => [n.id, n.deps.length]));
  const queue = nodes.filter((n) => n.deps.length === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const n of nodes) {
      if (!n.deps.includes(id)) continue;
      indeg.set(n.id, indeg.get(n.id)! - 1);
      if (indeg.get(n.id) === 0) queue.push(n.id);
    }
  }
  if (order.length < nodes.length) errors.push(`cycle among ${nodes.filter((n) => !order.includes(n.id)).map((n) => n.id).join(", ")}`);
  return errors.length ? { ok: false, errors } : { ok: true, plan: { nodes, order }, errors };
}
```

// compiler/refs.ts — $node / ${node.path} references, whole file.
// walkRefs, substitute and signature: how one chunk's output becomes another
// chunk's argument. This is the mechanism the re-cut keeps and hardens.

compiler/refs.ts
```ts
// Result references inside plan arguments: "$id.path" substitutes the typed
// value, "${id.path}" interpolates text. Shared by parsing, execution and MBR.
import { canonical, getPath, isObj } from "../toolbox/util.ts";
import type { Json } from "../toolbox/types.ts";

const ID = "[A-Za-z_][\\w-]{0,31}";
const PATH = "((?:\\.[\\w-]+|\\[\\d+\\])*)";
export const WHOLE = new RegExp(`^\\$(${ID})${PATH}$`);
export const INLINE = new RegExp(`\\$\\{(${ID})${PATH}\\}`, "g");
export const ID_RE = new RegExp(`^${ID}$`);

export function walkRefs(v: unknown, visit: (id: string, path: string) => void): void {
  if (typeof v === "string") {
    const w = WHOLE.exec(v);
    if (w) return visit(w[1], w[2]);
    for (const m of v.matchAll(INLINE)) visit(m[1], m[2]);
  } else if (Array.isArray(v)) v.forEach((x) => walkRefs(x, visit));
  else if (isObj(v)) Object.values(v).forEach((x) => walkRefs(x, visit));
}

function lookup(results: ReadonlyMap<string, unknown>, id: string, path: string): unknown {
  const root = results.get(id);
  let p = path.replace(/^\./, "");
  // Planners often address the wrapper they imagine ("$n1.result.x"); strip it when the value has no such key.
  if (/^result\b/.test(p) && !(isObj(root) && "result" in root)) p = p.replace(/^result\.?/, "");
  return p ? getPath(root, p) : root;
}

/** Replaces refs with upstream values. A whole-string ref keeps the value's type. */
export function substitute(args: Json, results: ReadonlyMap<string, unknown>): { ok: true; value: Json } | { ok: false; error: string } {
  let missing = "";
  const map = (v: unknown): unknown => {
    if (typeof v === "string") {
      const w = WHOLE.exec(v);
      if (w && results.has(w[1])) {
        const got = lookup(results, w[1], w[2]);
        if (got === undefined) missing ||= v;
        return got;
      }
      return v.replace(INLINE, (m, id: string, path: string) => {
        if (!results.has(id)) return m;
        const got = lookup(results, id, path);
        if (got === undefined) missing ||= m;
        return typeof got === "string" ? got : JSON.stringify(got);
      });
    }
    if (Array.isArray(v)) return v.map(map);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]));
    return v;
  };
  const value = map(args) as Json;
  return missing ? { ok: false, error: `${missing} resolved to nothing` } : { ok: true, value };
}

/** Id-free call signature: refs become the producing tool, so two samples with different ids compare equal. */
export function signature(node: { tool: string; args: Json }, toolOf: (id: string) => string | undefined): string {
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") {
      const w = WHOLE.exec(v);
      if (w && toolOf(w[1])) return `$${toolOf(w[1])}${w[2]}`;
      return v.replace(INLINE, (m, id: string, path: string) => toolOf(id) ? `\${${toolOf(id)}${path}}` : m);
    }
    if (Array.isArray(v)) return v.map(rewrite);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };
  return `${node.tool}:${canonical(rewrite(node.args))}`;
}
```

// compiler/mbr.ts — minimum-Bayes-risk selection, whole file.
// viewOf / utility / selectMbr: pick the sampled plan closest to the consensus
// instead of trusting one sample. Robustness by voting, not by retrying.

compiler/mbr.ts
```ts
// Minimum Bayes risk plan selection (Kumar & Byrne 2004). K sampled plans are
// an empirical distribution; the pick maximises expected utility against it.
// Self-consistency (Wang et al. 2022) is the special case of exact-match utility.
import type { Plan } from "./plan.ts";
import { signature } from "./refs.ts";

/** Σmin/Σmax over multiset counts; two empty multisets are identical. */
export function multisetJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  for (const x of a) ca.set(x, (ca.get(x) ?? 0) + 1);
  for (const x of b) cb.set(x, (cb.get(x) ?? 0) + 1);
  let min = 0;
  let max = 0;
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    const x = ca.get(k) ?? 0;
    const y = cb.get(k) ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  return min / max;
}

export interface PlanView { tools: string[]; calls: string[]; size: number }

export function viewOf(plan: Plan, priorTool: (id: string) => string | undefined): PlanView {
  const byId = new Map(plan.nodes.map((n) => [n.id, n.tool]));
  const toolOf = (id: string) => byId.get(id) ?? priorTool(id);
  return { tools: plan.nodes.map((n) => n.tool), calls: plan.nodes.map((n) => signature(n, toolOf)), size: plan.nodes.length };
}

/** Utility u(p,q): exact calls carry half the mass, tool choice the other half, so near-misses in arguments still vote. */
export function utility(p: PlanView, q: PlanView): number {
  return 0.5 * multisetJaccard(p.calls, q.calls) + 0.5 * multisetJaccard(p.tools, q.tools);
}

export interface MbrPick { index: number; scores: number[]; consensus: number | null }

/** `validity` ∈ [0,1] down-weights plans whose literal arguments already fail their schemas. */
export function selectMbr(views: readonly PlanView[], validity: readonly number[]): MbrPick {
  const n = views.length;
  if (n === 0) throw new Error("selectMbr: no candidates");
  if (n === 1) return { index: 0, scores: [validity[0]], consensus: null };
  const u = views.map((p) => views.map((q) => utility(p, q)));
  const scores = views.map((_, i) => validity[i] * u[i].reduce((s, x, j) => (j === i ? s : s + x), 0) / (n - 1));
  let best = 0;
  for (let i = 1; i < n; i++) {
    const d = scores[i] - scores[best];
    if (d > 1e-9 || (Math.abs(d) <= 1e-9 && views[i].size < views[best].size)) best = i;
  }
  let pair = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pair += u[i][j];
  return { index: best, scores: scores.map((s) => Number(s.toFixed(4))), consensus: Number((pair / (n * (n - 1) / 2)).toFixed(4)) };
}
```

// compiler/sample.ts — K plan samples at rising temperature, whole file.
// samplePlans returns every candidate with its errors, so a bad sample is data
// rather than a failure.

compiler/sample.ts
```ts
// Plan sampling: K planner calls in one parallel round trip at spread
// temperatures (and lanes, by `attempt`), parsed, then reduced to one plan by MBR.
import { type Plan, parsePlan } from "./plan.ts";
import { selectMbr, viewOf } from "./mbr.ts";
import type { Msg } from "./prompts.ts";

export type Complete = (messages: Msg[], o: { temperature: number; max_tokens: number; signal: AbortSignal; attempt: number }) => Promise<{ content: string; model?: string }>;
export interface Candidate { model?: string; ok: boolean; nodes: number; errors: string[]; mbr?: number }
export interface Sampled { candidates: Candidate[]; plan: Plan | null; selected: number | null; consensus: number | null }

export const TEMPS = [0.2, 0.6, 0.9, 1.0, 1.1];

export async function samplePlans(
  complete: Complete,
  msgs: Msg[],
  samples: number,
  prior: ReadonlySet<string>,
  priorTool: (id: string) => string | undefined,
  signal: AbortSignal,
): Promise<Sampled> {
  const settled = await Promise.allSettled(TEMPS.slice(0, samples).map((temperature, attempt) => complete(msgs, { temperature, max_tokens: 4000, signal, attempt })));
  const parsed = settled.map((s) => s.status === "fulfilled"
    ? { model: s.value.model, ...parsePlan(s.value.content, prior) }
    : { model: undefined, ok: false, plan: undefined, errors: [`planner call failed: ${String((s.reason as Error)?.message ?? s.reason)}`] });
  const candidates: Candidate[] = parsed.map((p) => ({ model: p.model, ok: p.ok, nodes: p.plan?.nodes.length ?? 0, errors: p.errors.slice(0, 8) }));
  const valid = parsed.flatMap((p, i) => (p.ok && p.plan ? [{ plan: p.plan, i }] : []));
  if (!valid.length) return { candidates, plan: null, selected: null, consensus: null };
  // Literal arguments that already fail their schema lower a plan's weight; refs are only checkable at run time.
  const validity = valid.map(({ plan }) => plan.nodes.length ? plan.nodes.filter((n) => n.issues.length === 0).length / plan.nodes.length : 1);
  const pick = selectMbr(valid.map(({ plan }) => viewOf(plan, priorTool)), validity);
  valid.forEach((x, j) => (candidates[x.i].mbr = pick.scores[j]));
  return { candidates, plan: valid[pick.index].plan, selected: valid[pick.index].i, consensus: pick.consensus };
}
```

// compiler/schedule.ts — dependency-aware DAG execution, whole file.
// runPlan runs independent nodes in parallel under a concurrency cap, skips
// stateful tools where order matters, and returns per-node runs plus metrics.

compiler/schedule.ts
```ts
// DAG executor: list scheduling by upward rank (HEFT, Topcuoglu et al. 2002)
// over learned tool latencies, bounded concurrency, data-dependency skipping.
import type { Plan } from "./plan.ts";
import { substitute } from "./refs.ts";
import type { ExecResult, NodeRun, RunMetrics, RunOptions } from "./types.ts";

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Runs the plan; successful outputs land in `results` so later rounds can reference them. */
export async function runPlan(plan: Plan, results: Map<string, unknown>, o: RunOptions): Promise<{ runs: NodeRun[]; metrics: RunMetrics }> {
  const node = new Map(plan.nodes.map((n) => [n.id, n]));
  // Stateful tools share a store: chain them in topological order (ordering edge, not data).
  const after = new Map(plan.order.map((id) => [id, new Set(node.get(id)!.deps)]));
  let prev: string | undefined;
  for (const id of plan.order) {
    if (!o.stateful(node.get(id)!.tool)) continue;
    if (prev) after.get(id)!.add(prev);
    prev = id;
  }
  const children = new Map(plan.order.map((id) => [id, [] as string[]]));
  for (const [id, deps] of after) for (const d of deps) children.get(d)!.push(id);
  const rank = new Map<string, number>();
  for (const id of [...plan.order].reverse()) {
    rank.set(id, o.estimateMs(node.get(id)!.tool) + Math.max(0, ...children.get(id)!.map((c) => rank.get(c)!)));
  }

  const t0 = performance.now();
  const runs = new Map<string, NodeRun>();
  const pending = new Map(plan.order.map((id) => [id, after.get(id)!.size]));
  const ready = plan.order.filter((id) => pending.get(id) === 0);
  const running = new Map<string, Promise<string>>();

  const settle = (id: string) => {
    for (const c of children.get(id)!) {
      pending.set(c, pending.get(c)! - 1);
      if (pending.get(c) !== 0) continue;
      const bad = node.get(c)!.deps.find((d) => runs.get(d)?.status !== "ok");
      if (bad) {
        finish(c, { status: "skipped", error: `upstream ${bad} ${runs.get(bad)!.status}`, code: "UPSTREAM_FAILED" }, performance.now(), performance.now());
        settle(c);
      } else ready.push(c);
    }
  };
  const finish = (id: string, r: Pick<NodeRun, "status"> & Partial<NodeRun>, start: number, end: number) => {
    const n = node.get(id)!;
    runs.set(id, { id, tool: n.tool, args: n.args, deps: n.deps, rank_ms: r1(rank.get(id)!), start_ms: r1(start - t0), end_ms: r1(end - t0), ms: r1(end - start), ...r });
  };
  const launch = (id: string): Promise<string> => {
    const n = node.get(id)!;
    const start = performance.now();
    const sub = substitute(n.args, results);
    if (!sub.ok) {
      finish(id, { status: "error", error: sub.error, code: "BAD_REF" }, start, performance.now());
      return Promise.resolve(id);
    }
    return o.exec(n.tool, sub.value, o.signal)
      .catch((e): ExecResult => ({ ok: false, error: String(e?.message ?? e), code: "EXEC_THREW", ms: 0 }))
      .then((x) => {
        if (x.ok) results.set(id, x.result);
        finish(id, x.ok ? { status: "ok", args: sub.value, result: x.result } : { status: "error", args: sub.value, error: x.error, code: x.code }, start, performance.now());
        return id;
      });
  };

  while (ready.length || running.size) {
    ready.sort((a, b) => rank.get(b)! - rank.get(a)!);
    while (ready.length && running.size < o.concurrency) {
      const id = ready.shift()!;
      if (o.signal.aborted) {
        finish(id, { status: "skipped", error: "deadline", code: "DEADLINE" }, performance.now(), performance.now());
        settle(id);
        continue;
      }
      running.set(id, launch(id));
    }
    if (!running.size) continue;
    const done = await Promise.race(running.values());
    running.delete(done);
    settle(done);
  }

  const list = plan.order.map((id) => runs.get(id)!);
  const ran = list.filter((r) => r.status !== "skipped");
  const finishAt = new Map<string, number>();
  const level = new Map<string, number>();
  for (const id of plan.order) {
    const r = runs.get(id)!;
    finishAt.set(id, r.ms + Math.max(0, ...[...after.get(id)!].map((d) => finishAt.get(d)!)));
    level.set(id, 1 + Math.max(0, ...node.get(id)!.deps.map((d) => level.get(d)!)));
  }
  const makespan = Math.max(0, ...list.map((r) => r.end_ms));
  const work = ran.reduce((s, r) => s + r.ms, 0);
  return {
    runs: list,
    metrics: {
      makespan_ms: r1(makespan),
      work_ms: r1(work),
      critical_path_ms: r1(Math.max(0, ...finishAt.values())),
      parallelism: makespan > 0 ? Number((work / makespan).toFixed(2)) : 0,
      depth: Math.max(0, ...level.values()),
    },
  };
}
```

// compiler/prompts.ts — planner / joiner prompts and observation lines, whole file.
// plannerMessages states the chunk contract to the model; joinerMessages asks
// for a verdict (finish | replan); observe renders one completed node.

compiler/prompts.ts
```ts
// Planner and joiner prompts. The planner emits the whole DAG in one call
// (no per-step LLM round trip); the joiner reads every result and either
// answers or asks for a replan with a stated reason.
import { safeStringify } from "../tools.ts";
import { truncate } from "../toolbox/util.ts";
import type { NodeRun } from "./types.ts";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

export function plannerMessages(question: string, catalog: string[], observations: string[], maxNodes: number): Msg[] {
  const system = [
    "You are a planning compiler. Translate the task into a DAG of tool calls that a runtime executes in parallel.",
    "Reply with JSON only, no prose:",
    '{"nodes":[{"id":"n1","tool":"<name>","args":{...}}, ...]}',
    "Rules:",
    "- ids are n1, n2, … and unique across rounds (continue numbering after earlier rounds).",
    '- To pass a result forward, set an argument to "$n1" (whole value, typed) or "$n1.field[0].x" (a path into it), or embed "${n1.field}" inside a string.',
    "- A node depends only on the nodes it references. Calls that do not consume each other's output must not reference each other: they run concurrently.",
    "- Earlier-round results can be referenced by their ids.",
    "- Use only the tools listed, with their exact argument names. Never call a tool to write the final answer.",
    `- At most ${maxNodes} nodes. Prefer the fewest calls that fully answer the task. If no tool is needed, return {"nodes":[]}.`,
    "",
    "Tools:",
    ...catalog.map((l) => `- ${l}`),
  ].join("\n");
  const user = observations.length
    ? `Task: ${question}\n\nEarlier rounds:\n${observations.join("\n\n")}\n\nPlan only what is still missing.`
    : `Task: ${question}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function joinerMessages(question: string, observations: string[], mustFinish: boolean): Msg[] {
  const system = [
    "You are the joiner of a planning compiler. Tool results for the task are below.",
    "Reply with JSON only:",
    '{"action":"finish","answer":"<complete answer for the user>"}',
    mustFinish
      ? "This is the final round: answer with what the results support and state plainly what they do not."
      : 'or {"action":"replan","reason":"<what is missing or failed and how to get it>"} when the results cannot support a correct answer.',
    "Ground every claim in the results; never invent values a tool did not return.",
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: `Task: ${question}\n\n${observations.join("\n\n") || "(no tool results)"}` }];
}

/** One executed node as the planner and joiner see it. */
export function observe(r: NodeRun): string {
  const call = `${r.id} = ${r.tool}(${truncate(safeStringify(r.args), 400)})`;
  return r.status === "ok" ? `${call} → ${truncate(safeStringify(r.result), 1500)}` : `${call} → ${r.status} ${r.code ?? ""}: ${r.error ?? ""}`;
}
```

// compiler/retrieve.ts — tool retrieval, whole file.
// bm25Rank over tool names/descriptions, retrieveTools (explicit, admin,
// fallback), and signatureLine for the catalog the planner sees.

compiler/retrieve.ts
```ts
// Tool retrieval: Okapi BM25 (Robertson & Zaragoza 2009) over each tool's
// name, aliases, description and parameter text, so the planner sees the
// k relevant signatures instead of the whole registry.
import { listTools, resolveTool } from "../tools.ts";
import { isObj, tokenize, truncate } from "../toolbox/util.ts";
import type { Json, ToolSpec } from "../toolbox/types.ts";

const K1 = 1.2;
const B = 0.75;

function docText(t: ToolSpec): string {
  const props = isObj(t.parameters.properties) ? t.parameters.properties : {};
  const params = Object.entries(props).map(([k, p]) => `${k} ${isObj(p) && typeof p.description === "string" ? p.description : ""}`);
  return [t.name.replace(/_/g, " "), ...(t.aliases ?? []).map((a) => a.replace(/_/g, " ")), t.kind, t.description, ...params].join(" ");
}

export function bm25Rank(query: string, tools: readonly ToolSpec[]): Array<{ name: string; score: number }> {
  const docs = tools.map((t) => tokenize(docText(t)));
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(tokenize(query))];
  const N = docs.length;
  return tools
    .map((t, i) => {
      const tf = new Map<string, number>();
      for (const w of docs[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
      let score = 0;
      for (const w of q) {
        const f = tf.get(w);
        if (!f) continue;
        const n = df.get(w)!;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * docs[i].length / avg));
      }
      return { name: t.name, score: Number(score.toFixed(4)) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Explicit names always win; else BM25 top-k with positive score; else the fallback set. */
export function retrieveTools(query: string, o: { k: number; admin: boolean; explicit?: string[]; fallback: string[] }): ToolSpec[] {
  const pool = listTools().filter((t) => o.admin || !t.admin);
  const pick = new Map<string, ToolSpec>();
  for (const name of o.explicit ?? []) {
    const t = resolveTool(name).tool;
    if (t && (o.admin || !t.admin)) pick.set(t.name, t);
  }
  if (pick.size === 0) {
    for (const r of bm25Rank(query, pool)) {
      if (pick.size >= o.k || r.score <= 0) break;
      pick.set(r.name, pool.find((t) => t.name === r.name)!);
    }
  }
  if (pick.size === 0) {
    for (const name of o.fallback.slice(0, o.k)) {
      const t = resolveTool(name).tool;
      if (t && (o.admin || !t.admin)) pick.set(t.name, t);
    }
  }
  return [...pick.values()];
}

function typeOf(p: unknown): string {
  if (!isObj(p)) return "any";
  if (Array.isArray(p.enum)) return p.enum.slice(0, 8).map((e) => JSON.stringify(e)).join("|");
  if (p.type === "array") return `${typeOf(p.items)}[]`;
  return Array.isArray(p.type) ? p.type.join("|") : typeof p.type === "string" ? p.type : "any";
}

/** Compact TypeScript-like signature: a fraction of the tokens of raw JSON Schema. */
export function signatureLine(t: ToolSpec): string {
  const schema = t.parameters as Json;
  const props = isObj(schema.properties) ? schema.properties : {};
  const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  const args = Object.entries(props).map(([k, p]) => `${k}${req.has(k) ? "" : "?"}: ${typeOf(p)}`).join(", ");
  return `${t.name}(${args}) — ${truncate(t.description.replace(/\s+/g, " "), 200)}`;
}
```

// compiler/index.ts — the compiler itself, whole file.
// retrieve -> K samples -> MBR -> DAG -> join (finish | replan). One planner
// round trip replaces the depth-sequential round trips ReAct needs.

compiler/index.ts
```ts
// Agent compiler: retrieve → K plan samples → MBR → DAG
// execution → join (finish | replan). One planner round trip replaces
// the `depth` sequential round trips ReAct needs for the same DAG.
import { isStatefulTool, safeStringify } from "../tools.ts";
import { lastJson, stripThinking } from "./json.ts";
import { isObj } from "../toolbox/util.ts";
import { MAX_NODES } from "./plan.ts";
import { samplePlans, TEMPS } from "./sample.ts";
import { runPlan } from "./schedule.ts";
import type { CompileOptions, CompileResult, NodeRun, Round, RunMetrics } from "./types.ts";
import { retrieveTools, signatureLine } from "./retrieve.ts";
import { joinerMessages, observe, plannerMessages } from "./prompts.ts";

export type * from "./types.ts";

const clampInt = (v: unknown, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Math.round(typeof v === "number" && Number.isFinite(v) ? v : d)));

const isVerdict = (v: unknown) => isObj(v) && (v.action === "finish" || v.action === "replan" || "answer" in v);

export async function compile(o: CompileOptions): Promise<CompileResult> {
  const started = performance.now();
  const samples = clampInt(o.samples, 1, TEMPS.length, 3);
  const maxRounds = clampInt(o.rounds, 1, 3, 2);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("compile budget exhausted")), clampInt(o.budgetMs, 1_000, 600_000, 120_000));
  o.signal?.addEventListener("abort", () => ctrl.abort(o.signal!.reason), { once: true });
  const tools = retrieveTools(o.question, { k: clampInt(o.k, 1, 40, 12), admin: o.admin ?? false, explicit: o.tools, fallback: o.fallbackTools ?? [] });
  const catalog = tools.map(signatureLine);
  const results = new Map<string, unknown>();
  const toolOfPrior = new Map<string, string>();
  const observations: string[] = [];
  const rounds: Round[] = [];
  let llm = 0;
  let toolCalls = 0;
  let reactTrips = 0;
  let compilerTrips = 0;
  let answer = "";

  try {
    for (let round = 0; round < maxRounds; round++) {
      const last = round === maxRounds - 1;
      const msgs = plannerMessages(o.question, catalog, observations, MAX_NODES);
      const sampled = await samplePlans(o.complete, msgs, samples, new Set(results.keys()), (id) => toolOfPrior.get(id), ctrl.signal);
      llm += samples;
      compilerTrips++;
      const { candidates } = sampled;
      let runs: NodeRun[] = [];
      let metrics: RunMetrics | null = null;

      if (sampled.plan) {
        const plan = sampled.plan;
        const out = await runPlan(plan, results, {
          exec: o.exec,
          concurrency: clampInt(o.concurrency, 1, 16, 6),
          estimateMs: o.estimateMs ?? (() => 50),
          stateful: isStatefulTool,
          signal: ctrl.signal,
        });
        runs = out.runs;
        metrics = out.metrics;
        toolCalls += runs.filter((r) => r.status !== "skipped").length;
        reactTrips += metrics.depth;
        for (const n of plan.nodes) toolOfPrior.set(n.id, n.tool);
        observations.push(`Round ${round + 1}:\n${runs.map(observe).join("\n") || "(plan used no tools)"}`);
      } else {
        observations.push(`Round ${round + 1}: no valid plan.\n${candidates.flatMap((c) => c.errors).slice(0, 12).join("\n")}`);
      }

      // A joiner reply with no verdict JSON (a reasoner that ran out of tokens) gets one retry on another lane.
      let joined: { content: string; model?: string } = { content: "" };
      let v: unknown;
      for (let attempt = 0; attempt < 2 && v === undefined; attempt++) {
        llm++;
        compilerTrips++;
        joined = await o.complete(joinerMessages(o.question, observations, last), { temperature: 0, max_tokens: 3000, signal: ctrl.signal, attempt });
        v = lastJson(joined.content, isVerdict);
      }
      const replan = !last && isObj(v) && v.action === "replan";
      const reason = isObj(v) && typeof v.reason === "string" ? v.reason : undefined;
      rounds.push({
        candidates,
        selected: sampled.selected,
        consensus: sampled.consensus,
        runs,
        metrics,
        join: { action: replan ? "replan" : "finish", reason, model: joined.model },
      });
      if (replan) {
        observations.push(`Joiner asked for a replan: ${reason ?? "results insufficient"}`);
        continue;
      }
      const a = isObj(v) && "answer" in v ? v.answer : undefined;
      answer = a === undefined ? stripThinking(joined.content) : typeof a === "string" ? a : safeStringify(a);
      break;
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    answer,
    tools: tools.map((t) => t.name),
    rounds,
    // ReAct spends one sequential LLM round trip per DAG level plus the final answer; the compiler spends plan + join per round.
    usage: { llm_calls: llm, tool_calls: toolCalls, react_round_trips: reactTrips + 1, compiler_round_trips: compilerTrips },
    ms: Math.round(performance.now() - started),
  };
}
```

// routes/agent-run.ts — POST /v1/agent/run, whole file (440 lines).
// The other existing answer to "break it into chunks": plan -> up to 4 parallel
// workers -> verify -> one bounded retry of failed workers -> synthesize, all
// streamed as AG-UI events. Worth reading against host/decompose.ts +
// host/execute.ts: same idea, different state machine.

routes/agent-run.ts
```ts
// routes/agent-run.ts — bounded multi-agent orchestration over this router's
// own chat plane. main.ts calls registerAgentRun() to attach the route.
//
// POST /v1/agent/run
//   PLAN       1 chat call  → JSON plan of ≤ 4 independent subtasks
//   WORKERS    ≤ 4 chat calls in parallel (tools:"auto"), one per subtask
//   VERIFY     1 chat call  → pass/fail; on fail, failed workers re-run ONCE
//   RETRY      ≤ 4 chat calls (only the failed workers, only once)
//   SYNTHESIZE 1 chat call  → the final answer
//
// Hard bound: 1 + 4 + 1 + 4 + 1 = 11 chat calls worst case, typically 7.
// Every sub-call goes in-process through honoApp.request (the ops.ts
// /v1/agent/compile precedent), so runs inherit routing, learning, quota,
// free-tier accounting and traces instead of bypassing them.
//
// Degradation is never dressed up as an answer: any sub-call that comes back
// degraded fails the whole run honestly (status "failed" / RUN_ERROR) rather
// than letting placeholder text flow into the synthesis.

import { honoApp, kv, SSE_HEADERS } from "../state.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatMessage = { role: string; content: string };

type ToolExec = Record<string, unknown>;

type ChatResult = {
  content: string;
  model: string;
  degraded: boolean;
  toolsExecuted: ToolExec[];
};

type Subtask = { id: string; title: string; detail: string };

type Step = {
  name: string;
  status: "completed" | "failed";
  ms: number;
  tools_executed?: ToolExec[];
};

type RunState = {
  plan: Subtask[];
  steps: Step[];
  chatCalls: number;
};

type Hooks = {
  stepStarted?: (name: string) => void;
  stepFinished?: (step: Step) => void;
};

// Minimal structural view of the Hono context this module needs.
type ChatCtx = {
  req: {
    header: (name: string) => string | undefined;
    raw: { signal: AbortSignal };
  };
};

/** A sub-call came back degraded — no upstream really answered. */
export class DegradedError extends Error {
  readonly code = "upstream_degraded";
  constructor() {
    super("upstream_degraded");
    this.name = "DegradedError";
  }
}

// ---------------------------------------------------------------------------
// Internal chat call — the canonical sibling-module contract (see ops.ts).
// Forwards ONLY the caller's identity/billing headers, the request's
// traceparent when present, a normalized x-forwarded-for, and an incremented
// x-kono-depth so nested runs stay visible (and bounded) downstream.
// ---------------------------------------------------------------------------

async function internalChat(
  c: ChatCtx,
  opts: { model: string; messages: ChatMessage[]; signal?: AbortSignal; tools?: string },
): Promise<ChatResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const h of ["authorization", "x-admin-secret", "x-kono-session", "x-session-id"]) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }
  const traceparent = c.req.header("traceparent");
  if (traceparent) headers["traceparent"] = traceparent;
  headers["x-forwarded-for"] = c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
  const depth = Number.parseInt(c.req.header("x-kono-depth") ?? c.req.header("x-nokey-depth") ?? "0", 10);
  headers["x-kono-depth"] = String((Number.isFinite(depth) ? depth : 0) + 1);

  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };
  if (opts.tools) payload.tools = opts.tools;

  const res = await honoApp.request("/v1/chat/completions", {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) {
    throw new Error(`chat call failed: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (res.headers.get("x-kono-degraded")) throw new DegradedError();
  const j = await res.json() as {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    kono?: { degraded?: unknown; tools_executed?: unknown };
  };
  if (j.kono?.degraded === true) throw new DegradedError();
  const content = j.choices?.[0]?.message?.content;
  return {
    content: typeof content === "string" ? content : "",
    model: typeof j.model === "string" ? j.model : opts.model,
    degraded: false,
    toolsExecuted: Array.isArray(j.kono?.tools_executed) ? j.kono.tools_executed as ToolExec[] : [],
  };
}

// ---------------------------------------------------------------------------
// Small parsing helpers. Model output is untrusted text: a bad plan falls
// back to "just do the goal", a bad verdict counts as a pass — a formatting
// slip by one sub-call must never fail the whole run.
// ---------------------------------------------------------------------------

function extractJson(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  return a >= 0 && b > a ? tryParse(text.slice(a, b + 1)) : null;
}

function parsePlan(text: string, goal: string): Subtask[] {
  const parsed = extractJson(text);
  const raw = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
  const subtasks: Subtask[] = [];
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : "";
    const detail = typeof o.detail === "string" && o.detail.trim() ? o.detail.trim() : title;
    if (!detail) continue;
    subtasks.push({ id: `st_${subtasks.length + 1}`, title: title || detail.slice(0, 80), detail });
  }
  // Fallback: one subtask that IS the goal — the run proceeds, just un-split.
  return subtasks.length ? subtasks : [{ id: "st_1", title: "Complete the goal", detail: goal }];
}

function parseVerdict(text: string, plan: Subtask[]): { fail: boolean; failedIds: string[] } {
  const parsed = extractJson(text);
  if (!parsed) return { fail: false, failedIds: [] }; // unparseable → pass
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict.toLowerCase() : "";
  const fail = verdict === "fail" || verdict === "failed" || parsed.pass === false;
  if (!fail) return { fail: false, failedIds: [] };
  const ids = Array.isArray(parsed.failed)
    ? parsed.failed.filter((x): x is string => typeof x === "string" && plan.some((s) => s.id === x))
    : [];
  // A fail with no named culprits re-runs everything once — still in budget.
  return { fail: true, failedIds: ids.length ? ids : plan.map((s) => s.id) };
}

function toolName(t: ToolExec): string {
  return typeof t.name === "string" ? t.name : typeof t.tool === "string" ? t.tool : "unknown_tool";
}

// ---------------------------------------------------------------------------
// The run itself. Mutates `state` (plan / steps / chatCalls) as it goes so a
// failed run can still report honest partial progress.
// ---------------------------------------------------------------------------

async function executeRun(args: {
  c: ChatCtx;
  goal: string;
  model: string;
  signal?: AbortSignal;
  state: RunState;
  hooks?: Hooks;
}): Promise<{ output: string; model: string }> {
  const { c, goal, model, signal, state, hooks } = args;
  const call = (messages: ChatMessage[], tools?: string) => {
    state.chatCalls++;
    return internalChat(c, { model, messages, signal, tools });
  };
  const timed = async <T>(name: string, fn: () => Promise<{ value: T; tools?: ToolExec[] }>): Promise<T> => {
    hooks?.stepStarted?.(name);
    const t0 = performance.now();
    try {
      const { value, tools } = await fn();
      const step: Step = { name, status: "completed", ms: Math.round(performance.now() - t0) };
      if (tools && tools.length) step.tools_executed = tools;
      state.steps.push(step);
      hooks?.stepFinished?.(step);
      return value;
    } catch (err) {
      const step: Step = { name, status: "failed", ms: Math.round(performance.now() - t0) };
      state.steps.push(step);
      hooks?.stepFinished?.(step);
      throw err;
    }
  };

  // PLAN ————————————————————————————————————————————————————————————————
  const planText = await timed("plan", async () => ({ value: (await call([
    {
      role: "system",
      content: "You are a planning agent. Split the user's goal into at most 4 INDEPENDENT subtasks " +
        "that can be executed in parallel and later combined. Respond with ONLY a JSON object: " +
        '{"subtasks":[{"title":"short title","detail":"self-contained instructions"}]}. No prose.',
    },
    { role: "user", content: goal },
  ])).content }));
  state.plan = parsePlan(planText, goal);

  // WORKERS —————————————————————————————————————————————————————————————
  type WorkerOut = { subtask: Subtask; content: string; tools: ToolExec[] };
  const runWorker = (subtask: Subtask, stepName: string): Promise<WorkerOut> =>
    timed(stepName, async () => {
      const r = await call([
        {
          role: "system",
          content: "You are a worker agent executing one subtask of a larger goal. " +
            "Use tools when they help. Return a complete, self-contained result for your subtask only.",
        },
        { role: "user", content: `Goal: ${goal}\n\nYour subtask: ${subtask.title} — ${subtask.detail}` },
      ], "auto");
      return { value: { subtask, content: r.content, tools: r.toolsExecuted }, tools: r.toolsExecuted };
    });
  const workers: WorkerOut[] = await Promise.all(
    state.plan.map((s) => runWorker(s, `worker:${s.id}`)),
  );
  const combined = () =>
    workers.map((w) => `## ${w.subtask.id} — ${w.subtask.title}\n${w.content}`).join("\n\n");

  // VERIFY (+ one bounded retry of the failed workers) ————————————————————
  const verdictText = await timed("verify", async () => ({ value: (await call([
    {
      role: "system",
      content: "You are a strict verifier. Judge whether the combined worker output fully and " +
        'correctly satisfies the goal. Respond with ONLY a JSON object: {"verdict":"pass"} or ' +
        '{"verdict":"fail","failed":["st_1"],"notes":"what is wrong"}. No prose.',
    },
    { role: "user", content: `Goal: ${goal}\n\nCombined worker output:\n${combined()}` },
  ])).content }));
  const verdict = parseVerdict(verdictText, state.plan);
  if (verdict.fail) {
    const targets = state.plan.filter((s) => verdict.failedIds.includes(s.id));
    const retried = await Promise.all(targets.map((s) => runWorker(s, `retry:${s.id}`)));
    for (const r of retried) {
      const i = workers.findIndex((w) => w.subtask.id === r.subtask.id);
      if (i >= 0) workers[i] = r;
    }
  }

  // SYNTHESIZE ——————————————————————————————————————————————————————————
  const synth = await timed("synthesize", async () => {
    const r = await call([
      {
        role: "system",
        content: "You are the synthesis agent. Using the verified worker results, write the final " +
          "answer to the user's goal. Be complete and direct; do not mention the internal process.",
      },
      { role: "user", content: `Goal: ${goal}\n\nWorker results:\n${combined()}` },
    ]);
    return { value: r, tools: r.toolsExecuted };
  });
  return { output: synth.content, model: synth.model };
}

// Best-effort run record in KV (inspectable later; never blocks the answer).
function persistRun(runId: string, record: Record<string, unknown>): void {
  kv.set(["agent_runs", runId], record, { expireIn: 7 * 86_400_000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerAgentRun() {
  honoApp.post("/v1/agent/run", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      input?: unknown;
      messages?: unknown;
      model?: unknown;
      stream?: unknown;
    };

    // Goal: explicit input wins, else the last user message's content.
    let goal = typeof body.input === "string" ? body.input.trim() : "";
    if (!goal && Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i] as { role?: unknown; content?: unknown };
        if (m?.role === "user" && typeof m.content === "string") {
          goal = m.content.trim();
          break;
        }
      }
    }
    if (!goal) {
      return c.json({ error: { message: "input (or a user message) is required" } }, 400);
    }
    const model = typeof body.model === "string" && body.model ? body.model : "free:smart";
    const runId = `run_${crypto.randomUUID()}`;
    const state: RunState = { plan: [], steps: [], chatCalls: 0 };
    const wantsStream = body.stream === true ||
      (c.req.header("accept") ?? "").includes("text/event-stream");

    // ——— Non-streaming: run to completion, answer once. ———————————————————
    if (!wantsStream) {
      try {
        const { output, model: outModel } = await executeRun({
          c, goal, model, signal: c.req.raw.signal, state,
        });
        const result = {
          id: runId,
          object: "agent.run",
          status: "completed",
          model: outModel,
          output,
          plan: { subtasks: state.plan },
          steps: state.steps,
          usage: { chat_calls: state.chatCalls },
        };
        persistRun(runId, result);
        return c.json(result);
      } catch (err) {
        const degraded = err instanceof DegradedError;
        const failed = {
          id: runId,
          object: "agent.run",
          status: "failed",
          model,
          output: null,
          error: degraded ? "upstream_degraded" : "run_failed",
          plan: { subtasks: state.plan },
          steps: state.steps,
          usage: { chat_calls: state.chatCalls },
        };
        persistRun(runId, failed);
        return c.json(failed);
      }
    }

    // ——— Streaming: AG-UI events over SSE (traces.ts stream pattern). ——————
    // Tool events are synthesized AFTER each step's chat call returns, from
    // that call's kono.tools_executed, labeled in order — by design, since
    // the in-process chat call only reports tools once it completes.
    const enc = new TextEncoder();
    const ac = new AbortController();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (s: string) => {
          try {
            ctrl.enqueue(enc.encode(s));
          } catch {
            stop();
          }
        };
        const sendEvent = (ev: Record<string, unknown>) => send(`data: ${JSON.stringify(ev)}\n\n`);
        const hb = setInterval(() => send(": hb\n\n"), 15_000);
        stop = () => {
          clearInterval(hb);
          ac.abort();
        };
        c.req.raw.signal.addEventListener("abort", () => {
          stop();
          try {
            ctrl.close();
          } catch { /* already closed */ }
        }, { once: true });

        const hooks: Hooks = {
          stepStarted: (name) => sendEvent({ type: "STEP_STARTED", stepName: name }),
          stepFinished: (step) => {
            sendEvent({ type: "STEP_FINISHED", stepName: step.name });
            (step.tools_executed ?? []).forEach((t, i) => {
              const toolCallId = `${runId}-${step.name}-${i}`;
              sendEvent({ type: "TOOL_CALL_START", toolCallId, toolCallName: toolName(t) });
              sendEvent({
                type: "TOOL_CALL_RESULT",
                toolCallId,
                content: JSON.stringify({ ok: t.ok ?? true, ms: t.ms ?? 0 }),
              });
            });
          },
        };

        (async () => {
          sendEvent({ type: "RUN_STARTED", threadId: runId, runId });
          try {
            const { output, model: outModel } = await executeRun({
              c, goal, model, signal: ac.signal, state, hooks,
            });
            const messageId = `${runId}-msg`;
            sendEvent({ type: "TEXT_MESSAGE_START", messageId });
            sendEvent({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: output });
            sendEvent({ type: "TEXT_MESSAGE_END", messageId });
            persistRun(runId, {
              id: runId, object: "agent.run", status: "completed", model: outModel,
              output, steps: state.steps, usage: { chat_calls: state.chatCalls },
            });
            sendEvent({ type: "RUN_FINISHED", threadId: runId, runId, result: { output } });
          } catch (err) {
            const degraded = err instanceof DegradedError;
            sendEvent({
              type: "RUN_ERROR",
              message: degraded ? "upstream_degraded" : (err instanceof Error ? err.message : "run_failed"),
              code: degraded ? "upstream_degraded" : "run_failed",
            });
          } finally {
            clearInterval(hb);
            try {
              ctrl.close();
            } catch { /* already closed */ }
          }
        })();
      },
      cancel: () => stop(),
    });
    return new Response(stream, { headers: SSE_HEADERS });
  });
}
```

// trace.ts — spans and trace records, whole file (161 lines).
// startTrace / Span / currentSpan / listTraces / subscribe. The existing
// visibility primitive: what the re-cut reuses as an adapter and replaces as
// the primary record.

trace.ts
```ts
// Request tracing: one span tree per request, kept in an isolate-local ring
// for the admin panel and mirrored to OpenTelemetry, which Deno Deploy
// collects natively (no-op API when OTel is off, e.g. in tests).
import { context, type Span as OSpan, SpanStatusCode, trace as otel } from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";

export type Attr = string | number | boolean;
export type Attrs = Record<string, Attr | undefined>;
export type SpanStatus = "unset" | "ok" | "error";

export interface SpanRec {
  id: string;
  parent: string | null;
  name: string;
  start: number;
  end: number | null;
  status: SpanStatus;
  attrs: Record<string, Attr>;
  events: Array<{ t: number; name: string; attrs?: Record<string, Attr> }>;
  /** Request/response bodies (JSON, capped), for the admin panel only: never exported to OTel. */
  io?: { request?: string; response?: string };
}

export interface TraceRec {
  id: string;
  spans: SpanRec[];
}

export type TraceEvent = { type: "start" | "end" | "event"; trace: string; span: SpanRec };

const RING_MAX = 256;
const IO_MAX = 32_000;
const ring = new Map<string, TraceRec>(); // insertion-ordered: oldest first
const subscribers = new Set<(e: TraceEvent) => void>();
const tracer = otel.getTracer("kono-router");
const als = new AsyncLocalStorage<Span>();
const now = () => performance.timeOrigin + performance.now();
const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const INVALID = /^0+$/;

function clean(a: Attrs): Record<string, Attr> {
  const out: Record<string, Attr> = {};
  for (const [k, v] of Object.entries(a)) if (v !== undefined && !(typeof v === "number" && !Number.isFinite(v))) out[k] = v;
  return out;
}

function publish(type: TraceEvent["type"], trace: string, span: SpanRec) {
  for (const fn of subscribers) {
    try {
      fn({ type, trace, span });
    } catch { /* a broken subscriber must not break the request */ }
  }
}

export class Span {
  readonly rec: SpanRec;
  constructor(readonly traceId: string, readonly otelSpan: OSpan, name: string, parent: string | null, attrs: Attrs) {
    const sc = otelSpan.spanContext();
    this.rec = {
      id: INVALID.test(sc.spanId) ? hex(8) : sc.spanId,
      parent,
      name,
      start: now(),
      end: null,
      status: "unset",
      attrs: clean(attrs),
      events: [],
    };
    ring.get(traceId)?.spans.push(this.rec);
    publish("start", traceId, this.rec);
  }

  child(name: string, attrs: Attrs = {}): Span {
    const ctx = otel.setSpan(context.active(), this.otelSpan);
    return new Span(this.traceId, tracer.startSpan(name, { attributes: clean(attrs) }, ctx), name, this.rec.id, attrs);
  }

  set(attrs: Attrs): this {
    const a = clean(attrs);
    Object.assign(this.rec.attrs, a);
    this.otelSpan.setAttributes(a);
    return this;
  }

  /** Keeps a capped JSON copy of the request or response body on this span. */
  io(kind: "request" | "response", value: unknown): void {
    let text: string;
    try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
    if (text.length > IO_MAX) text = text.slice(0, IO_MAX) + `\n… truncated (${text.length} chars)`;
    (this.rec.io ??= {})[kind] = text;
    publish("event", this.traceId, this.rec);
  }

  event(name: string, attrs: Attrs = {}): void {
    const a = clean(attrs);
    this.rec.events.push({ t: now(), name, attrs: a });
    this.otelSpan.addEvent(name, a);
    publish("event", this.traceId, this.rec);
  }

  end(status: SpanStatus = "ok", attrs: Attrs = {}): void {
    if (this.rec.end !== null) return;
    this.set(attrs);
    this.rec.end = now();
    this.rec.status = status;
    if (status !== "unset") {
      this.otelSpan.setStatus({ code: status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR, message: String(attrs.error ?? "") });
    }
    this.otelSpan.end();
    publish("end", this.traceId, this.rec);
  }

  /** Runs fn with this span active for OTel auto-instrumentation (fetch) and currentSpan(). */
  run<T>(fn: () => T): T {
    return context.with(otel.setSpan(context.active(), this.otelSpan), () => als.run(this, fn));
  }

  get traceparent(): string {
    return `00-${this.traceId}-${this.rec.id}-01`;
  }

  get ms(): number {
    return (this.rec.end ?? now()) - this.rec.start;
  }
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Opens a root span. Joins the caller's W3C trace when OTel is off; OTel's own context wins otherwise. */
export function startTrace(name: string, attrs: Attrs = {}, traceparent?: string | null): Span {
  const o = tracer.startSpan(name, { attributes: clean(attrs) }, context.active());
  const sc = o.spanContext();
  const inbound = traceparent ? TRACEPARENT.exec(traceparent.trim().toLowerCase()) : null;
  const traceId = !INVALID.test(sc.traceId) ? sc.traceId : inbound && !INVALID.test(inbound[1]) ? inbound[1] : hex(16);
  // A joined trace already in the ring keeps its spans (in-process sub-requests nest under their parent).
  if (!ring.has(traceId)) ring.set(traceId, { id: traceId, spans: [] });
  while (ring.size > RING_MAX) ring.delete(ring.keys().next().value!);
  const span = new Span(traceId, o, name, inbound?.[2] ?? null, attrs);
  return span;
}

export const currentSpan = (): Span | undefined => als.getStore();

export function getTrace(id: string): TraceRec | undefined {
  return ring.get(id);
}

export function listTraces(limit = 100): Array<{ id: string; root: SpanRec; spans: number; errors: number }> {
  const out = [];
  for (const t of [...ring.values()].reverse()) {
    if (out.length >= limit) break;
    const root = t.spans[0];
    if (root) out.push({ id: t.id, root, spans: t.spans.length, errors: t.spans.filter((s) => s.status === "error").length });
  }
  return out;
}

export function subscribe(fn: (e: TraceEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
```

---

# Part B — the re-cut

## The shape

```
                       ┌─────────────── ports (6) ───────────────┐
                       │ candidates  models  tools  prompts     │
                       │ clock  ids  events                     │
                       └───────────────────────────────────────┘
intake ──► build ──► decompose ──► execute ──► assemble
 HostRequest  BuiltRequest  ChunkPlan  ChunkResult[]  Assembled
      │           │            │           │             │
      └───────────┴────────────┴───────────┴─────────────┘
                        Ledger → HostEvent[] → RouteReport
```

Stage by stage, and what each one *owns*:

| Stage | Input | Output | Owns | Can throw? |
| --- | --- | --- | --- | --- |
| `intake` | raw body, `HostContext`, limits | `HostRequest` | roles, content flattening, clamps, budget, mode/task classification, notes | no |
| `build` | `HostRequest`, ports, ledger | `BuiltRequest` + `BuildManifest` | tool selection, router system text, candidate ranking, budget split | no |
| `decompose` | `BuiltRequest` | `ChunkPlan` | the planner call, validation, one repair, fallback | no |
| `execute` | `BuiltRequest`, `ChunkPlan` | `ChunkResult[]`, `Assembled` | dependencies, concurrency, deadlines, one retry, ref substitution, assembly | only on caller abort |
| `assemble` | (inside `execute`) | `Assembled` | terminal-answer collapse, synthesis, degraded text | only on caller abort |

## The invariants the interfaces exist to enforce

1. **One abort path.** Every call takes a signal derived from the master
   signal (`withDeadline`), so a caller disconnect, a budget expiry and an
   internal timeout are indistinguishable downstream and there is exactly one
   place to clean up.
2. **Bounded everything.** `RequestLimits` is the entire budget surface: model
   calls, chunks, concurrency, per-chunk ms, per-tool ms, output cap, tools.
   Every loop in the spine has a constant bound; none of them are `while(true)`.
3. **The planner cannot execute.** `Chunk.tool` is checked against the tools this
   request actually declared; `Chunk.args` refs are checked against
   already-accepted chunks; `needs` may only point backwards, so the scheduler
   never has to detect a cycle.
4. **Degrade, never fabricate.** A failed chunk is a `ChunkResult` with a code;
   no ok chunks yields an explicit "nothing was fabricated" body, never prose
   invented by the router.
5. **Every decision is an event.** `build` emits the tool selection, the prompt
   part digests and the ranking head; `decompose` emits one event per accepted
   chunk; `execute` emits start/decision/retry/error per chunk with model, tuple,
   ms and token counts; `assemble` emits which path it took.
6. **Models cannot smuggle state.** `ModelPort.complete` is buffered and
   explicit: purpose, pinned candidate, deadline, attempt. There is no
   `fetch` in the spine and no provider-specific shape above the port.

## What is here for now

Exactly what was asked: the interfaces, and the minimum that takes a simple
request end to end — build up, then break down into chunks the AI writes, then
run and assemble them. What is *not* here yet is listed in Part C.

## The files, in the order you would read them

`contracts` (the shapes) → `support` (helpers) → `ledger` (visibility) →
`intake` → `build` → `decompose` → `execute` → `host` (wiring) → `index`
(surface) → `adapters/memory` (a runnable host) → the test that proves it.

// host/contracts.ts — every type the spine passes between stages. Types only:
// no imports, no runtime, no I/O. This is the file to read first: if a piece of
// state is not in here, it does not cross a stage boundary.

host/contracts.ts
```ts
// host/contracts.ts — every type the host-side message router passes between
// stages. Types only: no imports, no runtime, no I/O.
//
// The spine is fixed and five stages long:
//
//   intake → build → decompose → execute → assemble
//   accept   grow a   ask the AI  run the   one answer
//   + tame   full     for the     tiny      out of the
//   the      request  chunk list  chunks    chunk outputs
//   request
//
// Every stage takes the previous stage's value plus the Ledger, returns a
// value plus notes, and can only throw when the caller aborts. That is the
// whole robustness contract: a malformed body, a broken planner, a dead tool
// and an empty catalog are all *values*, never exceptions.

export type Json = Record<string, unknown>;

export type Role = "system" | "user" | "assistant" | "tool";

/** Routing lanes — same vocabulary as the existing engine so the two can share
 *  a catalog, a breaker table and a learning corpus. */
export type RoutingMode = "fast" | "smart" | "code" | "reasoning";

/** What the request is *for*. Drives tool exposure, chunk shape and ranking. */
export type TaskClass =
  | "chat"
  | "code"
  | "math"
  | "json"
  | "tool"
  | "vision"
  | "reasoning";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

// ---------------------------------------------------------------------------
// 1. INTAKE — the caller's bytes, made safe to route.
// ---------------------------------------------------------------------------

export type Severity = "info" | "warn" | "degrade";

/** One thing the host had to change, guess, or give up on. Notes are the
 *  difference between "it worked" and "we know exactly what it cost". */
export interface Note {
  code: string;
  detail: string;
  severity: Severity;
  stage?: StageName;
}

export interface HostContext {
  /** Tenant / API-key namespace. Scopes tools, ranking and caching. */
  tenant: string;
  traceparent?: string | null;
  /** Caller-supplied wall clock for the whole request, in ms. */
  budgetMs?: number;
  /** Client disconnect or gateway timeout. */
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Json;
  source: "client" | "builtin";
}

export interface SamplingParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  toolChoice?: unknown;
  responseFormat?: Json;
  reasoningEffort?: string;
  parallelToolCalls?: boolean;
}

export interface RequestLimits {
  /** Messages kept after intake (system messages are always kept). */
  maxMessages: number;
  /** Total characters across all message content. */
  maxRequestChars: number;
  /** Characters kept per message before middle-elision. */
  maxMessageChars: number;
  /** Model round trips the whole request may spend. */
  maxModelCalls: number;
  /** Chunks the planner may hand back. */
  maxChunks: number;
  /** Chunks allowed in flight at once. */
  maxConcurrency: number;
  /** Per-chunk generation budget. */
  maxChunkMs: number;
  /** Per-tool-execution budget. */
  maxToolMs: number;
  /** Characters kept from one chunk's output. */
  maxChunkOutputChars: number;
  /** Declared tools per request (client + builtin). */
  maxTools: number;
}

export type ToolsRequest = "none" | "auto" | "explicit";

export interface HostRequest {
  id: string;
  /** Epoch ms at which intake started. Every event is relative to this. */
  startedAt: number;
  tenant: string;
  traceparent: string;
  /** Exactly as the caller sent it (`free:auto`, a model id, …). */
  model: string;
  mode: RoutingMode;
  taskClass: TaskClass;
  stream: boolean;
  messages: ChatMessage[];
  /** True when any message carried an image part. */
  hasImages: boolean;
  clientTools: ToolDecl[];
  toolsRequested: ToolsRequest;
  params: SamplingParams;
  budgetMs: number;
  limits: RequestLimits;
  /** Composed caller signal + request deadline. */
  signal: AbortSignal;
  /** Everything intake changed, clamped, dropped or guessed. */
  notes: Note[];
  /** The body after legacy-field aliasing. Never trusted again. */
  raw: Json;
  /** Set when the caller explicitly disabled decomposition. */
  decompose?: boolean;
}

// ---------------------------------------------------------------------------
// 2. CANDIDATES — "who could answer this", asked, never assumed.
// ---------------------------------------------------------------------------

export interface CandidateRef {
  /** Stable tuple id: providerId::modelId. */
  tupleId: string;
  providerId: string;
  modelId: string;
  /** Ranking score in whatever units the candidate port uses. Higher wins. */
  score: number;
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow: number;
  /** Learned time-to-first-token, for budgeting the hedge. */
  p50TtftMs: number;
}

export interface RankQuery {
  mode: RoutingMode;
  taskClass: TaskClass;
  tenant: string;
  requiresTools: boolean;
  requiresVision: boolean;
  limit: number;
  exclude: string[];
}

export interface CandidatePort {
  rank(q: RankQuery): Promise<CandidateRef[]>;
  /** Last-resort pool when `rank` returns nothing. */
  sweep?(q: RankQuery): Promise<CandidateRef[]>;
}

// ---------------------------------------------------------------------------
// 3. MODEL — one buffered completion, no streaming, no hidden retries.
// ---------------------------------------------------------------------------

export type CallPurpose = "planner" | "repair" | "chunk" | "synthesize";

export interface ModelCall {
  purpose: CallPurpose;
  messages: ChatMessage[];
  /** Pinned candidate. Undefined = the adapter routes it. */
  model?: string;
  tupleId?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
  tools?: ToolDecl[];
  /** Wall clock for this call; the adapter must honour it. */
  deadlineMs: number;
  signal: AbortSignal;
  /** Stamped on every ledger event the adapter emits. */
  chunkId?: string;
  attempt: number;
}

export interface ModelReply {
  content: string;
  model: string;
  tupleId?: string;
  finish?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  ttftMs?: number;
  ms: number;
  /** Endpoints tried before this reply (visibility into the hedge). */
  upstreamAttempts: number;
}

export interface ModelPort {
  complete(call: ModelCall): Promise<ModelReply>;
}

// ---------------------------------------------------------------------------
// 4. TOOLS — executed by the host, never by the model.
// ---------------------------------------------------------------------------

export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
  ms: number;
  /** True when the host truncated the value to the output cap. */
  truncated?: boolean;
}

export interface ToolRunOptions {
  signal: AbortSignal;
  tenant: string;
  timeoutMs: number;
}

export interface ToolPort {
  list(): ToolDecl[];
  has(name: string): boolean;
  execute(name: string, args: Json, o: ToolRunOptions): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// 5. PROMPT — the only place router-authored text enters the request.
// ---------------------------------------------------------------------------

export interface PromptContributor {
  /** ASCK-L strategy variant (routing mode / arm prefix). */
  variant?(r: HostRequest): Promise<string | null> | string | null;
  /** Verified lessons for this task class, newest first. */
  lessons?(r: HostRequest): Promise<string[]> | string[];
  /** Session workspace brief: what exists, what is broken. */
  workspaceBrief?(r: HostRequest): Promise<string | null> | string | null;
  /** Tool-use preamble. Defaults to a short built-in text. */
  preamble?(names: string[]): Promise<string> | string;
}

// ---------------------------------------------------------------------------
// 6. BUILD — the manifest is the receipt for every decision build made.
// ---------------------------------------------------------------------------

export interface ToolSelection {
  declared: ToolDecl[];
  /** Builtin names selected by task class. */
  auto: string[];
  dropped: Note[];
}

export interface PromptPart {
  source: "variant" | "lessons" | "workspace" | "preamble" | "client";
  bytes: number;
  digest: string;
  preview: string;
}

export interface BudgetSplit {
  totalMs: number;
  plannerMs: number;
  chunkMs: number;
  synthMs: number;
}

export interface BuildManifest {
  modelRequested: string;
  mode: RoutingMode;
  taskClass: TaskClass;
  candidates: CandidateRef[];
  tools: ToolSelection;
  prompt: PromptPart[];
  params: SamplingParams;
  budget: BudgetSplit;
  limits: RequestLimits;
  notes: Note[];
}

export interface BuiltRequest {
  request: HostRequest;
  /** Ready to send: router system text first, then the caller's messages. */
  messages: ChatMessage[];
  manifest: BuildManifest;
}

// ---------------------------------------------------------------------------
// 7. DECOMPOSE — the chunk plan the AI writes, after validation.
// ---------------------------------------------------------------------------

export type ChunkKind = "answer" | "tool";

export interface Chunk {
  /** ^[a-z][a-z0-9_]{0,23}$ — referenced by later chunks as `$id.path`. */
  id: string;
  title: string;
  kind: ChunkKind;
  /** Required for kind "tool"; must be a declared tool. */
  tool?: string;
  /** Tool arguments. May contain `$id`, `$id/path`, `${id/path}` refs. */
  args?: Json;
  /** Chunk ids that must finish first. Always lower-indexed: no cycles. */
  needs: string[];
  /** kind "answer": the micro-instruction for this chunk. */
  prompt?: string;
  outputCapChars: number;
}

export type PlanSource = "planner" | "fallback";

export interface ChunkPlan {
  requestId: string;
  source: PlanSource;
  rationale: string;
  chunks: Chunk[];
  plannerModel?: string;
  plannerAttempts: number;
  plannerMs: number;
  /** Why candidate chunks were thrown away — visible, not silent. */
  rejects: Note[];
  /** The validation errors that triggered the repair call, if any. */
  repairErrors: string[];
}

// ---------------------------------------------------------------------------
// 8. EXECUTE — one record per chunk, whatever happened to it.
// ---------------------------------------------------------------------------

export type ChunkStatus = "ok" | "failed" | "skipped";

export interface ChunkResult {
  chunk: Chunk;
  status: ChunkStatus;
  /** Normalized text output (tool value stringified, or the answer). */
  output: string;
  /** Raw tool value, for `$id.path` substitution downstream. */
  value?: unknown;
  ms: number;
  attempts: number;
  model?: string;
  error?: string;
  code?: string;
}

export interface Assembled {
  content: string;
  finish: "stop" | "degraded" | "abort";
  modelUsed?: string;
  tupleId?: string;
}

// ---------------------------------------------------------------------------
// 9. VISIBILITY — the event stream is the product, not a debug aid.
// ---------------------------------------------------------------------------

export type StageName =
  | "intake"
  | "build"
  | "rank"
  | "decompose"
  | "chunk"
  | "assemble"
  | "done";

export type Phase = "start" | "end" | "decision" | "retry" | "error" | "info";

export interface HostEvent {
  /** Monotonic per request, starting at 1. Never reordered, never dropped. */
  seq: number;
  requestId: string;
  /** ms since request start. */
  at: number;
  /** Epoch ms. */
  wall: number;
  stage: StageName;
  phase: Phase;
  chunkId?: string;
  attempt?: number;
  model?: string;
  tupleId?: string;
  ok?: boolean;
  ms?: number;
  data?: Json;
}

export type EventSink = (e: HostEvent) => void;

export interface StageSummary {
  stage: StageName;
  events: number;
  ms: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// 10. REPORT — what the model did, and when, in one serializable object.
// ---------------------------------------------------------------------------

export interface RouteReport {
  requestId: string;
  traceparent: string;
  modelRequested: string;
  modelUsed?: string;
  tupleId?: string;
  mode: RoutingMode;
  taskClass: TaskClass;
  planSource: PlanSource;
  stages: StageSummary[];
  modelCalls: number;
  toolCalls: number;
  retries: number;
  errors: number;
  chunks: ChunkResult[];
  notes: Note[];
  totalMs: number;
  budgetMs: number;
  finish: Assembled["finish"];
  /** Human-readable one-screen summary for logs, SSE and the dashboard. */
  explain(): string;
}

export interface HostResponse {
  content: string;
  finish: Assembled["finish"];
  report: RouteReport;
  plan: ChunkPlan;
  events: HostEvent[];
}

// ---------------------------------------------------------------------------
// 11. PORTS — the whole host depends on these six and nothing else.
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export interface IdSource {
  next(prefix: string): string;
}

export interface HostPorts {
  candidates: CandidatePort;
  models: ModelPort;
  tools: ToolPort;
  events?: EventSink;
  clock?: Clock;
  ids?: IdSource;
  prompt?: PromptContributor;
}

export interface HostRouter {
  /** Accept anything, always answer, report everything. */
  handle(raw: unknown, ctx: HostContext): Promise<HostResponse>;
  /** The last report for a request id, if it is still in the ring. */
  report(requestId: string): RouteReport | undefined;
}
```

// host/support.ts — the shared helpers: DEFAULT_LIMITS, clamps, digests,
// middle-elision, extractJson (models wrap JSON in prose), abortable,
// withDeadline, raceSoft, goalText. Small on purpose: anything larger belongs
// to a stage. No Deno/Node globals.

host/support.ts
```ts
// host/support.ts — the handful of helpers every stage shares. Anything larger
// belongs to a stage. Deliberately free of Deno/Node globals so the whole host
// runs unchanged in Deno, Node, workers and tests.

import type {
  ChatMessage,
  Json,
  Note,
  RequestLimits,
  Severity,
  StageName,
} from "./contracts.ts";

export const DEFAULT_LIMITS: RequestLimits = {
  maxMessages: 64,
  maxRequestChars: 96_000,
  maxMessageChars: 24_000,
  maxModelCalls: 10,
  maxChunks: 8,
  maxConcurrency: 4,
  maxChunkMs: 45_000,
  maxToolMs: 30_000,
  maxChunkOutputChars: 8_000,
  maxTools: 48,
};

export function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  return Math.round(clampNum(v, lo, hi, fallback));
}

export function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function note(
  code: string,
  detail: string,
  severity: Severity = "warn",
  stage?: StageName,
): Note {
  return { code, detail, severity, ...(stage ? { stage } : {}) };
}

const encoder = new TextEncoder();

export function byteLen(s: string): number {
  return encoder.encode(s).length;
}

/** FNV-1a 32-bit, hex. Stable across processes: safe in a manifest or a cache key. */
export function digest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function preview(s: string, n = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : `${oneLine.slice(0, n - 1)}…`;
}

/** Middle-elision: keeps the head and the tail, which is what instructions and
 *  code need; the middle of a long paste is the safest thing to lose. */
export function elide(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const keep = Math.max(0, max - 24);
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  return {
    text: `${s.slice(0, head)}\n…[${s.length - keep} chars elided]…\n${tail > 0 ? s.slice(-tail) : ""}`,
    truncated: true,
  };
}

export function tailCap(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…[${s.length - max} chars truncated]`, truncated: true };
}

/** First complete JSON value in `text`. Models wrap JSON in prose, fences and
 *  thinking blocks; the host must never require a clean body. */
export function extractJson(text: string): unknown {
  const start = (() => {
    const obj = text.indexOf("{");
    const arr = text.indexOf("[");
    if (obj < 0) return arr;
    if (arr < 0) return obj;
    return Math.min(obj, arr);
  })();
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function safeStringify(v: unknown, max = 20_000): string {
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v ?? null);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(v);
  }
}

export function isAbort(e: unknown): boolean {
  if (e instanceof Error) {
    return e.name === "AbortError" || /abort|cancel|disconnect/i.test(e.message);
  }
  return false;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return typeof e === "string" ? e : safeStringify(e, 400);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(finish, ms);
    function finish(): void {
      cleanup();
      resolve();
    }
    function cleanup(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort(): void {
      cleanup();
      reject(signal?.reason ?? new Error("ABORTED"));
    }
    if (signal?.aborted) {
      cleanup();
      reject(signal.reason ?? new Error("ABORTED"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Race a promise against an abort signal. The loser is abandoned, not leaked:
 *  callers pass signals down to the underlying work. */
export function abortable<T>(p: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error(`ABORTED: ${label}`));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new Error(`ABORTED: ${label}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** A fresh deadline composed with the caller's signal. The child controller is
 *  always cleaned up, and the timer never outlives the work. */
export async function withDeadline<T>(
  ms: number,
  parent: AbortSignal,
  label: string,
  fn: (signal: AbortSignal, remaining: () => number) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw parent.reason ?? new Error(`ABORTED: ${label}`);
  const ctrl = new AbortController();
  const end = Date.now() + Math.max(0, ms);
  const remaining = () => Math.max(0, end - Date.now());
  const onParent = () => ctrl.abort(parent.reason ?? new Error(`ABORTED: ${label}`));
  parent.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(
    () => ctrl.abort(new Error(`DEADLINE: ${label} exceeded ${Math.round(ms)}ms`)),
    Math.max(1, ms),
  );
  try {
    return await fn(ctrl.signal, remaining);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParent);
  }
}

/** Resolve after `ms` or when `p` settles — whichever comes first. Never throws
 *  and never leaves an unhandled rejection behind. */
export async function raceSoft<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = p.then(
    (v) => ({ v }),
    () => ({ v: undefined as T | undefined }),
  );
  const timeout = new Promise<{ v: T | undefined }>((resolve) => {
    timer = setTimeout(() => resolve({ v: undefined }), Math.max(1, ms));
  });
  try {
    const out = await Promise.race([settled, timeout]);
    return out.v;
  } finally {
    clearTimeout(timer);
  }
}

/** Random-ish but cheap id suffixes for hosts without crypto.randomUUID. */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

export function newTraceparent(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `00-${hex(32)}-${hex(16)}-01`;
}

/** The caller's actual ask, newest last, without assistant/tool chatter. */
export function goalText(messages: ChatMessage[], max = 4_000): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" || m.role === "tool") continue;
    if (typeof m.content === "string" && m.content.trim()) parts.push(m.content.trim());
  }
  return tailCap(parts.slice(-3).join("\n\n"), max).text;
}
```

// host/ledger.ts — the visibility layer. One append-only event list, one
// monotonic seq, two clocks, stage summaries and counters. Every stage writes
// here and nowhere else, which is what makes "what is the model doing and when"
// a single query instead of archaeology.

host/ledger.ts
```ts
// host/ledger.ts — the visibility layer. Every stage writes here and nowhere
// else, so "what is the model doing and when" has exactly one answer: the event
// stream. Events are appended, never mutated, and carry a monotonic seq plus
// two clocks (relative ms for humans, epoch ms for joining with upstream logs).

import type {
  EventSink,
  HostEvent,
  Json,
  Note,
  Phase,
  StageName,
  StageSummary,
} from "./contracts.ts";
import { errText } from "./support.ts";

export interface LedgerInit {
  requestId: string;
  startedAt: number;
  clock?: () => number;
  sinks?: EventSink[];
}

/** An open stage measurement. `end` is idempotent, so a `finally` block and an
 *  error path can both close it without double-counting. */
export interface SpanHandle {
  end(ok: boolean, data?: Json): HostEvent;
  fail(e: unknown, data?: Json): HostEvent;
}

/** Hard cap on retained events. Beyond it, events still reach sinks and are
 *  still counted; only the in-memory copy stops growing. */
const MAX_EVENTS = 4_000;

export type CounterName = "model_calls" | "tool_calls" | "retries" | "errors";

export class Ledger {
  readonly requestId: string;
  readonly events: HostEvent[] = [];
  readonly notes: Note[] = [];
  readonly startedAt: number;
  private readonly clock: () => number;
  private readonly sinks: EventSink[];
  private seq = 0;
  private dropped = 0;
  private readonly counts: Record<CounterName, number> = {
    model_calls: 0,
    tool_calls: 0,
    retries: 0,
    errors: 0,
  };

  constructor(init: LedgerInit) {
    this.requestId = init.requestId;
    this.startedAt = init.startedAt;
    this.clock = init.clock ?? (() => Date.now());
    this.sinks = init.sinks ?? [];
  }

  /** ms since request start. */
  elapsed(): number {
    return Math.max(0, this.clock() - this.startedAt);
  }

  emit(e: {
    stage: StageName;
    phase: Phase;
    chunkId?: string;
    attempt?: number;
    model?: string;
    tupleId?: string;
    ok?: boolean;
    ms?: number;
    data?: Json;
  }): HostEvent {
    const ev: HostEvent = {
      seq: ++this.seq,
      requestId: this.requestId,
      at: this.elapsed(),
      wall: this.clock(),
      stage: e.stage,
      phase: e.phase,
      ...(e.chunkId !== undefined ? { chunkId: e.chunkId } : {}),
      ...(e.attempt !== undefined ? { attempt: e.attempt } : {}),
      ...(e.model !== undefined ? { model: e.model } : {}),
      ...(e.tupleId !== undefined ? { tupleId: e.tupleId } : {}),
      ...(e.ok !== undefined ? { ok: e.ok } : {}),
      ...(e.ms !== undefined ? { ms: e.ms } : {}),
      ...(e.data !== undefined ? { data: e.data } : {}),
    };
    if (this.events.length < MAX_EVENTS) this.events.push(ev);
    else this.dropped++;
    if (ev.ok === false) this.counts.errors++;
    for (const sink of this.sinks) {
      // A broken sink must never break routing.
      try {
        sink(ev);
      } catch {
        /* ignore */
      }
    }
    return ev;
  }

  span(stage: StageName, data?: Json): SpanHandle {
    const t0 = this.clock();
    let last: HostEvent = this.emit({ stage, phase: "start", data });
    let closed = false;
    const close = (ok: boolean, extra?: Json): HostEvent => {
      if (closed) return last;
      closed = true;
      const ms = this.clock() - t0;
      last = this.emit({
        stage,
        phase: ok ? "end" : "error",
        ok,
        ms,
        data: extra === undefined ? data : { ...(data ?? {}), ...extra },
      });
      return last;
    };
    return {
      end: (ok: boolean, extra?: Json) => close(ok, extra),
      fail: (e: unknown, extra?: Json) =>
        close(false, { error: errText(e).slice(0, 300), ...(extra ?? {}) }),
    };
  }

  bump(name: CounterName, by = 1): void {
    this.counts[name] += by;
  }

  counters(): Record<CounterName, number> {
    return { ...this.counts };
  }

  droppedEvents(): number {
    return this.dropped;
  }

  addNote(n: Note): Note {
    this.notes.push(n);
    return n;
  }

  summarize(): StageSummary[] {
    const byStage = new Map<StageName, StageSummary>();
    for (const ev of this.events) {
      const row = byStage.get(ev.stage) ?? { stage: ev.stage, events: 0, ms: 0, errors: 0 };
      row.events++;
      if (ev.phase === "end" || ev.phase === "error") row.ms += ev.ms ?? 0;
      if (ev.ok === false) row.errors++;
      byStage.set(ev.stage, row);
    }
    return [...byStage.values()].sort((a, b) => {
      const first = this.events.find((e) => e.stage === a.stage)?.seq ?? 0;
      const second = this.events.find((e) => e.stage === b.stage)?.seq ?? 0;
      return first - second;
    });
  }
}
```

// host/intake.ts — stage 1. Never 400s on a malformed body: it coerces roles,
// flattens content parts, stringifies tool calls, clamps sampling params, caps
// messages with middle-elision, classifies lane and task class, sets a budget,
// and records a note for every single thing it changed.

host/intake.ts
````ts
// host/intake.ts — stage 1. Accept anything the caller sends and return a
// HostRequest that the rest of the host can trust: valid roles, string content,
// clamped sampling params, a real budget, a real signal, and a note for every
// single thing that had to be changed.
//
// Intake never throws for a bad body and never 400s. A router that refuses
// malformed input is a router that cannot be put in front of chat clients.

import type {
  ChatMessage,
  HostContext,
  HostRequest,
  Json,
  Note,
  RequestLimits,
  Role,
  RoutingMode,
  SamplingParams,
  TaskClass,
  ToolCall,
  ToolDecl,
  ToolsRequest,
} from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import {
  DEFAULT_LIMITS,
  clampInt,
  clampNum,
  elide,
  isRecord,
  newTraceparent,
  note,
  shortId,
} from "./support.ts";

const VALID_ROLES = new Set<Role>(["system", "user", "assistant", "tool"]);
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;
const MAX_NOTES = 64;

const CODE_RE =
  /```|function\s+\w+|interface\s+\w+|class\s+\w+|def\s+\w+|import\s+[{(\w]|SELECT\s+.+\s+FROM|async\s+function|pub\s+fn\s+|#include\s*<|=>/i;
const MATH_RE =
  /\bprove\b|\btheorem\b|\blemma\b|\bderivative\b|\bintegral\b|\beigenvalue\b|\bmatrix\b|\bequation\b|\bprobability\b|\bmodulo\b|\bprime\b|\bgeometry\b/i;
const JSON_RE = /\bjson\b|\bschema\b|valid\s+json/i;
const REASON_RE =
  /\bprove\s+that\b|step[- ]by[- ]step|\btradeoff\b|\banaly[sz]e\b|\barchitect\b|\bderive\b/i;

/** Budgets by lane. A caller can always override with `budgetMs`. */
const MODE_BUDGET_MS: Record<RoutingMode, number> = {
  fast: 60_000,
  smart: 180_000,
  code: 300_000,
  reasoning: 600_000,
};

/** Legacy field names kept working: pre-rename clients still send `nokey_*`. */
const ALIASED_FIELDS = [
  "tools",
  "rounds",
  "builder",
  "gate",
  "runner",
  "tests",
  "preamble",
  "decompose",
];

interface NoteSink {
  (n: Note): void;
}

function makeNoteSink(notes: Note[]): NoteSink {
  let capped = false;
  return (n: Note) => {
    if (notes.length < MAX_NOTES) notes.push(n);
    else if (!capped) {
      capped = true;
      notes.push(note("notes.capped", `more than ${MAX_NOTES} notes; later notes dropped`, "info"));
    }
  };
}

function flattenContent(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (content === null || content === undefined) return { text: "", images: 0 };
  if (Array.isArray(content)) {
    let text = "";
    let images = 0;
    for (const part of content) {
      if (typeof part === "string") {
        text += part;
        continue;
      }
      if (!isRecord(part)) continue;
      const type = part.type;
      if (type === "text" && typeof part.text === "string") text += part.text;
      else if (type === "image_url" || type === "input_image" || type === "image") {
        images++;
        text += "⟦image⟧";
      } else if (typeof part.text === "string") text += part.text;
    }
    return { text, images };
  }
  if (isRecord(content)) return { text: JSON.stringify(content), images: 0 };
  return { text: String(content), images: 0 };
}

function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : item;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    const args =
      typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    out.push({
      id: typeof item.id === "string" && item.id ? item.id : `call_${shortId()}`,
      type: "function",
      function: { name, arguments: args },
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeTools(raw: unknown, limits: RequestLimits, push: NoteSink): ToolDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolDecl[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= limits.maxTools) {
      push(note("tools.capped", `more than ${limits.maxTools} tools declared; extras dropped`));
      break;
    }
    if (!isRecord(item)) {
      push(note("tools.not_object", "a tool declaration was not an object and was dropped"));
      continue;
    }
    const fn = isRecord(item.function) ? item.function : item;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!TOOL_NAME_RE.test(name)) {
      push(note("tools.bad_name", `tool name ${JSON.stringify(name).slice(0, 40)} is unusable`));
      continue;
    }
    if (seen.has(name)) {
      push(note("tools.duplicate", `duplicate tool declaration for ${name}`));
      continue;
    }
    seen.add(name);
    out.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      source: "client",
    });
  }
  return out;
}

function classify(
  text: string,
  hasTools: boolean,
  hasImages: boolean,
  params: SamplingParams,
  model: string,
): { mode: RoutingMode; taskClass: TaskClass } {
  const lower = model.toLowerCase();
  const effort = (params.reasoningEffort ?? "").toLowerCase();
  const wantsJson = isRecord(params.responseFormat) &&
    params.responseFormat.type === "json_object";

  let taskClass: TaskClass = "chat";
  if (hasImages) taskClass = "vision";
  else if (hasTools) taskClass = "tool";
  else if (wantsJson || JSON_RE.test(text)) taskClass = "json";
  else if (MATH_RE.test(text)) taskClass = "math";
  else if (CODE_RE.test(text)) taskClass = "code";
  else if (REASON_RE.test(text) || text.length > 1800) taskClass = "reasoning";

  let mode: RoutingMode;
  if (lower.includes("fast")) mode = "fast";
  else if (lower.includes("code")) mode = "code";
  else if (lower.includes("reason") || lower.includes("think")) mode = "reasoning";
  else if (lower.includes("smart")) mode = "smart";
  else if (effort === "high" || effort === "xhigh" || effort === "max") mode = "reasoning";
  else if (taskClass === "code") mode = "code";
  else if (taskClass === "reasoning") mode = "reasoning";
  else if (text.length > 1800 || REASON_RE.test(text)) mode = "smart";
  else mode = "fast";

  return { mode, taskClass };
}

function capMessages(
  messages: ChatMessage[],
  limits: RequestLimits,
  push: NoteSink,
): ChatMessage[] {
  let out = messages.map((m) => ({ ...m }));
  let truncatedMessages = 0;

  for (const message of out) {
    if (typeof message.content === "string" && message.content.length > limits.maxMessageChars) {
      const { text } = elide(message.content, limits.maxMessageChars);
      message.content = text;
      truncatedMessages++;
    }
  }
  if (truncatedMessages > 0) {
    push(
      note(
        "messages.elided",
        `${truncatedMessages} message(s) exceeded ${limits.maxMessageChars} chars and were middle-elided`,
      ),
    );
  }

  const totalChars = () =>
    out.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);

  let droppedForChars = 0;
  while (totalChars() > limits.maxRequestChars && out.length > 1) {
    const index = out.findIndex((m) => m.role !== "system");
    if (index < 0) break;
    out.splice(index, 1);
    droppedForChars++;
  }
  if (droppedForChars > 0) {
    push(
      note(
        "messages.dropped_for_size",
        `${droppedForChars} oldest message(s) dropped to fit ${limits.maxRequestChars} chars`,
        "degrade",
      ),
    );
  }

  if (out.length > limits.maxMessages) {
    const systems = out.filter((m) => m.role === "system").slice(0, 8);
    const budgetForRest = Math.max(1, limits.maxMessages - systems.length);
    const rest = out.filter((m) => m.role !== "system").slice(-budgetForRest);
    const dropped = out.length - systems.length - rest.length;
    out = [...systems, ...rest];
    push(note("messages.trimmed", `${dropped} older message(s) trimmed; newest kept`));
  }

  return out;
}

export function mergeLimits(overrides?: Partial<RequestLimits>): RequestLimits {
  const merged: RequestLimits = { ...DEFAULT_LIMITS, ...(overrides ?? {}) };
  return {
    maxMessages: clampInt(merged.maxMessages, 1, 512, DEFAULT_LIMITS.maxMessages),
    maxRequestChars: clampInt(merged.maxRequestChars, 500, 1_000_000, DEFAULT_LIMITS.maxRequestChars),
    maxMessageChars: clampInt(merged.maxMessageChars, 200, 1_000_000, DEFAULT_LIMITS.maxMessageChars),
    maxModelCalls: clampInt(merged.maxModelCalls, 1, 64, DEFAULT_LIMITS.maxModelCalls),
    maxChunks: clampInt(merged.maxChunks, 1, 32, DEFAULT_LIMITS.maxChunks),
    maxConcurrency: clampInt(merged.maxConcurrency, 1, 16, DEFAULT_LIMITS.maxConcurrency),
    maxChunkMs: clampInt(merged.maxChunkMs, 500, 900_000, DEFAULT_LIMITS.maxChunkMs),
    maxToolMs: clampInt(merged.maxToolMs, 100, 900_000, DEFAULT_LIMITS.maxToolMs),
    maxChunkOutputChars: clampInt(
      merged.maxChunkOutputChars,
      200,
      200_000,
      DEFAULT_LIMITS.maxChunkOutputChars,
    ),
    maxTools: clampInt(merged.maxTools, 0, 256, DEFAULT_LIMITS.maxTools),
  };
}

export function intake(
  raw: unknown,
  ctx: HostContext,
  limitsIn: Partial<RequestLimits> | undefined,
  ledger: Ledger,
): HostRequest {
  const limits = mergeLimits(limitsIn);
  const notes: Note[] = [];
  const push = makeNoteSink(notes);
  const span = ledger.span("intake");

  const body: Json = isRecord(raw) ? { ...raw } : {};
  if (!isRecord(raw)) push(note("body.not_object", "request body was not an object", "warn"));

  for (const field of ALIASED_FIELDS) {
    const legacy = `nokey_${field}`;
    if (body[`kono_${field}`] === undefined && body[legacy] !== undefined) {
      body[`kono_${field}`] = body[legacy];
    }
  }

  // ---- messages ----------------------------------------------------------
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    push(note("messages.not_array", "messages was not an array; ignored", "warn"));
  }
  const messages: ChatMessage[] = [];
  let hasImages = false;
  let badRoles = 0;
  for (const item of rawMessages) {
    if (!isRecord(item)) {
      push(note("messages.item", "a message was not an object and was dropped"));
      continue;
    }
    const roleText = typeof item.role === "string" ? item.role.toLowerCase() : "";
    const role: Role = VALID_ROLES.has(roleText as Role) ? (roleText as Role) : "user";
    if (roleText && role !== roleText) badRoles++;

    const flat = flattenContent(item.content ?? item.text);
    if (flat.images > 0) hasImages = true;

    const message: ChatMessage = {
      role,
      content: flat.text.length > 0 ? flat.text : null,
    };
    const calls = normalizeToolCalls(item.tool_calls);
    if (calls) {
      message.tool_calls = calls;
      if (message.content === "") message.content = null;
    }
    if (typeof item.tool_call_id === "string") message.tool_call_id = item.tool_call_id;
    if (typeof item.name === "string") message.name = item.name;
    messages.push(message);
  }
  if (badRoles > 0) {
    push(note("messages.role", `${badRoles} unknown role(s) coerced to "user"`));
  }
  if (messages.length === 0) {
    const fallback = typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim()
      : "Please reply with a short acknowledgement.";
    messages.push({ role: "user", content: fallback });
    push(note("messages.empty", "no usable messages; a prompt fallback was inserted"));
  }

  const kept = capMessages(messages, limits, push);

  // ---- model, mode, task class -------------------------------------------
  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : "free:auto";
  if (typeof body.model !== "string") {
    push(note("model.default", "no model requested; using free:auto", "info"));
  }
  const promptText = kept
    .filter((m) => m.role === "user" || m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  // ---- tools -------------------------------------------------------------
  const rawTools = body.tools;
  const clientTools = normalizeTools(Array.isArray(rawTools) ? rawTools : [], limits, push);
  let toolsRequested: ToolsRequest = "none";
  if (Array.isArray(rawTools) && rawTools.length > 0) toolsRequested = "explicit";
  const autoAsk =
    rawTools === "auto" ||
    rawTools === true ||
    rawTools === "*" ||
    body.kono_tools !== undefined ||
    rawTools === "kono_tools";
  if (autoAsk) toolsRequested = clientTools.length > 0 ? "explicit" : "auto";

  const params: SamplingParams = (() => {
    const p: SamplingParams = {};
    if (typeof body.temperature === "number") {
      p.temperature = clampNum(body.temperature, 0, 2, 0.7);
      if (p.temperature !== body.temperature) {
        push(note("params.temperature", `temperature clamped to ${p.temperature}`));
      }
    }
    const maxTokens = typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : undefined;
    if (maxTokens !== undefined) {
      p.maxTokens = clampInt(maxTokens, 1, 32_000, 1_024);
      if (p.maxTokens !== Math.round(maxTokens)) {
        push(note("params.max_tokens", `max_tokens clamped to ${p.maxTokens}`));
      }
    }
    if (typeof body.top_p === "number") p.topP = clampNum(body.top_p, 0, 1, 1);
    if (body.tool_choice !== undefined) p.toolChoice = body.tool_choice;
    if (isRecord(body.response_format)) p.responseFormat = body.response_format;
    if (typeof body.reasoning_effort === "string") p.reasoningEffort = body.reasoning_effort;
    if (typeof body.parallel_tool_calls === "boolean") {
      p.parallelToolCalls = body.parallel_tool_calls;
    }
    return p;
  })();

  const { mode, taskClass } = classify(promptText, kept.some((m) => m.tool_calls), hasImages, params, model);

  // ---- budget, limits, signal -------------------------------------------
  const requestedBudget = typeof ctx.budgetMs === "number"
    ? ctx.budgetMs
    : typeof body.kono_budget_ms === "number"
    ? body.kono_budget_ms
    : MODE_BUDGET_MS[mode];
  const budgetMs = clampInt(requestedBudget, 2_000, 1_800_000, MODE_BUDGET_MS[mode]);
  if (budgetMs !== Math.round(requestedBudget)) {
    push(note("budget.clamped", `budget clamped to ${budgetMs}ms`, "info"));
  }

  const decompose = body.kono_decompose === false ? false : undefined;
  const stream = body.stream === true;
  const traceparent = ctx.traceparent || newTraceparent();
  const tenant = ctx.tenant || "global";

  const request: HostRequest = {
    id: ledger.requestId,
    startedAt: ledger.startedAt,
    tenant,
    traceparent,
    model,
    mode,
    taskClass,
    stream,
    messages: kept,
    hasImages,
    clientTools,
    toolsRequested,
    params,
    budgetMs,
    limits,
    signal: ctx.signal ?? new AbortController().signal,
    notes,
    raw: body,
    ...(decompose === false ? { decompose } : {}),
  };

  for (const n of notes) ledger.addNote(n.stage ? n : { ...n, stage: "intake" });
  ledger.emit({
    stage: "intake",
    phase: "decision",
    data: {
      model,
      mode,
      task_class: taskClass,
      stream,
      messages_in: rawMessages.length,
      messages_kept: kept.length,
      tools_requested: toolsRequested,
      client_tools: clientTools.length,
      has_images: hasImages,
      budget_ms: budgetMs,
      notes: notes.length,
    },
  });
  span.end(true, { notes: notes.length });
  return request;
}
````

// host/build.ts — stage 2: build the request up. Selects tools (client wins,
// builtin fills in by task class), assembles the router-owned system text in
// priority order, ranks candidates, and splits the wall clock into planner /
// chunk / synthesis budgets. Returns a BuildManifest that is the receipt for
// every decision.

host/build.ts
```ts
// host/build.ts — stage 2: grow the accepted request into a full one.
//
// "Building up" means four concrete things, in this order:
//   1. decide which tools this request may use (client wins, builtin fills in);
//   2. assemble the system text the router owns, highest priority first;
//   3. ask the candidate port who could answer it, and keep the ranked list;
//   4. split the wall clock into planner / chunk / synthesis budgets.
//
// Build returns a BuildManifest alongside the wire messages: the manifest is
// the receipt. If a later stage looks wrong, the manifest says which decision
// made it look that way.

import type {
  BudgetSplit,
  BuildManifest,
  BuiltRequest,
  CandidateRef,
  ChatMessage,
  HostPorts,
  HostRequest,
  PromptPart,
  RankQuery,
  TaskClass,
  ToolDecl,
  ToolSelection,
} from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import { byteLen, digest, errText, note, preview, raceSoft, tailCap } from "./support.ts";

/** Builtin tools a task class can actually use. `tool` gets everything: the
 *  caller asked for the plane, not for a guess about the plane. */
const CLASS_TOOL_HINTS: Record<TaskClass, string[]> = {
  chat: ["web"],
  code: ["fs_", "shell", "code", "test"],
  math: ["calc", "data", "unit"],
  json: ["json", "calc"],
  tool: ["*"],
  vision: [],
  reasoning: ["calc", "web"],
};

const FALLBACK_PREAMBLE =
  "You have server-side tools. Call one with a single valid JSON object of arguments; " +
  "the host executes it and returns the result. Prefer a tool over guessing.";

const LESSON_CHARS = 600;
const BRIEF_CHARS = 1_200;
const VARIANT_CHARS = 400;

function pickAuto(tools: ToolDecl[], taskClass: TaskClass, max: number): string[] {
  const hints = CLASS_TOOL_HINTS[taskClass];
  if (hints.includes("*")) return tools.slice(0, max).map((t) => t.name);
  const chosen: string[] = [];
  for (const tool of tools) {
    if (chosen.length >= max) break;
    if (hints.some((h) => tool.name.toLowerCase().startsWith(h))) chosen.push(tool.name);
  }
  return chosen;
}

function selectTools(request: HostRequest, ports: HostPorts, ledger: Ledger): ToolSelection {
  const dropped: ToolSelection["dropped"] = [];
  const byName = new Map<string, ToolDecl>();
  for (const tool of request.clientTools) byName.set(tool.name, tool);

  const auto: string[] = [];
  if (request.toolsRequested === "auto" || request.toolsRequested === "explicit") {
    const available = ports.tools.list();
    const wanted = pickAuto(available, request.taskClass, request.limits.maxTools);
    for (const name of wanted) {
      const decl = available.find((t) => t.name === name);
      if (!decl) continue;
      if (byName.has(name)) {
        dropped.push(note("tools.shadowed", `builtin ${name} not added: client supplied its own`));
        continue;
      }
      byName.set(name, { ...decl, source: "builtin" });
      auto.push(name);
    }
    if (request.toolsRequested === "auto" && auto.length === 0) {
      dropped.push(note("tools.none_available", "auto tools requested but no builtin matched", "info"));
    }
  }

  const declared = [...byName.values()].slice(0, request.limits.maxTools);
  ledger.emit({
    stage: "build",
    phase: "decision",
    data: {
      tool_source: request.toolsRequested,
      client: request.clientTools.length,
      auto: auto.length,
      declared: declared.length,
      names: declared.map((t) => t.name).slice(0, 24),
    },
  });
  return { declared, auto, dropped };
}

interface PromptBlock {
  id: "variant" | "lessons" | "workspace" | "preamble";
  text: string;
  /** 0 = dropped first when the prompt is too large. */
  priority: number;
}

async function collectPrompt(
  request: HostRequest,
  selection: ToolSelection,
  ports: HostPorts,
  ledger: Ledger,
): Promise<PromptBlock[]> {
  const blocks: PromptBlock[] = [];
  const prompt = ports.prompt;

  if (prompt?.variant) {
    const text = await raceSoft(Promise.resolve(prompt.variant(request)), 400);
    if (text && text.trim()) {
      blocks.push({ id: "variant", text: tailCap(text.trim(), VARIANT_CHARS).text, priority: 1 });
    }
  }
  if (prompt?.lessons) {
    const lessons = await raceSoft(Promise.resolve(prompt.lessons(request)), 600);
    if (lessons && lessons.length > 0) {
      const text = tailCap(
        `Lessons learned from verified failures on similar tasks:\n${lessons
          .slice(0, 2)
          .map((l) => `- ${l}`)
          .join("\n")}`,
        LESSON_CHARS,
      ).text;
      blocks.push({ id: "lessons", text, priority: 2 });
    }
  }
  if (prompt?.workspaceBrief && selection.declared.length > 0) {
    const brief = await raceSoft(Promise.resolve(prompt.workspaceBrief(request)), 1_200);
    if (brief && brief.trim()) {
      blocks.push({ id: "workspace", text: tailCap(brief.trim(), BRIEF_CHARS).text, priority: 3 });
    }
  }
  if (selection.declared.length > 0) {
    const text = prompt?.preamble
      ? await raceSoft(Promise.resolve(prompt.preamble(selection.declared.map((t) => t.name))), 400)
      : FALLBACK_PREAMBLE;
    if (text && text.trim()) {
      blocks.push({ id: "preamble", text: tailCap(text.trim(), 2_000).text, priority: 4 });
    }
  }
  ledger.emit({
    stage: "build",
    phase: "decision",
    data: {
      prompt_blocks: blocks.map((b) => ({ id: b.id, bytes: byteLen(b.text), digest: digest(b.text) })),
    },
  });
  return blocks;
}

function splitBudget(totalMs: number): BudgetSplit {
  const plannerMs = Math.min(20_000, Math.max(2_000, Math.round(totalMs * 0.15)));
  const chunkMs = Math.min(120_000, Math.max(6_000, Math.round(totalMs * 0.55)));
  const synthMs = Math.max(3_000, totalMs - plannerMs - chunkMs);
  return { totalMs, plannerMs, chunkMs, synthMs };
}

function dedupeCandidates(list: CandidateRef[], query: RankQuery): CandidateRef[] {
  const seen = new Set<string>(query.exclude);
  const out: CandidateRef[] = [];
  for (const cand of list) {
    if (!cand || typeof cand.tupleId !== "string") continue;
    if (seen.has(cand.tupleId)) continue;
    if (query.requiresTools && !cand.supportsTools) continue;
    if (query.requiresVision && !cand.supportsVision) continue;
    seen.add(cand.tupleId);
    out.push(cand);
    if (out.length >= query.limit) break;
  }
  return out;
}

export async function buildRequest(
  request: HostRequest,
  ports: HostPorts,
  ledger: Ledger,
): Promise<BuiltRequest> {
  const span = ledger.span("build", { model: request.model, mode: request.mode });
  const notes = [...request.notes];

  const selection = selectTools(request, ports, ledger);
  notes.push(...selection.dropped);

  const blocks = await collectPrompt(request, selection, ports, ledger);

  // ---- assemble the wire messages ----------------------------------------
  const totalChars = () =>
    blocks.reduce((n, b) => n + b.text.length, 0) +
    request.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);

  // Router text yields before the caller's messages, least important first.
  const dropOrder: PromptBlock["id"][] = ["workspace", "lessons", "variant", "preamble"];
  for (const id of dropOrder) {
    if (totalChars() <= request.limits.maxRequestChars) break;
    const index = blocks.findIndex((b) => b.id === id);
    if (index < 0) continue;
    blocks.splice(index, 1);
    notes.push(
      note("prompt.dropped", `${id} text dropped to stay under ${request.limits.maxRequestChars} chars`, "degrade"),
    );
  }

  const systemMessages: ChatMessage[] = blocks.map((b) => ({ role: "system", content: b.text }));
  const messages: ChatMessage[] = [...systemMessages, ...request.messages];

  const promptParts: PromptPart[] = [
    ...blocks.map((b) => ({
      source: b.id as PromptPart["source"],
      bytes: byteLen(b.text),
      digest: digest(b.text),
      preview: preview(b.text),
    })),
    ...request.messages.map((m) => {
      const text = typeof m.content === "string" ? m.content : "";
      return {
        source: "client" as const,
        bytes: byteLen(text),
        digest: digest(`${m.role}:${text}`),
        preview: preview(`${m.role}: ${text}`),
      };
    }),
  ];

  // ---- candidates --------------------------------------------------------
  const rankSpan = ledger.span("rank", { mode: request.mode, task_class: request.taskClass });
  const query: RankQuery = {
    mode: request.mode,
    taskClass: request.taskClass,
    tenant: request.tenant,
    requiresTools: selection.declared.length > 0,
    requiresVision: request.hasImages,
    limit: 8,
    exclude: [],
  };
  let candidates: CandidateRef[] = [];
  try {
    candidates = dedupeCandidates(await ports.candidates.rank(query), query);
  } catch (err) {
    notes.push(note("rank.failed", `rank() threw: ${errText(err).slice(0, 200)}`, "warn"));
  }
  if (candidates.length === 0 && ports.candidates.sweep) {
    try {
      candidates = dedupeCandidates(await ports.candidates.sweep(query), query);
      if (candidates.length > 0) {
        notes.push(note("rank.swept", "rank() was empty; used the sweep pool", "info"));
      }
    } catch (err) {
      notes.push(note("rank.sweep_failed", `sweep() threw: ${errText(err).slice(0, 200)}`, "warn"));
    }
  }
  if (candidates.length === 0) {
    notes.push(
      note(
        "rank.empty",
        "no candidate endpoints; the model port must resolve a lane itself",
        "warn",
      ),
    );
  }
  const head = candidates[0];
  rankSpan.end(true, {
    candidates: candidates.length,
    head: head?.tupleId,
    head_model: head?.modelId,
    requires_tools: query.requiresTools,
  });

  const budget = splitBudget(request.budgetMs);
  const manifest: BuildManifest = {
    modelRequested: request.model,
    mode: request.mode,
    taskClass: request.taskClass,
    candidates,
    tools: selection,
    prompt: promptParts,
    params: request.params,
    budget,
    limits: request.limits,
    notes,
  };

  ledger.emit({
    stage: "build",
    phase: "decision",
    data: {
      messages: messages.length,
      system_messages: systemMessages.length,
      chars: totalChars(),
      prompt_digest: digest(promptParts.map((p) => p.digest).join("|")),
      budget,
      notes: notes.length,
    },
  });
  span.end(true, { candidates: candidates.length, notes: notes.length });

  return { request: { ...request, notes }, messages, manifest };
}

/** Exposed for tests and for callers that want the split without a request. */
export function budgetFor(totalMs: number): BudgetSplit {
  return splitBudget(totalMs);
}
```

// host/decompose.ts — stage 3: ask the AI for the chunk list, then distrust it.
// The only AI-authored control flow in the host, so the only thing with a full
// validation pass (ids, kinds, declared tools only, backward-only deps, arg
// refs) plus one bounded repair call and a single-chunk fallback.

host/decompose.ts
```ts
// host/decompose.ts — stage 3: ask the AI to break the request into tiny chunks,
// then distrust the answer completely.
//
// The planner is the only place in the host where a model is allowed to write
// control flow, so it is also the only place with a full validation pass
// (ids, kinds, declared tools only, backward-only dependencies, arg refs) plus
// one bounded repair call. A planner that returns prose, an unknown tool, a
// cycle or nothing at all cannot fail the request: the stage falls back to a
// single answer chunk and says exactly why in the report.

import type {
  BuiltRequest,
  ChatMessage,
  Chunk,
  ChunkPlan,
  HostPorts,
  Json,
  Note,
  RequestLimits,
} from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import {
  abortable,
  clampInt,
  errText,
  extractJson,
  goalText,
  isRecord,
  note,
  preview,
  tailCap,
  withDeadline,
} from "./support.ts";

const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const REF_RE = /\$\{?([a-z][a-z0-9_]{0,23})(?:[./][^}\s"',)]*)?\}?/g;
const MAX_TITLE = 120;
const MAX_PROMPT = 600;
const MIN_PLAN_MS = 1_200;
const PLANNER_MAX_TOKENS = 1_200;
const REPAIR_ECHO_CHARS = 3_000;

export interface PlanValidation {
  chunks: Chunk[];
  rejects: Note[];
  errors: string[];
  rationale: string;
}

function refIds(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(REF_RE)) out.add(match[1]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) refIds(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) refIds(item, out);
    return out;
  }
  return out;
}

function firstUnresolvedRef(value: unknown, known: Map<string, number>): string | null {
  for (const id of refIds(value)) {
    if (!known.has(id)) return `$${id}`;
  }
  return null;
}

function normalizeId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 24);
}

/**
 * Validate a planner reply. Pure, synchronous and exhaustive: it keeps the
 * chunks that are safe to run, rejects the rest with a reason, and returns the
 * errors that a repair call should be told about.
 *
 * Invariants enforced here, in order:
 *   - at most `limits.maxChunks` chunks;
 *   - ids match ID_RE and are unique;
 *   - a "tool" chunk names a tool this request actually declared;
 *   - a "tool" chunk's args reference only already-accepted chunks;
 *   - `needs` only reference already-accepted chunks (so the DAG is acyclic
 *     and the scheduler never has to detect a cycle);
 *   - an "answer" chunk always has a prompt.
 */
export function validatePlan(
  raw: unknown,
  allowedTools: ReadonlySet<string>,
  limits: RequestLimits,
): PlanValidation {
  const rejects: Note[] = [];
  const errors: string[] = [];
  const chunks: Chunk[] = [];
  const seen = new Map<string, number>();

  const obj = isRecord(raw) ? raw : undefined;
  const list = obj && Array.isArray(obj.chunks)
    ? obj.chunks
    : Array.isArray(raw)
    ? raw
    : undefined;
  const rationale = obj && typeof obj.rationale === "string"
    ? tailCap(obj.rationale, 300).text
    : "";

  if (!list) {
    errors.push("reply had no `chunks` array");
    return { chunks, rejects, errors, rationale };
  }
  if (list.length === 0) errors.push("`chunks` was empty");

  for (const [index, item] of list.entries()) {
    if (chunks.length >= limits.maxChunks) {
      rejects.push(note("chunk.capped", `chunk #${index + 1} dropped: plan exceeds ${limits.maxChunks} chunks`));
      continue;
    }
    if (!isRecord(item)) {
      rejects.push(note("chunk.not_object", `chunk #${index + 1} was not an object`));
      continue;
    }

    const id = normalizeId(item.id);
    if (!ID_RE.test(id)) {
      rejects.push(note("chunk.bad_id", `chunk #${index + 1} id ${JSON.stringify(item.id)} is not a usable id`));
      continue;
    }
    if (seen.has(id)) {
      rejects.push(note("chunk.duplicate_id", `chunk id ${id} appeared twice; the second was dropped`));
      continue;
    }

    const kind: "answer" | "tool" | null = item.kind === "tool" || (item.kind === undefined && typeof item.tool === "string")
      ? "tool"
      : item.kind === "answer" || item.kind === undefined
      ? "answer"
      : null;
    if (!kind) {
      rejects.push(note("chunk.bad_kind", `chunk ${id}: kind ${JSON.stringify(item.kind)} is not "tool" or "answer"`));
      continue;
    }

    let tool: string | undefined;
    let args: Json | undefined;
    if (kind === "tool") {
      tool = typeof item.tool === "string" ? item.tool.trim() : "";
      if (!tool || !allowedTools.has(tool)) {
        rejects.push(
          note(
            "chunk.tool_not_declared",
            `chunk ${id} wants tool ${JSON.stringify(tool)}, which this request did not declare`,
          ),
        );
        continue;
      }
      if (item.args !== undefined && !isRecord(item.args)) {
        rejects.push(note("chunk.bad_args", `chunk ${id}: args must be an object`));
        continue;
      }
      args = isRecord(item.args) ? item.args : {};
      const unresolved = firstUnresolvedRef(args, seen);
      if (unresolved) {
        rejects.push(
          note("chunk.ref_unresolved", `chunk ${id} reads ${unresolved}, which is not an earlier chunk`),
        );
        continue;
      }
    }

    const needs: string[] = [];
    if (Array.isArray(item.needs)) {
      for (const need of item.needs) {
        if (typeof need !== "string") continue;
        const dep = need.trim().toLowerCase();
        if (!seen.has(dep)) {
          rejects.push(note("chunk.need_dropped", `chunk ${id}: dependency ${dep} is not an earlier chunk; dropped`));
          continue;
        }
        if (!needs.includes(dep)) needs.push(dep);
      }
    }
    if (args) {
      for (const dep of refIds(args)) {
        if (!needs.includes(dep)) needs.push(dep);
      }
    }

    const title = tailCap(
      typeof item.title === "string" && item.title.trim() ? item.title.trim() : `chunk ${id}`,
      MAX_TITLE,
    ).text;
    const prompt = kind === "answer"
      ? tailCap(
        typeof item.prompt === "string" && item.prompt.trim()
          ? item.prompt.trim()
          : `Answer this part of the request on its own: ${title}`,
        MAX_PROMPT,
      ).text
      : undefined;
    const outputCapChars = clampInt(
      typeof item.outputCapChars === "number" ? item.outputCapChars : limits.maxChunkOutputChars,
      200,
      limits.maxChunkOutputChars,
      limits.maxChunkOutputChars,
    );

    seen.set(id, chunks.length);
    chunks.push({
      id,
      title,
      kind,
      ...(tool ? { tool } : {}),
      ...(args ? { args } : {}),
      needs,
      ...(prompt ? { prompt } : {}),
      outputCapChars,
    });
  }

  return { chunks, rejects, errors, rationale };
}

function plannerSystem(limits: RequestLimits): string {
  return [
    "You are the planning stage of a message router.",
    "Break the user's request into the smallest chunks that can run independently and in parallel.",
    `Rules:`,
    `- 1 to ${limits.maxChunks} chunks. Prefer 2-4. One atomic question means exactly one answer chunk.`,
    `- Every id matches ${ID_RE.source}. Ids are unique and lowercase.`,
    `- Every chunk is kind "tool" or "answer".`,
    `- A "tool" chunk has "tool" (from the catalog) and "args" (an object). Use "$chunkId" or "$chunkId/path" inside args to read an earlier chunk's result.`,
    `- An "answer" chunk has "prompt": one self-contained instruction, at most 300 characters. It must not restate the whole goal.`,
    `- "needs" lists only ids of chunks earlier in the array. No cycles, no forward references.`,
    "Output JSON only, no prose, no code fences:",
    `{"rationale":"why this split","chunks":[{"id":"facts","title":"...","kind":"tool","tool":"...","args":{},"needs":[]},{"id":"draft","title":"...","kind":"answer","prompt":"...","needs":["facts"]}]}`,
  ].join("\n");
}

function plannerMessages(built: BuiltRequest, limits: RequestLimits): ChatMessage[] {
  const goal = tailCap(goalText(built.request.messages, 4_000), 4_000).text;
  const catalog = built.manifest.tools.declared.length > 0
    ? built.manifest.tools.declared
      .slice(0, 24)
      .map((t) => `- ${t.name}: ${preview(t.description, 100) || "(no description)"}`)
      .join("\n")
    : "(no tools declared: every chunk must be kind \"answer\")";
  return [
    { role: "system", content: plannerSystem(limits) },
    { role: "user", content: `GOAL:\n${goal}\n\nTOOLS:\n${catalog}\n\nReturn the JSON plan now.` },
  ];
}

function repairMessages(
  built: BuiltRequest,
  limits: RequestLimits,
  previous: string,
  errors: string[],
): ChatMessage[] {
  const base = plannerMessages(built, limits);
  return [
    ...base,
    { role: "assistant", content: tailCap(previous, REPAIR_ECHO_CHARS).text },
    {
      role: "user",
      content: [
        "That reply was rejected. Fix each problem and return the complete JSON plan again.",
        ...errors.slice(0, 8).map((e) => `- ${e}`),
      ].join("\n"),
    },
  ];
}

function singleChunkPlan(built: BuiltRequest, rationale: string): ChunkPlan {
  const goal = tailCap(goalText(built.request.messages, 2_000), 600).text;
  const chunk: Chunk = {
    id: "answer",
    title: "Answer the request",
    kind: "answer",
    needs: [],
    prompt: goal || "Answer the user's request.",
    outputCapChars: built.request.limits.maxChunkOutputChars,
  };
  return {
    requestId: built.request.id,
    source: "fallback",
    rationale,
    chunks: [chunk],
    plannerAttempts: 0,
    plannerMs: 0,
    rejects: [],
    repairErrors: [],
  };
}

export async function decompose(
  built: BuiltRequest,
  ports: HostPorts,
  ledger: Ledger,
  plannerBudgetMs: number,
): Promise<ChunkPlan> {
  const { request, manifest } = built;
  const limits = request.limits;
  const span = ledger.span("decompose", { budget_ms: Math.round(plannerBudgetMs) });
  const allowed = new Set(manifest.tools.declared.map((t) => t.name));
  const startedMs = Date.now();

  const fallback = (code: string, detail: string, severity: Note["severity"] = "warn"): ChunkPlan => {
    const plan = singleChunkPlan(built, detail);
    plan.plannerAttempts = attempts;
    plan.plannerMs = Date.now() - startedMs;
    const n = note(code, detail, severity, "decompose");
    ledger.addNote(n);
    plan.rejects = [n];
    ledger.emit({
      stage: "decompose",
      phase: "decision",
      attempt: attempts,
      chunkId: plan.chunks[0].id,
      data: { fallback: true, code, source: plan.source },
    });
    span.end(false, { fallback: true, code, attempts });
    return plan;
  };

  let attempts = 0;

  if (request.decompose === false) {
    return fallback("decompose.disabled", "caller disabled decomposition", "info");
  }
  if (plannerBudgetMs < MIN_PLAN_MS) {
    return fallback(
      "decompose.no_budget",
      `planner budget ${Math.round(plannerBudgetMs)}ms is below the ${MIN_PLAN_MS}ms floor`,
      "info",
    );
  }

  let rejected: Note[] = [];
  let repairErrors: string[] = [];
  let previous = "";
  let model: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = attempt === 0 ? Math.round(plannerBudgetMs * 0.7) : Math.round(plannerBudgetMs * 0.3);
    if (budget < 500) break;
    const messages = attempt === 0
      ? plannerMessages(built, limits)
      : repairMessages(built, limits, previous, repairErrors);
    const pin = manifest.candidates[0];
    attempts++;
    ledger.bump("model_calls");
    try {
      const reply = await withDeadline(budget, request.signal, "planner", (signal) =>
        abortable(
          ports.models.complete({
            purpose: attempt === 0 ? "planner" : "repair",
            messages,
            ...(pin ? { model: pin.modelId, tupleId: pin.tupleId } : {}),
            temperature: attempt === 0 ? 0.2 : 0,
            maxTokens: PLANNER_MAX_TOKENS,
            responseFormat: { type: "json_object" },
            deadlineMs: budget,
            signal,
            chunkId: attempt === 0 ? "planner" : "planner_repair",
            attempt,
          }),
          signal,
          "planner",
        ));
      model = reply.model;
      previous = reply.content;
      ledger.emit({
        stage: "decompose",
        phase: "decision",
        attempt,
        model: reply.model,
        tupleId: reply.tupleId,
        ms: reply.ms,
        data: {
          chars: reply.content.length,
          upstream_attempts: reply.upstreamAttempts,
          preview: preview(reply.content, 160),
        },
      });

      const validation = validatePlan(extractJson(reply.content), allowed, limits);
      rejected = validation.rejects;
      repairErrors = validation.errors;
      if (validation.errors.length === 0 && validation.chunks.length > 0) {
        for (const r of rejected) ledger.addNote({ ...r, stage: "decompose" });
        for (const chunk of validation.chunks) {
          ledger.emit({
            stage: "decompose",
            phase: "decision",
            chunkId: chunk.id,
            data: {
              kind: chunk.kind,
              tool: chunk.tool,
              needs: chunk.needs,
              title: chunk.title,
              cap: chunk.outputCapChars,
            },
          });
        }
        const plan: ChunkPlan = {
          requestId: request.id,
          source: "planner",
          rationale: validation.rationale,
          chunks: validation.chunks,
          ...(model ? { plannerModel: model } : {}),
          plannerAttempts: attempts,
          plannerMs: Date.now() - startedMs,
          rejects: rejected,
          repairErrors: [],
        };
        span.end(true, {
          chunks: plan.chunks.length,
          attempts,
          rejects: rejected.length,
          model,
        });
        return plan;
      }
      ledger.emit({
        stage: "decompose",
        phase: "error",
        attempt,
        ok: false,
        data: {
          errors: repairErrors.slice(0, 6),
          rejects: rejected.length,
        },
      });
    } catch (err) {
      if (request.signal.aborted) {
        span.fail(err);
        throw err;
      }
      repairErrors = [errText(err).slice(0, 240)];
      ledger.emit({
        stage: "decompose",
        phase: "error",
        attempt,
        ok: false,
        data: { error: errText(err).slice(0, 240) },
      });
    }
  }

  const why = repairErrors.length > 0
    ? `planner produced no valid plan after ${attempts} attempt(s): ${repairErrors.slice(0, 3).join("; ")}`
    : `planner produced no valid plan after ${attempts} attempt(s)`;
  const plan = fallback("decompose.fallback", why, "degrade");
  if (rejected.length > 0) {
    plan.rejects = [...rejected, ...plan.rejects];
    ledger.emit({
      stage: "decompose",
      phase: "info",
      data: { rejected: rejected.map((r) => r.code).slice(0, 8) },
    });
  }
  return plan;
}

/** Exposed for tests: the exact planner prompt for a built request. */
export function planPromptFor(built: BuiltRequest): ChatMessage[] {
  return plannerMessages(built, built.request.limits);
}

/** Exposed for tests: what the host would send a repair call. */
export function repairPromptFor(built: BuiltRequest, previous: string, errors: string[]): ChatMessage[] {
  return repairMessages(built, built.request.limits, previous, errors);
}

/** Structured plan summary, safe to log. */
export function describePlan(plan: ChunkPlan): Json {
  return {
    source: plan.source,
    chunks: plan.chunks.map((c) => ({ id: c.id, kind: c.kind, tool: c.tool ?? null, needs: c.needs })),
    attempts: plan.plannerAttempts,
    rejects: plan.rejects.length,
    rationale: plan.rationale.slice(0, 200),
  };
}
```

// host/execute.ts — stages 4 and 5: run the chunks, then assemble.
// Dependency-aware scheduling behind a real semaphore, per-chunk and per-tool
// deadlines, one retry for plausibly-transient errors, a shared model-call
// budget, `$chunk.path` substitution, terminal-answer collapse, and a degraded
// body when nothing usable came back.

host/execute.ts
```ts
// host/execute.ts — stage 4 and 5: run the chunks, then assemble one answer.
//
// Execution rules that make this stage safe to point at production:
//   - a chunk runs only after its `needs` are ok; a failed dependency turns the
//     dependent into `skipped` instead of a confusing cascade of errors;
//   - every chunk and every tool call has its own deadline derived from the
//     request signal, and the concurrency cap is a real semaphore;
//   - one bounded retry, only for errors that are plausibly transient;
//   - the model-call budget is shared by the whole request and is checked
//     before each call, so a planner cannot starve the answer;
//   - assembly never invents an answer: no ok chunks means a degraded body
//     that names the failures.
//
// Every decision lands in the ledger with the chunk id attached, which is what
// turns "the router answered" into "chunk draft called model X, took 812ms,
// read chunks facts+lookup".

import type {
  Assembled,
  BuiltRequest,
  ChatMessage,
  Chunk,
  ChunkPlan,
  ChunkResult,
  HostPorts,
  Json,
  ToolResult,
} from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import {
  abortable,
  errText,
  goalText,
  isRecord,
  note,
  safeStringify,
  tailCap,
  withDeadline,
} from "./support.ts";

export interface ExecuteOptions {
  chunkMs: number;
  synthMs: number;
}

export interface ExecuteOutcome {
  results: ChunkResult[];
  assembled: Assembled;
}

const DEP_OUTPUT_CHARS = 2_000;
const RETRYABLE = /timeout|deadline|429|rate.?limit|ECONN|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket|5\d\d/i;

const WHOLE_REF = /^\$\{?([a-z][a-z0-9_]{0,23})(?:[./]([^}]*))?\}?$/;
const INLINE_REF = /\$\{?([a-z][a-z0-9_]{0,23})(?:[./]([^}\s"',)]*))?\}?/g;

function pathGet(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cursor: unknown = value;
  for (const part of path.split(/[./]/)) {
    for (const segment of part.replace(/\[(\d+)\]/g, ".$1").split(".")) {
      if (!segment) continue;
      if (Array.isArray(cursor)) {
        const index = Number(segment);
        if (!Number.isInteger(index)) return undefined;
        cursor = cursor[index];
      } else if (isRecord(cursor)) {
        cursor = cursor[segment];
      } else {
        return undefined;
      }
    }
  }
  return cursor;
}

/** `$facts`, `$facts/items/0/title`, `${facts.count}` → the earlier chunk's
 *  value. Whole-string refs keep their type; inline refs become text. */
export function substituteRefs(
  value: unknown,
  results: ReadonlyMap<string, ChunkResult>,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const lookup = (id: string): ChunkResult => {
    const res = results.get(id);
    if (!res || res.status !== "ok") throw new Error(`REF_UNAVAILABLE: $${id}`);
    return res;
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = v.match(WHOLE_REF);
      if (whole) {
        const res = lookup(whole[1]);
        return pathGet(res.value !== undefined ? res.value : res.output, whole[2]);
      }
      return v.replace(INLINE_REF, (_match, id: string, path?: string) => {
        const res = lookup(id);
        const got = pathGet(res.value !== undefined ? res.value : res.output, path);
        return typeof got === "string" ? got : safeStringify(got, 4_000);
      });
    }
    if (Array.isArray(v)) return v.map(visit);
    if (isRecord(v)) {
      const out: Json = {};
      for (const [key, item] of Object.entries(v)) out[key] = visit(item);
      return out;
    }
    return v;
  };
  try {
    return { ok: true, value: visit(value) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function createSemaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

function chunkMessages(
  built: BuiltRequest,
  chunk: Chunk,
  deps: ChunkResult[],
  index: number,
  total: number,
): ChatMessage[] {
  const system =
    `You are running chunk ${index + 1} of ${total} of a routed request. ` +
    "Do only this chunk's job, as briefly as the job allows, and never restate the overall goal. " +
    "The host runs tools; you do not.";
  const earlier = deps
    .filter((d) => d.status === "ok")
    .map((d) => `## ${d.chunk.id} — ${d.chunk.title}\n${tailCap(d.output, DEP_OUTPUT_CHARS).text}`)
    .join("\n\n");
  const user = [
    `GOAL (context only, do not answer it):\n${tailCap(goalText(built.request.messages, 1_500), 1_500).text}`,
    earlier ? `EARLIER CHUNKS:\n${earlier}` : "",
    `YOUR CHUNK (${chunk.id} — ${chunk.title}):\n${chunk.prompt ?? chunk.title}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * A plan whose answer chunks form a chain (draft → polish → final) has exactly
 * one terminal answer, and that answer already consumed everything before it.
 * Collapsing the chain to it is both the cheapest and the most faithful
 * assembly: no extra model call, no re-summarising, no lost nuance.
 */
function terminalAnswer(ordered: ChunkResult[]): ChunkResult | undefined {
  const ok = ordered.filter((r) => r.status === "ok");
  const okIds = new Set(ok.map((r) => r.chunk.id));
  const consumed = new Set<string>();
  for (const r of ok) for (const dep of r.chunk.needs) consumed.add(dep);
  const terminals = ok.filter((r) => r.chunk.kind === "answer" && !consumed.has(r.chunk.id));
  if (terminals.length !== 1) return undefined;
  const terminal = terminals[0];
  const byId = new Map(ok.map((r) => [r.chunk.id, r]));
  const ancestors = new Set<string>();
  const stack = [...terminal.chunk.needs];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (ancestors.has(id) || !okIds.has(id)) continue;
    ancestors.add(id);
    const dep = byId.get(id);
    if (dep) stack.push(...dep.chunk.needs);
  }
  for (const r of ok) {
    if (r.chunk.id === terminal.chunk.id) continue;
    if (!ancestors.has(r.chunk.id)) return undefined;
  }
  return terminal;
}

function degradationText(results: ChunkResult[]): string {
  const failures = results
    .filter((r) => r.status !== "ok")
    .slice(0, 6)
    .map((r) => `${r.chunk.id}: ${r.code ?? "error"}${r.error ? ` — ${r.error.slice(0, 140)}` : ""}`)
    .join("; ");
  return (
    "[kono-host] No chunk of this request produced an answer, so nothing was fabricated. " +
    `Chunks attempted: ${results.length}. ${failures || "No failure detail was recorded."} ` +
    "Retry, or check GET /health for live endpoint coverage."
  );
}

export async function executePlan(
  built: BuiltRequest,
  plan: ChunkPlan,
  ports: HostPorts,
  ledger: Ledger,
  options: ExecuteOptions,
): Promise<ExecuteOutcome> {
  const { request } = built;
  const limits = request.limits;
  const span = ledger.span("chunk", {
    chunks: plan.chunks.length,
    source: plan.source,
    concurrency: limits.maxConcurrency,
    chunk_ms: options.chunkMs,
  });
  const results = new Map<string, ChunkResult>();
  const gate = createSemaphore(limits.maxConcurrency);
  let modelCalls = 0;

  const takeModelCall = (): boolean => {
    if (modelCalls >= limits.maxModelCalls) {
      ledger.addNote(
        note("chunk.model_budget", `model call budget ${limits.maxModelCalls} reached`, "degrade", "chunk"),
      );
      return false;
    }
    modelCalls++;
    ledger.bump("model_calls");
    return true;
  };

  const finishChunk = (result: ChunkResult): ChunkResult => {
    results.set(result.chunk.id, result);
    ledger.emit({
      stage: "chunk",
      phase: result.status === "ok" ? "end" : "error",
      chunkId: result.chunk.id,
      ok: result.status === "ok",
      ms: result.ms,
      model: result.model,
      attempt: result.attempts,
      data: {
        status: result.status,
        kind: result.chunk.kind,
        tool: result.chunk.tool,
        chars: result.output.length,
        code: result.code,
        error: result.error?.slice(0, 240),
      },
    });
    return result;
  };

  const runToolChunk = async (chunk: Chunk, deps: ChunkResult[]): Promise<ChunkResult> => {
    const t0 = Date.now();
    const byId = new Map(deps.map((d) => [d.chunk.id, d]));
    const args = substituteRefs(chunk.args ?? {}, byId);
    if (!args.ok) {
      return finishChunk({
        chunk,
        status: "failed",
        output: "",
        ms: Date.now() - t0,
        attempts: 0,
        error: args.error,
        code: "ref_unresolved",
      });
    }
    const timeoutMs = Math.min(limits.maxToolMs, options.chunkMs);
    let attempts = 0;
    let lastError = "";
    let lastCode = "tool_failed";
    while (attempts < 2) {
      attempts++;
      const started = Date.now();
      try {
        const value: ToolResult = await withDeadline(
          timeoutMs,
          request.signal,
          `tool:${chunk.tool}`,
          (signal) =>
            abortable(
              ports.tools.execute(chunk.tool as string, args.value as Json, {
                signal,
                tenant: request.tenant,
                timeoutMs,
              }),
              signal,
              `tool:${chunk.tool}`,
            ),
        );
        ledger.bump("tool_calls");
        ledger.emit({
          stage: "chunk",
          phase: "decision",
          chunkId: chunk.id,
          attempt: attempts - 1,
          ok: value.ok,
          ms: value.ms || Date.now() - started,
          data: { tool: chunk.tool, code: value.code, ok: value.ok },
        });
        if (value.ok) {
          const text = tailCap(safeStringify(value.value), chunk.outputCapChars);
          return finishChunk({
            chunk,
            status: "ok",
            output: text.text,
            value: value.value,
            ms: Date.now() - t0,
            attempts,
          });
        }
        lastError = value.error ?? "tool reported failure";
        lastCode = value.code ?? "tool_failed";
      } catch (err) {
        if (request.signal.aborted) throw err;
        lastError = errText(err);
        lastCode = /DEADLINE|timeout/i.test(lastError) ? "tool_timeout" : "tool_threw";
        ledger.emit({
          stage: "chunk",
          phase: "error",
          chunkId: chunk.id,
          attempt: attempts - 1,
          ok: false,
          ms: Date.now() - started,
          data: { tool: chunk.tool, error: lastError.slice(0, 240) },
        });
      }
      if (attempts === 1 && RETRYABLE.test(lastError)) {
        ledger.bump("retries");
        ledger.emit({
          stage: "chunk",
          phase: "retry",
          chunkId: chunk.id,
          attempt: 1,
          data: { tool: chunk.tool, reason: lastError.slice(0, 160) },
        });
        continue;
      }
      break;
    }
    return finishChunk({
      chunk,
      status: "failed",
      output: "",
      ms: Date.now() - t0,
      attempts,
      error: lastError,
      code: lastCode,
    });
  };

  const runAnswerChunk = async (
    chunk: Chunk,
    deps: ChunkResult[],
    index: number,
  ): Promise<ChunkResult> => {
    const t0 = Date.now();
    // A fallback plan is a pass-through: the caller's own messages, no framing.
    const passThrough = plan.source === "fallback" && plan.chunks.length === 1;
    const messages = passThrough
      ? built.messages
      : chunkMessages(built, chunk, deps, index, plan.chunks.length);
    const pin = built.manifest.candidates[0];
    let attempts = 0;
    let lastError = "";
    let lastCode = "model_failed";
    while (attempts < 2) {
      if (!takeModelCall()) {
        return finishChunk({
          chunk,
          status: "failed",
          output: "",
          ms: Date.now() - t0,
          attempts,
          error: `model call budget ${limits.maxModelCalls} exhausted`,
          code: "model_call_budget",
        });
      }
      attempts++;
      const started = Date.now();
      try {
        const reply = await withDeadline(
          options.chunkMs,
          request.signal,
          `chunk:${chunk.id}`,
          (signal) =>
            abortable(
              ports.models.complete({
                purpose: "chunk",
                messages,
                ...(pin ? { model: pin.modelId, tupleId: pin.tupleId } : {}),
                temperature: request.params.temperature ?? 0.3,
                maxTokens: request.params.maxTokens ?? 1_200,
                deadlineMs: options.chunkMs,
                signal,
                chunkId: chunk.id,
                attempt: attempts - 1,
              }),
              signal,
              `chunk:${chunk.id}`,
            ),
        );
        const text = tailCap(reply.content, chunk.outputCapChars);
        ledger.emit({
          stage: "chunk",
          phase: "decision",
          chunkId: chunk.id,
          attempt: attempts - 1,
          model: reply.model,
          tupleId: reply.tupleId,
          ms: reply.ms,
          data: {
            chars: reply.content.length,
            upstream_attempts: reply.upstreamAttempts,
            truncated: text.truncated,
            prompt_tokens: reply.usage?.promptTokens,
            completion_tokens: reply.usage?.completionTokens,
          },
        });
        if (!reply.content.trim()) {
          lastError = "model returned empty content";
          lastCode = "empty_content";
          if (attempts < 2) {
            ledger.bump("retries");
            ledger.emit({
              stage: "chunk",
              phase: "retry",
              chunkId: chunk.id,
              attempt: attempts,
              data: { reason: lastCode },
            });
            continue;
          }
          break;
        }
        return finishChunk({
          chunk,
          status: "ok",
          output: text.text,
          value: reply.content,
          ms: Date.now() - t0,
          attempts,
          model: reply.model,
        });
      } catch (err) {
        if (request.signal.aborted) throw err;
        lastError = errText(err);
        lastCode = /DEADLINE/i.test(lastError) ? "chunk_timeout" : "model_threw";
        ledger.emit({
          stage: "chunk",
          phase: "error",
          chunkId: chunk.id,
          attempt: attempts - 1,
          ok: false,
          ms: Date.now() - started,
          data: { error: lastError.slice(0, 240) },
        });
        if (attempts < 2 && RETRYABLE.test(lastError)) {
          ledger.bump("retries");
          ledger.emit({
            stage: "chunk",
            phase: "retry",
            chunkId: chunk.id,
            attempt: attempts,
            data: { reason: lastError.slice(0, 160) },
          });
          continue;
        }
        break;
      }
    }
    return finishChunk({
      chunk,
      status: "failed",
      output: "",
      ms: Date.now() - t0,
      attempts,
      error: lastError,
      code: lastCode,
    });
  };

  // ---- schedule ----------------------------------------------------------
  const promises = new Map<string, Promise<ChunkResult>>();
  for (const [index, chunk] of plan.chunks.entries()) {
    const deps = chunk.needs
      .map((id) => promises.get(id))
      .filter((p): p is Promise<ChunkResult> => p !== undefined);
    const promise = (async () => {
      ledger.emit({
        stage: "chunk",
        phase: "start",
        chunkId: chunk.id,
        data: { kind: chunk.kind, tool: chunk.tool, needs: chunk.needs, index },
      });
      const depResults = await Promise.all(deps);
      const failedDep = depResults.find((d) => d.status !== "ok");
      if (failedDep) {
        return finishChunk({
          chunk,
          status: "skipped",
          output: "",
          ms: 0,
          attempts: 0,
          error: `DEPENDENCY_FAILED: ${failedDep.chunk.id}`,
          code: "dependency_failed",
        });
      }
      return gate(() =>
        chunk.kind === "tool" ? runToolChunk(chunk, depResults) : runAnswerChunk(chunk, depResults, index)
      );
    })();
    promises.set(chunk.id, promise);
  }

  await Promise.all([...promises.values()]);
  const ordered = plan.chunks
    .map((c) => results.get(c.id))
    .filter((r): r is ChunkResult => r !== undefined);

  // ---- assemble ----------------------------------------------------------
  const assembleSpan = ledger.span("assemble", { chunks: ordered.length });
  const okChunks = ordered.filter((r) => r.status === "ok");
  const okAnswers = okChunks.filter((r) => r.chunk.kind === "answer");
  const pick = (r: ChunkResult): Assembled => ({
    content: r.output,
    finish: "stop",
    ...(r.model ? { modelUsed: r.model } : {}),
  });

  let assembled: Assembled;
  if (okChunks.length === 0) {
    assembled = { content: degradationText(ordered), finish: "degraded" };
    ledger.addNote(
      note("assemble.degraded", `${ordered.length} chunk(s) produced no usable output`, "degrade", "assemble"),
    );
  } else if (okAnswers.length === 1) {
    assembled = pick(okAnswers[0]);
    ledger.emit({
      stage: "assemble",
      phase: "decision",
      chunkId: okAnswers[0].chunk.id,
      ok: true,
      data: { path: "single_answer" },
    });
  } else if (terminalAnswer(ordered)) {
    const terminal = terminalAnswer(ordered) as ChunkResult;
    assembled = pick(terminal);
    ledger.emit({
      stage: "assemble",
      phase: "decision",
      chunkId: terminal.chunk.id,
      ok: true,
      data: { path: "chain_collapse", chunks: okChunks.length },
    });
  } else if (okAnswers.length === 0) {
    assembled = {
      content: okChunks
        .map((r) => `## ${r.chunk.title}\n${r.output}`)
        .join("\n\n"),
      finish: "stop",
    };
    ledger.emit({ stage: "assemble", phase: "decision", ok: true, data: { path: "tool_outputs" } });
  } else {
    const join = (): Assembled => ({
      content: okAnswers.map((r) => `## ${r.chunk.title}\n${r.output}`).join("\n\n"),
      finish: "stop",
    });
    if (modelCalls >= limits.maxModelCalls) {
      assembled = join();
      ledger.addNote(
        note("assemble.joined", "no model budget left for synthesis; chunk outputs were joined", "warn", "assemble"),
      );
      ledger.emit({ stage: "assemble", phase: "decision", ok: true, data: { path: "join_budget" } });
    } else {
      modelCalls++;
      ledger.bump("model_calls");
      const sections = okAnswers
        .map((r) => `## ${r.chunk.id} — ${r.chunk.title}\n${tailCap(r.output, 4_000).text}`)
        .join("\n\n");
      try {
        const reply = await withDeadline(
          options.synthMs,
          request.signal,
          "synthesize",
          (signal) =>
            abortable(
              ports.models.complete({
                purpose: "synthesize",
                messages: [
                  {
                    role: "system",
                    content:
                      "You are the synthesis stage. Combine the chunk results into one direct answer " +
                      "to the user's request. Do not mention chunks, do not repeat headings, do not invent facts.",
                  },
                  {
                    role: "user",
                    content: `REQUEST:\n${tailCap(goalText(request.messages, 2_000), 2_000).text}\n\nCHUNK RESULTS:\n${sections}`,
                  },
                ],
                temperature: 0.2,
                maxTokens: request.params.maxTokens ?? 1_500,
                deadlineMs: options.synthMs,
                signal,
                chunkId: "synthesize",
                attempt: 0,
              }),
              signal,
              "synthesize",
            ),
        );
        assembled = {
          content: reply.content.trim() || join().content,
          finish: "stop",
          modelUsed: reply.model,
          ...(reply.tupleId ? { tupleId: reply.tupleId } : {}),
        };
        ledger.emit({
          stage: "assemble",
          phase: "decision",
          chunkId: "synthesize",
          ok: true,
          ms: reply.ms,
          model: reply.model,
          data: { path: "synthesize", chars: assembled.content.length },
        });
      } catch (err) {
        if (request.signal.aborted) throw err;
        assembled = join();
        ledger.addNote(
          note("assemble.synth_failed", `synthesis failed, chunks joined: ${errText(err).slice(0, 200)}`, "degrade", "assemble"),
        );
        ledger.emit({
          stage: "assemble",
          phase: "error",
          chunkId: "synthesize",
          ok: false,
          data: { path: "join_after_error" },
        });
      }
    }
  }

  assembleSpan.end(assembled.finish !== "degraded", {
    finish: assembled.finish,
    chars: assembled.content.length,
    ok_chunks: okChunks.length,
  });
  span.end(assembled.finish !== "degraded", {
    chunks: ordered.length,
    ok: okChunks.length,
    finish: assembled.finish,
    model_calls: modelCalls,
  });

  return { results: ordered, assembled };
}
```

// host/host.ts — the orchestrator. Owns ids, the master abort/deadline signal,
// the stage order, the report ring, and the RouteReport.explain() renderer.
// No routing logic lives here.

host/host.ts
```ts
// host/host.ts — the orchestrator. It owns exactly four things: request ids,
// the master abort/deadline signal, the stage order, and the report ring.
// All routing logic lives in the stages; all state lives in the ledger.

import type {
  ChunkPlan,
  ChunkResult,
  EventSink,
  HostContext,
  HostPorts,
  HostResponse,
  HostRouter,
  RequestLimits,
  RouteReport,
} from "./contracts.ts";
import { Ledger } from "./ledger.ts";
import { intake, mergeLimits } from "./intake.ts";
import { buildRequest } from "./build.ts";
import { decompose } from "./decompose.ts";
import { executePlan } from "./execute.ts";
import { errText, isAbort, note, shortId } from "./support.ts";

export interface HostRouterOptions {
  /** Per-router overrides of the default limits. */
  limits?: Partial<RequestLimits>;
  /** How many reports stay resolvable by `report(id)` (ring, newest kept). */
  retainReports?: number;
}

function emptyPlan(requestId: string, rationale: string): ChunkPlan {
  return {
    requestId,
    source: "fallback",
    rationale,
    chunks: [],
    plannerAttempts: 0,
    plannerMs: 0,
    rejects: [],
    repairErrors: [],
  };
}

function explainReport(r: Omit<RouteReport, "explain">): string {
  const ok = r.chunks.filter((c) => c.status === "ok").length;
  const head =
    `${r.requestId} ${r.modelRequested} → ${r.mode}/${r.taskClass} | ` +
    `plan ${r.planSource} (${r.chunks.length} chunk${r.chunks.length === 1 ? "" : "s"}, ${ok} ok) | ` +
    `calls model ${r.modelCalls} / tool ${r.toolCalls}, retries ${r.retries}, errors ${r.errors} | ` +
    `${Math.round(r.totalMs)}ms of ${Math.round(r.budgetMs)}ms | finish ${r.finish}`;
  const lines = r.chunks.map((c) => {
    const outcome = c.status === "ok" ? `ok ${Math.round(c.ms)}ms` : `${c.status} (${c.code ?? "error"})`;
    const model = c.model ? ` via ${c.model}` : "";
    const tool = c.chunk.tool ? ` tool=${c.chunk.tool}` : "";
    return `  ${c.chunk.id} [${c.chunk.kind}${tool}] → ${outcome}${model}${c.output ? ` ${c.output.length}c` : ""}`;
  });
  const degraded = r.notes.filter((n) => n.severity === "degrade");
  const notes = r.notes.length > 0
    ? `\nnotes: ${r.notes.length}${degraded.length ? ` (${degraded.length} degraded: ${degraded.slice(0, 3).map((n) => n.code).join(", ")})` : ""}`
    : "";
  const stages = `\nstages: ${r.stages.map((s) => `${s.stage} ${Math.round(s.ms)}ms${s.errors ? `/${s.errors}err` : ""}`).join(" · ")}`;
  return [head, ...lines, stages + notes].join("\n");
}

export function createHostRouter(ports: HostPorts, options: HostRouterOptions = {}): HostRouter {
  const limits = mergeLimits(options.limits);
  const retain = Math.max(1, Math.round(options.retainReports ?? 64));
  const clock = ports.clock ?? { now: () => Date.now() };
  const ids = ports.ids ?? { next: (prefix: string) => `${prefix}_${shortId()}` };
  const reports = new Map<string, RouteReport>();

  return {
    async handle(raw: unknown, ctx: HostContext): Promise<HostResponse> {
      const requestId = ids.next("req");
      const startedAt = clock.now();
      const sinks: EventSink[] = ports.events ? [ports.events] : [];
      const ledger = new Ledger({ requestId, startedAt, clock: clock.now, sinks });

      const draft = intake(raw, ctx, limits, ledger);

      // One master signal: caller disconnect, budget expiry, or an internal
      // abort all look the same downstream, which is what makes cleanup simple.
      const master = new AbortController();
      const onCallerAbort = () => master.abort(ctx.signal?.reason ?? new Error("CLIENT_DISCONNECTED"));
      if (ctx.signal) {
        if (ctx.signal.aborted) onCallerAbort();
        else ctx.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      const budgetTimer = setTimeout(
        () => master.abort(new Error(`BUDGET_EXCEEDED: ${draft.budgetMs}ms`)),
        Math.max(1, draft.budgetMs),
      );
      const request = { ...draft, signal: master.signal };

      let plan = emptyPlan(requestId, "no plan: the request failed before decomposition");
      let results: ChunkResult[] = [];
      let content = "";
      let finish: RouteReport["finish"] = "degraded";
      let modelUsed: string | undefined;
      let tupleId: string | undefined;

      try {
        const built = await buildRequest(request, ports, ledger);
        plan = await decompose(built, ports, ledger, built.manifest.budget.plannerMs);
        const outcome = await executePlan(built, plan, ports, ledger, {
          chunkMs: built.manifest.budget.chunkMs,
          synthMs: built.manifest.budget.synthMs,
        });
        results = outcome.results;
        content = outcome.assembled.content;
        finish = outcome.assembled.finish;
        modelUsed = outcome.assembled.modelUsed;
        tupleId = outcome.assembled.tupleId;
      } catch (err) {
        const aborted = isAbort(err) && master.signal.aborted;
        finish = aborted ? "abort" : "degraded";
        content = aborted
          ? `[kono-host] Request aborted before an answer was produced (${errText(err).slice(0, 120)}).`
          : `[kono-host] The host failed before producing an answer. Nothing was fabricated. ${errText(err).slice(0, 200)}`;
        ledger.addNote(
          note(
            aborted ? "request.aborted" : "request.internal_error",
            errText(err).slice(0, 300),
            "degrade",
            "done",
          ),
        );
        ledger.emit({
          stage: "done",
          phase: "error",
          ok: false,
          data: { finish, error: errText(err).slice(0, 240) },
        });
      } finally {
        clearTimeout(budgetTimer);
        ctx.signal?.removeEventListener("abort", onCallerAbort);
      }

      if (finish !== "abort") {
        ledger.emit({
          stage: "done",
          phase: "end",
          ok: finish === "stop",
          data: {
            finish,
            chars: content.length,
            model: modelUsed,
            tuple_id: tupleId,
            chunks: results.length,
          },
        });
      }

      const counters = ledger.counters();
      const totalMs = ledger.elapsed();
      const fields: Omit<RouteReport, "explain"> = {
        requestId,
        traceparent: request.traceparent,
        modelRequested: request.model,
        ...(modelUsed ? { modelUsed } : {}),
        ...(tupleId ? { tupleId } : {}),
        mode: request.mode,
        taskClass: request.taskClass,
        planSource: plan.source,
        stages: ledger.summarize(),
        modelCalls: counters.model_calls,
        toolCalls: counters.tool_calls,
        retries: counters.retries,
        errors: counters.errors,
        chunks: results,
        notes: ledger.notes,
        totalMs,
        budgetMs: request.budgetMs,
        finish,
      };
      const report: RouteReport = { ...fields, explain: () => explainReport(fields) };

      reports.set(requestId, report);
      while (reports.size > retain) {
        const oldest = reports.keys().next();
        if (oldest.done) break;
        reports.delete(oldest.value);
      }

      return { content, finish, report, plan, events: ledger.events };
    },

    report(requestId: string): RouteReport | undefined {
      return reports.get(requestId);
    },
  };
}
```

// host/index.ts — the public surface. Import from here, never from a stage, so
// the pipeline stays free to move between files.

host/index.ts
```ts
// host/index.ts — the public surface. Import from here, never from a stage,
// so the pipeline stays free to move between files.

export type * from "./contracts.ts";
export { Ledger } from "./ledger.ts";
export type { CounterName, LedgerInit, SpanHandle } from "./ledger.ts";
export { intake, mergeLimits } from "./intake.ts";
export { buildRequest, budgetFor } from "./build.ts";
export { decompose, describePlan, validatePlan } from "./decompose.ts";
export { executePlan, substituteRefs } from "./execute.ts";
export { createHostRouter } from "./host.ts";
export type { HostRouterOptions } from "./host.ts";
export { createMemoryPorts, memoryPortsWithEvents } from "./adapters/memory.ts";
export type { MemoryPortsOptions } from "./adapters/memory.ts";
export { DEFAULT_LIMITS } from "./support.ts";
```

// host/adapters/memory.ts — a complete set of ports with no network, no KV and
// no clock of its own. This is what makes the spine provable: if the simplest
// request cannot run through these, it cannot run against real endpoints.

host/adapters/memory.ts
```ts
// host/adapters/memory.ts — a complete set of ports with no network, no KV and
// no clock of its own. This is the adapter the tests use and the one a host
// boots with before it has a catalog: if the pipeline cannot run the simplest
// possible request through these, it cannot run anything.

import type {
  CandidateRef,
  HostEvent,
  HostPorts,
  Json,
  ModelCall,
  ModelReply,
  ToolDecl,
  ToolResult,
} from "../contracts.ts";
import { isRecord, safeStringify, sleep } from "../support.ts";

export interface MemoryPortsOptions {
  /** Planner reply. Return a string, a JSON value, or null for the default plan. */
  planner?: (call: ModelCall) => Json | string | null | Promise<Json | string | null>;
  /** Answer text for a chunk or synthesis call. */
  answer?: (call: ModelCall) => string | Promise<string>;
  /** Make every planner call throw (exercises the fallback path). */
  failPlanner?: boolean;
  /** Tool implementations by name. Defaults to a tiny lookup/calc pair. */
  tools?: Record<string, (args: Json, signal: AbortSignal) => unknown | Promise<unknown>>;
  candidates?: CandidateRef[];
  /** Artificial latency per model call. */
  latencyMs?: number;
}

const BUILTIN_TOOLS: ToolDecl[] = [
  {
    name: "web_lookup",
    description: "Look up current facts about a topic.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
    source: "builtin",
  },
  {
    name: "calculate",
    description: "Evaluate an arithmetic expression exactly.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    source: "builtin",
  },
];

const DEFAULT_CANDIDATES: CandidateRef[] = [
  {
    tupleId: "memory::planner-1",
    providerId: "memory",
    modelId: "memory-model",
    score: 0.9,
    supportsTools: true,
    supportsVision: false,
    contextWindow: 32_000,
    p50TtftMs: 40,
  },
  {
    tupleId: "memory::planner-2",
    providerId: "memory",
    modelId: "memory-model-alt",
    score: 0.8,
    supportsTools: true,
    supportsVision: false,
    contextWindow: 32_000,
    p50TtftMs: 60,
  },
];

/** The default plan: one lookup, one draft, one tighten. Written to be small,
 *  ordered, and to exercise a real dependency edge. */
function defaultPlan(hasLookup: boolean): Json {
  const chunks: Json[] = [];
  if (hasLookup) {
    chunks.push({
      id: "facts",
      title: "Collect facts",
      kind: "tool",
      tool: "web_lookup",
      args: { topic: "the user's request" },
      needs: [],
    });
  }
  chunks.push({
    id: "draft",
    title: "Draft the answer",
    kind: "answer",
    needs: hasLookup ? ["facts"] : [],
    prompt: "Answer the user's request in two sentences.",
  });
  chunks.push({
    id: "polish",
    title: "Tighten the answer",
    kind: "answer",
    needs: ["draft"],
    prompt: "Rewrite the draft as one short, concrete sentence.",
  });
  return { rationale: "look up, draft, tighten", chunks };
}

function catalogText(call: ModelCall): string {
  const user = [...call.messages].reverse().find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

export function createMemoryPorts(options: MemoryPortsOptions = {}): HostPorts {
  const toolImpls = options.tools ?? {
    web_lookup: (args: Json) => ({
      topic: typeof args.topic === "string" ? args.topic : "unknown",
      facts: ["a", "b", "c"],
    }),
    calculate: (args: Json) => ({
      expression: typeof args.expression === "string" ? args.expression : "",
      value: 42,
    }),
  };

  const complete = async (call: ModelCall): Promise<ModelReply> => {
    const started = Date.now();
    if (options.latencyMs) await sleep(options.latencyMs, call.signal);
    if (call.signal.aborted) throw call.signal.reason ?? new Error("ABORTED");

    if (call.purpose === "planner" || call.purpose === "repair") {
      if (options.failPlanner) throw new Error("HTTP_503: planner unavailable");
      const reply = options.planner
        ? await options.planner(call)
        : defaultPlan(/-\s*web_lookup/.test(catalogText(call)));
      const content = reply === null
        ? safeStringify(defaultPlan(/-\s*web_lookup/.test(catalogText(call))))
        : typeof reply === "string"
        ? reply
        : safeStringify(reply);
      return {
        content,
        model: "memory-planner",
        ms: Date.now() - started,
        upstreamAttempts: 1,
      };
    }

    if (call.purpose === "synthesize") {
      const content = options.answer
        ? await options.answer(call)
        : `[synthesize] ${catalogText(call).split("\n").filter(Boolean).slice(-1)[0] ?? ""}`;
      return { content, model: "memory-synth", ms: Date.now() - started, upstreamAttempts: 1 };
    }

    const content = options.answer
      ? await options.answer(call)
      : `[${call.chunkId ?? "single"}] answered`;
    return { content, model: "memory-answer", ms: Date.now() - started, upstreamAttempts: 1 };
  };

  return {
    candidates: {
      async rank() {
        return options.candidates ?? DEFAULT_CANDIDATES;
      },
    },
    models: { complete },
    tools: {
      list() {
        return BUILTIN_TOOLS;
      },
      has(name: string) {
        return Object.prototype.hasOwnProperty.call(toolImpls, name);
      },
      async execute(name: string, args: Json, o): Promise<ToolResult> {
        const impl = toolImpls[name];
        const started = Date.now();
        if (!impl) {
          return { ok: false, error: `unknown tool ${name}`, code: "unknown_tool", ms: 0 };
        }
        try {
          const value = await impl(args, o.signal);
          return { ok: true, value, ms: Date.now() - started };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : safeStringify(e, 200),
            code: isRecord(e) && typeof (e as Json).code === "string"
              ? String((e as Json).code)
              : "tool_error",
            ms: Date.now() - started,
          };
        }
      },
    },
  };
}

/** Convenience: an in-memory router that can be called in one line. */
export function memoryPortsWithEvents(
  collected: HostEvent[],
  options: MemoryPortsOptions = {},
): HostPorts {
  const ports = createMemoryPorts(options);
  return { ...ports, events: (e) => collected.push(e) };
}
```

// tests/host_routing_test.ts — the spine, proven: simple request end to end,
// prose-answering planner, undeclared tool, cycle impossibility, ref
// substitution, dead tool cascade, caller abort, planner budget floor, and a
// hostile body through intake. A ~30-line harness replaces node:test and
// Deno.test, so the same file runs under either runtime.

tests/host_routing_test.ts
```ts
// tests/host_routing_test.ts — the host spine, proven without a network, a key
// or a KV. Runtime-neutral: a ~30-line harness, no `node:test`, no `Deno.test`,
// no imports outside `host/`.
//
//   node --experimental-strip-types tests/host_routing_test.ts
//   deno run -A tests/host_routing_test.ts

import {
  buildRequest,
  createHostRouter,
  decompose,
  intake,
  Ledger,
  memoryPortsWithEvents,
  mergeLimits,
  substituteRefs,
  validatePlan,
} from "../host/index.ts";
import type { ChunkResult, HostEvent, HostPorts, Json } from "../host/index.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type TestFn = () => Promise<void> | void;

interface Case {
  name: string;
  fn: TestFn;
}

const cases: Case[] = [];

export function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

export function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function expectEqual(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? `${msg}: ` : ""}expected ${e}, got ${a}`);
}

export function expectMatch(text: string, re: RegExp, msg = ""): void {
  if (!re.test(text)) {
    throw new Error(`${msg ? `${msg}: ` : ""}expected ${re} in ${JSON.stringify(text.slice(0, 200))}`);
  }
}

export async function run(): Promise<{ passed: number; failed: Array<{ name: string; error: string }> }> {
  const failed: Array<{ name: string; error: string }> = [];
  let passed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`ok   ${c.name}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ name: c.name, error });
      console.log(`FAIL ${c.name}\n     ${error.replace(/\n/g, "\n     ")}`);
    }
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const silentPorts = (): HostPorts => memoryPortsWithEvents([]);

function simpleBody(extra: Json = {}): Json {
  return {
    model: "free:auto",
    tools: "auto",
    messages: [{ role: "user", content: "What is the capital of France?" }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// the spine
// ---------------------------------------------------------------------------

test("a simple request is built, decomposed by the AI, executed and assembled", async () => {
  const events: HostEvent[] = [];
  const router = createHostRouter(memoryPortsWithEvents(events));
  const res = await router.handle(simpleBody(), { tenant: "test" });

  expectEqual(res.finish, "stop", "finish");
  expectEqual(res.plan.source, "planner", "plan source");
  expectEqual(res.plan.chunks.map((c) => c.id), ["facts", "draft", "polish"], "chunk ids");
  expectEqual(res.plan.chunks.map((c) => c.needs), [[], ["facts"], ["draft"]], "dependencies");
  expectMatch(res.content, /\[polish\] answered/, "assembled from the terminal chunk");
  expectEqual(res.report.toolCalls, 1, "tool calls");
  expect(res.report.modelCalls >= 3, `model calls: ${res.report.modelCalls}`);
  expectEqual(res.report.chunks.filter((c) => c.status === "ok").length, 3, "ok chunks");
  expectEqual(res.report.finish, "stop", "report finish");

  // Visibility: one monotonic stream, every stage represented.
  expect(events.length > 10, `event count: ${events.length}`);
  expectEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seq is monotonic");
  const stages = new Set(events.map((e) => e.stage));
  for (const stage of ["intake", "build", "rank", "decompose", "chunk", "assemble", "done"]) {
    expect(stages.has(stage as HostEvent["stage"]), `missing stage ${stage}`);
  }
  const chunkEnds = events.filter((e) => e.stage === "chunk" && e.phase === "end" && e.chunkId);
  expectEqual(chunkEnds.length, 3, "one end event per chunk");
  expect(res.report.explain().includes(res.report.requestId), "explain names the request");
  expectEqual(router.report(res.report.requestId)?.finish, "stop", "report ring");
});

test("a planner that answers in prose degrades to one chunk instead of failing", async () => {
  const ports = memoryPortsWithEvents([], { planner: () => "I would rather not answer in JSON." });
  const res = await createHostRouter(ports).handle(simpleBody(), { tenant: "test" });

  expectEqual(res.finish, "stop", "finish");
  expectEqual(res.plan.source, "fallback", "fallback source");
  expectEqual(res.plan.chunks.length, 1, "single chunk");
  expectEqual(res.plan.plannerAttempts, 2, "bounded attempts");
  expect(res.plan.rejects.some((r) => r.code === "decompose.fallback"), "fallback note");
  expectMatch(res.content, /\[answer\] answered/, "pass-through answer");
  expect(res.report.errors >= 2, "both planner attempts are visible as errors");
});

test("a chunk that names an undeclared tool is rejected, the rest still run", async () => {
  const plan: Json = {
    rationale: "run a shell command, then summarise",
    chunks: [
      { id: "run", title: "Run", kind: "tool", tool: "shell", args: {}, needs: [] },
      { id: "sum", title: "Sum", kind: "answer", needs: ["run"], prompt: "Summarise the result." },
    ],
  };
  const ports = memoryPortsWithEvents([], { planner: () => plan });
  const res = await createHostRouter(ports).handle(simpleBody(), { tenant: "test" });

  expectEqual(res.finish, "stop", "finish");
  expectEqual(res.plan.source, "planner", "plan source");
  expectEqual(res.plan.chunks.map((c) => c.id), ["sum"], "only the safe chunk runs");
  expectEqual(res.plan.chunks[0].needs, [], "orphaned dependency dropped");
  expect(res.plan.rejects.some((r) => r.code === "chunk.tool_not_declared"), "tool reject");
  expect(res.plan.rejects.some((r) => r.code === "chunk.need_dropped"), "need reject");
  expectMatch(res.content, /\[sum\] answered/, "remaining chunk still answers");
});

test("dependency cycles are impossible: needs may only point backwards", () => {
  const v = validatePlan(
    {
      chunks: [
        { id: "a", kind: "answer", prompt: "first", needs: ["b"] },
        { id: "b", kind: "answer", prompt: "second", needs: ["a"] },
      ],
    },
    new Set(),
    mergeLimits(),
  );
  expectEqual(v.chunks.length, 2, "chunks kept");
  expectEqual(v.chunks[0].needs, [], "forward dependency dropped");
  expectEqual(v.chunks[1].needs, ["a"], "backward dependency kept");
  expect(v.rejects.some((r) => r.code === "chunk.need_dropped"), "drop is recorded");
});

test("tool args may only read earlier chunks", () => {
  const v = validatePlan(
    {
      chunks: [
        { id: "late", kind: "tool", tool: "web_lookup", args: { q: "$missing" } },
        { id: "fine", kind: "tool", tool: "web_lookup", args: { q: "static" } },
      ],
    },
    new Set(["web_lookup"]),
    mergeLimits(),
  );
  expectEqual(v.chunks.map((c) => c.id), ["fine"], "unresolved ref rejects the chunk");
  expect(v.rejects.some((r) => r.code === "chunk.ref_unresolved"), "ref reject recorded");
});

test("refs substitute whole values and inline text", () => {
  const result: ChunkResult = {
    chunk: { id: "facts", title: "Facts", kind: "tool", needs: [], outputCapChars: 1_000 },
    status: "ok",
    output: '{"capital":"Paris"}',
    value: { capital: "Paris", tags: ["europe", "france"] },
    ms: 1,
    attempts: 1,
  };
  const results = new Map([["facts", result]]);
  const whole = substituteRefs({ city: "$facts/capital" }, results);
  expect(whole.ok, "whole ref resolves");
  if (whole.ok) expectEqual(whole.value, { city: "Paris" }, "whole ref");
  const inline = substituteRefs({ text: "it is $facts/capital, tags $facts/tags/0" }, results);
  expect(inline.ok, "inline ref resolves");
  if (inline.ok) expectEqual(inline.value, { text: "it is Paris, tags europe" }, "inline ref");
  expectEqual(substituteRefs({ text: "$nope" }, results).ok, false, "missing ref fails");
});

test("a dead tool fails its chunk, skips dependents, and never fabricates an answer", async () => {
  const ports = memoryPortsWithEvents([], {
    tools: {
      web_lookup: () => {
        throw new Error("HTTP_500: upstream exploded");
      },
    },
  });
  const res = await createHostRouter(ports).handle(simpleBody(), { tenant: "test" });

  expectEqual(res.finish, "degraded", "finish");
  expectEqual(res.report.chunks.map((c) => c.status), ["failed", "skipped", "skipped"], "statuses");
  expectEqual(
    res.report.chunks.map((c) => c.code),
    ["tool_error", "dependency_failed", "dependency_failed"],
    "codes",
  );
  expectMatch(res.content, /No chunk of this request produced an answer/, "degraded body");
  expect(res.report.notes.some((n) => n.code === "assemble.degraded"), "degraded note");
  expectEqual(res.report.retries, 1, "the 500 was retried exactly once");
});

test("an aborting caller gets an abort, not an answer", async () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error("CLIENT_DISCONNECTED"));
  const res = await createHostRouter(silentPorts()).handle(simpleBody(), {
    tenant: "test",
    signal: ctrl.signal,
  });
  expectEqual(res.finish, "abort", "finish");
  expectMatch(res.content, /aborted before an answer/, "abort body");
  expect(res.report.notes.some((n) => n.code === "request.aborted"), "abort note");
});

test("too little planner budget falls back before calling a model", async () => {
  const ledger = new Ledger({ requestId: "req_unit", startedAt: Date.now() });
  const ports = silentPorts();
  const request = intake(simpleBody(), { tenant: "test" }, undefined, ledger);
  const built = await buildRequest({ ...request, signal: new AbortController().signal }, ports, ledger);
  const plan = await decompose(built, ports, ledger, 500);
  expectEqual(plan.source, "fallback", "fallback source");
  expect(plan.rejects.some((r) => r.code === "decompose.no_budget"), "budget floor note");
  expectEqual(plan.chunks.length, 1, "single chunk");
});

test("intake tames a hostile body and records every change", () => {
  const ledger = new Ledger({ requestId: "req_intake", startedAt: Date.now() });
  const request = intake(
    {
      model: 42,
      temperature: 9,
      max_tokens: -5,
      messages: [
        { role: "wizard", content: "hello" },
        {
          role: "user",
          content: [{ type: "text", text: "see " }, { type: "image_url", image_url: { url: "x" } }],
        },
        17,
      ],
      tools: [{ name: "ok" }, { name: "" }, "nope"],
    },
    { tenant: "" },
    { maxMessages: 8 },
    ledger,
  );
  expectEqual(request.model, "free:auto", "model default");
  expectEqual(request.tenant, "global", "tenant default");
  expectEqual(request.params.temperature, 2, "temperature clamped");
  expectEqual(request.params.maxTokens, 1, "max_tokens clamped");
  expectEqual(request.messages.length, 2, "non-object message dropped");
  expectEqual(request.messages[0].role, "user", "unknown role coerced");
  expect(request.hasImages, "image part detected");
  expectEqual(request.clientTools.length, 1, "only the valid tool kept");
  const codes = request.notes.map((n) => n.code);
  for (const code of [
    "messages.role",
    "messages.item",
    "tools.bad_name",
    "params.temperature",
    "model.default",
  ]) {
    expect(codes.includes(code), `missing intake note ${code}`);
  }
});

// ---------------------------------------------------------------------------
// direct invocation (node or deno); silent when imported by a test runner
// ---------------------------------------------------------------------------

const meta = import.meta as unknown as { main?: boolean };
const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
const isDirect = meta.main === true || argv.some((a) => a.endsWith("host_routing_test.ts"));

if (isDirect) {
  const { failed } = await run();
  if (failed.length > 0) throw new Error(`${failed.length} host routing test(s) failed`);
}
```

---

# Part C — what is proven, and what is deliberately not here yet

## Proven on this branch

`tsc --strict --noEmit` is clean across `host/**` and the test file.
`node --experimental-strip-types tests/host_routing_test.ts` reports
**10 passed, 0 failed**:

| Test | What it pins down |
| --- | --- |
| a simple request is built, decomposed by the AI, executed and assembled | 3 chunks, dependency order, 1 tool call, 3 model calls, all 7 stages in one monotonic event stream, `report()` still resolvable |
| a planner that answers in prose degrades to one chunk | 2 bounded attempts, `source: "fallback"`, request still answers, errors visible |
| an undeclared tool chunk is rejected, the rest still run | planner cannot widen its own tool set; the orphaned dependency is dropped with a note |
| dependency cycles are impossible | `needs` may only point backwards, by construction |
| tool args may only read earlier chunks | `$missing` rejects the chunk, not the request |
| refs substitute whole values and inline text | `$facts/capital`, `$facts/tags/0`, and unresolved refs |
| a dead tool fails its chunk, skips dependents, never fabricates | `failed` + 2×`skipped`, degraded body, exactly one retry |
| an aborting caller gets an abort, not an answer | one abort path, note recorded |
| too little planner budget falls back before calling a model | the budget floor is enforced before any spend |
| intake tames a hostile body | bad model, temperature 9, role `wizard`, image parts, malformed tools — all noted |

## Not in this minimum (the next five cuts, in dependency order)

1. **Streaming adapter.** `ModelPort.complete` is buffered by design; an SSE
   pass-through is `Ledger` events → `HostEvent` → `data:` frames, and the
   existing `keepalive` / `idleBuffered` / `commit` logic from `routes/chat.ts`
   is reusable as-is once chunk outputs are streamed.
2. **Hedging tier adapter.** `HEDGE` / `ESCALATION` / `WIDE` / `SWEEP` and
   `hedgedDispatch` become the implementation behind `ModelPort`; the spine
   already records `upstreamAttempts` per call, so the hedge is visible without
   changing a single stage interface.
3. **Real candidate adapter.** `getRankedCandidates` + `allSweepCandidates`
   behind `CandidatePort`; `scoreRecord` needs no changes, only mapping to
   `CandidateRef`.
4. **Tool-plane adapter.** `executeOwnedToolCalls` / `executeTool` behind
   `ToolPort`, with `ToolCaps` (kv, namespace, depth) carried in
   `ToolRunOptions`.
5. **Report persistence + learning.** `RouteReport` is already serializable;
   `ChunkResult` carries the model, tuple, ms and codes that ASCK-L and ASCK-T
   rewards need, so neither loop has to be re-instrumented.

Two deliberate omissions worth naming: intake reduces image parts to a
placeholder (`hasImages` is still set, so ranking and vision gates work), and
`assemble` uses a single synthesis call rather than the compiler-style
multi-sample join — both are one adapter away and neither changes a contract.
