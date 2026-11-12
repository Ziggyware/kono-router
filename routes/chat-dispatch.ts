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
import { atomicUpdateModel } from "../engine/core.ts";

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
    await atomicUpdateModel(tupleId, (r) => ({
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
