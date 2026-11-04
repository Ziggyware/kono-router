/**
 * ============================================================================
 * ASCK-L — the router's learning loop
 * ============================================================================
 * The model behind each request is fixed; the router's choices are not.
 * This module is the pure core of the loop that makes those choices —
 * provider tuple, strategy arm, compute budget, injected lessons — improve
 * measurably with use. It extends the existing ASCK mechanisms in math.ts
 * (discounted Beta posteriors, Thompson sampling, Wilson floors) and the
 * toolbox feature-hash embedder; it does not replace them. All state lives
 * in Deno KV in main.ts; everything here is a deterministic function of its
 * inputs plus an injectable RNG, so every claim is testable in simulation.
 *
 * Invariants enforced here:
 *  - the generator never grades itself (self-sourced rewards are rejected);
 *  - exploration floor: every candidate keeps a minimum selection chance;
 *  - no raw user content anywhere: only classes, signatures, rewards, ids;
 *  - bounded growth: cell/lesson compaction helpers cap the state.
 * ============================================================================
 */
import { clamp, discountedPosterior, wilsonLowerBound } from "./math.ts";
import { embed } from "./toolbox/vec.ts";

// ---------------------------------------------------------------------------
// Seeded RNG (tests must be reproducible; the live path passes Math.random)
// ---------------------------------------------------------------------------

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngNormal(rng: Rng): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function rngGamma(rng: Rng, shape: number): number {
  const alpha = Math.max(0.5, shape);
  if (alpha < 1) return rngGamma(rng, 1 + alpha) * Math.pow(Math.max(1e-12, rng()), 1 / alpha);
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = rngNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(1e-300, u)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta draw driven by an injectable RNG (math.ts's sampler uses Math.random). */
export function rngBeta(rng: Rng, alpha: number, beta: number): number {
  const x = rngGamma(rng, Math.max(0.5, alpha));
  const y = rngGamma(rng, Math.max(0.5, beta));
  return x / (x + y);
}

// ---------------------------------------------------------------------------
// 1. TASK CONTEXT — a small, stable, deterministic class set
// ---------------------------------------------------------------------------

export const TASK_CLASSES = [
  "chat",
  "qa",
  "code",
  "math",
  "tool",
  "vision",
  "json",
  "reasoning",
  "multilingual",
  "longform",
  "summarize",
  "creative",
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export interface TaskFeatures {
  chars: number;
  words: number;
  hasTools: boolean;
  toolIntent: boolean;
  imageParts: number;
  codeFence: boolean;
  codeTokens: number;
  mathTokens: number;
  jsonIntent: boolean;
  reasoningTokens: number;
  summarizeIntent: boolean;
  creativeIntent: boolean;
  question: boolean;
  language: string;
}

export interface TaskContext {
  taskClass: TaskClass;
  features: TaskFeatures;
  /** Nearest embed centroid among the soft classes, when rules did not fire. */
  centroid: { taskClass: TaskClass; score: number } | null;
}

interface MessageLike {
  role: string;
  content: unknown;
}

function messageText(messages: MessageLike[]): { text: string; imageParts: number } {
  const parts: string[] = [];
  let imageParts = 0;
  for (const m of messages) {
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
        else if (b.type === "image_url" || b.type === "image" || b.type === "input_image") imageParts++;
      }
    }
  }
  return { text: parts.join("\n"), imageParts };
}

const LANG_STOPS: Record<string, string[]> = {
  es: [" el ", " la ", " los ", " las ", " una ", " gracias ", " hola ", " por favor "],
  fr: [" le ", " la ", " les ", " des ", " une ", " merci ", " bonjour ", " s'il "],
  de: [" der ", " die ", " das ", " und ", " ist ", " ich ", " nicht ", " danke "],
  pt: [" o ", " a ", " os ", " as ", " um ", " obrigado ", " olá ", " por favor "],
  it: [" il ", " lo ", " gli ", " una ", " grazie ", " ciao ", " per favore "],
};

export function detectLanguage(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7a3]/.test(text)) return "ko";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  const padded = ` ${text.toLowerCase()} `;
  let best = "en";
  let bestHits = 0;
  for (const [lang, stops] of Object.entries(LANG_STOPS)) {
    const hits = stops.reduce((n, s) => n + (padded.includes(s) ? 1 : 0), 0);
    if (hits > bestHits) {
      bestHits = hits;
      best = lang;
    }
  }
  return bestHits >= 2 ? best : "en";
}

const CENTROID_SEEDS: Partial<Record<TaskClass, string>> = {
  chat: "hello hi there how are you thanks bye good morning what's up",
  qa: "what is the capital of france who wrote hamlet when did the war end how many people live in",
  summarize: "summarize this article give me the key points tl dr condense the following text",
  creative: "write a story poem song rap joke about a dragon in the style of",
  multilingual: "translate this to spanish french german say in another language meaning of this word",
  longform: "write a detailed comprehensive essay report analysis covering history causes effects and outlook",
  reasoning: "prove that show step by step therefore deduce logically implies contradiction theorem",
  math: "compute calculate integral derivative equation solve for x percent of total sum",
  code: "function bug error compile typescript javascript python code review refactor",
  json: "return json object schema fields parse serialize structured output",
};

let centroidCache: Array<{ taskClass: TaskClass; vec: Float32Array }> | null = null;
function centroids(): Array<{ taskClass: TaskClass; vec: Float32Array }> {
  if (centroidCache) return centroidCache;
  centroidCache = Object.entries(CENTROID_SEEDS).map(([taskClass, seed]) => ({
    taskClass: taskClass as TaskClass,
    vec: embed(seed),
  }));
  return centroidCache;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // embed() returns unit vectors
}

export function nearestCentroid(text: string): { taskClass: TaskClass; score: number } | null {
  if (!text.trim()) return null;
  const vec = embed(text);
  let best: { taskClass: TaskClass; score: number } | null = null;
  for (const c of centroids()) {
    const score = cosine(vec, c.vec);
    if (!best || score > best.score) best = { taskClass: c.taskClass, score: Number(score.toFixed(4)) };
  }
  return best;
}

/** Deterministic request → task class. Strong structural signals win first;
 *  the embed centroid only arbitrates the soft residue, so classes stay
 *  stable under paraphrase of the same intent. */
export function classifyTask(input: {
  messages: MessageLike[];
  hasTools?: boolean;
  toolChoice?: unknown;
  responseFormat?: unknown;
  reasoningEffort?: string;
}): TaskContext {
  const { text, imageParts } = messageText(input.messages);
  const lower = text.toLowerCase();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const codeFence = /```/.test(text);
  const codeTokens = (lower.match(/\b(function|const|class|import|def|return|async|await|bug|error|compile|typescript|javascript|python|rust|sql|api|endpoint|refactor)\b/g) ?? []).length;
  const mathTokens = (lower.match(/\b(compute|calculate|integral|derivative|equation|solve|percent|probability|sqrt|theorem|eigenvalue|sum of|product of)\b/g) ?? []).length +
    (/\d+\s*[-+*/^=]\s*\d+/.test(text) ? 2 : 0);
  const reasoningTokens = (lower.match(/\b(prove|proof|theorem|lemma|deduce|derive|step[- ]by[- ]step|logically|implies|contradiction|bayesian)\b/g) ?? []).length;
  const toolIntent = /\b(use|call|run|fetch|search|look up|check|read|write|save|remember|recall|schedule|send|download|open)\b[^.]{0,40}\b(tool|web|internet|file|memory|search|url|website|database)\b/i.test(text) ||
    input.toolChoice === "required" || input.toolChoice === "any";
  const rf = input.responseFormat as Record<string, unknown> | undefined;
  const jsonIntent = Boolean(rf && (rf.type === "json_object" || rf.type === "json_schema")) ||
    /\b(return|respond|output|reply|give|format)\b[^.]{0,30}\bjson\b/i.test(text) || /\bjson schema\b/i.test(text);
  const summarizeIntent = /\b(summarize|summarise|summary of|key points|tl;?dr|condense)\b/i.test(text);
  const creativeIntent = /\b(write|compose| invent)\b[^.]{0,30}\b(story|poem|song|rap|joke|haiku|limerick|screenplay)\b/i.test(text);
  const language = detectLanguage(text);
  const features: TaskFeatures = {
    chars: text.length,
    words,
    hasTools: Boolean(input.hasTools),
    toolIntent,
    imageParts,
    codeFence,
    codeTokens,
    mathTokens,
    jsonIntent,
    reasoningTokens,
    summarizeIntent,
    creativeIntent,
    question: /\?\s*$/.test(text.trim()) || /^(what|who|when|where|why|how|which|is|are|do|does|can)\b/i.test(text.trim()),
    language,
  };

  let taskClass: TaskClass | null = null;
  if (imageParts > 0) taskClass = "vision";
  else if (codeFence || codeTokens >= 3) taskClass = "code";
  else if (toolIntent) taskClass = "tool";
  else if (mathTokens >= 2) taskClass = "math";
  else if (jsonIntent) taskClass = "json";
  else if (reasoningTokens >= 2 || input.reasoningEffort === "high" || input.reasoningEffort === "xhigh" || input.reasoningEffort === "max") taskClass = "reasoning";
  else if (summarizeIntent) taskClass = "summarize";
  else if (creativeIntent) taskClass = "creative";
  else if (codeTokens >= 1) taskClass = "code";
  else if (mathTokens >= 1) taskClass = "math";
  else if (language !== "en") taskClass = "multilingual";

  let centroid: TaskContext["centroid"] = null;
  if (!taskClass) {
    centroid = nearestCentroid(text);
    if (features.chars > 1800) taskClass = "longform";
    else if (centroid && centroid.score >= 0.15 && centroid.taskClass !== "code" && centroid.taskClass !== "math" && centroid.taskClass !== "json") {
      taskClass = centroid.taskClass;
    } else taskClass = features.question ? "qa" : "chat";
  }
  return { taskClass, features, centroid };
}

/** Classes for which an independent verifier exists in the router today:
 *  math → the deterministic calculate evaluator; json → JSON-schema
 *  validation; tool → schema-valid tool-call grading; code → only when the
 *  caller supplies sandbox tests. */
export const VERIFIER_KINDS: Record<string, string> = {
  math: "calculate",
  json: "json_schema",
  tool: "tool_schema",
  code: "sandbox_tests",
};

export function failureSignature(kind: string, detail = ""): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  const d = clean(detail);
  return d ? `${clean(kind)}:${d}` : clean(kind);
}

export const LESSON_CORRECTIONS: Record<string, string> = {
  verifier_math_mismatch: "Recompute every arithmetic step with the calculate tool and state only the verified result.",
  verifier_json_invalid: "Return exactly one JSON value that validates against the requested schema — no prose, no fences.",
  verifier_json_parse: "Return exactly one JSON value that validates against the requested schema — no prose, no fences.",
  tool_invalid_schema: "Call tools only with arguments that match the declared schema exactly; check required fields before calling.",
  tool_not_declared: "Call only tools that are declared for this request; never invent a tool name.",
  feedback_thumbs_down: "The previous approach was rated down for this task class: be more careful, verify before answering, and keep the answer focused.",
  completion_error: "Prefer the simplest reliable path: answer directly, avoid speculative tool calls, and verify the final result.",
};

export function correctionFor(signature: string): string {
  for (const [prefix, text] of Object.entries(LESSON_CORRECTIONS)) {
    if (signature.startsWith(prefix)) return text;
  }
  return "Verify the result before answering and prefer the simplest reliable path.";
}

// ---------------------------------------------------------------------------
// 2. GRADED REWARD with provenance — the generator never grades itself
// ---------------------------------------------------------------------------

export interface RewardSignal {
  kind: string;
  /** 0..1 */
  value: number;
  weight?: number;
  /** Who produced this grade: "router", "verifier:<kind>", "user", a tuple id… */
  source: string;
}

export interface GradedReward {
  reward: number;
  accepted: RewardSignal[];
  rejected: Array<{ signal: RewardSignal; reason: string }>;
}

export function gradeReward(
  signals: RewardSignal[],
  ctx: { tupleId?: string; armId?: string },
): GradedReward | null {
  const accepted: RewardSignal[] = [];
  const rejected: GradedReward["rejected"] = [];
  let wsum = 0;
  let total = 0;
  for (const s of signals) {
    if (!Number.isFinite(s.value)) {
      rejected.push({ signal: s, reason: "non-finite value" });
      continue;
    }
    if (s.kind === "self_eval" || (ctx.tupleId && s.source === ctx.tupleId) || (ctx.armId && s.source === ctx.armId)) {
      rejected.push({ signal: s, reason: "generator grading itself" });
      continue;
    }
    // Verifier grades must come from a verifier, not from the arm under test.
    if (s.kind.startsWith("verifier") && !s.source.startsWith("verifier:")) {
      rejected.push({ signal: s, reason: "verifier signal without verifier provenance" });
      continue;
    }
    const w = clamp(s.weight ?? 1, 0, 3);
    accepted.push(s);
    wsum += w;
    total += w * clamp(s.value, 0, 1);
  }
  if (accepted.length === 0 || wsum <= 0) return null;
  return { reward: Number(clamp(total / wsum, 0, 1).toFixed(4)), accepted, rejected };
}

// ---------------------------------------------------------------------------
// 3. CONTEXTUAL POSTERIOR — Beta per (arm, class), empirical-Bayes shrinkage
// ---------------------------------------------------------------------------

export interface BetaCell {
  alpha: number;
  beta: number;
  pulls: number;
  rewardSum: number;
  lastAt: number;
}

export function emptyCell(): BetaCell {
  return { alpha: 1, beta: 1, pulls: 0, rewardSum: 0, lastAt: 0 };
}

/** Exponential forgetting toward the uniform prior (6 h half-life), the same
 *  discounting the tuple and tool posteriors already use. */
export function discountCell(cell: BetaCell, now: number, halfLifeHours = 6): BetaCell {
  if (!cell.lastAt) return { ...cell };
  const post = discountedPosterior(cell.alpha, cell.beta, cell.lastAt, now, halfLifeHours);
  const ageH = clamp((now - cell.lastAt) / 3_600_000, 0, 24 * 30);
  const lambda = Math.pow(0.5, ageH / Math.max(0.25, halfLifeHours));
  return { ...cell, alpha: post.alpha, beta: post.beta, rewardSum: cell.rewardSum * lambda };
}

export function observeCell(cell: BetaCell, reward: number, now: number): BetaCell {
  const d = discountCell(cell, now);
  const r = clamp(reward, 0, 1);
  return {
    alpha: Math.min(500, d.alpha + r),
    beta: Math.min(500, d.beta + (1 - r)),
    pulls: Math.min(1_000_000, d.pulls + 1),
    rewardSum: d.rewardSum + r,
    lastAt: now,
  };
}

/** Method-of-moments empirical Bayes: how many pseudo-counts of the global
 *  posterior a sparse cell should borrow. kappa = mu(1-mu)/var_between - 1. */
export function estimateShrinkageKappa(
  samples: Array<{ successes: number; trials: number }>,
  fallback = 8,
): number {
  const usable = samples.filter((s) => s.trials >= 2);
  if (usable.length < 3) return fallback;
  const means = usable.map((s) => s.successes / s.trials);
  const mu = means.reduce((a, x) => a + x, 0) / means.length;
  if (mu <= 0.01 || mu >= 0.99) return 64;
  const within = usable.reduce((a, s) => {
    const p = s.successes / s.trials;
    return a + (p * (1 - p)) / s.trials;
  }, 0) / usable.length;
  const total = means.reduce((a, x) => a + (x - mu) * (x - mu), 0) / means.length;
  const between = Math.max(1e-4, total - within);
  return Number(clamp(mu * (1 - mu) / between - 1, 2, 64).toFixed(2));
}

/** The cell's posterior after borrowing strength from the global posterior:
 *  prior pseudo-counts kappa*mu sit under the cell's own discounted evidence. */
export function effectivePosterior(
  cell: BetaCell,
  global: { alpha: number; beta: number },
  kappa: number,
): { alpha: number; beta: number } {
  const gTotal = Math.max(2, global.alpha + global.beta);
  const mu = clamp(global.alpha / gTotal, 0.01, 0.99);
  return {
    alpha: Math.max(0.5, kappa * mu + Math.max(0, cell.alpha - 1)),
    beta: Math.max(0.5, kappa * (1 - mu) + Math.max(0, cell.beta - 1)),
  };
}

export function betaMean(alpha: number, beta: number): number {
  return alpha / Math.max(1e-9, alpha + beta);
}

export function betaVariance(alpha: number, beta: number): number {
  const t = alpha + beta;
  return (alpha * beta) / Math.max(1e-9, t * t * (t + 1));
}

/** Deterministic-mode floor: Wilson bound over the effective pseudo-counts. */
export function posteriorLowerBound(alpha: number, beta: number): number {
  return wilsonLowerBound(alpha, Math.max(1, alpha + beta));
}

// ---------------------------------------------------------------------------
// 4. THOMPSON CHOICE with an exploration floor + resampled propensity
// ---------------------------------------------------------------------------

export interface BanditCandidate {
  id: string;
  alpha: number;
  beta: number;
  pulls: number;
}

export interface BanditChoice {
  id: string;
  /** Estimated probability this policy selects this candidate. */
  propensity: number;
  viaFloor: boolean;
}

/** Thompson sampling over Beta posteriors. With probability `epsilon` the
 *  least-pulled candidate is chosen (exploration floor — no arm starves).
 *  The propensity is estimated by resampling the posteriors `resamples`
 *  times and counting wins, mixed with the floor probability. */
export function chooseThompson(
  candidates: BanditCandidate[],
  rng: Rng,
  opts: { epsilon?: number; resamples?: number } = {},
): BanditChoice | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { id: candidates[0].id, propensity: 1, viaFloor: false };
  const epsilon = clamp(opts.epsilon ?? 0.05, 0, 0.5);
  const resamples = Math.max(32, Math.round(opts.resamples ?? 200));

  const minPulls = Math.min(...candidates.map((c) => c.pulls));
  const floorSet = candidates.filter((c) => c.pulls === minPulls);
  const viaFloor = rng() < epsilon;
  let chosen: BanditCandidate;
  if (viaFloor) {
    chosen = floorSet[Math.floor(rng() * floorSet.length) % floorSet.length];
  } else {
    let best = -1;
    chosen = candidates[0];
    for (const c of candidates) {
      const draw = rngBeta(rng, c.alpha, c.beta);
      if (draw > best) {
        best = draw;
        chosen = c;
      }
    }
  }
  // Propensity by resampling: how often does plain Thompson pick `chosen`?
  let wins = 0;
  for (let s = 0; s < resamples; s++) {
    let best = -1;
    let winner = "";
    for (const c of candidates) {
      const draw = rngBeta(rng, c.alpha, c.beta);
      if (draw > best) {
        best = draw;
        winner = c.id;
      }
    }
    if (winner === chosen.id) wins++;
  }
  const mc = wins / resamples;
  const floorP = floorSet.some((c) => c.id === chosen.id) ? epsilon / floorSet.length : 0;
  const propensity = clamp((1 - epsilon) * mc + floorP, 1e-4, 1);
  return { id: chosen.id, propensity: Number(propensity.toFixed(4)), viaFloor };
}

/** Propensity of one fixed candidate under Thompson resampling (used to log
 *  the tuple choice the contextual posterior made, after dispatch settles). */
export function thompsonPropensity(
  candidates: BanditCandidate[],
  chosenId: string,
  rng: Rng,
  resamples = 200,
): number {
  if (candidates.length <= 1) return 1;
  let wins = 0;
  for (let s = 0; s < resamples; s++) {
    let best = -1;
    let winner = "";
    for (const c of candidates) {
      const draw = rngBeta(rng, c.alpha, c.beta);
      if (draw > best) {
        best = draw;
        winner = c.id;
      }
    }
    if (winner === chosenId) wins++;
  }
  return Number(clamp(wins / resamples, 1e-4, 1).toFixed(4));
}

// ---------------------------------------------------------------------------
// 5. STRATEGY ARMS — data, not code. Defaults below; KV can add more.
// ---------------------------------------------------------------------------

export type PromptVariant = "plain" | "verify" | "concise";
export type ComputeMode = "single" | "verify_retry" | "best_of_n";

export interface StrategyArm {
  id: string;
  label: string;
  promptVariant: PromptVariant;
  temperatureDelta: number;
  compute: ComputeMode;
  enabled: boolean;
  /** Optional class restriction — an arm can be scoped to some task classes. */
  classes?: TaskClass[];
}

export const DEFAULT_STRATEGY_ARMS: StrategyArm[] = [
  { id: "baseline", label: "Baseline single-shot", promptVariant: "plain", temperatureDelta: 0, compute: "single", enabled: true },
  { id: "verify", label: "Verify-and-retry", promptVariant: "verify", temperatureDelta: -0.1, compute: "verify_retry", enabled: true },
  { id: "concise", label: "Concise single-shot", promptVariant: "concise", temperatureDelta: 0, compute: "single", enabled: true },
  { id: "explore_temp", label: "Higher temperature", promptVariant: "plain", temperatureDelta: 0.25, compute: "single", enabled: true },
  { id: "best_of", label: "Best-of-2 with verifier", promptVariant: "verify", temperatureDelta: 0, compute: "best_of_n", enabled: true },
];

/** Arms whose compute mode needs a verifier are only offered where one exists. */
export function armsForClass(arms: StrategyArm[], taskClass: TaskClass, hasVerifier: boolean): StrategyArm[] {
  return arms.filter((a) =>
    a.enabled &&
    (hasVerifier || a.compute === "single") &&
    (!a.classes || a.classes.includes(taskClass))
  );
}

export const PROMPT_VARIANTS: Record<PromptVariant, string | null> = {
  plain: null,
  verify: "Before answering, work through the problem carefully and check the result. If a tool can verify a fact or a computation, use it. Give the final answer only after the check passes.",
  concise: "Answer directly and concisely. Skip preamble and repetition; keep only what the request needs.",
};

// ---------------------------------------------------------------------------
// 6. COMPUTE ALLOCATION BY VALUE OF INFORMATION
// ---------------------------------------------------------------------------

export interface ComputeDecision {
  mode: ComputeMode;
  n: number;
  variance: number;
  reason: string;
}

/** Escalate only when BOTH hold: posterior variance is high (the router is
 *  genuinely unsure) AND an independent verifier exists for the class.
 *  Otherwise single-shot. Variance threshold ~ Beta variance at effective
 *  n≈30 for a 0.5 mean — below that, extra samples buy little. */
export function decideCompute(input: {
  taskClass: TaskClass;
  alpha: number;
  beta: number;
  hasVerifier: boolean;
  armCompute: ComputeMode;
  stream?: boolean;
}): ComputeDecision {
  const variance = betaVariance(input.alpha, input.beta);
  const highVariance = variance > 0.015;
  if (input.stream) return { mode: "single", n: 1, variance, reason: "streaming answers cannot be re-graded before tokens ship" };
  if (!input.hasVerifier) return { mode: "single", n: 1, variance, reason: "no independent verifier for this class" };
  if (input.armCompute === "best_of_n" && highVariance) {
    return { mode: "best_of_n", n: 2, variance, reason: "arm requests best-of-n and posterior variance is high" };
  }
  if (input.armCompute === "verify_retry" || highVariance) {
    return { mode: "verify_retry", n: 1, variance, reason: highVariance ? "posterior variance is high and a verifier exists" : "arm requests verify-and-retry" };
  }
  return { mode: "single", n: 1, variance, reason: "posterior is confident; extra compute buys little" };
}

// ---------------------------------------------------------------------------
// 7. LESSONS — each lesson is itself an arm, with efficacy tracking
// ---------------------------------------------------------------------------

export interface Lesson extends BetaCell {
  id: string;
  taskClass: TaskClass;
  failureSignature: string;
  correction: string;
  createdAt: number;
  pruned: boolean;
}

export function lessonMean(lesson: Lesson): number {
  return betaMean(lesson.alpha, lesson.beta);
}

/** A lesson is pruned when it has had a fair trial (>= 10 injections) and
 *  the decisions it touched still score below the midpoint — zero measured
 *  effect. Effective lessons (mean >= 0.5) are never pruned by this rule. */
export function shouldPruneLesson(lesson: Lesson): boolean {
  if (lesson.pruned) return false;
  if (lesson.pulls < 10) return false;
  return lessonMean(lesson) < 0.5 && posteriorLowerBound(lesson.alpha, lesson.beta) < 0.45;
}

/** Top-k lessons for a class, Thompson-scored by tracked efficacy. */
export function rankLessons(
  lessons: Lesson[],
  taskClass: TaskClass,
  k: number,
  rng: Rng,
  deterministic = false,
): Lesson[] {
  return lessons
    .filter((l) => !l.pruned && l.taskClass === taskClass)
    .map((l) => ({
      l,
      score: deterministic ? posteriorLowerBound(l.alpha, l.beta) : rngBeta(rng, l.alpha, l.beta),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, k))
    .map((x) => x.l);
}

// ---------------------------------------------------------------------------
// 8. OFF-POLICY EVALUATION — IPS and doubly-robust estimators
// ---------------------------------------------------------------------------

export interface DecisionLog {
  taskClass: TaskClass;
  action: string;
  /** Probability the logging policy chose this action (must be > 0). */
  propensity: number;
  reward: number;
  tokens?: number;
  extraTokens?: number;
  expectedReward?: number;
}

/** Inverse propensity scoring: unbiased for the target policy's value when
 *  propensities are correct and coverage holds. */
export function ipsEstimate(
  logs: DecisionLog[],
  targetProb: (log: DecisionLog) => number,
): { estimate: number; n: number; effectiveSampleSize: number } {
  let sum = 0;
  let wsum = 0;
  let w2 = 0;
  let n = 0;
  for (const log of logs) {
    if (!(log.propensity > 0)) continue;
    const w = targetProb(log) / log.propensity;
    sum += w * log.reward;
    wsum += w;
    w2 += w * w;
    n++;
  }
  return {
    estimate: n ? Number((sum / n).toFixed(4)) : 0,
    n,
    effectiveSampleSize: wsum > 0 ? Number((wsum * wsum / Math.max(1e-9, w2)).toFixed(1)) : 0,
  };
}

/** Doubly robust: consistent if EITHER the propensities or the value model
 *  is right. `qLogged` = model value of the logged action, `qTarget` =
 *  model expectation under the target policy. */
export function drEstimate(
  logs: DecisionLog[],
  targetProb: (log: DecisionLog) => number,
  qLogged: (log: DecisionLog) => number,
  qTarget: (log: DecisionLog) => number,
): { estimate: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const log of logs) {
    if (!(log.propensity > 0)) continue;
    const w = targetProb(log) / log.propensity;
    sum += qTarget(log) + w * (log.reward - qLogged(log));
    n++;
  }
  return { estimate: n ? Number((sum / n).toFixed(4)) : 0, n };
}

/** Evaluate "always pick arm X" from logs, per arm, with both estimators.
 *  The value model is the per-(class, action) mean reward — the standard
 *  direct-method baseline for the DR correction term. */
export function evaluateArmPolicies(logs: DecisionLog[]): Array<{
  arm: string;
  ips: number;
  dr: number;
  n: number;
  loggedMean: number;
}> {
  const arms = [...new Set(logs.map((l) => l.action))];
  const cellMean = new Map<string, { sum: number; n: number }>();
  for (const l of logs) {
    const key = `${l.taskClass}|${l.action}`;
    const cur = cellMean.get(key) ?? { sum: 0, n: 0 };
    cur.sum += l.reward;
    cur.n++;
    cellMean.set(key, cur);
  }
  const q = (taskClass: TaskClass, action: string) => {
    const cur = cellMean.get(`${taskClass}|${action}`);
    return cur ? cur.sum / cur.n : 0.5;
  };
  return arms.map((arm) => {
    const target = (log: DecisionLog) => (log.action === arm ? 1 : 0);
    const ips = ipsEstimate(logs, target);
    const dr = drEstimate(logs, target, (log) => q(log.taskClass, log.action), (log) => q(log.taskClass, arm));
    const mine = logs.filter((l) => l.action === arm);
    return {
      arm,
      ips: ips.estimate,
      dr: dr.estimate,
      n: ips.n,
      loggedMean: mine.length ? Number((mine.reduce((a, l) => a + l.reward, 0) / mine.length).toFixed(4)) : 0,
    };
  }).sort((a, b) => b.dr - a.dr);
}

// ---------------------------------------------------------------------------
// 9. REPORTING — regret curve, calibration, reward per extra token, caps
// ---------------------------------------------------------------------------

export interface DecisionRecord extends DecisionLog {
  traceId: string;
  tupleId: string;
  ts: number;
  computeMode: ComputeMode;
  lessonIds: string[];
}

/** Cumulative regret against an oracle that always earns `oracleMean`
 *  (in the endpoint: the current best posterior mean for the class). */
export function regretCurve(records: DecisionRecord[], oracleMean: (taskClass: TaskClass) => number): Array<{ t: number; regret: number }> {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  let acc = 0;
  return sorted.map((r, i) => {
    acc += Math.max(0, oracleMean(r.taskClass) - r.reward);
    return { t: i + 1, regret: Number(acc.toFixed(3)) };
  });
}

/** Fit the exponent b in regret ~ t^b by log-log least squares.
 *  b < 1 is sublinear — the signature of a learning (not guessing) policy. */
export function fitRegretExponent(points: Array<{ t: number; regret: number }>): number {
  const usable = points.filter((p) => p.t > 1 && p.regret > 0);
  if (usable.length < 2) return 0;
  const xs = usable.map((p) => Math.log(p.t));
  const ys = usable.map((p) => Math.log(p.regret));
  const mx = xs.reduce((a, x) => a + x, 0) / xs.length;
  const my = ys.reduce((a, x) => a + x, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  return den > 0 ? Number((num / den).toFixed(3)) : 0;
}

/** Predicted (posterior mean at decision time) vs realized reward, bucketed. */
export function calibrationBuckets(records: DecisionRecord[], buckets = 5): Array<{
  bucket: number;
  predicted: number;
  realized: number;
  n: number;
}> {
  const out: Array<{ bucket: number; predicted: number; realized: number; n: number }> = [];
  for (let b = 0; b < buckets; b++) {
    const lo = b / buckets;
    const hi = (b + 1) / buckets;
    const rows = records.filter((r) => (r.expectedReward ?? 0) >= lo && (r.expectedReward ?? 0) < hi || (b === buckets - 1 && (r.expectedReward ?? 0) === 1));
    out.push({
      bucket: b,
      predicted: rows.length ? Number((rows.reduce((a, r) => a + (r.expectedReward ?? 0), 0) / rows.length).toFixed(3)) : 0,
      realized: rows.length ? Number((rows.reduce((a, r) => a + r.reward, 0) / rows.length).toFixed(3)) : 0,
      n: rows.length,
    });
  }
  return out;
}

/** Realized reward gained per extra token spent on escalation, over the
 *  escalated decisions only. Null when nothing has escalated yet. */
export function rewardPerExtraToken(records: DecisionRecord[]): number | null {
  const esc = records.filter((r) => (r.extraTokens ?? 0) > 0);
  if (esc.length === 0) return null;
  const gain = esc.reduce((a, r) => a + (r.reward - (r.expectedReward ?? r.reward)), 0);
  const tokens = esc.reduce((a, r) => a + (r.extraTokens ?? 0), 0);
  return tokens > 0 ? Number((gain / tokens).toFixed(6)) : null;
}

/** Bounded growth: keep the most valuable cells (evidence + recency). */
export function pruneCells<T extends BetaCell>(cells: T[], cap: number, now: number): T[] {
  if (cells.length <= cap) return cells;
  const score = (c: BetaCell) => c.pulls * 2 - (now - c.lastAt) / 86_400_000;
  return [...cells].sort((a, b) => score(b) - score(a)).slice(0, cap);
}
