// engine/providers.ts — providers subsystem, partitioned from engine.ts (originally main.ts).
// Capability analysis lives in ./capabilities.ts, the service-JSON registry
// machinery in ./registry.ts, and candidate scoring/ranking in ./ranking.ts;
// every moved name is re-exported below so existing importers are untouched.

import { IMAGE_CATALOG, perEndpointSyncGate, hydrateL1Cache, ensureCatalogSynced, PROVIDER_BREAKER, hydrateLearning, providerModelHints, loadServiceJsonRegistry } from "../main.ts";
import type { ProviderSpec, MeshModelRecord, ScoredCandidate, RoutingMode, RankOptions } from "../main.ts";
import { kv, L1_CACHE, UNIVERSAL_MODEL_ALIAS } from "../state.ts";
import { clamp as clampNum } from "../math.ts";
import { pickOpenRouterKey, KV_PREFIX, atomicUpdateModel } from "./core.ts";
import { openUpstreamAdaptive, collectUpstream } from "./dispatch.ts";
import { recordTupleSuccess, recordTupleFailure } from "./learning.ts";
import { analyzeModelCapabilities } from "./capabilities.ts";
import { serviceJsonProviderList, buildOptionalParams, OPENROUTER_OCT2026_FREE_FALLBACK, buildProviderIdFromEndpointName } from "./registry.ts";
import { interleaveByProvider, scoreRecord, totalCatalogPulls } from "./ranking.ts";

export { analyzeModelCapabilities } from "./capabilities.ts";
export type { ModelCapabilityProfile } from "./capabilities.ts";
export { serviceJsonProviderList, buildOptionalParams, OPENROUTER_OCT2026_FREE_FALLBACK, parseServiceJsonRegistry, isFileReadable, loadTextFile, discoverServiceJsonPath, buildProviderIdFromEndpointName, authHeadersForEndpoint, validateServiceJsonProvider, makeServiceJsonProvider } from "./registry.ts";
export { interleaveByProvider, breakerProviderId, IQ_POPULATION_MEAN, IQ_CREDIBILITY_FLOOR, scoreRecord, totalCatalogPulls } from "./ranking.ts";





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
export const IMAGE_KV_PREFIX = "kono_images";




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
