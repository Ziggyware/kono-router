// engine/providers.ts — providers subsystem, partitioned from engine.ts (originally main.ts).

import { serviceJsonProviders, IMAGE_CATALOG, perEndpointSyncGate, hydrateL1Cache, ensureCatalogSynced, PROVIDER_BREAKER, hydrateLearning, providerModelHints, loadServiceJsonRegistry } from "../main.ts";
import type { ProviderSpec, CompletionOptions, ServiceJsonRegistry, ServiceJsonEndpoint, MeshModelRecord, ScoredCandidate, RoutingMode, RankOptions } from "../main.ts";
import { isEndpointConfigured, buildRotatedHeaders } from "../util.ts";
import { kv, L1_CACHE, UNIVERSAL_MODEL_ALIAS } from "../state.ts";
import { posteriorLowerBound } from "../learning.ts";
import type { TaskClass } from "../learning.ts";
import { clamp as clampNum, predictiveSigma, discountedPosterior, wilsonLowerBound, sampleBeta, ucbBonus, gumbelNoise } from "../math.ts";
import { toolRoutingBonus, tupleToolCompetence } from "../tools.ts";
import { SERVICE_JSON_FILE, pickOpenRouterKey, KV_PREFIX, atomicUpdateModel } from "./core.ts";
import { openUpstreamAdaptive, collectUpstream } from "./dispatch.ts";
import { contextualPosterior, recordTupleSuccess, recordTupleFailure } from "./learning.ts";





// ============================================================================
// 3. VERIFIED OCT-2026 CAPABILITY PARSER & SHANNON ENTROPY POISON GUARD
// ============================================================================

export interface ModelCapabilityProfile {
  iqPrior: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  isCodingSpecialist: boolean;
}





export function analyzeModelCapabilities(modelId: string, contextLength: number = 128000): ModelCapabilityProfile {
  const m = modelId.toLowerCase();

  // Exclude non-chat, moderation/guardrail, audio-only, image-gen, and embedding endpoints
  // Note: nvidia/nemotron-3.5-content-safety:free is a guardrail moderation classifier, not a general chat LLM
  if (
    /embed|bge-|e5-|whisper|tts|kokoro|flux|sdxl|stable-diffusion|\bsd3|dall-e|gpt-image|imagen|veo-|bria|recraft|ideogram|kandinsky|hidream|seedream|seededit|cogview|qwen-image|playground-v|kling|hunyuan-video|ltx-video|wan-?2|moderation|guard|content-safety|rerank|suno|udio|respan/i
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

  // Code-tuned models only: strong generalists rank on IQ, and flagging them
  // here erased the code lane's difference from the smart lane.
  const isCodingSpecialist =
    /laguna|north-mini-code|flint|coder|codestral|devstral|codex|starcoder|codegemma|code-?llama|-code\b/i
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





// ============================================================================
// 5. LIVE UPSTREAM MODEL CATALOG DISCOVERY ADAPTERS (INCL. OPENROUTER :free)
// ============================================================================

export async function serviceJsonProviderList(): Promise<ProviderSpec[]> {
  try {
    return await serviceJsonProviders();
  } catch (err) {
    console.error("service-json provider load promise rejected:", err);
    return [];
  }
}





export function buildOptionalParams(options?: CompletionOptions): Record<string, unknown> {
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
export const OPENROUTER_OCT2026_FREE_FALLBACK: Array<{ id: string; context: number }> = [
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





// Schema-guarded registry parser. Only accepts {"endpoints": [...]} payloads
// where every endpoint tuple carries the fields required to build a ProviderSpec.
export function parseServiceJsonRegistry(raw: string): ServiceJsonRegistry | null {
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





export function isFileReadable(path: string): boolean {
  try {
    const stat = Deno.statSync(path);
    return stat.isFile;
  } catch {
    return false;
  }
}





export function loadTextFile(path: string): string | null {
  if (!isFileReadable(path)) return null;
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}





export async function discoverServiceJsonPath(): Promise<string | null> {
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





export function buildProviderIdFromEndpointName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  if (!normalized) return "services_json_endpoint";
  return "services_json_" + normalized;
}





export function authHeadersForEndpoint(endpoint: ServiceJsonEndpoint): Record<string, string> {
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





export function validateServiceJsonProvider(endpoint: ServiceJsonEndpoint): string | null {
  if (!isEndpointConfigured(endpoint)) return "endpoint-not-configured";
  if (!endpoint.name.trim()) return "endpoint-name-empty";
  if (!endpoint.url.trim()) return "endpoint-url-empty";
  if (endpoint.url.trim().length > 4096) return "endpoint-url-too-long";
  if (endpoint.baseUrl && !/^https?:\/\//i.test(endpoint.baseUrl)) return "endpoint-baseurl-malformed";
  if (endpoint.modelsUrl && !/^https?:\/\//i.test(endpoint.modelsUrl)) return "endpoint-modelsurl-malformed";
  if (endpoint.authHeader && endpoint.authHeader.trim().length > 2048) return "endpoint-auth-header-too-long";
  return null;
}





export function makeServiceJsonProvider(endpoint: ServiceJsonEndpoint, validationError?: string | null): ProviderSpec {
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
    ...(/\/chat\/completions\/?$/.test(chatUrl) ? { imagesUrl: chatUrl.replace(/\/chat\/completions\/?$/, "/images/generations"), imageHeaders: headers } : {}),
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





export const PROVIDERS: ProviderSpec[] = [
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





export async function activeProviderList(): Promise<ProviderSpec[]> {
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
export async function resolveProviderById(providerId: string): Promise<ProviderSpec | undefined> {
  const native = PROVIDERS.find((p) => p.id === providerId);
  if (native) return native;
  const extra = await serviceJsonProviderList();
  return extra.find((p) => p.id === providerId);
}



export interface SyncProviderTask {
  provider: ProviderSpec;
  last: number;
  force: boolean;
}





export async function runSyncProviderTask(task: SyncProviderTask): Promise<void> {
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
    if (provider.imagesUrl) {
      const images = discovered.map((m) => m.id).filter(isImageModelId);
      IMAGE_CATALOG.set(provider.id, images);
      await kv.set([IMAGE_KV_PREFIX, provider.id], images);
    }

    const modelTasks = discovered.map(async (item) => {
      const ctxWindow = item.context || 128000;
      const profile = analyzeModelCapabilities(item.id, ctxWindow);
      const tupleId = `${provider.id}::${item.id}`;
      const modelKey = [KV_PREFIX, tupleId];
      // Non-chat models (image, audio, embeddings) never rank; one catalogued
      // before the exclusion list caught it is evicted on the next sync.
      if (profile.iqPrior <= 0.0) {
        if (L1_CACHE.has(tupleId)) { L1_CACHE.delete(tupleId); await kv.delete(modelKey); }
        return;
      }
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





export async function runCatalogSyncBody(force: boolean = false): Promise<void> {

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





export function syntheticRecord(providerId: string, modelId: string): MeshModelRecord {
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





// Compact coverage report for /health, /v1/endpoints and the dashboard.
export async function endpointCoverage(): Promise<{
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





export async function runCanaryProbeOnTopCandidates(limit: number = 4, mode: RoutingMode = "smart") {
  const topSmart = (await getRankedCandidates(mode, true)).slice(0, limit);
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
export async function runResurrectionProbe(
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





// ---- OpenAI-standard image backends ----------------------------------------
// Discovery already lists image models on configured providers (flux, sdxl,
// gpt-image, seedream…). Each one is a candidate for POST {v1}/images/generations,
// the de-facto standard across OpenAI-compatible gateways. Ordering is a
// Laplace-smoothed success rate learned per (provider, model) in this isolate.
export const IMAGE_KV_PREFIX = "nokey_images";




export const IMAGE_MODEL_RE = /flux|sdxl|stable-diffusion|\bsd-?3|dall-e|gpt-image|imagen|bria|recraft|ideogram|kandinsky|hidream|seedream|cogview|qwen-image|playground-v|midjourney|janus-pro|\bimage(?!-to-text|-?2-?text)\b/i;




export function isImageModelId(id: string): boolean {
  return IMAGE_MODEL_RE.test(id) && !/vision|\bvl\b|-vl-|caption|embed/i.test(id);
}




export async function hydrateImageCatalog(): Promise<void> {
  if (IMAGE_CATALOG.size) return;
  for await (const e of kv.list<string[]>({ prefix: [IMAGE_KV_PREFIX] })) {
    if (Array.isArray(e.value)) IMAGE_CATALOG.set(String(e.key[1]), e.value);
  }
}
