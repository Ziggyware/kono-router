import { Hono, type Context, type MiddlewareHandler } from "hono";
import { currentSpan, getTrace, listTraces, type Span, startTrace, subscribe } from "./trace.ts";
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

// ============================================================================
// 1. DENO KV + L1 ISOLATE CACHE + CAS ATOMIC STATE ENGINE
// ============================================================================

const kv = await Deno.openKv();
const KV_PREFIX = "mesh_models_v5_2";

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
}

const L1_CACHE = new Map<string, MeshModelRecord>();
let l1LastHydrated = 0;
const L1_TTL_MS = 15_000;

let l1Refresh: Promise<Map<string, MeshModelRecord>> | null = null;

// Stale-while-revalidate: a warm isolate never blocks a request on kv.list.
function hydrateL1Cache(force = false): Promise<Map<string, MeshModelRecord>> {
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

async function atomicUpdateModel(
  tupleId: string,
  mutator: (current: MeshModelRecord) => MeshModelRecord,
  maxRetries = 4,
): Promise<void> {
  const key = [KV_PREFIX, tupleId];
  // Optimistic L1 write: concurrent requests on this isolate see cooldowns before the KV commit lands.
  const cached = L1_CACHE.get(tupleId);
  if (cached) L1_CACHE.set(tupleId, mutator(cached));
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const entry = await kv.get<MeshModelRecord>(key);
    if (!entry.value) return;
    const updated = mutator(entry.value);
    const res = await kv.atomic().check(entry).set(key, updated).commit();
    if (res.ok) {
      L1_CACHE.set(tupleId, updated);
      return;
    }
    await new Promise((r) => setTimeout(r, 10 * (attempt + 1) + Math.random() * 15));
  }
}

// ============================================================================
// 2. SECURITY: CONSTANT-TIME AUTH, RATE LIMITER & HEADER ROTATOR
// ============================================================================

const encoder = new TextEncoder();

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) {
    let diff = 1;
    for (let i = 0; i < bufB.byteLength; i++) diff |= bufB[i] ^ bufB[i];
    return diff === 0;
  }
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

const IP_BUCKETS = new Map<string, { tokens: number; lastRefill: number }>();
// Generous but bounded: a normal client must never see a 429 from the router,
// while a pathological flood is still contained. Tunable per deployment.
const MAX_BURST = clampNum(Number(Deno.env.get("NOKEY_RATE_BURST")) || 120, 5, 10_000);
const REFILL_PER_SEC = clampNum(Number(Deno.env.get("NOKEY_RATE_REFILL")) || 8, 0.1, 1_000);

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = IP_BUCKETS.get(ip) ?? { tokens: MAX_BURST, lastRefill: now };
  const elapsedSec = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(MAX_BURST, bucket.tokens + elapsedSec * REFILL_PER_SEC);
  bucket.lastRefill = now;

  if (IP_BUCKETS.size > 5000) IP_BUCKETS.clear();

  if (bucket.tokens < 1) {
    IP_BUCKETS.set(ip, bucket);
    return false;
  }
  bucket.tokens -= 1;
  IP_BUCKETS.set(ip, bucket);
  return true;
}

function buildRotatedHeaders(baseHeaders: Record<string, string>): Headers {
  const uaPool = [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36",
    "OpenAI/v1 PythonBindings/1.82.0",
    "continue-dev/1.4.12 (darwin-arm64)",
    "cline/4.1.0 vscode/1.105.0",
    "roo-code/3.18.0 (win32-x64)",
    "opencode-ai/2.6.4 (linux-x64)",
  ];
  const entries = Object.entries({
    "Accept": "application/json, text/event-stream",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "User-Agent": uaPool[Math.floor(Math.random() * uaPool.length)],
    ...baseHeaders,
    "Content-Type": "application/json",
  });

  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const h = new Headers();
  for (const [k, v] of entries) h.set(k, v);
  return h;
}

function pickOpenRouterKey(): string | null {
  const raw = Deno.env.get("OPENROUTER_API_KEY") || Deno.env.get("OPENROUTER_API_KEYS") || "";
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)];
}

// ============================================================================
// 3. VERIFIED OCT-2026 CAPABILITY PARSER & SHANNON ENTROPY POISON GUARD
// ============================================================================

interface ModelCapabilityProfile {
  iqPrior: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  isCodingSpecialist: boolean;
}

function analyzeModelCapabilities(modelId: string, contextLength: number = 128000): ModelCapabilityProfile {
  const m = modelId.toLowerCase();

  // Exclude non-chat, moderation/guardrail, audio-only, image-gen, and embedding endpoints
  // Note: nvidia/nemotron-3.5-content-safety:free is a guardrail moderation classifier, not a general chat LLM
  if (
    /embed|bge-|e5-|whisper|tts|kokoro|flux|sdxl|dall-e|imagen|veo-|moderation|guard|content-safety|rerank|suno|udio|respan/i
      .test(m)
  ) {
    return { iqPrior: 0.0, supportsReasoning: false, supportsVision: false, isCodingSpecialist: false };
  }

  let baseScore = 0.56;

  // Tier 0: October 2026 Apex Frontier (AA Intelligence Index 52.5 - 57.6 / Vals #1)
  // Includes: Claude Opus 5.5 (57.6), Claude Sonnet 5.5 (56.0), Kimi K3.1 Pro (55.1, 2.8T/104B),
  // Claude Fable 5.1 (53.4), Gemini 4 Argon (52.6, #1 Vals Index), GPT-6.1 Terra, GPT-6 Astra
  if (
    /claude-opus-5(\.5)?|claude-sonnet-5(\.5)?|claude-fable-5(\.1)?|kimi-k3(\.1)?-pro|gemini-4-argon|argon|gpt-6(\.1)?-(terra|astra)|space-bunny-alpha/i
      .test(m)
  ) {
    baseScore = 0.975;
  } // Tier 1: Late-2026 Flagships & Ultra-Heavy Free MoEs
  // Includes: Grok 4.7 / 4.5 / 4.4 / 4-Heavy, Gemini 3.1 Pro (77.1% ARC-AGI-2), Gemini 3.8 Flash, Gemini 2.8,
  // Qwen3.8 Max, DeepSeek V4 Pro (1.6T/49B), DeepSeek V4.1 Flash (1017 CED), GLM 5.3,
  // ThinkingMachines Inkling (975B/41B :free), NVIDIA Nemotron 3 Ultra (550B/55B :free),
  // Poolside Laguna S 2.1 (118B/8B :free), Dots3-Note Preview (280B/16B :free)
  else if (
    /grok-4(\.[13457]|-heavy)?(?!-mini)|gemini-(3\.[158]|2\.8)-(pro|flash)|qwen3\.8-max|deepseek-v4(\.1)?-(pro|flash)|glm-5\.3|thinkingmachines\/inkling(?!-small)|nemotron-3-ultra-550b|laguna-s-2\.1|dots-3-note|claude-4-[57]|claude-opus-4|gpt-5\.6-sol|o3(?!-mini)|o4(?!-mini)/i
      .test(m)
  ) {
    baseScore = 0.935;
  } // Tier 2: High-Efficiency Agentic, Coding & Multimodal Workhorses (Oct 2026 :free core)
  // Includes: GPT-6 Luna, GPT-5.6 Luna, Kimi K3 / K2, DeepSeek V4 Flash 0731, DeepSeek V3.2, DeepSeek R1 0528,
  // Inkling Small (276B/12B :free), Nemotron 3 Super (120B/12B :free), Qwen3.8 27B (:free),
  // Gemma 4 31B IT (:free), Gemma 4 26B A4B (:free), Cohere North Mini Code (30B/3B :free),
  // Poolside Laguna XS 2.1 (:free), Recursive Flint (40B/2.5B :free), Xing4.0 29B A4B (:free),
  // MiMo-V2.6-Flash, Tencent Hy4 Preview, MiniMax M2, OpenRouter Auto-Free Router (openrouter/free)
  else if (
    /gpt-6-luna|gpt-5\.6-luna|kimi-k[23]|deepseek-v4-flash|deepseek-v3\.2|deepseek-r1|inkling-small|nemotron-3-super-120b|qwen3\.8-27b|qwen3(\.5)?-(32b|72b|235b|coder)|gemma-?4-(31b|26b)|north-mini-code|laguna-xs-2\.1|recursive\/flint|xing4\.0-29b|mimo-v2\.6|hy4-preview|minimax-m2|ling-3\.0-flash|solar-pro-4|openrouter\/free|kilo-auto\/free|claude-3-[57]-sonnet|gpt-4\.1(?!-nano|-mini)|llama-4-(maverick|behemoth)/i
      .test(m)
  ) {
    baseScore = 0.875;
  } // Tier 3: High-Throughput Agent Lightning & Perception Sub-Agents
  // Includes: Nemotron 3.5 Lightning (30B/3B :free, 1M ctx), Nemotron 3 Nano Omni (30B/3B :free),
  // Nemotron 3.5 Bolt E4B, Apodex 1.1 Mini (:free), Gemma 3 27B, Llama 3.3 70B, Llama 4 Scout
  else if (
    /nemotron-3\.5-lightning|nemotron-3-nano-omni|nemotron-3\.5-bolt|apodex-1\.1-mini|gemma-?3-27b|llama-3\.3-70b|llama-4-scout|qwen-?2\.5-(coder-32b|72b)|codestral|mistral-large|glm-4\.5|grok-4-mini|grok-3|gpt-4o-mini|claude-3-5-haiku|kilo-auto\/small/i
      .test(m)
  ) {
    baseScore = 0.77;
  } // Tier 4: Compact Extraction / Edge 2B-9B Models
  // Note: Liquid LFM2.5-2.6B (:free) is explicitly advised by Liquid AI for RAG/extraction, NOT agentic coding
  else if (
    /lfm-2\.5-2\.6b|gemma-?[34]-(9b|12b)|qwen3-(8b|4b)|llama-3\.[12]-(8b|11b)|ministral|mistral-nemo|phi-4|flash-lite/i
      .test(m)
  ) {
    baseScore = 0.52;
  } // Tier 5: Sub-2B Micro Models
  else if (/0\.5b|0\.6b|1b|1\.5b|tinyllama|smollm/i.test(m)) {
    baseScore = 0.35;
  }

  const supportsReasoning =
    /argon|claude-opus-5|claude-sonnet-5|claude-fable-5|kimi-k3|gpt-6|grok-4|gemini-3|gemini-2\.8|deepseek-v4|deepseek-v3\.2|deepseek-r1|glm-5|qwen3\.8|inkling|nemotron-3|dots-3|xing4\.0|apodex|lfm-2\.5|o1|o3|o4|thinking|reason/i
      .test(m);

  const supportsVision =
    /argon|claude-opus-5|claude-sonnet-5|kimi-k3|gpt-6|grok-4|gemini|qwen3\.8|gemma-?4-(26b|31b)|inkling|nemotron-3-nano-omni|dots-3|deepseek-v3\.2|vision|vl|pixtral|llama-4/i
      .test(m);

  const isCodingSpecialist =
    /laguna|north-mini-code|flint|coder|codestral|devstral|kimi-k3|claude-opus-5|claude-sonnet-5|gemini-4-argon|deepseek-v4|glm-5\.3|qwen3\.8|inkling|kilo/i
      .test(m);

  if (isCodingSpecialist) baseScore += 0.015;
  if (contextLength >= 256000) baseScore += 0.01;
  if (contextLength >= 1000000) baseScore += 0.01;

  return {
    iqPrior: Math.min(0.995, Number(baseScore.toFixed(3))),
    supportsReasoning,
    supportsVision,
    isCodingSpecialist,
  };
}

const POISON_REGEX =
  /rate limit exceeded|too many requests|cloudflare ray id|just a moment\.\.\.|api key is required|insufficient_quota|error code: 1020|visit https:\/\/|upgrade your plan|free tier limit|model is overloaded|service unavailable|provider returned error|<\s*!doctype|<\s*html|access denied|captcha|bad gateway|upstream connect error|service temporarily unavailable|enable javascript|origin (?:is|not) allowed/i;

function computeShannonEntropy(str: string): number {
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

function verifyCleanText(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("POISON_EMPTY: Zero content tokens");
  if (POISON_REGEX.test(trimmed.slice(0, 400))) {
    throw new Error("POISON_SOFTBLOCK: Upstream proxy error disguised as 200 OK");
  }
  if (trimmed.length >= 32 && computeShannonEntropy(trimmed.slice(0, 128)) < 1.15) {
    throw new Error("POISON_DEGENERATE: Low-entropy token collapse detected");
  }
}

// ============================================================================
// 4. EPISTEMIC THOMPSON SAMPLING + MULTIMODAL INTENT AUTO-CLASSIFIER
// ============================================================================

export type RoutingMode = "fast" | "smart" | "code" | "reasoning";

// Bandit sampling primitives live in ./math.ts (ASCK v1): sampleGamma /
// sampleBeta (Marsaglia–Tsang), discountedPosterior, UCB, Wilson, Gumbel.

function extractMessageText(messages: Array<{ role: string; content: unknown }>): {
  combinedText: string;
  hasVisionPayload: boolean;
} {
  let hasVisionPayload = false;
  const parts: string[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            parts.push(b.text);
          } else if (
            b.type === "image_url" ||
            b.type === "image" ||
            b.type === "input_image" ||
            b.type === "video_url" ||
            b.type === "input_audio"
          ) {
            hasVisionPayload = true;
          }
        }
      }
    }
  }
  return { combinedText: parts.join("\n"), hasVisionPayload };
}

function classifyPromptIntent(
  messages: Array<{ role: string; content: unknown }>,
  hasTools = false,
  reasoningEffort?: string,
): RoutingMode {
  if (reasoningEffort === "high" || reasoningEffort === "xhigh" || reasoningEffort === "max") {
    return "reasoning";
  }
  const { combinedText } = extractMessageText(messages);

  if (
    hasTools ||
    /```|function\s+\w+|interface\s+\w+|def\s+\w+|import\s+\{|SELECT\s+.*\s+FROM|cargo\s+build|Deno\.|async\s+function|pub\s+fn\s+|#include\s*</i
      .test(combinedText)
  ) {
    return "code";
  }
  if (
    /prove\s+that|formal\s+proof|theorem|lemma|eigenvalue|hamiltonian|lagrangian|step-by-step\s+derivation|game\s+theory|bayesian|time\s+complexity\s+proof/i
      .test(combinedText)
  ) {
    return "reasoning";
  }
  if (combinedText.length > 1800 || /architect|analyze|differential|rigorous|synthesize|tradeoff/i.test(combinedText)) {
    return "smart";
  }
  return "fast";
}

// ============================================================================
// 5. LIVE UPSTREAM MODEL CATALOG DISCOVERY ADAPTERS (INCL. OPENROUTER :free)
// ============================================================================

async function serviceJsonProviderList(): Promise<ProviderSpec[]> {
  try {
    return await serviceJsonProviders();
  } catch (err) {
    console.error("service-json provider load promise rejected:", err);
    return [];
  }
}


interface CompletionResult {
  content: string;
  reasoningContent: string | null;
  toolCalls?: unknown[];
  ttftMs: number;
  totalMs: number;
  estTokens: number;
}

interface CompletionOptions {
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

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface Delta {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  finish?: string;
}

// An upstream generation whose first tokens already passed the poison guard.
interface UpstreamStream {
  t0: number;
  ttftMs: number;
  head: Delta[];
  tail: AsyncGenerator<Delta>;
}

interface ProviderSpec {
  id: string;
  name: string;
  /** Chat completions URL, exposed for coverage reporting. */
  chatUrl?: string;
  isConfigured: () => boolean;
  discoverModels: (signal: AbortSignal) => Promise<Array<{ id: string, context?: number; }>>;
  executeCompletion: (
    modelId: string,
    messages: Array<{ role: string; content: unknown }>,
    signal: AbortSignal,
    options?: CompletionOptions,
  ) => Promise<UpstreamStream>;
}

type Json = Record<string, unknown>;

function firstString(...xs: unknown[]): string | undefined {
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
function extractJsonDelta(data: unknown): Delta | null {
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

function sseLineDelta(line: string): Delta | null {
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

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Length of the longest suffix of s that is a proper prefix of tag (a tag split across chunks). */
function partialTagSuffix(s: string, tag: string): number {
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
async function* refineDeltas(src: AsyncIterable<Delta>): AsyncGenerator<Delta> {
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

// Incremental, self-sniffing response decoder. It handles SSE, a single JSON
// document (bodies that ignore stream:true), JSON arrays, and plain text —
// every shape the heterogeneous keyless registry emits.
async function* parseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<Delta> {
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
const COMMIT_CHARS = 64;

// Resolves at the first validated tokens (or a tool call), not at completion: the race is decided
// on time-to-first-token and the winner's remainder is piped, never buffered.
async function openUpstream(
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

  const tail = refineDeltas(parseDeltas(res.body));
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

// A model id accepted by the widest set of keyless relays (used only on the
// last protocol-negotiation rung, never on the fast path).
const UNIVERSAL_MODEL_ALIAS = "gpt-4o-mini";

function isNegotiableFailure(e: unknown): boolean {
  if (e instanceof Error && /abort/i.test(e.name) && /HEDGE_LOST|CLIENT_DISCONNECTED|TIMEOUT/.test(e.message)) return false;
  const m = e instanceof Error ? e.message : String(e);
  return /^(PROTOCOL_|HTTP_400|HTTP_404|HTTP_405|HTTP_415|HTTP_422|HTTP_501|POISON_EMPTY|POISON_DEGENERATE|UPSTREAM_ERR)/.test(m) ||
    /^Unexpected|JSON|SyntaxError/i.test(m);
}

// Adaptive wire-protocol negotiation. A keyless relay that rejects streaming,
// optional params, or the requested model name is retried with progressively
// simpler payloads instead of being written off as dead. This is what lets the
// exhaustive sweep actually use heterogeneous endpoints.
async function openUpstreamAdaptive(
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

function mergeToolCalls(acc: Map<number, ToolCallDelta>, deltas: ToolCallDelta[]): void {
  for (const t of deltas) {
    const cur = acc.get(t.index);
    if (!cur) {
      acc.set(t.index, { ...t, function: { name: t.function?.name, arguments: t.function?.arguments ?? "" } });
      continue;
    }
    if (t.id) cur.id = t.id;
    if (t.type) cur.type = t.type;
    if (t.function?.name) cur.function!.name = t.function.name;
    cur.function!.arguments = (cur.function!.arguments ?? "") + (t.function?.arguments ?? "");
  }
}

// Drains a committed upstream into the buffered (non-stream) completion shape.
async function collectUpstream(up: UpstreamStream): Promise<CompletionResult & { finish?: string }> {
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

function buildOptionalParams(options?: CompletionOptions): Record<string, unknown> {
  if (!options) return {};
  const extra: Record<string, unknown> = {};
  if (typeof options.temperature === "number") extra.temperature = options.temperature;
  if (typeof options.max_tokens === "number") extra.max_tokens = options.max_tokens;
  if (typeof options.top_p === "number") extra.top_p = options.top_p;
  if (options.reasoning_effort) extra.reasoning_effort = options.reasoning_effort;
  if (Array.isArray(options.tools) && options.tools.length > 0) extra.tools = options.tools;
  if (options.tool_choice !== undefined) extra.tool_choice = options.tool_choice;
  if (typeof options.parallel_tool_calls === "boolean") extra.parallel_tool_calls = options.parallel_tool_calls;
  if (options.reasoning !== undefined) extra.reasoning = options.reasoning;
  if (options.response_format !== undefined) extra.response_format = options.response_format;
  return extra;
}

// Verified October 2026 OpenRouter :free model catalog fallback
const OPENROUTER_OCT2026_FREE_FALLBACK: Array<{ id: string; context: number }> = [
  { id: "openrouter/free", context: 262144 },
  { id: "thinkingmachines/inkling:free", context: 1048576 },
  { id: "thinkingmachines/inkling-small:free", context: 1048576 },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", context: 1048576 },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", context: 262144 },
  { id: "nvidia/nemotron-3.5-lightning:free", context: 1048576 },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", context: 262144 },
  { id: "poolside/laguna-s-2.1:free", context: 262144 },
  { id: "poolside/laguna-xs-2.1:free", context: 262144 },
  { id: "cohere/north-mini-code:free", context: 256000 },
  { id: "recursive/flint:free", context: 262144 },
  { id: "qwen/qwen3.8-27b:free", context: 262144 },
  { id: "google/gemma-4-31b-it:free", context: 262144 },
  { id: "google/gemma-4-26b-a4b-it:free", context: 262144 },
  { id: "dots-studio/dots-3-note-preview:free", context: 524288 },
  { id: "xingchen-agi/xing4.0-29b-a4b:free", context: 262144 },
  { id: "apodex/apodex-1.1-mini:free", context: 262144 },
  { id: "inclusionai/ling-3.0-flash-sante:free", context: 262144 },
  { id: "liquid/lfm-2.5-2.6b:free", context: 65536 },
];

// ============================================================================
// 5b. SERVICES.JSON REGISTRY DRIVEN PROVIDERS
// ============================================================================

interface ServiceJsonEndpoint {
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

interface ServiceJsonRegistry {
  registryName: string;
  asOfDate: string;
  totalEndpoints: number;
  endpoints: ServiceJsonEndpoint[];
}

// Schema-guarded registry parser. Only accepts {"endpoints": [...]} payloads
// where every endpoint tuple carries the fields required to build a ProviderSpec.
function parseServiceJsonRegistry(raw: string): ServiceJsonRegistry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;

  if (typeof root.totalEndpoints !== "number" || !Array.isArray(root.endpoints)) {
    return null;
  }
  if (root.endpoints.length === 0) {
    return null;
  }

  const endpoints: ServiceJsonEndpoint[] = [];
  for (const item of root.endpoints) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== "string" || typeof obj.url !== "string") continue;
    // Optional string fields may legitimately be null (e.g. 47 of the 100
    // keyless endpoints carry "authHeader": null). Rejecting null here used to
    // silently discard nearly half the registry before it could be ranked.
    const optionalString = (v: unknown) => v === undefined || v === null || typeof v === "string";
    if (!optionalString(obj.baseUrl)) continue;
    if (!optionalString(obj.modelsUrl)) continue;
    if (!optionalString(obj.authHeader)) continue;
    if (!optionalString(obj.defaultModel)) continue;
    if (!optionalString(obj.authMode)) continue;
    if (!optionalString(obj.category)) continue;
    if (!optionalString(obj.notes)) continue;
    if (obj.id !== undefined && typeof obj.id !== "number") continue;
    endpoints.push({
      id: typeof obj.id === "number" ? obj.id : 0,
      name: obj.name,
      category: typeof obj.category === "string" ? obj.category : "",
      baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : "",
      url: obj.url,
      modelsUrl: typeof obj.modelsUrl === "string" ? obj.modelsUrl : null,
      defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel : "",
      authRequired: Boolean(obj.authRequired),
      authMode: typeof obj.authMode === "string" ? obj.authMode : null,
      authHeader: typeof obj.authHeader === "string" ? obj.authHeader : null,
      notes: typeof obj.notes === "string" ? obj.notes : null,
      telemetry: obj.telemetry ?? null,
    });
  }

  if (endpoints.length === 0) return null;

  return {
    registryName: typeof root.registryName === "string" ? root.registryName : "",
    asOfDate: typeof root.asOfDate === "string" ? root.asOfDate : "",
    totalEndpoints: root.totalEndpoints,
    endpoints,
  };
}

let SERVICE_JSON_REGISTRY: ServiceJsonRegistry | null = null;
let serviceJsonLoadError: string | null = null;

const SERVICE_JSON_FILE = "services.json";

function isFileReadable(path: string): boolean {
  try {
    const stat = Deno.statSync(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

function loadTextFile(path: string): string | null {
  if (!isFileReadable(path)) return null;
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

function isServiceJsonFile(path: string): boolean {
  const base = path.split("/").pop()?.split("\\").pop();
  if (!base) return false;
  return base === SERVICE_JSON_FILE;
}

async function discoverServiceJsonPath(): Promise<string | null> {
  try {
    for await (const item of Deno.readDir(".")) {
      if (item.name !== SERVICE_JSON_FILE) continue;
      const full = await Deno.realPath(item.name);
      if (loadTextFile(full)) return full;
    }
    return null;
  } catch {
    return null;
  }
}

async function loadServiceJsonRegistry(): Promise<ServiceJsonRegistry | null> {
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

function buildProviderIdFromEndpointName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  if (!normalized) return "services_json_endpoint";
  return "services_json_" + normalized;
}

function authHeadersForEndpoint(endpoint: ServiceJsonEndpoint): Record<string, string> {
  const headerValue = endpoint.authHeader?.trim();
  if (!headerValue) return {};
  const lower = headerValue.toLowerCase();
  if (lower.startsWith("bearer ")) {
    const token = headerValue.slice("bearer ".length).trim();
    return { "Authorization": `Bearer ${token}` };
  }
  if (lower.startsWith("x-")) {
    return { [endpoint.authHeader!]: headerValue };
  }
  return { "Authorization": headerValue };
}

function isEndpointConfigured(endpoint: ServiceJsonEndpoint): boolean {
  const url = endpoint.url.trim();
  if (!url) return false;
  if (!endpoint.baseUrl.trim() && !endpoint.modelsUrl) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\{\{|\{\s*\w|\}\s*\}|%[0-9a-z]{2}/i.test(url)) return false;
  if (url.length > 4096) return false;
  return true;
}

function validateServiceJsonProvider(endpoint: ServiceJsonEndpoint): string | null {
  if (!isEndpointConfigured(endpoint)) return "endpoint-not-configured";
  if (!endpoint.name.trim()) return "endpoint-name-empty";
  if (!endpoint.url.trim()) return "endpoint-url-empty";
  if (endpoint.url.trim().length > 4096) return "endpoint-url-too-long";
  if (endpoint.baseUrl && !/^https?:\/\//i.test(endpoint.baseUrl)) return "endpoint-baseurl-malformed";
  if (endpoint.modelsUrl && !/^https?:\/\//i.test(endpoint.modelsUrl)) return "endpoint-modelsurl-malformed";
  if (endpoint.authHeader && endpoint.authHeader.trim().length > 2048) return "endpoint-auth-header-too-long";
  return null;
}

function makeServiceJsonProvider(endpoint: ServiceJsonEndpoint, validationError?: string | null): ProviderSpec {
  const id = buildProviderIdFromEndpointName(endpoint.name);
  const headers = authHeadersForEndpoint(endpoint);
  const baseUrl = endpoint.baseUrl.trim();
  const modelsUrl = endpoint.modelsUrl?.trim() || null;
  const chatUrl = endpoint.url.trim();
  const defaultModel = endpoint.defaultModel.trim() || "unknown";
  const _validationTag = validationError ?? "ok";

  return {
    id,
    name: endpoint.name,
    chatUrl,
    isConfigured: () => isEndpointConfigured(endpoint),
    discoverModels: async () => {
      const targetUrl = modelsUrl ?? (baseUrl ? `${baseUrl}/models` : null);
      if (!targetUrl) {
        return [{ id: defaultModel, context: 128000 }];
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(targetUrl, {
          method: "GET",
          headers: buildRotatedHeaders({}),
          signal: ctrl.signal,
        });

        if (!res.ok) {
          return [{ id: defaultModel, context: 128000 }];
        }

        const body = await res.json().catch(() => ({} as unknown));
        const dataArray = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];

        const models: Array<{ id: string; context?: number }> = [];
        for (const item of dataArray) {
          const obj = item as Record<string, unknown>;
          const idField = String(obj.id || obj.name || obj.model || "").trim();
          if (!idField) continue;
          const ctx = Number(obj.context_length ?? obj.context ?? obj.maxInputChars ?? obj.max_tokens ?? 0);
          models.push({ id: idField, context: ctx || undefined });
        }

        if (models.length === 0) {
          return [{ id: defaultModel, context: 128000 }];
        }

        return models;
      } catch {
        return [{ id: defaultModel, context: 128000 }];
      } finally {
        clearTimeout(timer);
      }
    },
    executeCompletion: (modelId, messages, signal, options) =>
      openUpstreamAdaptive(
        chatUrl,
        headers,
        { model: modelId, messages, ...buildOptionalParams(options) },
        signal,
      ),
  };
}

const PROVIDERS: ProviderSpec[] = [
  {
    id: "openrouter",
    name: "OpenRouter Verified :free Mesh",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    isConfigured: () => Boolean(pickOpenRouterKey()),
    discoverModels: async (signal) => {
      try {
        // OpenRouter's /api/v1/models endpoint is public and returns live pricing & :free slugs
        const res = await fetch("https://openrouter.ai/api/v1/models", { signal });
        if (res.ok) {
          const json = await res.json();
          const data: Array<Record<string, unknown>> = Array.isArray(json.data) ? json.data : [];
          const freeModels = data.filter((m) => {
            const id = String(m.id || "");
            const pricing = (m.pricing as Record<string, unknown>) || {};
            const isZeroCost =
              String(pricing.prompt) === "0" && String(pricing.completion) === "0";
            return id.endsWith(":free") || id === "openrouter/free" || isZeroCost;
          });

          if (freeModels.length > 0) {
            const mapped = freeModels.map((m) => ({
              id: String(m.id),
              context: Number(m.context_length || 262144),
            }));
            if (!mapped.some((m) => m.id === "openrouter/free")) {
              mapped.unshift({ id: "openrouter/free", context: 262144 });
            }
            return mapped;
          }
        }
      } catch {
        // Fallback to verified October 2026 :free list
      }
      return OPENROUTER_OCT2026_FREE_FALLBACK;
    },
    executeCompletion: (modelId, messages, signal, options) => {
      const apiKey = pickOpenRouterKey();
      if (!apiKey) {
        throw new Error("HTTP_401: OPENROUTER_API_KEY not configured for openrouter provider");
      }
      return openUpstreamAdaptive(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": "https://vajra-mesh.deno.dev",
          "X-Title": "Vajra Empirical Sovereign Router",
        },
        { model: modelId, messages, ...buildOptionalParams(options) },
        signal,
      );
    },
  },
  {
    id: "llm7",
    name: "LLM7 Anonymous Mesh",
    chatUrl: "https://api.llm7.io/v1/chat/completions",
    // Disabled 2026-10-27: llm7.io revoked anonymous access (401 on the hardcoded
    // "Bearer unused" token) and its 47 catalog tuples clogged the smart/code
    // dispatch waves. Re-enable only after wiring a real LLM7_API_KEY here.
    isConfigured: () => false,
    discoverModels: async (signal) => {
      const res = await fetch("https://api.llm7.io/v1/models", { signal });
      if (!res.ok) throw new Error("Failed LLM7 model discovery");
      const json = await res.json();
      const list = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
      return list.map((m: Record<string, unknown>) => ({
        id: String(m.id),
        context: Number(m.context_window || m.context_length || 128000),
      }));
    },
    executeCompletion: (modelId, messages, signal, options) =>
      openUpstreamAdaptive(
        "https://api.llm7.io/v1/chat/completions",
        { "Authorization": "Bearer unused" },
        { model: modelId, messages, ...buildOptionalParams(options) },
        signal,
      ),
  },
  {
    id: "kilo",
    name: "Kilo Code AI Gateway",
    chatUrl: "https://ai-gateway.kilo.ai/api/v1/chat/completions",
    isConfigured: () => true,
    discoverModels: async (signal) => {
      try {
        const res = await fetch("https://ai-gateway.kilo.ai/api/v1/models", { signal });
        if (res.ok) {
          const json = await res.json();
          const freeOnes = (json.data || []).filter((m: Record<string, unknown>) =>
            String(m.id).includes(":free") ||
            String(m.id).includes("free") ||
            String(m.id).includes("kilo-auto")
          );
          if (freeOnes.length > 0) {
            return freeOnes.map((m: Record<string, unknown>) => ({
              id: String(m.id),
              context: Number(m.context_length || 262144),
            }));
          }
        }
      } catch {
        // Fallback to known keyless endpoints
      }
      return [
        { id: "kilo-auto/free", context: 262144 },
        { id: "kilo-auto/small", context: 128000 },
        { id: "google/gemma-4-31b-it:free", context: 262144 },
        { id: "google/gemma-4-26b-a4b-it:free", context: 262144 },
        { id: "qwen/qwen3.8-27b:free", context: 262144 },
        { id: "poolside/laguna-s-2.1:free", context: 262144 },
        { id: "cohere/north-mini-code:free", context: 256000 },
      ];
    },
    executeCompletion: (modelId, messages, signal, options) =>
      openUpstreamAdaptive(
        "https://ai-gateway.kilo.ai/api/v1/chat/completions",
        { "x-kilocode-mode": "code", "User-Agent": "Kilo-Code/3.4.0" },
        { model: modelId, messages, ...buildOptionalParams(options) },
        signal,
      ),
  },
  {
    id: "opencode",
    name: "OpenCode V2 Zen",
    chatUrl: "https://opencode.ai/inference/openai/v1/chat/completions",
    isConfigured: () => true,
    discoverModels: () => Promise.resolve([
      { id: "deepseek-v4.1-flash-free", context: 1048576 },
      { id: "glm-5.3-flash-free", context: 1048576 },
      { id: "nemotron-3.5-lightning-free", context: 1048576 },
      { id: "qwen3.8-27b-free", context: 262144 },
      { id: "mimo-v2.6-flash-free", context: 262144 },
    ]),
    executeCompletion: (modelId, messages, signal, options) =>
      openUpstreamAdaptive(
        "https://opencode.ai/inference/openai/v1/chat/completions",
        {
          "x-opencode-client": "cli",
          "x-opencode-project": "opencode-cli",
          "User-Agent": "opencode-ai/2.6.4",
        },
        { model: modelId, messages, ...buildOptionalParams(options) },
        signal,
      ),
  },
];

// ============================================================================
// 5c. MERGE SERVICES.JSON BACKED PROVIDERS INTO THE ACTIVE PROVIDER LIST
// ============================================================================

let serviceJsonProvidersPromise: Promise<ProviderSpec[]> | null = null;

function serviceJsonProviders(): Promise<ProviderSpec[]> {
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

async function activeProviderList(): Promise<ProviderSpec[]> {
  try {
    const native = PROVIDERS.filter((p) => p.isConfigured());
    const serviceJsonParts = await serviceJsonProviderList();
    const serviceJson = serviceJsonParts.filter((p) => p.isConfigured());
    return [...native, ...serviceJson];
  } catch (err) {
    console.error("active-provider-list rejected:", err);
    return PROVIDERS.filter((p) => p.isConfigured());
  }
}

// Resolve a candidate's provider by id across BOTH provider universes
// (native PROVIDERS and the services.json registry). The dispatch race and
// the canary probe previously searched PROVIDERS only, so any registry
// candidate that ranked into a wave instantly failed with "Provider missing
// or unconfigured" -- enough of them near the head of the ranking and every
// request returned 502 "All promises were rejected" while healthy native
// providers sat idle.
async function resolveProviderById(providerId: string): Promise<ProviderSpec | undefined> {
  const native = PROVIDERS.find((p) => p.id === providerId);
  if (native) return native;
  const extra = await serviceJsonProviderList();
  return extra.find((p) => p.id === providerId);
}

// ============================================================================
// 6. AUTO-DISCOVERY SYNC & PARETO + THOMPSON OBJECTIVE SCORER
// ============================================================================

let lastSyncCheckMemory = 0;interface SyncProviderTask {
  provider: ProviderSpec;
  last: number;
  force: boolean;
}

const perEndpointSyncGate = new Map<string, Promise<void>>();

async function runSyncProviderTask(task: SyncProviderTask): Promise<void> {
  const { provider, last, force } = task;
  if (!provider.isConfigured()) return;
  if (!force && last > 0 && Date.now() - last < 6 * 3600 * 1000) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5500);
  try {
    const discovered = await provider.discoverModels(ctrl.signal).catch((err) => {
      console.error(`sync discovery failed for ${provider.id}:`, err);
      return [] as Array<{ id: string; context?: number }>;
    });
    if (!discovered || discovered.length === 0) return;

    const modelTasks = discovered.map(async (item) => {
      const ctxWindow = item.context || 128000;
      const profile = analyzeModelCapabilities(item.id, ctxWindow);
      if (profile.iqPrior <= 0.0) return;

      const tupleId = `${provider.id}::${item.id}`;
      const modelKey = [KV_PREFIX, tupleId];
      const existing = await kv.get<MeshModelRecord>(modelKey);

      if (existing.value) {
        const updated: MeshModelRecord = {
          ...existing.value,
          iq_prior: profile.iqPrior,
          iq_verified: existing.value.success_count > 0
            ? existing.value.iq_verified
            : Math.min(existing.value.iq_verified, 0.55),
          supports_reasoning: profile.supportsReasoning,
          supports_vision: profile.supportsVision,
          is_coding_specialist: profile.isCodingSpecialist,
          context_window: ctxWindow,
        };
        await kv.set(modelKey, updated);
        L1_CACHE.set(tupleId, updated);
      } else {
        const freshRecord: MeshModelRecord = {
          tuple_id: tupleId,
          provider_id: provider.id,
          model_id: item.id,
          iq_prior: profile.iqPrior,
          iq_verified: 0.55,
          supports_reasoning: profile.supportsReasoning,
          supports_vision: profile.supportsVision,
          is_coding_specialist: profile.isCodingSpecialist,
          context_window: ctxWindow,
          ewma_ttft_ms: 2500.0,
          ewma_tps: 42.0,
          alpha_success: 2.0,
          beta_failure: 1.0,
          success_count: 0,
          failure_streak: 0,
          cooldown_until: 0,
          last_probed: 0,
          last_error: null,
        };
        await kv.set(modelKey, freshRecord);
        L1_CACHE.set(tupleId, freshRecord);
      }
    });

    await Promise.allSettled(modelTasks);
    await kv.set(["mesh_discovery_meta_v5_2", provider.id], Date.now());
  } catch (err) {
    console.error(`sync task failed for ${provider.id}:`, err);
  } finally {
    clearTimeout(timer);
  }
}

let catalogSyncInFlight = false;

// Hot-path guard: a chat request must never wait out a full provider sweep
// before its first upstream call. With a warm cache, a due sync refreshes
// in the background and the request is served from the current catalog.
// Only a cold start (empty cache) or an explicit admin force awaits it.
async function ensureCatalogSynced(force: boolean = false): Promise<void> {
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

async function runCatalogSyncBody(force: boolean = false): Promise<void> {

  const mergedProviders = [...PROVIDERS, ...await serviceJsonProviderList()];

  const syncMap = new Map<string, number>();
  const metaIter = kv.list<number>({ prefix: ["mesh_discovery_meta_v5_2"] });
  for await (const entry of metaIter) {
    syncMap.set(String(entry.key[1]), Number(entry.value));
  }

  const syncTasks = mergedProviders.map((p) => ({
    provider: p,
    last: syncMap.get(p.id) ?? 0,
    force,
  }));

  const router = async (task: SyncProviderTask): Promise<void> => {
    const gate = perEndpointSyncGate.get(task.provider.id);
    if (gate) {
      try {
        await gate;
      } catch {
        // prior wave failed; proceed with fresh attempt
      }
    }
    const currentGate = runSyncProviderTask(task);
    perEndpointSyncGate.set(task.provider.id, currentGate);
    try {
      await currentGate;
    } finally {
      if (perEndpointSyncGate.get(task.provider.id) === currentGate) {
        perEndpointSyncGate.delete(task.provider.id);
      }
    }
  };

  await Promise.allSettled(syncTasks.map(router));
  perEndpointSyncGate.clear();
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
}

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
function interleaveByProvider(sorted: ScoredCandidate[]): ScoredCandidate[] {
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

const PROVIDER_BREAKER = new Map<string, { fails: number; openUntil: number }>();
const BREAKER_FAIL_THRESHOLD = 6;
const BREAKER_OPEN_MS = 300000;

function breakerProviderId(tupleId: string): string {
  return tupleId.split("::")[0] || "";
}

interface RankOptions {
  includeCoolingDown?: boolean;
  verifiedOnly?: boolean;
  /** Exhaustive mode: ignore breaker, tuple cooldown, vision and IQ gates. */
  unrestricted?: boolean;
}

// ---------------------------------------------------------------------------
// ASCK v1 scoring: discounted Thompson sampling + Kalman predictive quantiles
// + UCB exploration + Plackett–Luce (Gumbel) rank sampling. Pure function of
// one catalog record, reused by the lane ranker and the exhaustive sweep.
// ---------------------------------------------------------------------------
function scoreRecord(
  r: MeshModelRecord,
  mode: RoutingMode,
  deterministic: boolean,
  totalPulls: number,
  now: number,
): ScoredCandidate {
  const iqPrior = Number(r.iq_prior);
  // Rank-time trust clamp: a tuple that has never completed a request cannot
  // spend a trusted iq_verified, no matter what sync stored.
  const iqVerified = r.success_count > 0
    ? Number(r.iq_verified)
    : Math.min(Number(r.iq_verified), 0.55);
  const iqEffective = Number((iqPrior * iqVerified).toFixed(3));
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
  const smartScore = Number(
    (iqEffective + codeBonus + reasoningBonus + thompsonBonus + exploration + plackettLuce - latencyPenalty)
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
  };
}

function totalCatalogPulls(catalog: Map<string, MeshModelRecord>): number {
  let n = 0;
  for (const r of catalog.values()) n += Math.max(1, r.success_count + r.failure_streak);
  return n;
}

async function getRankedCandidates(
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

  const candidates: ScoredCandidate[] = [];
  for (const r of catalog.values()) {
    if (!activeProviderIds.has(r.provider_id)) continue;
    if (!opts.includeCoolingDown && !opts.unrestricted && r.cooldown_until > now) continue;
    if (opts.verifiedOnly && !opts.unrestricted && r.success_count <= 0) continue;
    if (requireVision && !opts.unrestricted && !r.supports_vision) continue;
    candidates.push(scoreRecord(r, mode, deterministic, totalPulls, now));
  }

  if (mode === "fast" && !opts.unrestricted) {
    return interleaveByProvider(
      candidates
        .filter((c) => c.iqEffective >= 0.50)
        .sort((a, b) => a.expectedFastMs - b.expectedFastMs),
    );
  }

  return interleaveByProvider(candidates.sort((a, b) => b.smartScore - a.smartScore));
}

// ---------------------------------------------------------------------------
// UNIVERSAL ENDPOINT COVERAGE
// The catalog only contains tuples whose discovery succeeded. That silently
// excluded endpoints whose /models endpoint was down, rate limited, or behind
// a different schema -- exactly the long tail that "try everything" needs.
// providerModelHints() builds a static per-endpoint model ladder from the
// registry's own telemetry (defaultModel + discoveredModels), so EVERY
// configured endpoint always has a dispatchable candidate, with or without KV.
// ---------------------------------------------------------------------------

const NATIVE_MODEL_HINTS: Record<string, string[]> = {
  openrouter: ["openrouter/free", UNIVERSAL_MODEL_ALIAS],
  llm7: ["gpt-oss", UNIVERSAL_MODEL_ALIAS],
  kilo: ["kilo-auto/free", "kilo-auto/small", UNIVERSAL_MODEL_ALIAS],
  opencode: ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", UNIVERSAL_MODEL_ALIAS],
};

let modelHintsCache: Map<string, string[]> | null = null;

async function providerModelHints(): Promise<Map<string, string[]>> {
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

function syntheticRecord(providerId: string, modelId: string): MeshModelRecord {
  const profile = analyzeModelCapabilities(modelId);
  const now = Date.now();
  return {
    tuple_id: `${providerId}::${modelId}`,
    provider_id: providerId,
    model_id: modelId,
    iq_prior: Math.max(0.35, profile.iqPrior),
    iq_verified: 0.55,
    supports_reasoning: profile.supportsReasoning,
    supports_vision: profile.supportsVision,
    is_coding_specialist: profile.isCodingSpecialist,
    context_window: 128000,
    ewma_ttft_ms: 2500,
    ewma_tps: 42,
    ewma_log_ttft: Math.log(2500),
    ewmv_log_ttft: 0.25,
    log_ttft_updated_at: now,
    last_success_at: 0,
    alpha_success: 2,
    beta_failure: 1,
    success_count: 0,
    failure_streak: 0,
    cooldown_until: 0,
    last_probed: 0,
    last_error: null,
  };
}

/** Every configured endpoint, round-robined so each provider is attempted
 *  before any provider's second model. Never returns empty when at least one
 *  provider is configured. */
async function allSweepCandidates(mode: RoutingMode): Promise<ScoredCandidate[]> {
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

// Compact coverage report for /health, /v1/endpoints and the dashboard.
async function endpointCoverage(): Promise<{
  configured_endpoints: number;
  registry_endpoints: number;
  catalog_tuples: number;
  sweep_candidates: number;
  endpoints: Array<{ id: string; name: string; url: string; catalog_tuples: number; models: string[] }>;
}> {
  // Warm the catalog first so coverage reflects live tuples, not an empty
  // isolate. With a warm cache this is a no-op (60 s memory gate).
  await ensureCatalogSynced(false).catch((err) => console.error("coverage sync:", err));
  let providers: ProviderSpec[] = [];
  try {
    providers = await activeProviderList();
  } catch (err) {
    console.error("coverage provider list failed:", err);
  }
  const hints = await providerModelHints();
  const registry = await loadServiceJsonRegistry();
  const urlById = new Map<string, string>();
  for (const e of registry?.endpoints ?? []) {
    urlById.set(buildProviderIdFromEndpointName(e.name), e.url);
  }
  let catalog = new Map<string, MeshModelRecord>();
  try {
    catalog = await hydrateL1Cache(false);
  } catch { /* coverage must never throw */ }
  const counts = new Map<string, number>();
  for (const r of catalog.values()) counts.set(r.provider_id, (counts.get(r.provider_id) ?? 0) + 1);
  const sweep = await allSweepCandidates("smart").catch(() => [] as ScoredCandidate[]);
  return {
    configured_endpoints: providers.length,
    registry_endpoints: registry?.endpoints.length ?? 0,
    catalog_tuples: catalog.size,
    sweep_candidates: sweep.length,
    endpoints: providers.map((p) => ({
      id: p.id,
      name: p.name,
      url: p.chatUrl ?? urlById.get(p.id) ?? "",
      catalog_tuples: counts.get(p.id) ?? 0,
      models: hints.get(p.id) ?? [UNIVERSAL_MODEL_ALIAS],
    })),
  };
}

// ============================================================================
// 7. ATOMIC TELEMETRY UPDATERS & CANARY VERIFICATION
// ============================================================================

async function recordTupleSuccess(
  tupleId: string,
  ttftMs: number,
  totalMs: number,
  estTokens: number,
): Promise<void> {
  PROVIDER_BREAKER.delete(breakerProviderId(tupleId));
  const streamDurationSec = Math.max(0.05, (totalMs - ttftMs) / 1000);
  const observedTps = Math.min(800, Math.max(2, estTokens / streamDurationSec));

  const now = Date.now();
  await atomicUpdateModel(tupleId, (r) => {
    // Bayesian state-space update (ASCK v1): the Kalman gain is the optimal
    // learning rate, and the posterior variance feeds the hedge/kill quantiles.
    const posterior = kalmanObserve({
      mu: r.ewma_log_ttft ?? Math.log(Math.max(1, r.ewma_ttft_ms)),
      variance: clampNum(r.ewmv_log_ttft ?? 0.25, 0.01, 2.5),
      updatedAtMs: r.log_ttft_updated_at ?? 0,
    }, ttftMs, now);
    return {
      ...r,
      ewma_log_ttft: posterior.mu,
      ewmv_log_ttft: posterior.variance,
      log_ttft_updated_at: posterior.updatedAtMs,
      last_success_at: now,
      ewma_ttft_ms: Math.exp(posterior.mu),
      ewma_tps: 0.3 * observedTps + 0.7 * r.ewma_tps,
      alpha_success: Math.min(50, (r.alpha_success || 2.0) * 0.95 + 1.0),
      beta_failure: Math.max(1.0, (r.beta_failure || 1.0) * 0.95),
      iq_verified: Math.min(1.0, (r.iq_verified || 0.55) + 0.15),
      success_count: r.success_count + 1,
      failure_streak: 0,
      cooldown_until: 0,
      last_error: null,
    };
  });
}

async function recordTupleFailure(tupleId: string, errMsg: string): Promise<void> {
  const now = Date.now();
  const pid = breakerProviderId(tupleId);
  if (pid) {
    const state = PROVIDER_BREAKER.get(pid) || { fails: 0, openUntil: 0 };
    state.fails += 1;
    if (state.fails >= BREAKER_FAIL_THRESHOLD) {
      state.openUntil = now + BREAKER_OPEN_MS;
      state.fails = 0;
      console.warn(`provider breaker OPEN for ${pid} (${BREAKER_OPEN_MS / 1000}s)`);
    }
    PROVIDER_BREAKER.set(pid, state);
  }
  const baseSec = errMsg.includes("429")
    ? 120
    : errMsg.includes("401") || errMsg.includes("403")
    ? 900
    : 60;

  await atomicUpdateModel(tupleId, (r) => {
    const streak = r.failure_streak + 1;
    const backoffMultiplier = Math.min(8, Math.pow(1.5, streak - 1));
    return {
      ...r,
      failure_streak: streak,
      alpha_success: Math.max(1.0, (r.alpha_success || 2.0) * 0.9),
      beta_failure: Math.min(50, (r.beta_failure || 1.0) + 1.5),
      cooldown_until: now + decorrelatedJitter(baseSec * 1000, Math.round(baseSec * backoffMultiplier * 1000), 900_000),
      ewma_ttft_ms: Math.min(18000, r.ewma_ttft_ms * 1.4),
      last_error: errMsg.slice(0, 200),
    };
  });
}

async function runCanaryProbeOnTopCandidates(limit: number = 4) {
  const topSmart = (await getRankedCandidates("smart", true)).slice(0, limit);
  const probePrompt = [
    {
      role: "user",
      content: "Compute (23 * 19) + 14. Reply ONLY with the exact integer and nothing else.",
    },
  ];

  return await Promise.allSettled(
    topSmart.map(async (cand) => {
      const provider = await resolveProviderById(cand.providerId);
      if (!provider || !provider.isConfigured()) return null;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 110000);
      try {
        const res = await collectUpstream(await provider.executeCompletion(cand.modelId, probePrompt, ctrl.signal));
        const passed = /\b451\b/.test(res.content.trim());
        const verifiedMultiplier = passed ? 1.0 : 0.55;

        await recordTupleSuccess(cand.tupleId, res.ttftMs, res.totalMs, res.estTokens);
        await atomicUpdateModel(cand.tupleId, (r) => ({
          ...r,
          iq_verified: verifiedMultiplier,
          last_probed: Date.now(),
        }));

        return {
          tupleId: cand.tupleId,
          passed,
          ttftMs: res.ttftMs,
          hasReasoning: Boolean(res.reasoningContent),
          answer: res.content.trim().slice(0, 80),
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Probe failed";
        await recordTupleFailure(cand.tupleId, msg);
        if (e && typeof e === "object") (e as { tupleId?: string }).tupleId = cand.tupleId;
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

// Long-tail resurrection: most of the catalog sits at success_count == 0
// (never proven) or has been unprobed for a day or more, and the head
// canary only ever re-tests the top 4. This prober walks the tail --
// least-recently-probed first -- and promotes anything that answers, so
// the pool of proven choices keeps growing instead of the same head
// failing forever.
async function runResurrectionProbe(
  limit: number = 6,
): Promise<Array<{ tupleId: string; ok: boolean; passed?: boolean; error?: string }>> {
  const catalog = await hydrateL1Cache(false);
  await ensureCatalogSynced(false);
  const now = Date.now();
  const tail = [...catalog.values()]
    .filter((r) => r.success_count === 0 || (r.last_probed ?? 0) < now - 24 * 3600_000)
    .sort((a, b) => (a.last_probed ?? 0) - (b.last_probed ?? 0))
    .slice(0, Math.max(1, Math.min(16, limit)));

  const probePrompt = [
    {
      role: "user",
      content: "Compute (23 * 19) + 14. Reply ONLY with the exact integer and nothing else.",
    },
  ];
  const results: Array<{ tupleId: string; ok: boolean; passed?: boolean; error?: string }> = [];

  for (const r of tail) {
    const provider = await resolveProviderById(r.provider_id);
    if (!provider || !provider.isConfigured()) {
      results.push({ tupleId: r.tuple_id, ok: false, error: "provider unavailable" });
      continue;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await collectUpstream(await provider.executeCompletion(r.model_id, probePrompt, ctrl.signal));
      const passed = /\b451\b/.test(res.content.trim());
      await recordTupleSuccess(r.tuple_id, res.ttftMs, res.totalMs, res.estTokens);
      await atomicUpdateModel(r.tuple_id, (rec) => ({
        ...rec,
        iq_verified: passed ? 1.0 : 0.55,
        last_probed: Date.now(),
      }));
      results.push({ tupleId: r.tuple_id, ok: true, passed });
      console.log(`[resurrect] ${r.tuple_id} answered (canary ${passed ? "PASS" : "wrong answer"}) -- promoted`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Probe failed";
      await recordTupleFailure(r.tuple_id, msg).catch(() => {});
      await atomicUpdateModel(r.tuple_id, (rec) => ({ ...rec, last_probed: Date.now() })).catch(() => {});
      results.push({ tupleId: r.tuple_id, ok: false, error: msg.slice(0, 120) });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

// ============================================================================
// 7b. ADAPTIVE HEDGED FIRST-TOKEN DISPATCH (ASCK v1 / TAIL-AT-SCALE)
// ============================================================================

// TTFT is modelled log-normal with a Kalman posterior mean/variance. hedgePlan()
// solves the survival-based stopping rule: with k spare endpoints, hedge at the
// (1 - θ0^(1/(1+η·ln(1+k)))) quantile; kill at the p99.9 predictive quantile.
// Tiers 1-3 are staggered hedges; tier 4 (exhaustive sweep) bursts every
// configured endpoint at once with a short, bounded first-token deadline.
interface HedgePolicy {
  maxInflight: number;
  tailProbability: number;
  hedgeMinMs: number;
  hedgeMaxMs: number;
  killFloorMs: number;
  killCeilMs: number;
  burst: boolean;
}

const HEDGE: Record<RoutingMode, HedgePolicy> = {
  fast: { maxInflight: 4, tailProbability: 0.20, hedgeMinMs: 120, hedgeMaxMs: 8_000, killFloorMs: 4_000, killCeilMs: 300_000, burst: false },
  code: { maxInflight: 3, tailProbability: 0.10, hedgeMinMs: 150, hedgeMaxMs: 8_000, killFloorMs: 25_000, killCeilMs: 300_000, burst: false },
  smart: { maxInflight: 3, tailProbability: 0.10, hedgeMinMs: 150, hedgeMaxMs: 8_000, killFloorMs: 25_000, killCeilMs: 300_000, burst: false },
  reasoning: { maxInflight: 3, tailProbability: 0.05, hedgeMinMs: 200, hedgeMaxMs: 8_000, killFloorMs: 90_000, killCeilMs: 300_000, burst: false },
};

// Tier 2: widen across lanes with more concurrency and a tighter deadline.
const ESCALATION_POLICY: HedgePolicy = {
  maxInflight: 6,
  tailProbability: 0.25,
  hedgeMinMs: 120,
  hedgeMaxMs: 3_000,
  killFloorMs: 10_000,
  killCeilMs: 30_000,
  burst: false,
};

// Tier 3: burst the whole catalog with a hard, short first-token deadline.
const WIDE_POLICY: HedgePolicy = {
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
const SWEEP_POLICY: HedgePolicy = {
  maxInflight: 128,
  tailProbability: 0.45,
  hedgeMinMs: 60,
  hedgeMaxMs: 1_000,
  killFloorMs: 6_000,
  killCeilMs: 15_000,
  burst: true,
};

/** Portable AbortSignal.any: a tier can be cut without killing the request. */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  a.addEventListener("abort", () => ctrl.abort(a.reason), { once: true });
  b.addEventListener("abort", () => ctrl.abort(b.reason), { once: true });
  return ctrl.signal;
}

const logErr = (e: unknown) => console.error("telemetry:", e);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Dispatched {
  cand: ScoredCandidate;
  up: UpstreamStream;
}

async function hedgedDispatch(
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

const VALID_ROLES = new Set(["system", "user", "assistant", "tool", "developer", "function"]);

function normalizeMessages(raw: unknown, promptFallback?: unknown): Array<{ role: string; content: unknown }> {
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

function degradationMessage(attempts: number, endpoints: number, lastErr: string): string {
  const tail = lastErr ? ` Last upstream error: ${lastErr.slice(0, 160)}.` : "";
  return `[nokey-router] No upstream model endpoint returned a valid completion for this request. ` +
    `All ${endpoints} configured endpoints were attempted (${attempts} dispatch attempts, including ` +
    `cross-lane fallbacks, protocol negotiation and a full endpoint sweep).${tail} ` +
    `No answer was fabricated — please retry shortly. GET /health and GET /v1/endpoints show live coverage.`;
}

interface DegradedOpts {
  id: string;
  created: number;
  requestedModel: string;
  attempts: number;
  endpoints: number;
  lastErr: string;
  stream: boolean;
  traceId: string;
}

function degradedMeta(o: DegradedOpts) {
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
function degradedSse(o: DegradedOpts): string {
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

const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive" };

function degradedCompletion(c: Context, o: DegradedOpts, headers: Record<string, string>): Response {
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

const honoApp = new Hono();
honoApp.use("*", cors({ origin: "*", exposeHeaders: ["traceparent", "Server-Timing", "X-Nokey-Attempts", "X-Nokey-Endpoints", "X-Nokey-Degraded"] }));
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
    if (!token || !timingSafeCompare(token, requiredKey)) {
      return c.json({ error: { message: "Unauthorized: Invalid ROUTER_API_KEY" } }, 401);
    }
  }
  await next();
});

const requireAdmin: MiddlewareHandler = async (c, next) => {
  const adminSecret = Deno.env.get("ADMIN_SECRET");
  if (adminSecret) {
    const provided = c.req.header("x-admin-secret") || "";
    if (!provided || !timingSafeCompare(provided, adminSecret)) {
      return c.json({ error: { message: "Forbidden: Invalid x-admin-secret" } }, 403);
    }
  }
  await next();
};

// Isolate-local trace ring (Deno Deploy's OTel view aggregates all isolates).
honoApp.get("/v1/traces", requireAdmin, (c) => {
  const limit = Math.round(clampNum(Number(c.req.query("limit")) || 100, 1, 256));
  return c.json({ object: "list", data: listTraces(limit) });
});

// Live tail: every span start/event/end as SSE. fetch()-readable (EventSource cannot send auth headers).
honoApp.get("/v1/traces/live", requireAdmin, (c) => {
  const enc = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (s: string) => {
        try {
          ctrl.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      send(": live\n\n");
      const unsubscribe = subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`));
      const hb = setInterval(() => send(": hb\n\n"), 15_000);
      stop = () => {
        clearInterval(hb);
        unsubscribe();
      };
      c.req.raw.signal.addEventListener("abort", () => {
        stop();
        try {
          ctrl.close();
        } catch { /* already closed */ }
      }, { once: true });
    },
    cancel: () => stop(),
  });
  return new Response(body, { headers: SSE_HEADERS });
});

honoApp.get("/v1/traces/:id", requireAdmin, (c) => {
  const t = getTrace(c.req.param("id"));
  return t ? c.json(t) : c.json({ error: { message: "Trace not in this isolate's ring" } }, 404);
});

honoApp.get("/", (_c) => {
        return new Response(loadTextFile("index.html"), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
});
// The workspace at / absorbed the standalone admin page; old links land on its Lanes view.
honoApp.get("/admin", (c) => c.redirect("/#lanes", 301));

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
honoApp.get("/health", async (c) => {
  const safeRank = async (m: RoutingMode) => {
    try {
      return (await getRankedCandidates(m, true)).slice(0, 5);
    } catch (err) {
      console.error(`health rank ${m}:`, err);
      return [];
    }
  };
  // Rank first (this hydrates the catalog on a cold isolate), then report
  // coverage so /health never shows an artificially empty catalog.
  const fastRank = await safeRank("fast");
  const smartRank = await safeRank("smart");
  const codeRank = await safeRank("code");
  const reasoningRank = await safeRank("reasoning");
  const coverage = await endpointCoverage().catch((err) => {
    console.error("health coverage:", err);
    return { configured_endpoints: 0, registry_endpoints: 0, catalog_tuples: L1_CACHE.size, sweep_candidates: 0 };
  });
  return c.json({
    engine: "nokey-sovereign-v6-asck1-exhaustive",
    runtime: "deno-deploy-kv-cas-l1",
    control_kernel: {
      name: "ASCK v1",
      ttft_model: "log-normal + scalar Kalman filter",
      reliability: "discounted Thompson sampling (6h half-life)",
      exploration: "UCB + Wilson lower bound + Gumbel/Plackett-Luce",
      hedging: "survival-quantile optimal stopping (tail-at-scale)",
      dispatch_tiers: ["mode-ranked", "cross-lane-proven", "full-catalog", "exhaustive-endpoint-sweep"],
      request_guarantee: "always 200; graceful degraded completion after full sweep",
      strict_errors: Deno.env.get("NOKEY_STRICT_ERRORS") === "1",
    },
    security: {
      auth_enabled: Boolean(Deno.env.get("ROUTER_API_KEY")),
      admin_guard_enabled: Boolean(Deno.env.get("ADMIN_SECRET")),
      openrouter_free_enabled: Boolean(pickOpenRouterKey()),
      l1_cache_entries: L1_CACHE.size,
      service_json_load_error: serviceJsonLoadError,
    },
    coverage: {
      configured_endpoints: coverage.configured_endpoints,
      registry_endpoints: coverage.registry_endpoints,
      catalog_tuples: coverage.catalog_tuples,
      sweep_candidates: coverage.sweep_candidates,
    },
    current_best_fast: fastRank,
    current_best_smart: smartRank,
    current_best_code: codeRank,
    current_best_reasoning: reasoningRank,
  });
});

// Live, dependency-free view of exactly what the exhaustive sweep will try.
honoApp.get("/v1/endpoints", async (c) => {
  try {
    const coverage = await endpointCoverage();
    return c.json({
      object: "list",
      policy: "every configured endpoint is attempted before a request can degrade",
      configured_endpoints: coverage.configured_endpoints,
      registry_endpoints: coverage.registry_endpoints,
      catalog_tuples: coverage.catalog_tuples,
      sweep_candidates: coverage.sweep_candidates,
      data: coverage.endpoints,
    });
  } catch (err) {
    return c.json({ object: "list", data: [], error: errText(err) }, 200);
  }
});

honoApp.get("/v1/models", async (c) => {
  const ranked = await getRankedCandidates("smart", true).catch((err) => {
    console.error("models ranking:", err);
    return [];
  });
  // Any model id is accepted by the chat route; advertise that explicitly.
  const virtualAliases = [
    "free:auto",
    "free:fast",
    "free:smart",
    "free:code",
    "free:reasoning",
  ].map((id) => ({
    id,
    object: "model",
    created: 1761523200,
    owned_by: "vajra-mesh-router",
  }));

  const discoveredModels = ranked.map((m) => ({
    id: m.modelId,
    tuple_id: m.tupleId,
    object: "model",
    created: 1761523200,
    owned_by: m.providerId,
    iq_effective: m.iqEffective,
    supports_reasoning: m.supportsReasoning,
    supports_vision: m.supportsVision,
    is_coding_specialist: m.isCodingSpecialist,
    context_window: m.contextWindow,
  }));

  const imageModels = IMAGE_MODELS.map((img) => ({
    id: img.id,
    object: "model",
    created: 1761523200,
    owned_by: "nokey-image",
  }));

  return c.json({
    object: "list",
    accepts_any_model: true,
    model_policy: "unknown model ids are routed by trigram/Jaccard similarity and fall back to the exhaustive endpoint sweep",
    data: [...virtualAliases, ...imageModels, ...discoveredModels],
  });
});

honoApp.post("/v1/probe", requireAdmin, async (c) => {
  const probeResults = await runCanaryProbeOnTopCandidates(4);
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
  return c.json({ status: "probe_complete", results });
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

// System source reader: lets the dashboard's Architect agent read the
// code it operates on. Allowlisted files only, admin-guarded like /v1/probe.
honoApp.get("/v1/source", requireAdmin, (c) => {
  const file = c.req.query("file") || "";
  const ALLOWED = new Set(["main.ts", "math.ts", "trace.ts", "index.html", "openapi.json", "CHANGES.md", "services.json", "deno.json"]);
  if (!ALLOWED.has(file)) {
    return c.json({ error: { message: "File is not in the readable allowlist" } }, 400);
  }
  const content = loadTextFile(file);
  if (content === null) {
    return c.json({ error: { message: `File not readable in this deployment: ${file}` } }, 404);
  }
  return c.json({ file, bytes: content.length, lines: content.split("\n").length, content });
});

// Comment frames keep proxies and clients alive while the race is still routing.
const HEARTBEAT_MS = 5_000;

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
    const messages = normalizeMessages(body.messages, body.prompt);
    reqModel = String(body.model || "free:auto");
    const reqModelLower = reqModel.toLowerCase();
    wantsStream = Boolean(body.stream);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
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
      tools: hasTools ? (body.tools as unknown[]) : undefined,
      tool_choice: body.tool_choice,
      parallel_tool_calls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
      reasoning: body.reasoning,
      response_format: body.response_format,
    };

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
      tools: hasTools ? (body.tools as unknown[]).length : 0,
      parallel_tool_calls: completionOptions.parallel_tool_calls,
      vision: hasVisionPayload,
      endpoints: endpointsAvailable,
    });

    const safeRanked = async (m: RoutingMode, o: RankOptions = {}): Promise<ScoredCandidate[]> => {
      try {
        return await getRankedCandidates(m, false, false, o);
      } catch (err) {
        console.error(`[rank] ${m} ranking failed:`, err);
        return [];
      }
    };

    const rankSpan = root.child("rank", { mode });
    let ranked = await safeRanked(mode, {});
    // Vision lanes must not filter themselves into an empty pool.
    if (ranked.length === 0 && hasVisionPayload) ranked = await getRankedCandidates(mode, false, hasVisionPayload).catch(() => []);
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

    if (!wantsStream) {
      try {
        // A generation that dies after its first token re-dispatches once over the untried pool.
        for (let round = 0; round < 2; round++) {
          const { cand, up } = await dispatch();
          try {
            const res = await collectUpstream(up);
            recordTupleSuccess(cand.tupleId, res.ttftMs, res.totalMs, res.estTokens).catch(logErr);
            root.end("ok", {
              tuple: cand.tupleId,
              provider: cand.providerId,
              ttft_ms: res.ttftMs,
              total_ms: res.totalMs,
              attempts: tried.size,
              finish: res.finish ?? (res.toolCalls ? "tool_calls" : "stop"),
              tool_calls: res.toolCalls?.length ?? 0,
              content_chars: res.content.length,
              reasoning_chars: res.reasoningContent?.length ?? 0,
            });
            return c.json({
              id: completionId,
              object: "chat.completion",
              created,
              model: cand.modelId,
              provider: cand.providerId,
              nokey: meta(cand),
              telemetry: {
                mode_selected: mode,
                iq_effective: cand.iqEffective,
                supports_reasoning: cand.supportsReasoning,
                is_coding_specialist: cand.isCodingSpecialist,
                reliability_draw: cand.reliabilityDraw,
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
            });
          } catch (e) {
            if (master.signal.aborted) break;
            lastErr = e;
            root.event("generation_failed", { tuple: cand.tupleId, error: errText(e).slice(0, 200) });
            recordTupleFailure(cand.tupleId, errText(e)).catch(logErr);
          }
        }
        throw lastErr ?? new Error("No endpoint completed a full generation");
      } finally {
        clearTimeout(globalTimeout);
      }
    }

    // Headers leave immediately; routing proceeds behind heartbeat comments and the
    // committed winner is piped token-by-token (post-commit failover is impossible).
    const sse = async function* (): AsyncGenerator<string> {
      let ok = false;
      try {
        yield `: trace ${root.traceId}\n\n`;
        const settled = dispatch().then((v) => ({ v }), (e: unknown) => ({ e }));
        let r: { v: Dispatched } | { e: unknown } | undefined;
        while (true) {
          let hb: ReturnType<typeof setTimeout> | undefined;
          r = await Promise.race([settled, new Promise<undefined>((res) => hb = setTimeout(() => res(undefined), HEARTBEAT_MS))]);
          clearTimeout(hb);
          if (r) break;
          yield `: routing attempts=${tried.size}\n\n`;
        }
        if ("e" in r) {
          endDegraded(r.e);
          ok = true;
          if (Deno.env.get("NOKEY_STRICT_ERRORS") === "1") {
            yield `data: ${JSON.stringify({ error: { message: errText(r.e) } })}\n\ndata: [DONE]\n\n`;
          } else {
            yield degradedSse(degradedOpts(r.e));
          }
          return;
        }
        const { cand, up } = r.v;
        root.event("first_token", { tuple: cand.tupleId, ttft_ms: up.ttftMs });
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
        let first = true;
        const toolCalls = new Set<number>();
        let contentChars = 0;
        let reasoning = "";
        let finish: string | undefined;
        const wire = (d: Delta): string | null => {
          const out: Record<string, unknown> = {};
          if (d.reasoning) out.reasoning_content = d.reasoning;
          if (d.content) out.content = d.content;
          if (d.toolCalls) {
            out.tool_calls = d.toolCalls;
            for (const t of d.toolCalls) toolCalls.add(t.index);
          }
          contentChars += d.content?.trim() ? d.content.length : 0;
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
          // Salvage parity with the buffered path: a reasoning-only stream also surfaces as content.
          if (!contentChars && !toolCalls.size && reasoning.trim()) yield chunk({ content: reasoning.trim() }, null);
          ok = true;
          const fin = finish ?? (toolCalls.size ? "tool_calls" : "stop");
          yield chunk({}, fin, { nokey: meta(cand) });
          const totalMs = Math.max(up.ttftMs + 1, Math.round(performance.now() - up.t0));
          recordTupleSuccess(cand.tupleId, up.ttftMs, totalMs, Math.max(1, Math.ceil((contentChars + reasoning.length) / 4))).catch(logErr);
          root.end("ok", {
            tuple: cand.tupleId,
            provider: cand.providerId,
            ttft_ms: up.ttftMs,
            total_ms: totalMs,
            attempts: tried.size,
            finish: fin,
            tool_calls: toolCalls.size,
            content_chars: contentChars,
            reasoning_chars: reasoning.length,
          });
        } catch (e) {
          if (!master.signal.aborted) recordTupleFailure(cand.tupleId, errText(e)).catch(logErr);
          root.end("error", { tuple: cand.tupleId, error: errText(e).slice(0, 300), content_chars: contentChars });
          yield `data: ${JSON.stringify({ error: { message: errText(e) } })}\n\n`;
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

    return new Response(ReadableStream.from(sse()).pipeThrough(new TextEncoderStream()), {
      headers: { ...SSE_HEADERS, ...traceHeaders, "X-Nokey-Endpoints": String(endpointsAvailable) },
    });
  } catch (err: unknown) {
    clearTimeout(globalTimeout);
    endDegraded(err);
    // Opt-out for operators who prefer the legacy hard failure while debugging.
    if (Deno.env.get("NOKEY_STRICT_ERRORS") === "1") {
      return c.json({ error: { message: errText(err) } }, 502, traceHeaders);
    }
    return degradedCompletion(c, degradedOpts(err), traceHeaders);
  }
});

// ============================================================================
// IMAGE GENERATION -- OpenAI-compatible POST /v1/images/generations
// Keyless upstreams only: Pollinations image API (primary) and the AI Horde
// anonymous pool (fallback / explicit). Model ids:
//   nokey-image       -> Pollinations "turbo" (fast)
//   nokey-image-flux  -> Pollinations "flux" (higher quality, slower)
//   nokey-image-horde -> AI Horde stable_diffusion (anonymous key)
// Response follows the OpenAI shape: { created, data: [{ url } | { b64_json }] }
// ============================================================================

const IMAGE_MODELS = [
  { id: "nokey-image", provider: "pollinations", upstreamModel: "turbo" },
  { id: "nokey-image-flux", provider: "pollinations", upstreamModel: "flux" },
  { id: "nokey-image-horde", provider: "horde", upstreamModel: "stable_diffusion" },
];

function parseImageSize(size: unknown): { width: number; height: number } {
  switch (String(size || "1024x1024")) {
    case "512x512": return { width: 512, height: 512 };
    case "1024x1024": return { width: 1024, height: 1024 };
    case "1024x576": return { width: 1024, height: 576 };
    case "576x1024": return { width: 576, height: 1024 };
    case "1792x1024": return { width: 1792, height: 1024 };
    case "1024x1792": return { width: 1024, height: 1792 };
    default: return { width: 1024, height: 1024 };
  }
}

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function generateViaPollinations(
  prompt: string,
  width: number,
  height: number,
  upstreamModel: string,
  seed: number,
): Promise<string> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&seed=${seed}&model=${upstreamModel}&nologo=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Pollinations image HTTP ${res.status}`);
  // Drain the body so the generation completes server-side; the returned URL
  // is seed-stable, so the client fetch renders the same image. A JSON/text
  // error page or a tiny body is NOT an image and must fall through to the
  // next backend rather than being reported as a successful generation.
  const buf = await res.arrayBuffer();
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("json") || contentType.includes("text/html") || buf.byteLength < 512) {
    throw new Error(`Pollinations returned a non-image body (${contentType || "no content-type"}, ${buf.byteLength} bytes)`);
  }
  return url;
}

async function generateViaHorde(prompt: string, width: number, height: number, budgetMs = 45000): Promise<string> {
  const submit = await fetch("https://stablehorde.net/api/v2/generate/async", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: "0000000000" },
    body: JSON.stringify({
      prompt,
      params: { width, height, steps: 20, sampler_name: "k_euler", cfg_scale: 7, n: 1 },
      models: ["stable_diffusion"],
      slow_workers: true,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!submit.ok) throw new Error(`AI Horde submit HTTP ${submit.status}`);
  const job = await submit.json();
  const jobId = String(job.id || "");
  if (!jobId) throw new Error("AI Horde submit returned no job id");
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const chkRes = await fetch(`https://stablehorde.net/api/v2/generate/check/${jobId}`, {
      signal: AbortSignal.timeout(15000),
    });
    const chk = await chkRes.json();
    if (chk.faulted) throw new Error("AI Horde job faulted");
    if (chk.done) {
      const stRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${jobId}`, {
        signal: AbortSignal.timeout(15000),
      });
      const st = await stRes.json();
      const img = st?.generations?.[0]?.img;
      if (img) return String(img);
      throw new Error("AI Horde finished without an image");
    }
  }
  throw new Error("AI Horde generation timed out");
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch] ?? ch));
}

/** Honest, locally generated SVG placeholder: keeps the OpenAI image contract
 *  valid when every keyless image backend is down, without faking model art. */
function placeholderImage(prompt: string, model: string, width: number, height: number, errors: string[]): {
  url: string;
  b64: string;
} {
  const title = "Image providers unavailable";
  const lines = [
    `Requested model: ${model}`,
    `Tried ${errors.length} backend variant(s); none returned an image.`,
    "No artwork was fabricated. Please retry shortly.",
  ];
  const text = lines.map((l, i) =>
    `<text x="64" y="${height / 2 + i * 34 - 34}" fill="#e2e8f0" font-family="monospace" font-size="22">${escapeXml(l)}</text>`
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="#0b1120"/>` +
    `<rect x="24" y="24" width="${width - 48}" height="${height - 48}" fill="none" stroke="#22d3ee" stroke-width="2"/>` +
    `<text x="64" y="${height / 2 - 90}" fill="#22d3ee" font-family="monospace" font-size="30">${escapeXml(title)}</text>` +
    text +
    `<text x="64" y="${height - 64}" fill="#64748b" font-family="monospace" font-size="18">${escapeXml(prompt.slice(0, 90))}</text>` +
    `</svg>`;
  const b64 = bytesToBase64(new TextEncoder().encode(svg).buffer as ArrayBuffer);
  return { url: `data:image/svg+xml;base64,${b64}`, b64 };
}

honoApp.post("/v1/images/generations", async (c) => {
  const body = await c.req.json().catch(() => ({} as Json)) as Json;
  const prompt = String(body.prompt || "").trim() || "abstract geometric composition";
  const requestedModel = String(body.model || "nokey-image");
  const spec = IMAGE_MODELS.find((img) => img.id === requestedModel) || IMAGE_MODELS[0];
  const { width, height } = parseImageSize(body.size);
  const n = Math.round(clampNum(Number(body.n || 1) || 1, 1, 4));
  const wantB64 = String(body.response_format || "url") === "b64_json";
  const root = startTrace("images.generations", { "model.requested": requestedModel, n, width, height, b64: wantB64 }, c.req.header("traceparent"));

  // Every available backend is tried, in "requested model first" order, for
  // ANY requested model id. Only a locally generated placeholder can end the
  // request — it never errors out.
  const chain = [spec, ...IMAGE_MODELS.filter((m) => m.id !== spec.id)];
  const errors: string[] = [];
  const data: Array<{ url?: string; b64_json?: string }> = [];
  let degraded = false;

  for (let i = 0; i < n; i++) {
    let url: string | null = null;
    for (const variant of chain) {
      const attempt = root.child("attempt", { backend: variant.id, provider: variant.provider, image: i });
      try {
        if (variant.provider === "horde") {
          url = await attempt.run(() => generateViaHorde(prompt, width, height));
        } else {
          const seed = Math.floor(Math.random() * 1000000) + i;
          url = await attempt.run(() => generateViaPollinations(prompt, width, height, variant.upstreamModel, seed));
        }
        attempt.end("ok", { outcome: "won" });
        break;
      } catch (err) {
        attempt.end("error", { outcome: "failed", error: errText(err).slice(0, 200) });
        errors.push(`${variant.id}: ${errText(err)}`);
        console.warn(`[image] ${variant.id} failed: ${errText(err)}`);
      }
    }
    if (!url) {
      degraded = true;
      const placeholder = placeholderImage(prompt, requestedModel, width, height, errors);
      if (wantB64) data.push({ b64_json: placeholder.b64 });
      else data.push({ url: placeholder.url });
      continue;
    }
    if (wantB64) {
      try {
        if (url.startsWith("data:")) {
          data.push({ b64_json: url.split(",")[1] ?? "" });
        } else {
          const imgRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (!imgRes.ok) throw new Error(`Image fetch HTTP ${imgRes.status}`);
          data.push({ b64_json: bytesToBase64(await imgRes.arrayBuffer()) });
        }
      } catch (err) {
        errors.push(`image-fetch: ${errText(err)}`);
        degraded = true;
        data.push({ b64_json: placeholderImage(prompt, requestedModel, width, height, errors).b64 });
      }
    } else {
      data.push({ url });
    }
  }

  root.end(degraded ? "error" : "ok", { degraded, images: data.length, backend_errors: errors.length });
  return c.json({
    created: Math.floor(Date.now() / 1000),
    data,
    nokey: {
      degraded,
      requested_model: requestedModel,
      backends_tried: errors.length + data.length,
      errors: errors.slice(0, 8),
      trace_id: root.traceId,
    },
  }, 200, {
    traceparent: root.traceparent,
    "Server-Timing": `total;dur=${Math.round(root.ms)}`,
    ...(degraded ? { "X-Nokey-Degraded": "1" } : {}),
  });
});

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
  Deno.serve(app.fetch);
}

export { app };
export default {
  fetch: app.fetch,
};