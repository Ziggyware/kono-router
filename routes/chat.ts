// routes/chat.ts — Chat route registrations extracted from main.ts.
// main.ts calls registerChat() at the position of this area's first route, preserving registration order.

import { thompsonPropensity, betaMean, gradeReward, classifyTask, DEFAULT_STRATEGY_ARMS, armsForClass, emptyCell, effectivePosterior, chooseThompson, PROMPT_VARIANTS, rankLessons, decideCompute, failureSignature } from "../learning.ts";
import type { StrategyArm, TaskContext, Lesson, ComputeDecision, RewardSignal, BanditCandidate } from "../learning.ts";
import { evaluate as evaluateCalc } from "../toolbox/calc.ts";
import { parseToolArguments, partitionToolCalls, executeToolCalls, toolResultContent, normalizeToolCalls, listTools, observeTupleToolStats, resolveAutoToolNames, mergeToolDeclarations, toToolSpecs, toolPreamble } from "../tools.ts";
import type { ToolCaps, ToolExecution } from "../tools.ts";
import { startTrace } from "../trace.ts";
import type { Span } from "../trace.ts";
import { hedgePlan, clamp as clampNum, modelSimilarity } from "../math.ts";
import type { Context } from "hono";
import { workspaceBrief, workspaceSigFor } from "../toolbox/project.ts";
import { buildGate } from "../toolbox/testing.ts";
import type { GateVerdict } from "../toolbox/testing.ts";
import { hydrateLearning, hydrateToolSkills, hydrateForgedTools, learningKappa } from "../main.ts";
import type { PendingDecision, StoredDecision, ScoredCandidate, Json, RoutingMode, UpstreamStream, CompletionOptions, RankOptions, CompletionResult, ToolCallDelta, Delta } from "../main.ts";
import { ARM_DEFS, ARM_CELLS, kv, LEARN_DECISION_PREFIX, DECISION_TTL_MS, L1_CACHE, TOOL_SKILLS, SSE_HEADERS, honoApp, LESSONS } from "../state.ts";
import { logErr, errText, traceAttrs, toolPlaneEnabled, maxToolRounds, toolNamespace, armCellKey, extractMessageText, classifyPromptIntent, strictErrors, mergeToolCalls } from "../util.ts";
import { contextualPosterior, recordLearningReward, recordTupleFailure, recordTupleSuccess, writeLesson } from "../engine/learning.ts";
import { resolveProviderById, activeProviderList, PROVIDERS, getRankedCandidates, allSweepCandidates } from "../engine/providers.ts";
import { recordToolExecution, normalizeMessages, isAdminContext, toolCaps, collectUpstream } from "../engine/dispatch.ts";
import { atomicUpdateModel } from "../engine/core.ts";



export async function loadStrategyArms(): Promise<StrategyArm[]> {
  await hydrateLearning();
  return [...ARM_DEFS.values()];
}



export function armGlobalPosterior(armId: string): { alpha: number; beta: number } {
  let s = 0;
  let f = 0;
  for (const c of ARM_CELLS.values()) {
    if (c.arm_id !== armId) continue;
    s += Math.max(0, c.alpha - 1);
    f += Math.max(0, c.beta - 1);
  }
  return { alpha: 1 + s, beta: 1 + f };
}



export interface LearnCtx {
  traceId: string;
  taskCtx: TaskContext;
  arm: StrategyArm;
  armPropensity: number;
  tenant: string;
  lessons: Lesson[];
  hasVerifier: boolean;
  planeActive: boolean;
  compute: ComputeDecision;
}



export async function saveDecision(d: PendingDecision, reward: number | null): Promise<void> {
  const rec: StoredDecision = {
    traceId: d.traceId,
    ts: d.ts,
    taskClass: d.taskClass,
    action: d.armId,
    tupleId: d.tupleId,
    propensity: d.armPropensity,
    armPropensity: d.armPropensity,
    tuplePropensity: d.tuplePropensity,
    tokens: d.tokens,
    extraTokens: d.extraTokens,
    expectedReward: d.expectedReward,
    computeMode: d.computeMode,
    lessonIds: d.lessonIds,
    tenant: d.tenant,
    reward,
  };
  await kv.set([LEARN_DECISION_PREFIX, d.traceId], rec, { expireIn: DECISION_TTL_MS }).catch(logErr);
}



/** Grade a finished decision and persist everything the loop learns from. */
export async function finalizeLearning(args: {
  ctx: LearnCtx;
  cand: ScoredCandidate;
  ranked: ScoredCandidate[];
  signals: RewardSignal[];
  tokens: number;
  extraTokens: number;
  now: number;
}): Promise<void> {
  const { ctx, cand } = args;
  const top = args.ranked.slice(0, 8);
  if (!top.some((c) => c.tupleId === cand.tupleId)) top.push(cand);
  const cands: BanditCandidate[] = top.map((c) => {
    const rec = L1_CACHE.get(c.tupleId);
    const post = rec
      ? contextualPosterior(rec, ctx.taskCtx.taskClass, ctx.tenant, args.now)
      : { alpha: 2, beta: 1, pulls: 0 };
    return { id: c.tupleId, alpha: post.alpha, beta: post.beta, pulls: post.pulls };
  });
  const winner = cands.find((c) => c.id === cand.tupleId) ?? cands[0];
  const tuplePropensity = thompsonPropensity(cands, cand.tupleId, Math.random, 120);
  const d: PendingDecision = {
    traceId: ctx.traceId,
    ts: args.now,
    taskClass: ctx.taskCtx.taskClass,
    tupleId: cand.tupleId,
    armId: ctx.arm.id,
    tenant: ctx.tenant,
    armPropensity: ctx.armPropensity,
    tuplePropensity,
    tokens: args.tokens,
    extraTokens: args.extraTokens,
    expectedReward: winner ? Number(betaMean(winner.alpha, winner.beta).toFixed(4)) : 0.5,
    computeMode: ctx.compute.mode,
    lessonIds: ctx.lessons.map((l) => l.id),
  };
  if (!d.traceId) return;
  const graded = gradeReward(args.signals, { tupleId: cand.tupleId, armId: ctx.arm.id });
  await saveDecision(d, graded?.reward ?? null);
  if (graded) await recordLearningReward(d, graded);
}



/** Arithmetic verifier: the deterministic calculate evaluator, independent
 *  of whatever model produced the answer. */
export function verifyMathAnswer(userText: string, answer: string): { pass: boolean; expected: number } | null {
  const m = userText.replace(/,/g, "").match(/\d+(?:\.\d+)?(?:\s*[-+*/^%()]\s*\d+(?:\.\d+)?)+/);
  if (!m) return null;
  const expr = m[0].trim();
  if (expr.length > 120) return null;
  let expected: number;
  try {
    expected = evaluateCalc(expr);
  } catch {
    return null;
  }
  if (!Number.isFinite(expected)) return null;
  const nums = (answer.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pass = nums.some((n) => Math.abs(n - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-6));
  return { pass, expected };
}



/** JSON verifier: parse + JSON-schema validation via the tool plane's own
 *  validator — again, code that did not generate the answer. */
export function verifyJsonAnswer(content: string, responseFormat: unknown): { pass: boolean; signature: string } | null {
  let text = content.trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { pass: false, signature: "parse" };
  }
  const rf = (responseFormat ?? {}) as Json;
  const holder = (rf.json_schema ?? {}) as Json;
  const schema = holder.schema ?? (rf.type === "json_schema" ? rf.schema : undefined);
  if (schema !== undefined) {
    const v = parseToolArguments(parsed, schema, { coerce: false });
    return { pass: v.ok, signature: v.ok ? "" : "invalid" };
  }
  return { pass: true, signature: "" };
}



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
export async function executeOwnedToolCalls(
  calls: unknown[],
  opts: { span?: Span; admin?: boolean; signal?: AbortSignal; now?: number; clientNames?: string[]; caps?: ToolCaps } = {},
): Promise<ToolRoundOutcome> {
  const { mine } = partitionToolCalls(calls, { clientNames: opts.clientNames });
  if (mine.length === 0) return { loop: false, messages: [], executed: [] };

  const skills = await hydrateToolSkills().catch(() => TOOL_SKILLS);
  const locals: Json = { tool_skills: Object.fromEntries([...skills.entries()]) as Json };
  const results = await executeToolCalls(
    mine.map((call) => ({ id: call.id, name: call.resolved ?? call.name, arguments: call.arguments })),
    {
      admin: opts.admin ?? false,
      caps: opts.caps,
      locals,
      signal: opts.signal,
      now: opts.now,
      event: (name, attrs) => opts.span?.event(name, traceAttrs(attrs ?? {})),
    },
  );

  const byId = new Map(results.map((r) => [r.id, r]));
  const messages: Array<{ role: string; content: unknown } & Json> = [];
  const executed: ToolRoundOutcome["executed"] = [];
  for (const call of mine) {
    const result = byId.get(call.id);
    const execution: ToolExecution | undefined = result?.execution;
    const content = execution ? toolResultContent(execution) : JSON.stringify({ error: "tool execution was skipped" });
    messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
    if (execution) {
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



export function degradationMessage(attempts: number, endpoints: number, lastErr: string): string {
  const tail = lastErr ? ` Last upstream error: ${lastErr.slice(0, 160)}.` : "";
  return `[nokey-router] No upstream model endpoint returned a valid completion for this request. ` +
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
      provider: "nokey-router",
      nokey: meta,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return frame({ role: "assistant" }, null) +
    frame({ content: degradationMessage(o.attempts, o.endpoints, o.lastErr) }, null) +
    frame({}, "stop") +
    "data: [DONE]\n\n";
}



export function degradedCompletion(c: Context, o: DegradedOpts, headers: Record<string, string>): Response {
  if (o.stream) return new Response(degradedSse(o), { status: 200, headers: { ...SSE_HEADERS, ...headers, "X-Nokey-Degraded": "1" } });
  return c.json({
    id: o.id,
    object: "chat.completion",
    created: o.created,
    model: o.requestedModel,
    provider: "nokey-router",
    nokey: degradedMeta(o),
    choices: [{
      index: 0,
      message: { role: "assistant", content: degradationMessage(o.attempts, o.endpoints, o.lastErr) },
      finish_reason: "stop",
    }],
  }, 200, { ...headers, "X-Nokey-Degraded": "1" });
}



// Comment frames keep proxies and clients alive while the race is still routing.
export const HEARTBEAT_MS = 5_000;


// Longest a response may go without sending a byte. Edge proxies and idle-bounded
// clients drop silent connections; this keeps slow generations and long tool
// rounds alive end to end.
export const idleMs = () => clampNum(Number(Deno.env.get("NOKEY_IDLE_MS")) || 15_000, 50, 60_000);



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
    root.io("request", body);
    const messages = normalizeMessages(body.messages, body.prompt);
    reqModel = String(body.model || "free:auto");
    const reqModelLower = reqModel.toLowerCase();
    wantsStream = Boolean(body.stream);

    // ---- Tool Plane: what this request may call ---------------------------
    // A client can bring its own tools, ask the router for its built-ins
    // ("tools": "auto" | "nokey_tools" | header x-nokey-tools), or both. Built-ins
    // are appended, never substituted: a client tool that shadows a built-in name
    // always wins, so the plane cannot hijack a caller's own API.
    const clientTools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
    const autoRequest = body.tools === "auto" || body.tools === true
      ? "auto"
      : body.nokey_tools ?? c.req.header("x-nokey-tools") ?? undefined;
    if (toolPlaneEnabled()) await hydrateForgedTools().catch(logErr);
    // Sub-agents (x-nokey-depth ≥ 1) get every tool but agent_team: teams do not nest.
    const autoTools = toolPlaneEnabled() ? resolveAutoToolNames(autoRequest)?.filter((n) => n !== "agent_team" || !(Number(c.req.header("x-nokey-depth") ?? 0) >= 1)) ?? null : null;
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
    let agentRounds = autoTools ? maxToolRounds(body.nokey_rounds) : 0;
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
    const hasTests = Array.isArray(body.nokey_tests) && body.nokey_tests.length > 0;
    const hasVerifier = taskCtx.taskClass === "math" || taskCtx.taskClass === "json" ||
      taskCtx.taskClass === "tool" || (taskCtx.taskClass === "code" && hasTests);
    await hydrateLearning().catch(logErr);
    const armDefs = await loadStrategyArms().catch(() => DEFAULT_STRATEGY_ARMS);
    const armCands: BanditCandidate[] = armsForClass(armDefs, taskCtx.taskClass, hasVerifier).map((a) => {
      const cell = ARM_CELLS.get(armCellKey(a.id, taskCtx.taskClass)) ?? emptyCell();
      const eff = effectivePosterior(cell, armGlobalPosterior(a.id), learningKappa());
      return { id: a.id, alpha: eff.alpha, beta: eff.beta, pulls: cell.pulls };
    });
    const armChoice = chooseThompson(armCands, Math.random, { epsilon: 0.05, resamples: 120 });
    const arm = armDefs.find((a) => a.id === armChoice?.id) ?? DEFAULT_STRATEGY_ARMS[0];
    // Pure-passthrough modes (tool plane off: NOKEY_TOOLS=0,
    // NOKEY_TOOL_ROUNDS=0, or no auto tools on this request) must not mutate
    // the request — no prompt variant, no lessons, no temperature shift, no
    // verify-retry. The strategy in effect is then the baseline, and the
    // baseline is what the decision log records.
    const planeActive = Boolean(autoTools && agentRounds > 0);
    const effArm = planeActive ? arm : (armDefs.find((a) => a.id === "baseline") ?? DEFAULT_STRATEGY_ARMS[0]);
    const variantText = planeActive ? PROMPT_VARIANTS[effArm.promptVariant] : null;
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
    // will actually execute the calls; opt out with nokey_preamble: false.
    if (autoTools && agentRounds > 0 && body.nokey_preamble !== false) {
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
    if (learnCtx.arm.temperatureDelta !== 0) {
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
        return await getRankedCandidates(m, false, false, { ...o, toolAware });
      } catch (err) {
        console.error(`[rank] ${m} ranking failed:`, err);
        return [];
      }
    };

    const rankSpan = root.child("rank", { mode });
    let ranked = await safeRanked(mode, { taskClass: taskCtx.taskClass, tenant });
    // Vision lanes must not filter themselves into an empty pool.
    if (ranked.length === 0 && hasVisionPayload) ranked = await getRankedCandidates(mode, false, hasVisionPayload, { toolAware }).catch(() => []);
    if (ranked.length === 0) ranked = await safeRanked(mode, { unrestricted: true });
    if (ranked.length === 0) ranked = await allSweepCandidates(mode).catch(() => []);

    // MODEL-AGNOSTIC ROUTING: an arbitrary requested model id never aborts the
    // request. Exact/near matches (trigram-Dice + token-Jaccard similarity) are
    // tried first; everything else keeps its Bayesian rank order as fallback.
    const isVirtualModel = reqModelLower.startsWith("free:") || reqModelLower.startsWith("nokey-image");
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

    const dispatch = async (): Promise<Dispatched> => {
      let err: unknown = null;
      for (const [i, tier] of tiers.entries()) {
        let candidates: ScoredCandidate[] = [];
        try {
          candidates = (await tier.pool()).slice(0, tier.cap);
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
    const gateMax = planeActive && body.nokey_gate !== false && autoTools?.includes("fs_write") ? Math.round(clampNum(Number(body.nokey_gate_rounds) || 6, 1, 12)) : 0;
    let gateRounds = 0;
    const gateCaps = toolCaps(c, reqModel, body.nokey_runner === true);
    const baseToolChoice = completionOptions.tool_choice;
    const startSig = gateMax ? await workspaceSigFor(gateCaps).catch(() => "") : "";
    const runGate = async (round: number, waitRuntimeMs: number): Promise<GateVerdict | null> => {
      if (!gateMax || gateRounds >= gateMax || master.signal.aborted) return null;
      // Sub-agents answer for their own part; testing the whole app is the lead agent's (or a tester's) job.
      const v = await buildGate(gateCaps, { startSig, force: body.nokey_gate === "always", tests: !(Number(c.req.header("x-nokey-depth") ?? 0) >= 1), waitRuntimeMs, signal: master.signal })
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
              const outcome = await executeOwnedToolCalls(res.toolCalls!, { span: roundSpan, signal: master.signal, admin: isAdminContext(c), clientNames: clientToolNames, caps: toolCaps(c, reqModel, body.nokey_runner === true) });
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
              nokey: {
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
              "X-Nokey-Attempts": String(tried.size),
              "X-Nokey-Endpoints": String(endpointsAvailable),
              ...(toolRound > 0 ? { "X-Nokey-Tool-Rounds": String(toolRound) } : {}),
            });
          }
        } finally {
          clearTimeout(globalTimeout);
        }
      };
      return await idleBuffered(buffered(), async (e) => {
        endDegraded(e);
        return strictErrors() ? c.json({ error: { message: errText(e) } }, 502) : degradedCompletion(c, degradedOpts(e), {});
      }, { ...traceHeaders, "X-Nokey-Endpoints": String(endpointsAvailable) });
    }

    // Headers leave immediately; routing proceeds behind heartbeat comments and the
    // committed winner is piped token-by-token (post-commit failover is impossible).
    // Headers leave immediately; routing proceeds behind heartbeat comments and the
    // committed winner is piped token-by-token (post-commit failover is impossible).
    // When the plane supplied the tools, a round that only produces tool calls is
    // drained quietly, executed server-side and re-dispatched: the client sees
    // `nokey` status frames instead of intermediate assistant chatter, then the
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
              provider: "nokey-router",
              nokey: payload,
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
            const outcome = await executeOwnedToolCalls(quiet.toolCalls ?? [], { span: roundSpan, signal: master.signal, admin: isAdminContext(c), clientNames: clientToolNames, caps: toolCaps(c, reqModel, body.nokey_runner === true) });
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
            yield chunk({}, clientFinish, { nokey: { ...meta(cand), ...(toolRound > 0 ? { tool_rounds: toolRound } : {}) } });
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
              const outcome = await executeOwnedToolCalls(late, { span: roundSpan, signal: master.signal, admin: isAdminContext(c), clientNames: clientToolNames, caps: toolCaps(c, reqModel, body.nokey_runner === true) });
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
            yield chunk({}, fin, { nokey: { ...meta(cand), ...(toolRound > 0 ? { tool_rounds: toolRound } : {}) } });
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
      headers: { ...SSE_HEADERS, ...traceHeaders, "X-Nokey-Endpoints": String(endpointsAvailable) },
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
