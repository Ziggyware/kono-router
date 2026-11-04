// Storage façade. Tools never touch Deno.Kv directly: they get a Store, which
// is either the durable KV namespace for this tenant or an in-isolate map.
// Values are chunked, so a 1MB file does not run into KV's 64KiB value limit.

import type { ToolCaps } from "./types.ts";

export interface Store {
  get<T>(key: string[]): Promise<T | null>;
  put(key: string[], value: unknown, ttlMs?: number): Promise<void>;
  del(key: string[]): Promise<void>;
  list<T>(prefix: string[], opts?: { limit?: number; reverse?: boolean }): Promise<Array<{ key: string[]; value: T }>>;
}

export const namespace = (caps?: ToolCaps): string => caps?.namespace || "shared";

class MemStore implements Store {
  #map = new Map<string, { value: unknown; exp: number }>();
  static readonly #id = "\u0000";

  #key(key: string[]): string {
    return key.map((k) => encodeURIComponent(k)).join(MemStore.#id);
  }
  #live(entry: { value: unknown; exp: number } | undefined): boolean {
    return Boolean(entry) && (entry!.exp === 0 || entry!.exp > Date.now());
  }
  get<T>(key: string[]): Promise<T | null> {
    const entry = this.#map.get(this.#key(key));
    if (!this.#live(entry)) {
      if (entry) this.#map.delete(this.#key(key));
      return Promise.resolve(null);
    }
    return Promise.resolve(entry!.value as T);
  }
  put(key: string[], value: unknown, ttlMs?: number): Promise<void> {
    this.#map.set(this.#key(key), { value, exp: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : 0 });
    if (this.#map.size > 20_000) {
      const now = Date.now();
      for (const [k, v] of this.#map) if (v.exp !== 0 && v.exp <= now) this.#map.delete(k);
    }
    return Promise.resolve();
  }
  del(key: string[]): Promise<void> {
    this.#map.delete(this.#key(key));
    return Promise.resolve();
  }
  list<T>(prefix: string[], opts: { limit?: number; reverse?: boolean } = {}): Promise<Array<{ key: string[]; value: T }>> {
    const head = this.#key(prefix) + MemStore.#id;
    const out: Array<{ key: string[]; value: T }> = [];
    const joined = [...this.#map.entries()]
      .filter(([k, v]) => k.startsWith(head) && this.#live(v))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [k, v] of opts.reverse ? joined.reverse() : joined) {
      const key = k.slice(head.length).split(MemStore.#id).map(decodeURIComponent);
      out.push({ key, value: v.value as T });
      if (out.length >= (opts.limit ?? 1000)) break;
    }
    return Promise.resolve(out);
  }
}

class KvStore implements Store {
  #kv: Deno.Kv;
  constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }
  async get<T>(key: string[]): Promise<T | null> {
    // Strong reads: a tool call immediately after a write must observe it,
    // even across isolates.
    const entry = await this.#kv.get<T>(key, { consistency: "strong" });
    return entry.value ?? null;
  }
  async put(key: string[], value: unknown, ttlMs?: number): Promise<void> {
    await this.#kv.set(key, value, ttlMs && ttlMs > 0 ? { expireIn: Math.max(1000, ttlMs) } : {});
  }
  async del(key: string[]): Promise<void> {
    await this.#kv.delete(key);
  }
  async list<T>(prefix: string[], opts: { limit?: number; reverse?: boolean } = {}): Promise<Array<{ key: string[]; value: T }>> {
    const out: Array<{ key: string[]; value: T }> = [];
    for await (const entry of this.#kv.list<T>({ prefix }, {
      limit: opts.limit ?? 1000,
      reverse: opts.reverse ?? false,
      consistency: "strong",
    })) {
      out.push({ key: entry.key as string[], value: entry.value as T });
      if (out.length >= (opts.limit ?? 1000)) break;
    }
    return out;
  }
}

const MEM = new MemStore();

/** One store per tenant, always prefixed so tenants cannot address each other. */
export function store(caps?: ToolCaps): Store {
  if (!caps?.kv) return prefixStore(MEM, `t:${namespace(caps)}`);
  return prefixStore(new KvStore(caps.kv), `t:${namespace(caps)}`);
}

/** Scope any store under a prefix — used to give tools their own keyspace. */
export function prefixStore(inner: Store, ...prefix: string[]): Store {
  return {
    get: <T>(key: string[]) => inner.get<T>([...prefix, ...key]),
    put: (key, value, ttlMs) => inner.put([...prefix, ...key], value, ttlMs),
    del: (key) => inner.del([...prefix, ...key]),
    list: <T>(key: string[], opts?: { limit?: number; reverse?: boolean }) => inner.list<T>([...prefix, ...key], opts),
  };
}

// --- large values -----------------------------------------------------------
// Deno KV caps a value at 64KiB; base64 inflates by 4/3. 32KiB chunks keep a
// comfortable margin and make partial reads possible later.

const CHUNK = 32 * 1024;

export async function putBytes(s: Store, base: string[], bytes: Uint8Array): Promise<number> {
  const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let i = 0; i < chunks; i++) {
    const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
    let bin = "";
    for (let j = 0; j < slice.length; j += 0x8000) bin += String.fromCharCode(...slice.subarray(j, j + 0x8000));
    await s.put([...base, "c", String(i)], btoa(bin));
  }
  return chunks;
}

export async function getBytes(s: Store, base: string[], chunks: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunks; i++) {
    const b64 = await s.get<string>([...base, "c", String(i)]);
    if (b64 === null) break;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
    parts.push(out);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function delBytes(s: Store, base: string[], chunks: number): Promise<void> {
  for (let i = 0; i < chunks; i++) await s.del([...base, "c", String(i)]);
}

/** JSON cache with TTL; a miss returns null and never throws. */
export async function cacheGet<T>(s: Store, key: string[], maxAgeMs: number, ttlMs?: number): Promise<T | null> {
  const entry = await s.get<{ at: number; value: T }>(key);
  if (!entry) return null;
  if (maxAgeMs > 0 && Date.now() - entry.at > maxAgeMs) return null;
  if (ttlMs) await s.put(key, entry, ttlMs);
  return entry.value;
}

export async function cachePut<T>(s: Store, key: string[], value: T, ttlMs = 3_600_000): Promise<void> {
  await s.put(key, { at: Date.now(), value }, ttlMs);
}
