// Deterministic compute tools: calculate, data, text, time, crypto.
//
// These replace the old toy set with one tool per *job* rather than one per
// function: `data` covers JSONPath, conversion, reshaping and validation; `text`
// covers extraction, diffing, similarity and summarisation; `crypto` covers
// digests, ids, encodings and JWTs. Fewer schemas, less prompt, same reach.

import { formatNumber, evaluate, statistics } from "./calc.ts";
import { query as jsonQuery } from "./jsonpath.ts";
import { lineDiff } from "./files.ts";
import { summarize as extractiveSummary } from "./vec.ts";
import {
  base64ToBytes, bufferSource, bytesToBase64, bytesToHex, clamp, csvToObjects, dice, flatten as flattenObj,
  fromHex, getPath, isObj, nanoid, objectsToCsv, oneLine, parseCsv, ratio as levRatio,
  toCsv, tokenize, truncate, ulid, uuidv7, utf8,
} from "./util.ts";
import type { Json, ToolSpec } from "./types.ts";
import type { ToolboxApi } from "./index.ts";

// --- time helpers -----------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  ms: 1, msec: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  mo: 2_592_000_000, month: 2_592_000_000, months: 2_592_000_000,
  y: 31_536_000_000, yr: 31_536_000_000, year: 31_536_000_000, years: 31_536_000_000,
};

export function parseDuration(input: string): number | null {
  const src = input.trim().toLowerCase();
  if (!src) return null;
  if (/^p/i.test(src)) {
    const m = src.match(/^p(?:(\d+(?:\.\d+)?)y)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)d)?(?:t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?)?$/);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map((x) => (x ? Number(x) : 0));
    return y * UNIT_MS.y + mo * UNIT_MS.mo + d * UNIT_MS.d + h * UNIT_MS.h + mi * UNIT_MS.m + s * UNIT_MS.s;
  }
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let found = false;
  for (const m of src.matchAll(re)) {
    const unit = UNIT_MS[m[2]];
    if (unit === undefined) return null;
    total += Number(m[1]) * unit;
    found = true;
  }
  if (!found && /^\d+(?:\.\d+)?$/.test(src)) return Number(src);
  return found ? total : null;
}

export function humanize(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  const units: Array<[string, number]> = [["d", UNIT_MS.d], ["h", UNIT_MS.h], ["m", UNIT_MS.m], ["s", 1000]];
  let rest = Math.round(abs);
  const out: string[] = [];
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) { out.push(`${n}${label}`); rest -= n * size; }
    if (out.length === 2) break;
  }
  return sign + out.join(" ");
}

export function parseInstant(value: unknown, zone?: string): number | null {
  if (typeof value === "number") return guessEpoch(value);
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^now$/i.test(raw)) return Date.now();
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return guessEpoch(Number(raw));
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  const duration = parseDuration(raw);
  if (duration !== null) return Date.now() + duration;
  void zone;
  return null;
}

export function guessEpoch(n: number): number {
  const abs = Math.abs(n);
  if (abs < 1e11) return Math.round(n * 1000);
  if (abs < 1e14) return Math.round(n);
  if (abs < 1e17) return Math.round(n / 1000);
  return Math.round(n / 1e6);
}

export function zoneInfo(date: Date, zone: string): { local: string; offset_minutes: number; zone: string } {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return {
      local: `${parts.year}-${parts.month}-${parts.day}T${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}:${parts.second}`,
      offset_minutes: Math.round((asUtc - date.getTime()) / 60_000),
      zone,
    };
  } catch {
    return { local: date.toISOString().slice(0, 19), offset_minutes: 0, zone: "UTC" };
  }
}

const offsetLabel = (min: number): string => {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};

// --- crypto helpers ---------------------------------------------------------

const HASHES: Record<string, string> = {
  "sha-1": "SHA-1", sha1: "SHA-1", "sha-256": "SHA-256", sha256: "SHA-256",
  "sha-384": "SHA-384", sha384: "SHA-384", "sha-512": "SHA-512", sha512: "SHA-512",
};

async function hmac(algo: string, key: string, bytes: Uint8Array): Promise<Uint8Array> {
  const subtleAlgo = HASHES[algo.toLowerCase()] ?? "SHA-256";
  const cryptoKey = await crypto.subtle.importKey("raw", bufferSource(utf8(key)), { name: "HMAC", hash: subtleAlgo }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, bufferSource(bytes)));
}

const b64url = (bytes: Uint8Array): string => bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwtDecode(token: string): Json {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT: expected three dot-separated segments");
  const dec = (s: string): Json => JSON.parse(new TextDecoder().decode(base64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/")))) as Json;
  const header = dec(parts[0]);
  const payload = dec(parts[1]);
  const exp = typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : undefined;
  const iat = typeof payload.iat === "number" ? new Date(payload.iat * 1000).toISOString() : undefined;
  return {
    header,
    payload,
    signature_bytes: base64ToBytes(parts[2].replace(/-/g, "+").replace(/_/g, "/")).length,
    ...(exp ? { expires_at: exp, expired: Date.now() > Number(payload.exp) * 1000 } : {}),
    ...(iat ? { issued_at: iat } : {}),
  };
}

async function jwtSign(payload: Json, secret: string, alg = "HS256"): Promise<string> {
  const enc = (obj: Json): string => b64url(utf8(JSON.stringify(obj)));
  const header = enc({ alg, typ: "JWT" });
  const body = enc(payload);
  const signingInput = `${header}.${body}`;
  const sig = await hmac(alg, secret, utf8(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

const ENTITY_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function encodeValue(data: string, to: string): string {
  switch (to) {
    case "base64": return bytesToBase64(utf8(data));
    case "base64url": return b64url(utf8(data));
    case "hex": return bytesToHex(utf8(data));
    case "url": return encodeURIComponent(data);
    case "html": return data.replace(/[&<>"']/g, (c) => ENTITY_MAP[c]);
    case "entities": return data.replace(/[\u0080-\uffff]/g, (c) => `&#${c.codePointAt(0)};`);
    default: throw new Error(`unsupported encoding "${to}"`);
  }
}

function decodeValue(data: string, from: string): string {
  switch (from) {
    case "base64": return new TextDecoder().decode(base64ToBytes(data));
    case "base64url": return new TextDecoder().decode(base64ToBytes(data.replace(/-/g, "+").replace(/_/g, "/")));
    case "hex": return new TextDecoder().decode(fromHex(data));
    case "url": return decodeURIComponent(data);
    case "html": return data.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g: string) => {
      if (g[0] === "#") {
        const code = g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[g.toLowerCase()] ?? m;
    });
    default: throw new Error(`unsupported decoding "${from}"`);
  }
}

// --- tool definitions -------------------------------------------------------

export function computeTools(api: ToolboxApi): ToolSpec[] {
  return [
    {
      name: "calculate",
      kind: "compute",
      aliases: ["math", "math.evaluate", "math_evaluate", "calculator", "eval", "arithmetic", "statistics", "stats"],
      deterministic: true,
      description:
        "Exact arithmetic and statistics, no eval. Handles precedence, functions (sqrt, log, trig with rad/deg, gcd, factorial, erf, normal CDF/quantile), variables, comparisons and batched expressions; pass `values` instead to get mean/median/sd/quantiles/outliers/histogram. Use it instead of doing mental arithmetic.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "e.g. \"(23*19)+14\", \"2^10\", \"sin(30)\"." },
          expressions: { type: "array", items: { type: "string" }, maxItems: 64, description: "Batch of expressions (max 64)." },
          variables: { type: "object", description: "Named variables referenced by the expressions." },
          angle: { type: "string", enum: ["rad", "deg"], default: "rad" },
          precision: { type: "integer", minimum: 1, maximum: 15, default: 12 },
          values: { type: "array", items: { type: "number" }, description: "Numeric series to summarise." },
          quantiles: { type: "array", items: { type: "number" }, description: "Quantiles to report, e.g. [0.5,0.95,0.99]." },
        },
        additionalProperties: false,
      },
      run: (args) => {
        if (Array.isArray(args.values)) {
          return { op: "statistics", ...statistics(args.values.map(Number), { quantiles: (args.quantiles as number[] | undefined) ?? [0.5, 0.9, 0.95, 0.99] }) };
        }
        const list = Array.isArray(args.expressions)
          ? (args.expressions as unknown[]).map(String)
          : typeof args.expression === "string" ? [args.expression] : [];
        if (list.length === 0) throw new Error("provide `expression`, `expressions` or `values`");
        if (list.length > 256) throw new Error("too many expressions (max 256)");
        const variables = isObj(args.variables)
          ? Object.fromEntries(Object.entries(args.variables).map(([k, v]) => [k.toLowerCase(), Number(v)]).filter(([, v]) => Number.isFinite(v as number))) as Record<string, number>
          : {};
        const precision = Math.max(1, Math.min(15, Number(args.precision ?? 12)));
        const results = list.map((expression) => {
          try {
            const value = formatNumber(evaluate(expression, { angle: (args.angle as "rad" | "deg") ?? "rad", variables }), precision);
            return { expression, value, ...(Number.isFinite(value) ? {} : { note: "non-finite result" }) };
          } catch (err) {
            return { expression, error: err instanceof Error ? err.message : String(err) };
          }
        });
        if (results.length === 1) return { op: "evaluate", ...results[0], expression: list[0] };
        return { op: "evaluate", count: results.length, results };
      },
    },

    {
      name: "data",
      kind: "data",
      aliases: ["json", "json_query", "json_transform", "csv", "query_data"],
      deterministic: true,
      description:
        "Work with structured data: JSONPath-lite queries (`$.items[?(@.price>10)].name`, `..id`), JSON⇄CSV/TSV/NDJSON conversion, reshaping (pick/omit/flatten/compact/sort/unique/group/rename) and JSON Schema validation. One tool for every data-shape problem.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["query", "convert", "transform", "validate"], default: "query" },
          data: { description: "Object, array, or a string when `from` says how to parse it." },
          path: { type: "string", default: "$", description: "JSONPath-lite expression for op=query." },
          from: { type: "string", enum: ["json", "csv", "tsv", "ndjson"], description: "Parse `data` as this format first." },
          to: { type: "string", enum: ["json", "csv", "tsv", "ndjson", "keys"], description: "Output format for op=convert." },
          pick: { type: "array", items: { type: "string" } },
          omit: { type: "array", items: { type: "string" } },
          rename: { type: "object", description: "Map old key → new key." },
          flatten: { type: "boolean", default: false },
          compact: { type: "boolean", default: false },
          sort_by: { type: "string" },
          sort_desc: { type: "boolean", default: false },
          unique_by: { type: "string" },
          group_by: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 10_000 },
          schema: { type: "object", description: "JSON Schema for op=validate." },
          coerce: { type: "boolean", default: true },
        },
        required: ["op"],
        additionalProperties: false,
      },
      run: (args) => {
        const parse = (): unknown => {
          const raw = args.data;
          if (typeof raw !== "string") return raw;
          const from = String(args.from ?? "json");
          if (from === "csv" || from === "tsv") return csvToObjects(raw, from === "tsv" ? "\t" : ",");
          if (from === "ndjson") return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
          return JSON.parse(raw);
        };
        const input = parse();
        const op = String(args.op ?? "query");

        if (op === "query") {
          const hits = jsonQuery(input, String(args.path ?? "$"));
          return {
            op, path: String(args.path ?? "$"), count: hits.length,
            value: hits.length === 1 ? hits[0] : hits,
            ...(hits.length > 200 ? { truncated: true, note: "showing all matches; narrow the path for less" } : {}),
          };
        }
        if (op === "convert") {
          const to = String(args.to ?? "json");
          if (to === "json") return { op, to, value: input };
          const rows = Array.isArray(input) ? input : [input];
          if (to === "keys") {
            const keys = new Set<string>();
            for (const r of rows) if (isObj(r)) for (const k of Object.keys(r)) keys.add(k);
            return { op, to, keys: [...keys], count: keys.size };
          }
          if (to === "ndjson") return { op, to, value: rows.map((r) => JSON.stringify(r)).join("\n"), lines: rows.length };
          const delim = to === "tsv" ? "\t" : ",";
          const text = rows.every((r) => isObj(r)) ? objectsToCsv(rows as Json[], delim) : toCsv(rows as unknown[][], delim);
          return { op, to, rows: rows.length, value: text };
        }
        if (op === "transform") {
          const applyOne = (row: unknown): unknown => {
            if (Array.isArray(row)) return row.map(applyOne);
            if (!isObj(row)) return row;
            let out: Json = row;
            if (Array.isArray(args.pick)) {
              const picked: Json = {};
              for (const path of args.pick) { const v = getPath(out, String(path)); if (v !== undefined) picked[String(path)] = v as Json["x"]; }
              out = picked;
            }
            if (Array.isArray(args.omit)) {
              const trimmed: Json = {};
              for (const [k, v] of Object.entries(out)) if (!args.omit.map(String).includes(k)) trimmed[k] = v;
              out = trimmed;
            }
            if (isObj(args.rename)) {
              const renamed: Json = {};
              for (const [k, v] of Object.entries(out)) renamed[(args.rename as Json)[k] as string ?? k] = v;
              out = renamed;
            }
            if (args.flatten === true) out = flattenObj(out);
            if (args.compact === true) {
              const kept: Json = {};
              for (const [k, v] of Object.entries(out)) {
                if (v === null || v === "" || v === undefined) continue;
                if (Array.isArray(v) && v.length === 0) continue;
                if (isObj(v) && Object.keys(v).length === 0) continue;
                kept[k] = v;
              }
              out = kept;
            }
            return out;
          };
          let value: unknown = applyOne(input);
          let rows = Array.isArray(value) ? value : null;
          if (rows && typeof args.sort_by === "string") {
            const desc = args.sort_desc === true;
            const key = args.sort_by;
            rows = [...rows].sort((a, b) => {
              const x = getPath(a, key), y = getPath(b, key);
              const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
              return desc ? -cmp : cmp;
            });
          }
          if (rows && typeof args.unique_by === "string") {
            const seen = new Set<string>();
            rows = rows.filter((r) => {
              const key = JSON.stringify(getPath(r, args.unique_by as string));
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          }
          if (rows && args.limit !== undefined) rows = rows.slice(0, Number(args.limit));
          if (rows && typeof args.group_by === "string") {
            const grouped: Json = {};
            for (const r of rows) {
              const key = String(getPath(r, args.group_by) ?? "null");
              (grouped[key] ??= [] as never[]);
              (grouped[key] as unknown[]).push(r);
            }
            return { op, grouped_by: args.group_by, groups: Object.keys(grouped).length, value: grouped };
          }
          value = rows ?? value;
          return { op, value, rows: rows?.length ?? null };
        }
        if (op === "validate") {
          if (args.schema === undefined) throw new Error("schema is required for validate");
          const result = api.validateJson(input, args.schema, { coerce: args.coerce !== false });
          return {
            op, valid: result.ok, coerced: result.repaired ?? false, repairs: result.repairs ?? 0,
            issues: result.issues.filter((i) => i.severity === "error").slice(0, 20).map((i) => ({ path: i.path, keyword: i.keyword, message: i.message })),
            ...(result.ok ? { value: result.value } : {}),
          };
        }
        throw new Error(`unknown op "${op}"`);
      },
    },

    {
      name: "text",
      kind: "text",
      aliases: ["text_tools", "regex", "extract_text", "diff", "similarity", "summarize"],
      deterministic: true,
      description:
        "Text surgery: regex extraction (or built-in emails/urls/numbers/dates), line or word diffs, similarity scoring (Levenshtein, trigram Dice, token Jaccard, embedding cosine), regex replace, template interpolation, extractive summarisation and corpus stats. Covers the long tail of string work in one schema.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["extract", "similarity", "diff", "replace", "template", "summarize", "stats"], default: "extract" },
          text: { type: "string" },
          other: { type: "string", description: "Second text for diff." },
          candidates: { type: "array", items: { type: "string" }, description: "Compare `text` against each of these." },
          pattern: { type: "string", description: "Regex (JS syntax) for extract/replace." },
          flags: { type: "string", default: "gi" },
          kind: { type: "string", enum: ["emails", "urls", "numbers", "dates", "uuids", "ips", "hashtags", "mentions"], description: "Preset extractor when `pattern` is absent." },
          replacement: { type: "string", default: "" },
          vars: { type: "object", description: "Template variables, dot-paths allowed." },
          max_chars: { type: "integer", minimum: 80, maximum: 20_000, default: 600 },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
          algorithm: { type: "string", enum: ["combined", "levenshtein", "trigram", "token", "embedding"], default: "combined" },
        },
        required: ["op"],
        additionalProperties: false,
      },
      run: (args) => {
        const op = String(args.op ?? "extract");
        const text = String(args.text ?? "");
        if (!text && op !== "stats") throw new Error("text is empty");
        const limit = Math.max(1, Math.min(500, Number(args.limit ?? 50)));

        if (op === "extract") {
          const presets: Record<string, string> = {
            emails: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
            urls: "https?://[^\\s<>\"')]+",
            numbers: "-?\\d+(?:\\.\\d+)?",
            dates: "\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b",
            uuids: "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b",
            ips: "\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b",
            hashtags: "#[A-Za-z0-9_]+",
            mentions: "@[A-Za-z0-9_]+",
          };
          const pattern = typeof args.pattern === "string" && args.pattern
            ? args.pattern
            : presets[String(args.kind ?? "urls")];
          if (!pattern) throw new Error("provide `pattern` or a known `kind`");
          const flags = String(args.flags ?? "gi").replace(/[^gimsuy]/g, "");
          const re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
          const matches: Json[] = [];
          for (const m of text.matchAll(re)) {
            if (matches.length >= limit) break;
            matches.push({
              value: m[0].slice(0, 500),
              index: m.index,
              ...(m.length > 1 ? { groups: m.slice(1, 6).map((g) => truncate(String(g ?? ""), 200)) } : {}),
              ...(m.groups ? { named: m.groups } : {}),
            });
          }
          return { op, pattern, count: matches.length, matches };
        }

        if (op === "similarity") {
          const candidates = Array.isArray(args.candidates) ? (args.candidates as unknown[]).map(String).slice(0, 100) : [];
          if (candidates.length === 0) throw new Error("candidates is required");
          const algorithm = String(args.algorithm ?? "combined");
          const tokens = new Set(tokenize(text));
          const scored = candidates.map((c) => {
            const other = new Set(tokenize(c));
            let inter = 0;
            for (const t of tokens) if (other.has(t)) inter++;
            const jaccard = tokens.size && other.size ? inter / (tokens.size + other.size - inter) : 0;
            const lev = levRatio(text.toLowerCase(), c.toLowerCase());
            const tri = dice(text, c);
            const score = algorithm === "levenshtein" ? lev
              : algorithm === "trigram" ? tri
              : algorithm === "token" ? jaccard
              : algorithm === "embedding" ? 0.5 * tri + 0.5 * jaccard
              : 0.45 * tri + 0.3 * jaccard + 0.25 * lev;
            return { candidate: c, score: Number(score.toFixed(4)), trigram: Number(tri.toFixed(4)), token_jaccard: Number(jaccard.toFixed(4)), levenshtein: Number(lev.toFixed(4)) };
          }).sort((a, b) => b.score - a.score);
          return { op, algorithm, count: scored.length, best: scored[0], ranked: scored };
        }

        if (op === "diff") {
          const other = String(args.other ?? "");
          const before = text.split("\n");
          const after = other.split("\n");
          const diff = lineDiff(before, after);
          const added = diff.split("\n").filter((l) => l.startsWith("+")).length;
          const removed = diff.split("\n").filter((l) => l.startsWith("-")).length;
          return { op, added, removed, identical: before.join("\n") === after.join("\n"), diff: truncate(diff, 20_000) };
        }

        if (op === "replace") {
          const pattern = String(args.pattern ?? "");
          if (!pattern) throw new Error("pattern is required");
          const flags = String(args.flags ?? "gi").replace(/[^gimsuy]/g, "").includes("g") ? String(args.flags ?? "gi").replace(/[^gimsuy]/g, "") : `${String(args.flags ?? "gi").replace(/[^gimsuy]/g, "")}g`;
          const re = new RegExp(pattern, flags);
          const replacement = String(args.replacement ?? "");
          let count = 0;
          const out = text.replace(re, (...m: unknown[]) => {
            count++;
            return replacement.replace(/\$(\d+)/g, (_s, i: string) => String(m[Number(i)] ?? ""));
          });
          return { op, replacements: count, chars: out.length, text: truncate(out, 40_000) };
        }

        if (op === "template") {
          const vars = isObj(args.vars) ? args.vars : {};
          const missing: string[] = [];
          const out = text.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m, path: string) => {
            const value = getPath(vars, path);
            if (value === undefined) { missing.push(path); return ""; }
            return typeof value === "object" ? JSON.stringify(value) : String(value);
          });
          return { op, chars: out.length, missing: [...new Set(missing)].slice(0, 20), text: out };
        }

        if (op === "summarize") {
          const maxChars = Math.max(80, Math.min(20_000, Number(args.max_chars ?? 600)));
          const summary = extractiveSummary(text, maxChars);
          return { op, original_chars: text.length, summary_chars: summary.length, compression: Number((summary.length / Math.max(1, text.length)).toFixed(3)), summary };
        }

        // stats
        const words = text.match(/[\p{L}\p{N}'-]+/gu) ?? [];
        const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
        const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim()).length;
        const freq = new Map<string, number>();
        for (const w of words.map((w) => w.toLowerCase())) if (w.length > 3) freq.set(w, (freq.get(w) ?? 0) + 1);
        const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([word, count]) => ({ word, count }));
        return {
          op: "stats",
          chars: text.length,
          words: words.length,
          unique_words: freq.size,
          sentences: sentences.length,
          paragraphs,
          avg_word_length: Number((words.reduce((n, w) => n + w.length, 0) / Math.max(1, words.length)).toFixed(2)),
          avg_sentence_words: Number((words.length / Math.max(1, sentences.length)).toFixed(1)),
          reading_time_seconds: Math.round((words.length / 230) * 60),
          estimated_tokens: Math.ceil(text.length / 4),
          top_words: top,
        };
      },
    },

    {
      name: "time",
      kind: "time",
      aliases: ["datetime", "clock", "date", "duration", "timezone"],
      deterministic: true,
      description:
        "Time arithmetic you can trust: current instant in any IANA zone, parse ISO/epoch/relative expressions, add or subtract durations (\"2h30m\", \"P1DT2H\"), diff two instants, and convert with correct UTC offsets. Never guess a date or a timezone again.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["now", "parse", "add", "diff", "convert"], default: "now" },
          value: { description: "ISO string, epoch number, \"now\", or a duration for add." },
          other: { description: "Second instant for diff." },
          duration: { type: "string", description: "e.g. \"90m\", \"2 days\", \"P1DT2H\"." },
          zone: { type: "string", default: "UTC", description: "IANA zone, e.g. America/New_York." },
          unit: { type: "string", enum: ["ms", "s", "m", "h", "d"], default: "ms", description: "Unit for diff output." },
        },
        required: ["op"],
        additionalProperties: false,
      },
      run: (args) => {
        const op = String(args.op ?? "now");
        const zone = String(args.zone ?? "UTC");
        const describe = (ms: number) => {
          const date = new Date(ms);
          const info = zoneInfo(date, zone);
          return {
            iso: date.toISOString(),
            local: info.local,
            zone: info.zone,
            utc_offset: offsetLabel(info.offset_minutes),
            epoch_ms: ms,
            epoch_s: Math.floor(ms / 1000),
            weekday: new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(date),
          };
        };
        if (op === "now") return { op, ...describe(Date.now()) };
        if (op === "parse") {
          const ms = parseInstant(args.value ?? "now", zone);
          if (ms === null) throw new Error(`cannot parse instant: ${String(args.value).slice(0, 80)}`);
          return { op, ...describe(ms) };
        }
        if (op === "add") {
          const base = parseInstant(args.value ?? "now", zone);
          if (base === null) throw new Error("cannot parse `value`");
          const duration = parseDuration(String(args.duration ?? ""));
          if (duration === null) throw new Error("cannot parse `duration` (try \"90m\", \"2 days\", \"P1DT2H\")");
          return { op, from: describe(base), delta: humanize(duration), ...describe(base + duration) };
        }
        if (op === "diff") {
          const a = parseInstant(args.value ?? "now", zone);
          const b = parseInstant(args.other ?? "now", zone);
          if (a === null || b === null) throw new Error("cannot parse one of the instants");
          const ms = b - a;
          const unit = String(args.unit ?? "ms");
          const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
          return { op, from: describe(a), to: describe(b), unit, value: Number((ms / factor).toFixed(3)), ms, human: humanize(ms), days: Number((ms / 86_400_000).toFixed(3)) };
        }
        if (op === "convert") {
          const ms = parseInstant(args.value ?? "now", zone);
          if (ms === null) throw new Error("cannot parse `value`");
          return { op, ...describe(ms) };
        }
        throw new Error(`unknown op "${op}"`);
      },
    },

    {
      name: "crypto",
      kind: "crypto",
      aliases: ["hash", "digest", "hmac", "uuid", "jwt", "encode", "base64"],
      deterministic: true,
      description:
        "Hashing, HMAC, ids and encodings: SHA-1/256/384/512 digests, HMAC signatures, UUIDv4/v7, ULID, nanoid, base64/base64url/hex/URL/HTML encode & decode, and JWT decode or HS256/384/512 signing. Exact bytes, no guessing.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["digest", "hmac", "id", "encode", "decode", "jwt_decode", "jwt_sign"], default: "digest" },
          data: { type: "string", description: "Input text (or token for jwt_decode)." },
          algorithm: { type: "string", default: "sha-256", description: "sha-1|sha-256|sha-384|sha-512, or HS256/384/512 for jwt_sign." },
          key: { type: "string", description: "HMAC key or JWT secret." },
          secret: { type: "string", description: "Alias for key, used by jwt_sign." },
          id_kind: { type: "string", enum: ["uuid4", "uuid7", "ulid", "nanoid"], default: "uuid7" },
          encoding: { type: "string", enum: ["base64", "base64url", "hex", "url", "html"], default: "base64" },
          count: { type: "integer", minimum: 1, maximum: 20, default: 1 },
          payload: { type: "object", description: "Claims for jwt_sign." },
          output: { type: "string", enum: ["hex", "base64", "base64url"], default: "hex" },
        },
        required: ["op"],
        additionalProperties: false,
      },
      run: async (args) => {
        const op = String(args.op ?? "digest");
        const data = String(args.data ?? "");
        const algorithm = String(args.algorithm ?? "sha-256").toLowerCase();
        if (op === "digest") {
          const subtleAlgo = HASHES[algorithm];
          if (!subtleAlgo) throw new Error(`unsupported algorithm "${algorithm}"`);
          if (data.length > 1_000_000) throw new Error("input exceeds 1MB");
          const bytes = new Uint8Array(await crypto.subtle.digest(subtleAlgo, bufferSource(utf8(data))));
          const output = String(args.output ?? "hex");
          return {
            op, algorithm, bytes: bytes.length,
            hex: bytesToHex(bytes),
            base64: bytesToBase64(bytes),
            base64url: b64url(bytes),
            ...(output !== "hex" ? {} : {}),
          };
        }
        if (op === "hmac") {
          const key = String(args.key ?? args.secret ?? "");
          if (!key) throw new Error("key is required");
          const bytes = await hmac(algorithm, key, utf8(data));
          return { op, algorithm, hex: bytesToHex(bytes), base64: bytesToBase64(bytes), base64url: b64url(bytes), bytes: bytes.length };
        }
        if (op === "id") {
          const count = Math.max(1, Math.min(20, Number(args.count ?? 1)));
          const kind = String(args.id_kind ?? "uuid7");
          const ids = Array.from({ length: count }, () => {
            if (kind === "uuid4") return crypto.randomUUID();
            if (kind === "uuid7") return uuidv7();
            if (kind === "ulid") return ulid();
            return nanoid();
          });
          return { op, kind, count, ids, id: ids[0] };
        }
        if (op === "encode") return { op, encoding: String(args.encoding ?? "base64"), result: encodeValue(data, String(args.encoding ?? "base64")) };
        if (op === "decode") return { op, encoding: String(args.encoding ?? "base64"), result: decodeValue(data.trim(), String(args.encoding ?? "base64")) };
        if (op === "jwt_decode") {
          const token = data.trim();
          if (!token) throw new Error("data must be the JWT");
          return { op, ...jwtDecode(token) };
        }
        if (op === "jwt_sign") {
          const secret = String(args.secret ?? args.key ?? "");
          if (!secret) throw new Error("secret is required");
          const payload = isObj(args.payload) ? args.payload : {};
          const alg = algorithm.toUpperCase().startsWith("HS") ? algorithm.toUpperCase() : "HS256";
          const token = await jwtSign(payload, secret, alg);
          return { op, algorithm: alg, token, ...jwtDecode(token) };
        }
        throw new Error(`unknown op "${op}"`);
      },
    },
  ];
}

export { clamp, oneLine, parseCsv };
