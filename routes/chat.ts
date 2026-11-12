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
