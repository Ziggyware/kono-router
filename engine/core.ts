// engine/core.ts — core subsystem, partitioned from engine.ts (originally main.ts).

import { encoder, IP_BUCKETS, MAX_BURST, REFILL_PER_SEC } from "../main.ts";
import type { MeshModelRecord } from "../main.ts";
import { L1_CACHE, kv, UNIVERSAL_MODEL_ALIAS } from "../state.ts";
import type { MiddlewareHandler } from "hono";




export const KV_PREFIX = "mesh_models_v5_2";




export const L1_TTL_MS = 15_000;





export async function atomicUpdateModel(
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




export const TOOL_SKILL_TTL_MS = 30_000;





export function timingSafeCompare(a: string, b: string): boolean {
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





export function checkRateLimit(ip: string): boolean {
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





export function pickOpenRouterKey(): string | null {
  const raw = Deno.env.get("OPENROUTER_API_KEY") || Deno.env.get("OPENROUTER_API_KEYS") || "";
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)];
}





export const SERVICE_JSON_FILE = "services.json";





export function isServiceJsonFile(path: string): boolean {
  const base = path.split("/").pop()?.split("\\").pop();
  if (!base) return false;
  return base === SERVICE_JSON_FILE;
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

export const NATIVE_MODEL_HINTS: Record<string, string[]> = {
  openrouter: ["openrouter/free", UNIVERSAL_MODEL_ALIAS],
  llm7: ["gpt-oss", UNIVERSAL_MODEL_ALIAS],
  kilo: ["kilo-auto/free", "kilo-auto/small", UNIVERSAL_MODEL_ALIAS],
  opencode: ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", UNIVERSAL_MODEL_ALIAS],
};





export async function freeTierConsume(ip: string): Promise<number> {
  const key = ["free_tier_v1", ip, new Date().toISOString().slice(0, 10)];
  let used = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const entry = await kv.get(key);
    used = (typeof entry.value === "number" ? entry.value : 0) + 1;
    const res = await kv.atomic().check(entry).set(key, used, { expireIn: 48 * 3600 * 1000 }).commit();
    if (res.ok) return used;
  }
  return used;
}





export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const adminSecret = Deno.env.get("ADMIN_SECRET");
  if (adminSecret) {
    const provided = c.req.header("x-admin-secret") || "";
    if (!provided || !timingSafeCompare(provided, adminSecret)) {
      return c.json({ error: { message: "Forbidden: Invalid x-admin-secret" } }, 403);
    }
  }
  await next();
};




export const IMAGE_BLOCK_KV = "nokey_images_blocked";
