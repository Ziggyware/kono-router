// Small, dependency-free primitives shared by every tool. No I/O, no globals:
// everything here is a pure function or a Web Crypto call.

import type { Json } from "./types.ts";

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Stable stringify: object keys sorted, so a hash of it is deterministic. */
export function canonical(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Json = {};
    for (const k of Object.keys(v as Json).sort()) out[k] = walk((v as Json)[k]);
    return out;
  };
  return JSON.stringify(walk(value)) ?? "null";
}

// --- bytes / text -----------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const text = (b: Uint8Array): string => dec.decode(b);

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/[\s-]/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const b64url = (s: string): string => bytesToBase64(utf8(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s: string): string => text(base64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/")));

/** WebCrypto's BufferSource wants a plain ArrayBuffer (TS 6 strictness). */
export const bufferSource = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof input === "string" ? utf8(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(bytes)));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return hex(await sha256(input));
}

/** Content id: 128 bits of SHA-256, base64url — 22 chars instead of 64. */
export async function contentId(input: string | Uint8Array): Promise<string> {
  return bytesToBase64((await sha256(input)).subarray(0, 16)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- ids --------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit time + 80 random bits, lexicographically sortable. */
export function ulid(now = Date.now()): string {
  let t = "";
  for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) t = CROCKFORD[n % 32] + t;
  const r = crypto.getRandomValues(new Uint8Array(16));
  let out = t;
  for (let i = 0; i < 16; i++) out += CROCKFORD[r[i] & 31];
  return out;
}

/** UUIDv7: time-ordered, RFC 9562 — better KV locality than v4. */
export function uuidv7(now = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let n = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const NANO = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-";
export function nanoid(size = 21): string {
  const r = crypto.getRandomValues(new Uint8Array(size));
  let out = "";
  for (const b of r) out += NANO[b & 63];
  return out;
}

// --- strings ----------------------------------------------------------------

export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);

/** One line, collapsed whitespace — for previews and table cells. */
export const oneLine = (s: string, max = 240): string => truncate(s.replace(/\s+/g, " ").trim(), max);

export function slug(s: string, max = 48): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "item";
}

/** Conservative English suffix folding. Not Porter: it only collapses the
 *  inflections that actually cost recall in short passages (deploy/deploys), and
 *  it refuses stems shorter than three characters. */
export function stem(word: string): string {
  if (word.length < 4) return word;
  if (/^[0-9]+$/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("es") && !/(?:s|x|z|ch|sh)es$/.test(word) && word.length > 4) return word.slice(0, -1);
  if (word.endsWith("s") && !/(?:ss|us|is|os)$/.test(word) && word.length > 3) return word.slice(0, -1);
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  return word;
}

/** Unicode-aware word tokenisation. CJK runs are split into bigrams so they
 *  still produce features a lexical index can match. */
export function tokenize(input: string): string[] {
  const words = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else if (w.length > 1) out.push(stem(w));
  }
  return out;
}

/** Levenshtein with an early-exit band; O(min(n,m)) memory. */
export function distance(a: string, b: string, cap = 10_000): number {
  if (a === b) return 0;
  if (a.length > cap || b.length > cap) return Math.max(a.length, b.length);
  if (a.length > b.length) [a, b] = [b, a];
  let prev = new Uint32Array(a.length + 1);
  let cur = new Uint32Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    cur[0] = j;
    const bc = b.charCodeAt(j - 1);
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === bc ? 0 : 1;
      cur[i] = Math.min(cur[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[a.length];
}

export const ratio = (a: string, b: string): number => {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - distance(a, b) / m;
};

export function trigrams(s: string): Set<string> {
  const padded = `  ${s.toLowerCase().replace(/\s+/g, " ")}  `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function dice(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return (2 * hit) / (A.size + B.size);
}

// --- CSV --------------------------------------------------------------------

export function parseCsv(input: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

export function toCsv(rows: unknown[][], delim = ","): string {
  const cell = (v: unknown): string => {
    const s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");
    return new RegExp(`["\\n\\r${delim === "\t" ? "\\t" : ","}]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(delim)).join("\n");
}

/** Objects → CSV with a stable, unioned header. */
export function objectsToCsv(rows: Json[], delim = ","): string {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return toCsv([cols, ...rows.map((r) => cols.map((c) => r[c]))], delim);
}

export function csvToObjects(input: string, delim = ","): Json[] {
  const rows = parseCsv(input, delim);
  if (rows.length === 0) return [];
  const [head, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim() || `col_${i}`, r[i] ?? ""])));
}

// --- paths ------------------------------------------------------------------

/** Virtual filesystem paths: relative, POSIX, no traversal, no NUL. */
export function normalizePath(raw: string): string {
  const p = String(raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (p.includes("\0")) throw new Error("path contains NUL");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) throw new Error("path escapes the workspace root");
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const out = parts.join("/");
  if (out.length > 512) throw new Error("path too long");
  return out;
}

export function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i++; if (glob[i + 1] === "/") i++; } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if ("+.^$()|[]{}".includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

/** Dot-path get/set: `a.b[0].c`. */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Json)[seg];
  }
  return cur;
}

export function setPath(root: Json, path: string, value: unknown): void {
  const segs = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: Json = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (!isObj(cur[k]) && !Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Json;
  }
  const last = segs.at(-1);
  if (last) cur[last] = value;
}

export function flatten(value: Json, prefix = "", depth = 0, out: Json = {}): Json {
  if (depth > 8) { out[prefix || "/"] = value; return out; }
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && !Array.isArray(v)) flatten(v, key, depth + 1, out);
    else out[key] = v as Json["value"];
  }
  return out;
}

// --- html -------------------------------------------------------------------

export const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", deg: "°", middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const code = g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return HTML_ENTITIES[g.toLowerCase()] ?? m;
  });
}

export const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const bytesToHex = hex;
