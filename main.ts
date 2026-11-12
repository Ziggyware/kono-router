import { Hono, type Context, type MiddlewareHandler } from "hono";


import { compile, type Complete } from "./compiler/index.ts";


import { type Attrs, currentSpan, getTrace, listTraces, type Span, startTrace, subscribe } from "./trace.ts";


import { cors } from "hono/cors";


import { bodyLimit } from "hono/body-limit";


import {
  clamp as clampNum,
  decorrelatedJitter,
  discountedPosterior,
  gumbelNoise,
  hedgePlan,
  kalmanObserve,
  modelSimilarity,
  predictiveSigma,
  sampleBeta,
  ucbBonus,
  wilsonLowerBound,
} from "./math.ts";


import {
  DEFAULT_AUTO_TOOLS,
  defaultAutoToolNames,
  emptyToolSkill,
  executeTool,
  executeToolCalls,
  isStatefulTool,
  listTools,
  mergeToolDeclarations,
  normalizeToolCalls,
  normalizeToolName,
  observeToolSkill,
  parseTextToolCalls,
  resolveTool,
  TEXT_CALL_OPENERS,
  observeTupleToolStats,
  parseToolArguments,
  partitionToolCalls,
  registerTool,
  resolveAutoToolNames,
  unregisterTool,
  skillSummary,
  toolPreamble,
  toolResultContent,
  toolRoutingBonus,
  toToolSpecs,
  tupleToolCompetence,
  type ToolCaps,
  type ToolContext,
  type ToolSpec,
  type ToolExecution,
  type ToolFlavor,
  type ToolSkillRecord,
  type ToolSkillSummary,
} from "./tools.ts";


import {
  armsForClass,
  type BanditCandidate,
  betaMean,
  type BetaCell,
  calibrationBuckets,
  chooseThompson,
  classifyTask,
  type ComputeDecision,
  type ComputeMode,
  type DecisionRecord,
  correctionFor,
  decideCompute,
  DEFAULT_STRATEGY_ARMS,
  effectivePosterior,
  emptyCell,
  estimateShrinkageKappa,
  evaluateArmPolicies,
  failureSignature,
  fitRegretExponent,
  gradeReward,
  type GradedReward,
  type Lesson,
  observeCell,
  posteriorLowerBound,
  PROMPT_VARIANTS,
  pruneCells,
  rankLessons,
  type RewardSignal,
  regretCurve,
  rewardPerExtraToken,
  shouldPruneLesson,
  type StrategyArm,
  type TaskClass,
  type TaskContext,
  thompsonPropensity,
} from "./learning.ts";


import { evaluate as evaluateCalc } from "./toolbox/calc.ts";


import { workspaceBrief, workspaceSigFor } from "./toolbox/project.ts";


import { buildGate, type GateVerdict } from "./toolbox/testing.ts";


import { TEAM_ROLES } from "./toolbox/team.ts";


import type { SubagentResult, SubagentTask } from "./toolbox/types.ts";

import { L1_CACHE, kv, TOOL_SKILLS, LEARN_ARM_DEF_PREFIX, LEARNING_CELLS, ARM_CELLS, ARM_DEFS, LESSONS, FORGED_TOOLS, UNIVERSAL_MODEL_ALIAS, honoApp, FREE_TIER_DAILY, IMAGE_BLOCKED } from "./state.ts";

import { L1_TTL_MS, KV_PREFIX, TOOL_SKILL_TTL_MS, SERVICE_JSON_FILE, isServiceJsonFile, NATIVE_MODEL_HINTS, checkRateLimit, timingSafeCompare, freeTierConsume, IMAGE_BLOCK_KV } from "./engine/core.ts";
import { TOOL_SKILL_PREFIX } from "./engine/dispatch.ts";
import { LEARN_CELL_PREFIX, LEARN_ARM_CELL_PREFIX, LESSON_PREFIX, LEARN_TTL_MS } from "./engine/learning.ts";
import { FORGED_TOOL_PREFIX, registerForgedTool, FORGED_TTL_MS, registerMeshTools } from "./engine/mesh.ts";
import { loadTextFile, discoverServiceJsonPath, parseServiceJsonRegistry, validateServiceJsonProvider, makeServiceJsonProvider, runCatalogSyncBody, buildProviderIdFromEndpointName, analyzeModelCapabilities, runCanaryProbeOnTopCandidates, runResurrectionProbe } from "./engine/providers.ts";

import { learnCellKey, armCellKey, isEndpointConfigured } from "./util.ts";

import { registerLearning } from "./routes/learning.ts";

import { registerChat } from "./routes/chat.ts";

import { registerTraces } from "./routes/traces.ts";

import { registerPages } from "./routes/pages.ts";

import { registerCatalog } from "./routes/catalog.ts";

import { registerToolsRoutes } from "./routes/tools.ts";

import { registerOps } from "./routes/ops.ts";

import { registerCommunity } from "./routes/community.ts";

import { registerImages } from "./routes/images.ts";

import { registerAgentProtocols } from "./routes/agent-protocols.ts";

import { registerConversations } from "./routes/conversations.ts";

import { registerAgentRun } from "./routes/agent-run.ts";

export type { ToolRoundOutcome, ToolCallVerdict } from "./routes/chat.ts";



export interface MeshModelRecord {
  tuple_id: string;
  provider_id: string;
  model_id: string;
  iq_prior: number;
  iq_verified: number;
  supports_reasoning: boolean;
  supports_vision: boolean;
  is_coding_specialist: boolean;
  context_window: number;
  ewma_ttft_ms: number;
  ewma_tps: number;
  // EW mean/variance of ln(TTFT); absent on older records (derived from ewma_ttft_ms).
  ewma_log_ttft?: number;
  ewmv_log_ttft?: number;
  // Kalman posterior timestamp (epoch ms) and last real success, used for
  // staleness inflation and discounted Thompson sampling respectively.
  log_ttft_updated_at?: number;
  last_success_at?: number;
  alpha_success: number;
  beta_failure: number;
  success_count: number;
  failure_streak: number;
  cooldown_until: number;
  last_probed: number;
  last_error: string | null;
  // --- Tool Plane competence (ASCK-T) -------------------------------------
  // Beta-Bernoulli posterior over "this tuple emitted a well-formed,
  // schema-valid tool call". Optional so pre-tool-plane KV records keep
  // loading unchanged: absent simply means "no evidence yet", which scores 0
  // and leaves exploration to the existing UCB term.
  tool_alpha?: number;
  tool_beta?: number;
  tool_pulls?: number;
  tool_repairs?: number;
  tool_last_at?: number;
}


let l1LastHydrated = 0;



let l1Refresh: Promise<Map<string, MeshModelRecord>> | null = null;



// Stale-while-revalidate: a warm isolate never blocks a request on kv.list.
export function hydrateL1Cache(force = false): Promise<Map<string, MeshModelRecord>> {
  const refresh = () => (l1Refresh ??= refreshL1Cache(force).finally(() => (l1Refresh = null)));
  if (force || L1_CACHE.size === 0) return refresh();
  if (Date.now() - l1LastHydrated >= L1_TTL_MS) refresh().catch((e) => console.error("L1 refresh:", e));
  return Promise.resolve(L1_CACHE);
}



async function refreshL1Cache(force: boolean): Promise<Map<string, MeshModelRecord>> {
  const now = Date.now();
  const iter = kv.list<MeshModelRecord>({ prefix: [KV_PREFIX] });
  const fresh = new Map<string, MeshModelRecord>();
  for await (const entry of iter) {
    if (entry.value) {
      fresh.set(entry.value.tuple_id, entry.value);
    }
  }
  if (fresh.size > 0 || force) {
    L1_CACHE.clear();
    for (const [k, v] of fresh) L1_CACHE.set(k, v);
    l1LastHydrated = now;
  }
  return L1_CACHE;
}


let toolSkillsHydratedAt = 0;


let toolSkillRefresh: Promise<Map<string, ToolSkillRecord>> | null = null;



async function refreshToolSkills(force: boolean): Promise<Map<string, ToolSkillRecord>> {
  const now = Date.now();
  const fresh = new Map<string, ToolSkillRecord>();
  for await (const entry of kv.list<ToolSkillRecord>({ prefix: [TOOL_SKILL_PREFIX] })) {
    if (entry.value?.tool) fresh.set(entry.value.tool, entry.value);
  }
  if (fresh.size > 0 || force) {
    TOOL_SKILLS.clear();
    for (const [k, v] of fresh) TOOL_SKILLS.set(k, v);
    toolSkillsHydratedAt = now;
  }
  return TOOL_SKILLS;
}



/** Warm isolate never blocks a request on kv.list; a cold one hydrates once. */
export function hydrateToolSkills(force = false): Promise<Map<string, ToolSkillRecord>> {
  const refresh = () => (toolSkillRefresh ??= refreshToolSkills(force).finally(() => (toolSkillRefresh = null)));
  if (force || TOOL_SKILLS.size === 0) return refresh();
  if (Date.now() - toolSkillsHydratedAt >= TOOL_SKILL_TTL_MS) refresh().catch((e) => console.error("tool skill refresh:", e));
  return Promise.resolve(TOOL_SKILLS);
}



export interface LearningCellRecord extends BetaCell {
  scope: string;
  tuple_id: string;
  task_class: TaskClass;
}


export interface ArmCellRecord extends BetaCell {
  arm_id: string;
  task_class: TaskClass;
}


export interface StoredDecision extends Omit<DecisionRecord, "reward"> {
  reward: number | null;
  armPropensity: number;
  tuplePropensity: number;
  tenant: string;
  feedbackApplied?: boolean;
}


let learnHydratedAt = 0;


let learnHydratedOnce = false;


let learnRefresh: Promise<void> | null = null;



async function refreshLearning(force: boolean): Promise<void> {
  const cells = new Map<string, LearningCellRecord>();
  for await (const e of kv.list<LearningCellRecord>({ prefix: [LEARN_CELL_PREFIX] })) {
    if (e.value?.tuple_id) cells.set(learnCellKey(e.value.scope, e.value.tuple_id, e.value.task_class), e.value);
  }
  const armCells = new Map<string, ArmCellRecord>();
  for await (const e of kv.list<ArmCellRecord>({ prefix: [LEARN_ARM_CELL_PREFIX] })) {
    if (e.value?.arm_id) armCells.set(armCellKey(e.value.arm_id, e.value.task_class), e.value);
  }
  const defs = new Map<string, StrategyArm>(DEFAULT_STRATEGY_ARMS.map((a) => [a.id, a]));
  for await (const e of kv.list<StrategyArm>({ prefix: [LEARN_ARM_DEF_PREFIX] })) {
    if (e.value?.id) defs.set(e.value.id, e.value);
  }
  const lessons = new Map<string, Lesson>();
  for await (const e of kv.list<Lesson>({ prefix: [LESSON_PREFIX] })) {
    if (e.value?.id) lessons.set(e.value.id, e.value);
  }
  if (cells.size > 0 || force) {
    LEARNING_CELLS.clear();
    for (const [k, v] of cells) LEARNING_CELLS.set(k, v);
  }
  if (armCells.size > 0 || force) {
    ARM_CELLS.clear();
    for (const [k, v] of armCells) ARM_CELLS.set(k, v);
  }
  ARM_DEFS.clear();
  for (const [k, v] of defs) ARM_DEFS.set(k, v);
  if (lessons.size > 0 || force) {
    LESSONS.clear();
    for (const [k, v] of lessons) LESSONS.set(k, v);
  }
  learnHydratedAt = Date.now();
  learnHydratedOnce = true;
}



export function hydrateLearning(force = false): Promise<void> {
  const refresh = () => (learnRefresh ??= refreshLearning(force).finally(() => (learnRefresh = null)));
  if (force || !learnHydratedOnce) return refresh();
  if (Date.now() - learnHydratedAt >= LEARN_TTL_MS) refresh().catch((e) => console.error("learning refresh:", e));
  return Promise.resolve();
}



/** Empirical-Bayes strength, estimated from the pooled cells themselves. */
let kappaCache = { at: 0, value: 8 };


export function learningKappa(): number {
  const now = Date.now();
  if (now - kappaCache.at < LEARN_TTL_MS) return kappaCache.value;
  const samples = [...LEARNING_CELLS.values()]
    .filter((c) => c.scope === "global")
    .map((c) => ({ successes: c.rewardSum, trials: c.pulls }));
  kappaCache = { at: now, value: estimateShrinkageKappa(samples, 8) };
  return kappaCache.value;
}



export interface PendingDecision {
  traceId: string;
  ts: number;
  taskClass: TaskClass;
  tupleId: string;
  armId: string;
  tenant: string;
  armPropensity: number;
  tuplePropensity: number;
  tokens: number;
  extraTokens: number;
  expectedReward: number;
  computeMode: ComputeMode;
  lessonIds: string[];
}


let forgedHydratedAt = 0;


let forgedRefresh: Promise<void> | null = null;


export const FORGED_KINDS = new Set(["web", "files", "memory", "rag", "vector", "clipboard", "task", "compute", "data", "text", "time", "crypto", "mesh"]);



export interface ForgedToolDef {
  name: string;
  description: string;
  parameters: Json;
  kind: string;
  code: string;
  deterministic?: boolean;
  admin?: boolean;
  timeout_ms?: number;
  created_at: number;
  updated_at: number;
}



export const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...params: string[]) => (...args: unknown[]) => Promise<unknown>;



async function refreshForgedTools(): Promise<void> {
  const fresh = new Map<string, ForgedToolDef>();
  for await (const entry of kv.list<ForgedToolDef>({ prefix: [FORGED_TOOL_PREFIX] })) {
    const def = entry.value;
    if (def && typeof def.name === "string" && typeof def.code === "string") fresh.set(def.name, def);
  }
  for (const name of [...FORGED_TOOLS.keys()]) {
    if (!fresh.has(name)) { FORGED_TOOLS.delete(name); unregisterTool(name); }
  }
  for (const def of fresh.values()) {
    const prev = FORGED_TOOLS.get(def.name);
    if (!prev || prev.updated_at !== def.updated_at) {
      try { registerForgedTool(def); } catch (e) { console.error("forged tool register:", e); }
    }
  }
  forgedHydratedAt = Date.now();
}



export function hydrateForgedTools(force = false): Promise<void> {
  if (!force && forgedHydratedAt > 0 && Date.now() - forgedHydratedAt < FORGED_TTL_MS) return Promise.resolve();
  if (!forgedRefresh) {
    forgedRefresh = refreshForgedTools()
      .catch((e) => console.error("forged tool refresh:", e))
      .finally(() => { forgedRefresh = null; });
  }
  return forgedRefresh;
}



// ============================================================================
// 2. SECURITY: CONSTANT-TIME AUTH, RATE LIMITER & HEADER ROTATOR
// ============================================================================

export const encoder = new TextEncoder();



export const IP_BUCKETS = new Map<string, { tokens: number; lastRefill: number }>();


// Generous but bounded: a normal client must never see a 429 from the router,
// while a pathological flood is still contained. Tunable per deployment.
export const MAX_BURST = clampNum(Number(Deno.env.get("NOKEY_RATE_BURST")) || 120, 5, 10_000);


export const REFILL_PER_SEC = clampNum(Number(Deno.env.get("NOKEY_RATE_REFILL")) || 8, 0.1, 1_000);



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



// ============================================================================
// 5b. SERVICES.JSON REGISTRY DRIVEN PROVIDERS
// ============================================================================

export interface ServiceJsonEndpoint {
  id: number;
  name: string;
  category: string;
  baseUrl: string;
  url: string;
  modelsUrl: string | null;
  defaultModel: string;
  authRequired: boolean;
  authMode: string | null;
  authHeader: string | null;
  notes: string | null;
  telemetry: unknown;
}



export interface ServiceJsonRegistry {
  registryName: string;
  asOfDate: string;
  totalEndpoints: number;
  endpoints: ServiceJsonEndpoint[];
}



let SERVICE_JSON_REGISTRY: ServiceJsonRegistry | null = null;


export let serviceJsonLoadError: string | null = null;



export async function loadServiceJsonRegistry(): Promise<ServiceJsonRegistry | null> {
  if (SERVICE_JSON_REGISTRY) return SERVICE_JSON_REGISTRY;

  const body = await loadTextFile(SERVICE_JSON_FILE);
  if (!body) {
    const discovered = await discoverServiceJsonPath();
    if (!discovered) {
      serviceJsonLoadError = "services.json-not-found";
      return null;
    }
    const raw = loadTextFile(discovered);
    if (!raw) {
      serviceJsonLoadError = "services.json-not-readable";
      return null;
    }
    const parsed = parseServiceJsonRegistry(raw);
    if (!parsed) {
      serviceJsonLoadError = "services.json-schema-invalid";
      return null;
    }
    SERVICE_JSON_REGISTRY = parsed;
    return SERVICE_JSON_REGISTRY;
  }

  if (!isServiceJsonFile(SERVICE_JSON_FILE)) {
    serviceJsonLoadError = "services.json-path-not-allowed";
    return null;
  }

  const parsed = parseServiceJsonRegistry(body);
  if (!parsed) {
    serviceJsonLoadError = "services.json-schema-invalid";
    return null;
  }
  SERVICE_JSON_REGISTRY = parsed;
  return SERVICE_JSON_REGISTRY;
}



// ============================================================================
// 5c. MERGE SERVICES.JSON BACKED PROVIDERS INTO THE ACTIVE PROVIDER LIST
// ============================================================================

let serviceJsonProvidersPromise: Promise<ProviderSpec[]> | null = null;



export function serviceJsonProviders(): Promise<ProviderSpec[]> {
  if (!serviceJsonProvidersPromise) {
    serviceJsonProvidersPromise = (async () => {
      const registry = await loadServiceJsonRegistry();
      if (!registry) return [];
      const specs: ProviderSpec[] = [];
      for (const endpoint of registry.endpoints) {
        if (!isEndpointConfigured(endpoint)) continue;
        const validationError = validateServiceJsonProvider(endpoint);
        if (validationError) {
          console.warn(`service-json endpoint skipped (${endpoint.name}): ${validationError}`);
          continue;
        }
        specs.push(makeServiceJsonProvider(endpoint, validationError));
      }
      return specs;
    })();
  }
  return serviceJsonProvidersPromise;
}



// ============================================================================
// 6. AUTO-DISCOVERY SYNC & PARETO + THOMPSON OBJECTIVE SCORER
// ============================================================================

let lastSyncCheckMemory = 0;



export const perEndpointSyncGate = new Map<string, Promise<void>>();



let catalogSyncInFlight = false;



// Hot-path guard: a chat request must never wait out a full provider sweep
// before its first upstream call. With a warm cache, a due sync refreshes
// in the background and the request is served from the current catalog.
// Only a cold start (empty cache) or an explicit admin force awaits it.
export async function ensureCatalogSynced(force: boolean = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSyncCheckMemory < 60_000 && L1_CACHE.size > 0) {
    return;
  }
  lastSyncCheckMemory = now;
  if (!force && L1_CACHE.size > 0) {
    if (!catalogSyncInFlight) {
      catalogSyncInFlight = true;
      void (async () => {
        try {
          await runCatalogSyncBody(force);
        } catch (err) {
          console.error("background catalog sync failed:", err);
        } finally {
          catalogSyncInFlight = false;
        }
      })();
    }
    return;
  }
  await runCatalogSyncBody(force);
}




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



export async function providerModelHints(): Promise<Map<string, string[]>> {
  if (modelHintsCache) return modelHintsCache;
  const map = new Map<string, string[]>(Object.entries(NATIVE_MODEL_HINTS).map(([k, v]) => [k, [...v]]));
  try {
    const registry = await loadServiceJsonRegistry();
    if (registry) {
      for (const e of registry.endpoints) {
        if (!isEndpointConfigured(e)) continue;
        const id = buildProviderIdFromEndpointName(e.name);
        const telemetry = (e.telemetry ?? {}) as Json;
        const discovered = Array.isArray(telemetry.discoveredModels)
          ? (telemetry.discoveredModels as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        // Keep the strongest-looking models first (capability parser weed-out),
        // then fall back to the alias accepted by the widest set of relays.
        const ranked = discovered
          .filter((m) => analyzeModelCapabilities(m).iqPrior > 0.5)
          .sort((a, b) => analyzeModelCapabilities(b).iqPrior - analyzeModelCapabilities(a).iqPrior)
          .slice(0, 6);
        const hints = [e.defaultModel?.trim(), ...ranked, UNIVERSAL_MODEL_ALIAS]
          .filter((m): m is string => Boolean(m && m.length < 200))
          .filter((m, i, arr) => arr.findIndex((x) => x.toLowerCase() === m.toLowerCase()) === i);
        map.set(id, hints.length > 0 ? hints : [UNIVERSAL_MODEL_ALIAS]);
      }
    }
  } catch (err) {
    console.error("model hints build failed:", err);
  }
  modelHintsCache = map;
  return map;
}




registerMeshTools();


hydrateForgedTools(true).catch((e) => console.error("forged tool boot hydrate:", e));



// ============================================================================
// 8. HONO HTTP APPLICATION & FRESH 2.0 COMPATIBILITY SHIM
// ============================================================================

// ---------------------------------------------------------------------------
// REQUEST NORMALISATION & GRACEFUL DEGRADATION
// "Requests always work": malformed/empty payloads are normalised rather than
// 400'd, and after the exhaustive sweep a valid OpenAI-shaped completion is
// always returned (never 502/503). The degraded body is explicitly labelled —
// no model output is ever fabricated.
// ---------------------------------------------------------------------------

export const VALID_ROLES = new Set(["system", "user", "assistant", "tool", "developer", "function"]);


honoApp.use("*", cors({ origin: "*", exposeHeaders: ["traceparent", "Server-Timing", "X-Nokey-Attempts", "X-Nokey-Endpoints", "X-Nokey-Degraded", "X-Nokey-Free-Tier"] }));


honoApp.use("*", bodyLimit({ maxSize: 512 * 1024 }));



honoApp.use("/v1/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    (c.env as Deno.ServeHandlerInfo<Deno.NetAddr> | undefined)?.remoteAddr?.hostname || "anon";
  if (!checkRateLimit(ip)) {
    return c.json({ error: { message: "Rate limit exceeded on edge isolate" } }, 429);
  }

  const requiredKey = Deno.env.get("ROUTER_API_KEY");
  if (requiredKey) {
    const authHeader = c.req.header("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (token && timingSafeCompare(token, requiredKey)) {
      await next();
      return;
    }
    if (token) {
      return c.json({ error: { message: "Unauthorized: Invalid ROUTER_API_KEY" } }, 401);
    }
    // No key at all → free tier: 50 requests/day per IP, then a 429 that
    // explains how to go unlimited.
    const used = await freeTierConsume(ip).catch(() => 0);
    if (used > FREE_TIER_DAILY) {
      return c.json({
        error: {
          message: "Free tier exhausted: 50 requests per day without an API key. Unlimited requests are $5/month — see /pricing or contact Michael Morton at ziggyware@gmail.com or +1-979-661-2553.",
          type: "free_tier_exhausted",
          limit: FREE_TIER_DAILY,
          pricing: "/pricing",
        },
      }, 429);
    }
    c.header("X-Nokey-Free-Tier", `${FREE_TIER_DAILY - used} requests left today`);
  }
  await next();
});

registerTraces();

registerLearning();

registerPages();



// Operator surfaces: static pages; every datum they show stays behind the /v1 guards.
for (const [route, file, type] of [
  ["/docs", "docs.html", "text/html; charset=utf-8"],
  ["/openapi.json", "openapi.json", "application/json"],
] as const) {
  honoApp.get(route, (c) => {
    const body = loadTextFile(file);
    if (body === null) return c.text(`${file} missing from deployment`, 404);
    return new Response(body, { headers: { "Content-Type": type, "Cache-Control": "no-cache" } });
  });
}

registerCatalog();

registerToolsRoutes();

registerOps();

registerAgentProtocols();

registerConversations();

registerAgentRun();



// =====================================================================
// COMMUNITY / PEOPLE CHAT — real-time peer messaging
// =====================================================================
export interface CommunityMessage {
  id: string;
  room: string;
  user: string;
  avatar?: string;
  content: string;
  createdAt: string;
  reactions?: Record<string, number>;
  replyTo?: { id: string; user: string; text: string };
}

registerCommunity();

registerChat();


export const IMAGE_CATALOG = new Map<string, string[]>();


export const IMAGE_STATS = new Map<string, { ok: number; fail: number }>();


let imageBlockHydrated = 0;


export async function hydrateImageBlocks(): Promise<void> {
  if (Date.now() - imageBlockHydrated < 60_000) return;
  imageBlockHydrated = Date.now();
  IMAGE_BLOCKED.clear();
  for await (const e of kv.list({ prefix: [IMAGE_BLOCK_KV] })) IMAGE_BLOCKED.add(String(e.key[1]));
}

registerImages();



// Fresh 2.0 (@fresh/core) compatibility shim in case Deno Deploy executes `/app/src/_fresh/server.js`
const app = Object.assign(honoApp, {
  config: {
    root: Deno.cwd(),
    basePath: "",
    mode: "production",
  },
  handler: () => honoApp.fetch,
  listen: (options?: Deno.ServeTcpOptions) => Deno.serve(options ?? {}, honoApp.fetch),
});



if (typeof Deno.cron === "function") {
  Deno.cron("canary-probe", "*/30 * * * *", async () => {
    await runCanaryProbeOnTopCandidates(4);
  });
  Deno.cron("tail-resurrection", "*/10 * * * *", async () => {
    await runResurrectionProbe(6);
  });
}



if (import.meta.main) {
  // Container hosts (Render, Koyeb, Fly, …) assign the port via $PORT;
  // everywhere else the router keeps its long-standing default of 8000.
  const port = Number(Deno.env.get("PORT") ?? 8000);
  Deno.serve({ port: Number.isFinite(port) && port > 0 ? port : 8000 }, app.fetch);
}



export { app };


export default {
  fetch: app.fetch,
};