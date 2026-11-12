// state.ts — shared runtime state extracted from main.ts (singletons, caches, registries).

import type { ToolSkillRecord } from "./tools.ts";
import type { StrategyArm, Lesson } from "./learning.ts";
import { Hono } from "hono";
import type { MeshModelRecord, LearningCellRecord, ArmCellRecord, ForgedToolDef, CommunityMessage } from "./main.ts";



// ============================================================================
// 1. DENO KV + L1 ISOLATE CACHE + CAS ATOMIC STATE ENGINE
// ============================================================================

// KV with an in-memory fallback: on Deno Deploy this is the real Deno KV.
// On hosts without Deno KV (e.g. Val Town) openKv throws, and the router
// runs on a process-local store implementing the surface it uses
// (get/getMany/set/delete/list/atomic). The fallback is volatile — data
// does not survive a restart — but every feature keeps working.
type MemEntry = { key: unknown[]; value: unknown; stamp: string; expiresAt: number | null };
function createMemoryKv(): Deno.Kv {
  const store = new Map<string, MemEntry>();
  let counter = 0;
  const ser = (key: readonly unknown[]) => JSON.stringify(key);
  const stamp = () => (++counter).toString(16).padStart(16, "0");
  const live = (key: readonly unknown[]): MemEntry | null => {
    const e = store.get(ser(key));
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) { store.delete(ser(key)); return null; }
    return e;
  };
  const get = async (key: readonly unknown[]) => {
    const e = live(key);
    return e ? { key: [...e.key], value: e.value, versionstamp: e.stamp } : { key: [...key], value: null, versionstamp: null };
  };
  const set = async (key: readonly unknown[], value: unknown, opts?: { expireIn?: number }) => {
    const s = stamp();
    store.set(ser(key), { key: [...key], value, stamp: s, expiresAt: opts?.expireIn ? Date.now() + opts.expireIn : null });
    return { ok: true, versionstamp: s };
  };
  const del = async (key: readonly unknown[]) => { store.delete(ser(key)); };
  const api = {
    get,
    getMany: async (keys: readonly unknown[][]) => Promise.all(keys.map((k) => get(k))),
    set,
    delete: del,
    list: async function* (selector: { prefix?: readonly unknown[]; limit?: number }) {
      const prefix = selector?.prefix ?? [];
      const rows = [...store.values()].filter((e) => live(e.key) && prefix.every((p, i) => JSON.stringify(e.key[i]) === JSON.stringify(p)));
      rows.sort((a, b) => ser(a.key) < ser(b.key) ? -1 : 1);
      let n = 0;
      for (const e of rows) { if (selector?.limit && ++n > selector.limit) break; yield { key: [...e.key], value: e.value, versionstamp: e.stamp }; }
    },
    atomic: () => {
      const checks: Array<{ key: readonly unknown[]; versionstamp: string | null }> = [];
      const ops: Array<() => Promise<unknown>> = [];
      const builder = {
        check(entry: { key: readonly unknown[]; versionstamp: string | null }) { checks.push(entry); return builder; },
        set(key: readonly unknown[], value: unknown, opts?: { expireIn?: number }) { ops.push(() => set(key, value, opts)); return builder; },
        delete(key: readonly unknown[]) { ops.push(() => del(key)); return builder; },
        commit: async () => {
          for (const c of checks) { const cur = live(c.key); if ((cur?.stamp ?? null) !== c.versionstamp) return { ok: false }; }
          for (const op of ops) await op();
          return { ok: true, versionstamp: stamp() };
        },
      };
      return builder;
    },
    close: () => {},
  };
  return api as unknown as Deno.Kv;
}
export const kv: Deno.Kv = await (async () => {
  // External store first: with TURSO_DATABASE_URL (or KONO_TURSO_URL) set,
  // state lives in a hosted libSQL database (kv-store.ts) and survives any
  // app host, including disk-less free tiers. A configured-but-unreachable
  // external store logs loudly and falls through rather than pretending.
  const extUrl = Deno.env.get("TURSO_DATABASE_URL") ?? Deno.env.get("KONO_TURSO_URL");
  if (extUrl) {
    try {
      const { createTursoKv } = await import("./kv-store.ts");
      return await createTursoKv(extUrl, Deno.env.get("TURSO_AUTH_TOKEN") ?? Deno.env.get("KONO_TURSO_TOKEN"));
    } catch (err) {
      console.error("[kono] external KV store unreachable, falling back to local stores:", err);
    }
  }
  try { return await Deno.openKv(); } catch { return createMemoryKv(); }
})();



export const L1_CACHE = new Map<string, MeshModelRecord>();


export const TOOL_SKILLS = new Map<string, ToolSkillRecord>();


export const LEARN_ARM_DEF_PREFIX = "mesh_learning_arms_v1";


export const LEARN_DECISION_PREFIX = "mesh_learning_decisions_v1";


export const DECISION_TTL_MS = 7 * 86_400_000;


export const TENANT_EVIDENCE_MIN = 30;


export const MAX_LEARN_CELLS = 4000;



export const LEARNING_CELLS = new Map<string, LearningCellRecord>();


export const ARM_CELLS = new Map<string, ArmCellRecord>();


export const ARM_DEFS = new Map<string, StrategyArm>();


export const LESSONS = new Map<string, Lesson>();


export const FORGED_TOOLS = new Map<string, ForgedToolDef>();



// A model id accepted by the widest set of keyless relays (used only on the
// last protocol-negotiation rung, never on the fast path).
export const UNIVERSAL_MODEL_ALIAS = "gpt-4o-mini";



export const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive" };



export const honoApp = new Hono();




// ---------------------------------------------------------------------------
// FREE TIER — no API key, no problem: 50 requests per day per IP, counted
// in Deno KV (UTC day buckets; entries expire after 48h so old days clean
// themselves up). A request carrying a WRONG key still 401s — the free
// tier is for having no key, not for guessing one. Unlimited is $5/month:
// see /pricing. A KV hiccup never fails a request (consume fails open).
// ---------------------------------------------------------------------------
export const FREE_TIER_DAILY = 50;



// System source reader: lets the dashboard's Architect agent read the
// code it operates on. Allowlisted files only, admin-guarded like /v1/probe.
export const SOURCE_FILES = ["main.ts", "math.ts", "learning.ts", "trace.ts", "index.html", "openapi.json", "CHANGES.md", "services.json", "deno.json"];


export const SOURCE_FILE_SET = new Set(SOURCE_FILES);



export const communityRooms = new Map<string, CommunityMessage[]>();


export const communitySubscribers = new Map<string, Set<(msg: CommunityMessage) => void>>();



// ============================================================================
// IMAGE GENERATION -- OpenAI-compatible POST /v1/images/generations
// Keyless upstreams only: Pollinations image API (primary) and the AI Horde
// anonymous pool (fallback / explicit). Model ids:
//   nokey-image       -> Pollinations "turbo" (fast)
//   nokey-image-flux  -> Pollinations "flux" (higher quality, slower)
//   nokey-image-horde -> AI Horde stable_diffusion (anonymous key)
// Response follows the OpenAI shape: { created, data: [{ url } | { b64_json }] }
// ============================================================================

export const IMAGE_MODELS = [
  { id: "nokey-image", provider: "pollinations", upstreamModel: "turbo" },
  { id: "nokey-image-flux", provider: "pollinations", upstreamModel: "flux" },
  { id: "nokey-image-horde", provider: "horde", upstreamModel: "stable_diffusion" },
];


// Backends that answered 401/402/403 need a key or payment: kept out of the
// list and the chain for a day, shared across isolates through KV.
export const IMAGE_BLOCKED = new Set<string>();
