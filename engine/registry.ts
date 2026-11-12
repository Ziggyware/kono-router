// engine/registry.ts — service-JSON registry machinery, extracted from engine/providers.ts.

import { serviceJsonProviders } from "../main.ts";
import type { ProviderSpec, CompletionOptions, ServiceJsonRegistry, ServiceJsonEndpoint } from "../main.ts";
import { isEndpointConfigured, buildRotatedHeaders } from "../util.ts";
import { SERVICE_JSON_FILE } from "./core.ts";
import { openUpstreamAdaptive } from "./dispatch.ts";





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
