// kv-store.ts — external KV backend for state.ts, backed by libSQL (Turso).
//
// Why this exists: Deno KV only lives where the Deno runtime hosts it. On a
// host with no Deno KV and no durable disk (free container tiers, serverless
// runners), the router used to fall back to the volatile in-memory store and
// lost conversations, forged tools, workspace files and learning state on
// every restart. This backend implements the exact six-operation surface the
// router uses (get/getMany/set/delete/list/atomic + close) against a hosted
// libSQL database, so state survives independently of the app host.
//
// Selection (state.ts): used when TURSO_DATABASE_URL (or KONO_TURSO_URL) is
// set; TURSO_AUTH_TOKEN (or KONO_TURSO_TOKEN) carries the database token.
// Otherwise state.ts keeps its previous behaviour (Deno KV, then memory).
//
// Storage mapping:
//   kono_kv(k TEXT PRIMARY KEY, kj TEXT, v TEXT, ver INTEGER, exp INTEGER)
//   k   — order-preserving encoding of the key (below); the PRIMARY KEY range
//         scan is what makes prefix list cheap in row-read accounting.
//   kj  — JSON.stringify(key), returned verbatim on reads.
//   v   — JSON.stringify(value).
//   ver — per-row version counter, bumped on every write; surfaced as the
//         Deno-style versionstamp string and compared by atomic check().
//   exp — expiry as epoch ms (NULL = no TTL); expired rows read as absent,
//         matching the memory fallback's lazy expiry.
//
// Key encoding: each part is stringified, NUL-escaped (\0 -> \0\1), and the
// parts are joined and terminated with \0\0. A tuple prefix therefore encodes
// to a string prefix of every extension's encoding, so a prefix list is the
// range [enc(prefix), enc(prefix) with the final \0 raised to \1). Ordering
// is bytewise on the encoding — identical to element-wise string ordering for
// the id/path/timestamp keys this router uses.
//
// Retries: transient transport failures (dropped TLS connections, edge 5xx)
// are a fact of life for a network-backed store, so every operation retries
// with backoff. That is safe here: reads are reads, set is an upsert, delete
// is a delete, and an atomic commit whose response was lost re-runs its
// checks on the next attempt — if the first attempt actually landed, the
// versionstamps no longer match and it reports { ok: false }, which the
// callers' CAS retry loops already handle.

import { createClient } from "@libsql/client/http";
import type { Client, InStatement } from "@libsql/client/http";

const SEP = "\u0000\u0000";

export function encodeKey(key: readonly unknown[]): string {
  return key.map((p) => String(p).replaceAll("\u0000", "\u0000\u0001")).join(SEP) + SEP;
}

export function keyPrefixRange(prefix: readonly unknown[]): { lo: string; hi: string } {
  const lo = encodeKey(prefix);
  return { lo, hi: lo.slice(0, -1) + "\u0001" };
}

const RETRY_DELAYS_MS = [100, 300, 700, 1500];
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastErr;
}

type KvKey = readonly unknown[];
type EntryLike = { key: KvKey; versionstamp: string | null };
type SetOpts = { expireIn?: number };

const UPSERT =
  `INSERT INTO kono_kv (k, kj, v, ver, exp) VALUES (?, ?, ?, 1, ?)
   ON CONFLICT(k) DO UPDATE SET kj = excluded.kj, v = excluded.v, exp = excluded.exp, ver = kono_kv.ver + 1
   RETURNING ver`;

export async function createTursoKv(url: string, authToken?: string): Promise<Deno.Kv> {
  const client: Client = createClient(authToken ? { url, authToken } : { url });
  const exec = (stmt: InStatement) => withRetry(() => client.execute(stmt));
  await exec(
    "CREATE TABLE IF NOT EXISTS kono_kv (k TEXT PRIMARY KEY, kj TEXT NOT NULL, v TEXT NOT NULL, ver INTEGER NOT NULL, exp INTEGER)",
  );

  const now = () => Date.now();
  const LIVE = "(exp IS NULL OR exp > ?)";

  const get = async (key: KvKey) => {
    const rs = await exec({
      sql: `SELECT kj, v, ver FROM kono_kv WHERE k = ? AND ${LIVE}`,
      args: [encodeKey(key), now()],
    });
    const row = rs.rows[0];
    if (!row) return { key: [...key], value: null, versionstamp: null };
    return { key: JSON.parse(String(row.kj)) as unknown[], value: JSON.parse(String(row.v)), versionstamp: String(row.ver) };
  };

  const set = async (key: KvKey, value: unknown, opts?: SetOpts) => {
    const exp = opts?.expireIn ? now() + opts.expireIn : null;
    const rs = await exec({
      sql: UPSERT,
      args: [encodeKey(key), JSON.stringify(key), JSON.stringify(value), exp],
    });
    return { ok: true as const, versionstamp: String(rs.rows[0].ver) };
  };

  const del = async (key: KvKey) => {
    await exec({ sql: "DELETE FROM kono_kv WHERE k = ?", args: [encodeKey(key)] });
  };

  const api = {
    get,
    getMany: async (keys: readonly KvKey[]) => {
      const out: Array<{ key: unknown[]; value: unknown; versionstamp: string | null }> = [];
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const enc = chunk.map(encodeKey);
        const rs = await exec({
          sql: `SELECT k, kj, v, ver FROM kono_kv WHERE k IN (${enc.map(() => "?").join(",")}) AND ${LIVE}`,
          args: [...enc, now()],
        });
        const byEnc = new Map(rs.rows.map((r) => [String(r.k), r]));
        for (let j = 0; j < chunk.length; j++) {
          const row = byEnc.get(enc[j]);
          out.push(row
            ? { key: JSON.parse(String(row.kj)) as unknown[], value: JSON.parse(String(row.v)), versionstamp: String(row.ver) }
            : { key: [...chunk[j]], value: null, versionstamp: null });
        }
      }
      return out;
    },
    set,
    delete: del,
    list: async function* (
      selector: { prefix?: KvKey; limit?: number; reverse?: boolean },
      options?: { limit?: number; reverse?: boolean },
    ) {
      const { lo, hi } = keyPrefixRange(selector?.prefix ?? []);
      const reverse = options?.reverse ?? selector?.reverse;
      const rawLimit = options?.limit ?? selector?.limit;
      const dir = reverse ? "DESC" : "ASC";
      const limit = rawLimit && rawLimit > 0 ? Math.floor(rawLimit) : -1;
      const rs = await exec({
        sql: `SELECT kj, v, ver FROM kono_kv WHERE k >= ? AND k < ? AND ${LIVE} ORDER BY k ${dir} LIMIT ?`,
        args: [lo, hi, now(), limit],
      });
      for (const row of rs.rows) {
        yield { key: JSON.parse(String(row.kj)) as unknown[], value: JSON.parse(String(row.v)), versionstamp: String(row.ver) };
      }
    },
    atomic: () => {
      const checks: EntryLike[] = [];
      const sets: Array<{ key: KvKey; value: unknown; opts?: SetOpts }> = [];
      const dels: KvKey[] = [];
      const builder = {
        check(entry: EntryLike) { checks.push(entry); return builder; },
        set(key: KvKey, value: unknown, opts?: SetOpts) { sets.push({ key, value, opts }); return builder; },
        delete(key: KvKey) { dels.push(key); return builder; },
        commit: async () => {
          return await withRetry(async () => {
            const tx = await client.transaction("write");
            try {
              for (const c of checks) {
                const rs = await tx.execute({
                  sql: `SELECT ver FROM kono_kv WHERE k = ? AND ${LIVE}`,
                  args: [encodeKey(c.key), now()],
                });
                const cur = rs.rows[0] ? String(rs.rows[0].ver) : null;
                if (cur !== c.versionstamp) { await tx.rollback(); return { ok: false as const }; }
              }
              let stamp = "0";
              for (const s of sets) {
                const exp = s.opts?.expireIn ? now() + s.opts.expireIn : null;
                const rs = await tx.execute({
                  sql: UPSERT,
                  args: [encodeKey(s.key), JSON.stringify(s.key), JSON.stringify(s.value), exp],
                });
                stamp = String(rs.rows[0].ver);
              }
              for (const d of dels) {
                await tx.execute({ sql: "DELETE FROM kono_kv WHERE k = ?", args: [encodeKey(d)] });
              }
              await tx.commit();
              return { ok: true as const, versionstamp: stamp };
            } catch (err) {
              try { await tx.rollback(); } catch { /* already closed */ }
              throw err;
            } finally {
              tx.close();
            }
          });
        },
      };
      return builder;
    },
    close: () => { client.close(); },
  };
  return api as unknown as Deno.Kv;
}
