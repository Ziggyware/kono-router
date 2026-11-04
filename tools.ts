/**
 * ============================================================================
 * NOKEY TOOL PLANE — ASCK-T v1 (Adaptive Stochastic Control Kernel · Tools)
 * ============================================================================
 * First-class tool support for the keyless mesh: real, executable tool
 * implementations plus the learning machinery that makes them compound.
 *
 * The router already forwarded `tools` to upstreams as opaque JSON. That left
 * three gaps this module closes:
 *
 *  1. NOTHING TO CALL. A client had to bring every tool itself. The plane ships
 *     a registry of deterministic, dependency-free, network-free implementations
 *     (math, statistics, text, JSON, time, crypto, encoding, sampling) that run
 *     inside the isolate with no warm-up cost, so any model on any keyless relay
 *     instantly gains a grounded, verifiable skill set.
 *
 *  2. NOTHING LEARNED. Tool calls were fire-and-forget bytes. Every execution
 *     now updates a Beta-Bernoulli success posterior and a scalar Kalman filter
 *     over ln(latency) for the tool itself — and, in main.ts, for the
 *     (provider, model) tuple that produced the call. Evidence compounds across
 *     requests and decays with the same 6 h half-life as the routing kernel, so
 *     the mesh gets better at *tools* specifically, not just at latency.
 *
 *  3. NOTHING REPAIRED. Small free models mangle tool arguments constantly:
 *     markdown fences, prose around the JSON, single quotes, bare keys, Python
 *     literals, trailing commas, `max_tokens` truncation mid-object. The plane
 *     parses them through a graded ladder (strict → extract → single-pass
 *     repair → double-decode → scalar salvage) and validates/coerces against the
 *     declared JSON Schema. A repaired call still counts as a call — and the
 *     repair rate is itself a learned signal about the model that emitted it.
 *
 * Design rules (same as math.ts): pure and side-effect free apart from the
 * in-memory registry; O(size of input) with hard caps everywhere; zero
 * dependencies beyond ./math.ts; no `eval`, no `Function`, no network, no fs.
 * Every tool is therefore safe to expose on a public, keyless endpoint.
 *
 * References: JSON Schema 2020-12 (subset); OpenAI function calling / strict
 * mode; Anthropic tool use; Gemini function declarations; Crockford base32
 * (ULID); Box–Muller (1958); Freedman & Diaconis (1981, bin width);
 * Kalman (1960); Garivier & Moulines (2008); Wilson (1927).
 * ============================================================================
 */

import { registerToolbox } from "./toolbox/index.ts";
import {
  clamp,
  discountedPosterior,
  erf,
  logNormalQuantileMs,
  logNormalSf,
  modelSimilarity,
  normalCdf,
  normalQuantile,
  sampleBeta,
  stalenessHours,
  wilsonLowerBound,
} from "./math.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const MAX_DEPTH = 24;
/** Validation budget. The HTTP body limit is 512KB, so ~250k scalar nodes is
 *  the most any single payload can hold; the cap only stops pathological
 *  nesting/fan-out, and it reports once instead of per node. */
const MAX_NODES = 250_000;

function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** Cheap, bounded deep clone used before mutating a caller's payload. */
export function cloneJson<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => cloneJson(v, depth + 1)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v, depth + 1);
    return out as unknown as T;
  }
  return value;
}

const REGEX_CACHE = new Map<string, RegExp | null>();
function cachedRegex(pattern: string, flags = ""): RegExp | null {
  const key = `${flags}\u0000${pattern}`;
  if (REGEX_CACHE.has(key)) return REGEX_CACHE.get(key)!;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = null;
  }
  if (REGEX_CACHE.size > 512) REGEX_CACHE.clear();
  REGEX_CACHE.set(key, re);
  return re;
}

/** Bounded LRU — the plane caches compiled expressions, paths and schemas. */
class Lru<K, V> {
  #map = new Map<K, V>();
  constructor(readonly capacity: number) {}
  get(key: K): V | undefined {
    const hit = this.#map.get(key);
    if (hit !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, hit);
    }
    return hit;
  }
  set(key: K, value: V): void {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.capacity) {
      const oldest = this.#map.keys().next();
      if (!oldest.done) this.#map.delete(oldest.value);
    }
  }
  get size(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// ---------------------------------------------------------------------------
// 1. JSON SCHEMA SUBSET — validate, coerce, repair, project
// ---------------------------------------------------------------------------

export interface SchemaIssue {
  /** JSON-pointer-ish location, "" for the root. */
  path: string;
  keyword: string;
  message: string;
  /** "error" rejects the payload; "repair" means the plane fixed it. */
  severity: "error" | "repair";
}

export interface ValidateOptions {
  /** Rewrite the payload to satisfy the schema where it is lossless to do so. */
  coerce?: boolean;
  maxDepth?: number;
  /** Fill missing values from schema `default`s (implied by coerce). */
  applyDefaults?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  value: JsonValue;
  issues: SchemaIssue[];
  repaired: boolean;
  repairs: number;
}

const SUPPORTED_FORMATS: Record<string, RegExp> = {
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(([Zz])|([+-]\d{2}:?\d{2}))?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?(([Zz])|([+-]\d{2}:?\d{2}))?$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  uri: /^[a-zA-Z][a-zA-Z\d+\-.]*:\S*$/,
  "uri-reference": /^(\S*)$/,
  ipv4: /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  hostname: /^[a-zA-Z\d]([a-zA-Z\d-]{0,61}[a-zA-Z\d])?(\.[a-zA-Z\d]([a-zA-Z\d-]{0,61}[a-zA-Z\d])?)*$/,
  "json-string": /^[\s\S]*$/,
};

interface SchemaCtx {
  root: Json;
  coerce: boolean;
  defaults: boolean;
  maxDepth: number;
  nodes: number;
  limitHit: boolean;
  issues: SchemaIssue[];
  /** Every mutation the validator made, including filling declared defaults. */
  repairs: number;
  /** Mutations that repaired *damage*: filling a declared default is not one,
   *  so `repaired` stays a signal about the caller's payload rather than about
   *  how many optional keys a schema happens to declare. */
  damaged: number;
}

function issue(ctx: SchemaCtx, path: string, keyword: string, message: string, severity: SchemaIssue["severity"] = "error") {
  ctx.issues.push({ path, keyword, message, severity });
  if (severity === "repair") {
    ctx.repairs += 1;
    if (keyword !== "default") ctx.damaged += 1;
  }
}

/** Resolve a local JSON pointer (`#/$defs/Foo`). External refs are rejected. */
function resolveRef(ctx: SchemaCtx, ref: string, seen: Set<string>): Json | null {
  if (!ref.startsWith("#")) {
    issue(ctx, "", "$ref", `external $ref not supported: ${ref.slice(0, 60)}`);
    return null;
  }
  if (seen.has(ref)) {
    issue(ctx, "", "$ref", `recursive $ref cycle at ${ref.slice(0, 60)}`);
    return null;
  }
  const parts = ref.slice(1).split("/").filter((p) => p.length > 0).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: unknown = ctx.root;
  for (const part of parts) {
    if (Array.isArray(node)) node = node[Number(part)];
    else if (isPlainObject(node)) node = node[part];
    else node = undefined;
    if (node === undefined) {
      issue(ctx, "", "$ref", `unresolvable $ref ${ref.slice(0, 60)}`);
      return null;
    }
  }
  return isPlainObject(node) ? node : null;
}

function canonical(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Type coercion ladder. Returns undefined when the value cannot be coerced. */
function coerceToType(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
      if (typeof value === "string") {
        const t = value.trim().replace(/_/g, "");
        if (!t) return undefined;
        const n = Number(t);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    case "integer": {
      const n = coerceToType(value, "number");
      if (typeof n !== "number") return undefined;
      return Number.isInteger(n) ? n : Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : undefined;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
      if (typeof value === "string") {
        const t = value.trim().toLowerCase();
        if (["true", "yes", "y", "on", "1"].includes(t)) return true;
        if (["false", "no", "n", "off", "0"].includes(t)) return false;
      }
      return undefined;
    }
    case "string":
      if (typeof value === "string") return value;
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (typeof value === "boolean") return String(value);
      return undefined;
    case "null":
      if (value === null) return null;
      if (typeof value === "string" && ["", "null", "none", "nil"].includes(value.trim().toLowerCase())) return null;
      return undefined;
    case "array": {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        const t = value.trim();
        if (!t) return undefined;
        if (t.startsWith("[")) return undefined; // let the JSON repair ladder handle it
        if (t.includes(",")) return t.split(",").map((s: string) => s.trim());
        return [t];
      }
      // A bare scalar where a list was asked for is the single most common
      // small-model mistake; wrapping it is lossless and keeps the call alive.
      if (value !== null && value !== undefined && typeof value !== "object") return [value];
      return undefined;
    }
    case "object": {
      if (isPlainObject(value)) return value;
      if (typeof value === "string") return undefined; // JSON repair ladder owns this
      if (Array.isArray(value) && value.every((e) => Array.isArray(e) && e.length === 2)) {
        return Object.fromEntries(value.map(([k, v]) => [String(k), v]));
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  return t; // "string" | "boolean" | "object" | "undefined"
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (actual === type) return true;
  if (type === "number" && actual === "integer") return true;
  return false;
}

function checkValue(value: unknown, schema: unknown, path: string, ctx: SchemaCtx, depth: number, refs: Set<string>): JsonValue {
  if (++ctx.nodes > MAX_NODES) {
    if (!ctx.limitHit) {
      ctx.limitHit = true;
      issue(ctx, path, "limit", `payload exceeds ${MAX_NODES} schema nodes; deeper values were not validated`);
    }
    return value as JsonValue;
  }
  if (depth > ctx.maxDepth) {
    issue(ctx, path, "limit", `nesting deeper than ${ctx.maxDepth}`);
    return value as JsonValue;
  }
  if (schema === true || schema === undefined) return value as JsonValue;
  if (schema === false) {
    issue(ctx, path, "false schema", "no value is allowed here");
    return value as JsonValue;
  }
  if (!isPlainObject(schema)) return value as JsonValue;

  // $ref is resolved first so the target's constraints apply.
  const ref = asString(schema.$ref);
  if (ref) {
    const target = resolveRef(ctx, ref, refs);
    if (!target) return value as JsonValue;
    const nested = new Set(refs);
    nested.add(ref);
    return checkValue(value, target, path, ctx, depth, nested);
  }

  // ---- combinator keywords -------------------------------------------------
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    let current = value;
    for (const sub of schema.allOf) current = checkValue(current, sub, path, ctx, depth + 1, refs);
    value = current;
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const before = ctx.issues.length;
    let matched = false;
    let best: JsonValue = value as JsonValue;
    // Fewest damage repairs wins: a branch that fits without rewriting the
    // value describes it better than one that has to coerce it into shape.
    let bestScore = Number.POSITIVE_INFINITY;
    for (const sub of schema.anyOf) {
      const probe: SchemaCtx = { ...ctx, issues: [], repairs: 0, damaged: 0, limitHit: false };
      const out = checkValue(value, sub, path, probe, depth + 1, refs);
      const errors = probe.issues.filter((i) => i.severity === "error").length;
      if (errors === 0 && probe.damaged < bestScore) {
        bestScore = probe.damaged;
        best = out;
        matched = true;
      }
    }
    if (!matched) {
      ctx.issues.length = before;
      issue(ctx, path, "anyOf", "value does not match any branch of anyOf");
    } else {
      value = best;
    }
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const hits: JsonValue[] = [];
    for (const sub of schema.oneOf) {
      const probe: SchemaCtx = { ...ctx, issues: [], repairs: 0, damaged: 0, limitHit: false };
      const out = checkValue(value, sub, path, probe, depth + 1, refs);
      if (probe.issues.every((i) => i.severity !== "error")) hits.push(out);
    }
    if (hits.length !== 1) {
      issue(ctx, path, "oneOf", `value matched ${hits.length} of oneOf branches (exactly 1 required)`);
    } else value = hits[0];
  }
  if (schema.not !== undefined) {
    const probe: SchemaCtx = { ...ctx, issues: [], repairs: 0, damaged: 0 };
    checkValue(value, schema.not, path, probe, depth + 1, refs);
    if (probe.issues.every((i) => i.severity !== "error")) issue(ctx, path, "not", "value must not match the `not` schema");
  }

  // ---- type ----------------------------------------------------------------
  const declared = schema.type;
  const types = Array.isArray(declared) ? declared.map(String) : declared ? [String(declared)] : [];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    let fixed: unknown;
    if (ctx.coerce) {
      for (const t of types) {
        fixed = coerceToType(value, t);
        if (fixed !== undefined) {
          issue(ctx, path, "type", `coerced ${typeOf(value)} → ${t}`, "repair");
          value = fixed;
          break;
        }
      }
    }
    if (!types.some((t) => matchesType(value, t))) {
      issue(ctx, path, "type", `expected ${types.join("|")}, got ${typeOf(value)}`);
      return value as JsonValue;
    }
  }

  // ---- enum / const --------------------------------------------------------
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allowed = schema.enum.map(canonical);
    const here = canonical(value);
    if (!allowed.includes(here)) {
      let fixed = false;
      if (ctx.coerce) {
        // Case/whitespace-insensitive enum matching rescues "High" for "high".
        const want = String(value).trim().toLowerCase();
        for (const candidate of schema.enum) {
          if (typeof candidate === "string" && candidate.trim().toLowerCase() === want) {
            issue(ctx, path, "enum", `normalised enum value to ${JSON.stringify(candidate)}`, "repair");
            value = candidate;
            fixed = true;
            break;
          }
        }
      }
      if (!fixed) issue(ctx, path, "enum", `must be one of ${schema.enum.slice(0, 8).map(canonical).join(", ")}`);
    }
  }
  if (schema.const !== undefined && canonical(schema.const) !== canonical(value)) {
    if (ctx.coerce) {
      issue(ctx, path, "const", `set to required constant ${canonical(schema.const)}`, "repair");
      value = schema.const;
    } else issue(ctx, path, "const", `must equal ${canonical(schema.const)}`);
  }

  // ---- numbers -------------------------------------------------------------
  const num = asNumber(value);
  if (num !== undefined) {
    const lo = asNumber(schema.minimum);
    const hi = asNumber(schema.maximum);
    const xlo = asNumber(schema.exclusiveMinimum);
    const xhi = asNumber(schema.exclusiveMaximum);
    const floorExclusive = lo === undefined && xlo !== undefined;
    const ceilExclusive = hi === undefined && xhi !== undefined;
    const floorValue = lo ?? xlo;
    const ceilValue = hi ?? xhi;
    const belowFloor = floorValue !== undefined && (floorExclusive ? num <= floorValue : num < floorValue);
    const aboveCeil = ceilValue !== undefined && (ceilExclusive ? num >= ceilValue : num > ceilValue);
    if (belowFloor || aboveCeil) {
      const kw = belowFloor ? (floorExclusive ? "exclusiveMinimum" : "minimum") : (ceilExclusive ? "exclusiveMaximum" : "maximum");
      const limit = belowFloor ? floorValue : ceilValue;
      const target = clamp(num, lo ?? xlo ?? -Infinity, hi ?? xhi ?? Infinity);
      // An exclusive bound cannot be satisfied by clamping onto it, so only
      // inclusive violations are repaired; the rest stay honest errors.
      const repairable = ctx.coerce && Number.isFinite(target) && target !== num &&
        !(belowFloor && floorExclusive) && !(aboveCeil && ceilExclusive);
      if (repairable) {
        issue(ctx, path, kw, `clamped ${num} into range (${kw} ${limit})`, "repair");
        value = target;
      } else issue(ctx, path, kw, `${num} violates ${kw} ${limit}`);
    }
    const multiple = asNumber(schema.multipleOf);
    const nowNum = asNumber(value);
    if (multiple && multiple > 0 && nowNum !== undefined) {
      const q = nowNum / multiple;
      if (Math.abs(q - Math.round(q)) > 1e-9) issue(ctx, path, "multipleOf", `${nowNum} is not a multiple of ${multiple}`);
    }
  }

  // ---- strings -------------------------------------------------------------
  const str = asString(value);
  if (str !== undefined) {
    const minLen = asNumber(schema.minLength);
    const maxLen = asNumber(schema.maxLength);
    if (minLen !== undefined && str.length < minLen) issue(ctx, path, "minLength", `shorter than ${minLen} chars`);
    if (maxLen !== undefined && str.length > maxLen) {
      if (ctx.coerce) {
        issue(ctx, path, "maxLength", `truncated to ${maxLen} chars`, "repair");
        value = str.slice(0, maxLen);
      } else issue(ctx, path, "maxLength", `longer than ${maxLen} chars`);
    }
    const pattern = asString(schema.pattern);
    if (pattern) {
      const re = cachedRegex(pattern);
      if (!re) issue(ctx, path, "pattern", `invalid pattern in schema: ${pattern.slice(0, 60)}`);
      else if (!re.test(String(value))) issue(ctx, path, "pattern", `does not match /${pattern.slice(0, 60)}/`);
    }
    const format = asString(schema.format);
    if (format && SUPPORTED_FORMATS[format]) {
      const text = String(value);
      if (!SUPPORTED_FORMATS[format].test(text)) {
        if (format === "ipv4") {
          const octets = text.split(".").map(Number);
          if (octets.length === 4 && octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) {
            // valid
          } else issue(ctx, path, "format", `not a valid ${format}`);
        } else issue(ctx, path, "format", `not a valid ${format}`);
      }
    }
  }

  // ---- arrays --------------------------------------------------------------
  if (Array.isArray(value)) {
    const arr = value;
    const minItems = asNumber(schema.minItems);
    const maxItems = asNumber(schema.maxItems);
    if (minItems !== undefined && arr.length < minItems) issue(ctx, path, "minItems", `fewer than ${minItems} items`);
    if (maxItems !== undefined && arr.length > maxItems) {
      if (ctx.coerce) {
        issue(ctx, path, "maxItems", `trimmed to ${maxItems} items`, "repair");
        arr.length = maxItems;
      } else issue(ctx, path, "maxItems", `more than ${maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of arr) {
        const key = canonical(item);
        if (seen.has(key)) {
          issue(ctx, path, "uniqueItems", "array contains duplicates");
          break;
        }
        seen.add(key);
      }
    }
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : null;
    const items = schema.items;
    for (let i = 0; i < arr.length; i++) {
      const sub = prefix ? prefix[i] : items;
      if (sub === undefined || sub === false) {
        if (prefix && i >= prefix.length && items === undefined) continue;
        if (sub === false) issue(ctx, `${path}/${i}`, "items", "extra items are not allowed");
        continue;
      }
      arr[i] = checkValue(arr[i], sub, `${path}/${i}`, ctx, depth + 1, refs);
    }
    if (schema.contains !== undefined) {
      let found = false;
      for (const item of arr) {
        const probe: SchemaCtx = { ...ctx, issues: [], repairs: 0, damaged: 0, limitHit: false };
        checkValue(item, schema.contains, path, probe, depth + 1, refs);
        if (probe.issues.every((i) => i.severity !== "error")) {
          found = true;
          break;
        }
      }
      if (!found) issue(ctx, path, "contains", "no item matches the `contains` schema");
    }
  }

  // ---- objects -------------------------------------------------------------
  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    const patternProps = isPlainObject(schema.patternProperties) ? schema.patternProperties : {};
    const additional = schema.additionalProperties;
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    const defaults = ctx.coerce || ctx.defaults;

    for (const key of required) {
      if (value[key] !== undefined) continue;
      const sub = props[key];
      if (defaults && isPlainObject(sub) && sub.default !== undefined) {
        value[key] = cloneJson(sub.default);
        issue(ctx, `${path}/${key}`, "required", "filled from schema default", "repair");
        continue;
      }
      // Deliberately NOT filled with an empty string/array: inventing a value
      // for a required key hides the model's mistake and produces a tool call
      // that looks valid but means nothing. The error goes back to the model,
      // and the repair ladder's failure is what the tuple posterior learns from.
      void sub;
      issue(ctx, `${path}/${key}`, "required", "missing required property");
    }

    if (defaults) {
      // Models omit optional parameters constantly; a declared `default` is the
      // author's intent, so filling it beats failing the call.
      for (const [key, sub] of Object.entries(props)) {
        if (value[key] !== undefined || !isPlainObject(sub) || sub.default === undefined) continue;
        value[key] = cloneJson(sub.default);
        issue(ctx, `${path}/${key}`, "default", "filled from schema default", "repair");
      }
    }
    if (ctx.coerce) {
      // `null` for an optional key that cannot be null is a non-answer, not a
      // value: drop it so the tool sees "absent" and applies its own default.
      for (const key of Object.keys(value)) {
        if (value[key] !== null || required.includes(key)) continue;
        const sub = props[key];
        if (!isPlainObject(sub)) continue;
        const declared = Array.isArray(sub.type) ? sub.type.map(String) : sub.type ? [String(sub.type)] : [];
        if (declared.length === 0 || declared.includes("null")) continue;
        delete value[key];
        issue(ctx, `${path}/${key}`, "null", "dropped null for a non-nullable optional key", "repair");
      }
    }

    for (const [key, sub] of Object.entries(props)) {
      if (value[key] === undefined) continue;
      value[key] = checkValue(value[key], sub, `${path}/${key}`, ctx, depth + 1, refs);
    }

    const compiledPatterns: Array<[RegExp, unknown]> = [];
    for (const [pattern, sub] of Object.entries(patternProps)) {
      const re = cachedRegex(pattern);
      if (re) compiledPatterns.push([re, sub]);
    }

    const maxProps = asNumber(schema.maxProperties);
    const keys = Object.keys(value);
    if (maxProps !== undefined && keys.length > maxProps) issue(ctx, path, "maxProperties", `more than ${maxProps} properties`);

    for (const key of keys) {
      if (props[key] !== undefined) continue;
      let matchedPattern = false;
      for (const [re, sub] of compiledPatterns) {
        if (!re.test(key)) continue;
        matchedPattern = true;
        value[key] = checkValue(value[key], sub, `${path}/${key}`, ctx, depth + 1, refs);
      }
      if (matchedPattern || additional === undefined || additional === true) continue;
      if (additional === false) {
        if (ctx.coerce) {
          delete value[key];
          issue(ctx, `${path}/${key}`, "additionalProperties", "dropped undeclared property", "repair");
        } else issue(ctx, `${path}/${key}`, "additionalProperties", `undeclared property "${key}"`);
      } else if (isPlainObject(additional)) {
        value[key] = checkValue(value[key], additional, `${path}/${key}`, ctx, depth + 1, refs);
      }
    }
  }

  return value as JsonValue;
}

/** Validate (and optionally repair) a payload against a JSON Schema subset. */
export function validateJson(input: unknown, schema: unknown, options: ValidateOptions = {}): ValidationResult {
  const coerce = options.coerce ?? false;
  const ctx: SchemaCtx = {
    root: isPlainObject(schema) ? schema : {},
    coerce,
    defaults: options.applyDefaults ?? coerce,
    maxDepth: options.maxDepth ?? MAX_DEPTH,
    nodes: 0,
    limitHit: false,
    issues: [],
    repairs: 0,
    damaged: 0,
  };
  const work = coerce ? cloneJson(input) : input;
  const value = checkValue(work, schema, "", ctx, 0, new Set<string>());
  const errors = ctx.issues.filter((i) => i.severity === "error");
  return { ok: errors.length === 0, value: value as JsonValue, issues: ctx.issues, repaired: ctx.damaged > 0, repairs: ctx.repairs };
}

// ---------------------------------------------------------------------------
// 2. MODEL-EMITTED ARGUMENT PARSING — the graded repair ladder
// ---------------------------------------------------------------------------

export type ParseStrategy = "native" | "strict" | "extract" | "repair" | "double-decode" | "salvage" | "empty";

export interface ParseArgsResult {
  ok: boolean;
  value: JsonValue;
  strategy: ParseStrategy;
  repaired: boolean;
  /** Machine-readable repair steps, e.g. ["fence", "bare-keys", "truncated"]. */
  repairs: string[];
  issues: SchemaIssue[];
  error?: string;
}

/** Strip markdown fences and surrounding prose down to the JSON candidate. */
export function extractJsonCandidate(raw: string): string {
  let text = raw.trim().replace(/^\uFEFF/, "");
  const fence = text.match(/```(?:json|jsonc|javascript|js|tool|function)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const firstObj = text.search(/[[{]/);
  if (firstObj > 0) {
    const head = text.slice(0, firstObj);
    // Only strip prose: a leading "-" or digit means the payload IS a scalar.
    if (/[a-z]{3,}/i.test(head)) text = text.slice(firstObj);
  }
  const open = text[0];
  if (open === "{" || open === "[") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      else if (!inString && (ch === "{" || ch === "[")) depth++;
      else if (!inString && (ch === "}" || ch === "]")) {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > 0 && end < text.length - 1) text = text.slice(0, end + 1);
  }
  return text.trim() || raw.trim();
}

/**
 * Single-pass, string-aware JSON normaliser. Fixes the five failure families
 * small models actually produce: comments, single quotes, bare keys, non-JSON
 * literals (None/True/NaN/undefined) and truncation by `max_tokens`.
 */
export function repairJsonText(source: string): { text: string; repairs: string[] } {
  const repairs: string[] = [];
  const out: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let quote = '"';
  let i = 0;
  const n = source.length;

  const literals: Record<string, string> = {
    true: "true",
    false: "false",
    null: "null",
    none: "null",
    nil: "null",
    undefined: "null",
    nan: "null",
    infinity: "1e999",
    "-infinity": "-1e999",
  };

  const skipWs = (from: number): number => {
    let j = from;
    while (j < n && /\s/.test(source[j])) j++;
    return j;
  };

  while (i < n) {
    const ch = source[i];

    if (inString) {
      if (ch === "\\") {
        const nxt = source[i + 1];
        if (nxt === "\n") {
          repairs.push("line-continuation");
          i += 2;
          continue;
        }
        if (nxt === undefined) {
          out.push("\\\\");
          i++;
          continue;
        }
        out.push(ch, nxt);
        i += 2;
        continue;
      }
      if (ch === quote) {
        out.push('"');
        inString = false;
        i++;
        continue;
      }
      if (quote === "'" && ch === '"') {
        out.push('\\"');
        i++;
        continue;
      }
      if (ch === "\n") {
        repairs.push("raw-newline");
        out.push("\\n");
        i++;
        continue;
      }
      if (ch === "\r") {
        out.push("\\r");
        i++;
        continue;
      }
      if (ch === "\t") {
        out.push("\\t");
        i++;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        repairs.push("control-char");
        out.push(`\\u${code.toString(16).padStart(4, "0")}`);
        i++;
        continue;
      }
      out.push(ch);
      i++;
      continue;
    }

    // --- outside a string ---------------------------------------------------
    if (ch === "/" && source[i + 1] === "/") {
      repairs.push("comment");
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      repairs.push("comment");
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (ch === "'") repairs.push("single-quote");
      inString = true;
      quote = ch;
      out.push('"');
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      out.push(ch);
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const expected = stack.pop();
      if (expected && expected !== ch) repairs.push("mismatched-bracket");
      // `{"a":1,}` is the most common near-miss; drop the dangling separator.
      for (let k = out.length - 1; k >= 0; k--) {
        if (/^\s+$/.test(out[k])) continue;
        if (out[k] === ",") {
          out.splice(k, 1);
          repairs.push("trailing-comma");
        }
        break;
      }
      out.push(ch);
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      const after = skipWs(j);
      if (source[after] === ":") {
        repairs.push("bare-key");
        out.push(`"${word}"`);
        i = j;
        continue;
      }
      const mapped = literals[word.toLowerCase()];
      if (mapped) {
        if (!["true", "false", "null"].includes(word)) repairs.push("literal");
        out.push(mapped);
        i = j;
        continue;
      }
      // A bare word that is neither key nor literal: quote it as a string so
      // the payload still parses and validation can complain precisely.
      repairs.push("bare-word");
      out.push(`"${word}"`);
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    out.push(ch);
    i++;
  }

  if (inString) {
    repairs.push("unterminated-string");
    out.push('"');
  }

  if (stack.length > 0) {
    repairs.push("truncated");
    let text = out.join("");
    // Drop a dangling separator or a key with no value before closing.
    for (let pass = 0; pass < 4; pass++) {
      const trimmed = text.replace(/\s+$/, "");
      if (trimmed.endsWith(",")) {
        text = trimmed.slice(0, -1);
        continue;
      }
      if (trimmed.endsWith(":")) {
        const cut = Math.max(trimmed.lastIndexOf(","), trimmed.lastIndexOf("{"));
        text = cut > 0 ? trimmed.slice(0, cut) : trimmed.slice(0, -1);
        continue;
      }
      if (trimmed.endsWith("[") || trimmed.endsWith("{")) {
        text = trimmed.slice(0, -1);
        stack.pop();
        continue;
      }
      text = trimmed;
      break;
    }
    out.length = 0;
    out.push(text);
    while (stack.length > 0) out.push(stack.pop()!);
  }

  const repairedText = out.join("").trim();
  return { text: repairedText || "{}", repairs: [...new Set(repairs)] };
}

/** Last-ditch: harvest `"key": scalar` pairs from an otherwise hopeless blob. */
function salvageScalars(text: string): Json | null {
  const re = /["']?([A-Za-z_$][\w$-]*)["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null|none|nan)/gi;
  const out: Json = {};
  let found = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && found < 64) {
    const key = m[1];
    let raw = m[2].trim();
    if (raw.startsWith("'") && raw.endsWith("'")) raw = `"${raw.slice(1, -1).replace(/"/g, '\\"')}"`;
    const lower = raw.toLowerCase();
    let value: unknown;
    if (["none", "nan", "null"].includes(lower)) value = null;
    else if (lower === "true") value = true;
    else if (lower === "false") value = false;
    else if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw.slice(1, -1);
      }
    } else value = Number(raw);
    out[key] = value as JsonValue;
    found++;
  }
  return found > 0 ? out : null;
}

/** Parse model-emitted arguments through the graded ladder, then validate. */
export function parseToolArguments(raw: unknown, schema?: unknown, options: ValidateOptions = {}): ParseArgsResult {
  const coerce = options.coerce ?? true;

  const finish = (value: unknown, strategy: ParseStrategy, repairs: string[], error?: string): ParseArgsResult => {
    const validation = validateJson(value, schema ?? true, { ...options, coerce });
    const errors = validation.issues.filter((i) => i.severity === "error").map((i) => `${i.path || "/"} ${i.message}`);
    const ok = validation.ok && error === undefined;
    const repairNotes = validation.issues.filter((i) => i.severity === "repair").map((i) => `${i.path || "/"}:${i.keyword}`);
    return {
      ok,
      value: validation.value,
      strategy,
      repaired: repairs.length > 0 || validation.repaired,
      repairs: [...new Set([...repairs, ...repairNotes])],
      issues: validation.issues,
      error: ok ? undefined : (error ?? errors.join("; ").slice(0, 400) ?? "invalid arguments"),
    };
  };

  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    // No arguments at all is fine for a zero-property tool; a schema with
    // required keys still gets to reject it precisely.
    return finish({}, "empty", []);
  }
  if (typeof raw !== "string") return finish(raw, "native", []);

  const text = raw.trim();
  try {
    const strict: unknown = JSON.parse(text);
    if (typeof strict === "string") {
      // `"{\"a\":1}"` — the whole argument object arrived as a JSON string.
      try {
        return finish(JSON.parse(strict), "double-decode", ["double-encoded"]);
      } catch {
        /* fall through with the string itself */
      }
    }
    return finish(strict, "strict", []);
  } catch {
    /* fall through the ladder */
  }

  const candidate = extractJsonCandidate(text);
  if (candidate !== text) {
    try {
      return finish(JSON.parse(candidate), "extract", ["fence-or-prose"]);
    } catch {
      /* fall through */
    }
  }

  const { text: fixed, repairs } = repairJsonText(candidate);
  if (fixed) {
    try {
      return finish(JSON.parse(fixed), "repair", repairs);
    } catch {
      /* fall through */
    }
    try {
      const once: unknown = JSON.parse(fixed);
      if (typeof once === "string") return finish(JSON.parse(once), "double-decode", [...repairs, "double-encoded"]);
    } catch {
      /* fall through */
    }
  }

  try {
    const outer: unknown = JSON.parse(text);
    if (typeof outer === "string") return finish(JSON.parse(outer), "double-decode", ["double-encoded"]);
  } catch {
    /* fall through */
  }

  const salvaged = salvageScalars(candidate || text);
  if (salvaged) return finish(salvaged, "salvage", [...repairs, "salvaged-scalars"]);

  return {
    ok: false,
    value: {},
    strategy: "repair",
    repaired: repairs.length > 0,
    repairs,
    issues: [],
    error: `unparseable tool arguments: ${text.slice(0, 160)}`,
  };
}

// ---------------------------------------------------------------------------
// 3. TOOL REGISTRY
// ---------------------------------------------------------------------------

export type { ToolCaps, ToolContext, ToolKind, ToolSpec } from "./toolbox/types.ts";
import type { ToolCaps, ToolContext, ToolSpec } from "./toolbox/types.ts";

export interface ToolExecutionOk {
  ok: true;
  tool: string;
  result: JsonValue;
  ms: number;
  strategy: ParseStrategy;
  /** True only when the caller's payload had to be fixed; declared defaults do
   *  not count, so this is the honest "the model damaged its call" signal. */
  repaired: boolean;
  repairs: string[];
  issues: SchemaIssue[];
  truncated: boolean;
  bytes: number;
}

export interface ToolExecutionErr {
  ok: false;
  tool: string | null;
  code: "UNKNOWN_TOOL" | "ADMIN_REQUIRED" | "INVALID_ARGUMENTS" | "TOOL_ERROR" | "TIMEOUT" | "ABORTED" | "RESULT_TOO_LARGE";
  error: string;
  ms: number;
  strategy?: ParseStrategy;
  repaired?: boolean;
  repairs?: string[];
  issues?: SchemaIssue[];
  suggestions?: Array<{ name: string; score: number }>;
}

export type ToolExecution = ToolExecutionOk | ToolExecutionErr;

const REGISTRY = new Map<string, ToolSpec>();
const ALIASES = new Map<string, string>();
/** Underscore-collapsed index: `MathEvaluate`, `math-evaluate` and
 *  `math_evaluate` are the same tool, and similarity matching cannot see that. */
const SQUASHED = new Map<string, string>();

/** Canonical wire-safe form: `router.health`, `router-health` and
 *  `RouterHealth` all collapse to `router_health`. */
export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

export function defineTool(spec: ToolSpec): ToolSpec {
  const canonical = normalizeToolName(spec.name);
  if (!/^[a-z0-9_]{1,64}$/.test(canonical)) throw new Error(`invalid tool name: ${spec.name}`);
  return { ...spec, name: canonical };
}

export function registerTool(spec: ToolSpec): ToolSpec {
  const tool = defineTool(spec);
  REGISTRY.set(tool.name, tool);
  ALIASES.set(tool.name, tool.name);
  SQUASHED.set(tool.name.replace(/_/g, ""), tool.name);
  for (const alias of spec.aliases ?? []) {
    const key = normalizeToolName(alias);
    if (!key) continue;
    SQUASHED.set(key.replace(/_/g, ""), tool.name);
    if (!REGISTRY.has(key)) ALIASES.set(key, tool.name);
  }
  return tool;
}

export function registerTools(specs: ToolSpec[]): ToolSpec[] {
  return specs.map(registerTool);
}

export function unregisterTool(name: string): boolean {
  const canonical = normalizeToolName(name);
  const existing = REGISTRY.get(canonical);
  if (!existing) return false;
  REGISTRY.delete(canonical);
  for (const [alias, target] of [...ALIASES]) if (target === canonical) ALIASES.delete(alias);
  for (const [key, target] of [...SQUASHED]) if (target === canonical) SQUASHED.delete(key);
  return Boolean(existing);
}

export function listTools(): ToolSpec[] {
  return [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getTool(name: string): ToolSpec | undefined {
  return REGISTRY.get(normalizeToolName(name));
}

/** Exact → alias → dotted/camel variants → fuzzy (trigram-Dice + Jaccard). */
export function resolveTool(name: string): { tool?: ToolSpec; suggestions: Array<{ name: string; score: number }> } {
  const canonical = normalizeToolName(name);
  const direct = REGISTRY.get(canonical);
  if (direct) return { tool: direct, suggestions: [] };
  const viaAlias = ALIASES.get(canonical);
  if (viaAlias) {
    const tool = REGISTRY.get(viaAlias);
    if (tool) return { tool, suggestions: [] };
  }
  // Punctuation-collapsed exact hit (camelCase, PascalCase, kebab-case).
  const squashed = SQUASHED.get(canonical.replace(/_/g, ""));
  if (squashed) {
    const tool = REGISTRY.get(squashed);
    if (tool) return { tool, suggestions: [] };
  }
  // Unique prefix: a name cut short by a token limit is still unambiguous.
  if (canonical.length >= 6) {
    const prefixed = [...REGISTRY.values()].filter((t) => t.name.startsWith(canonical));
    if (prefixed.length === 1) return { tool: prefixed[0], suggestions: [] };
  }
  const scored = [...REGISTRY.values()]
    .map((tool) => ({
      tool,
      score: Math.max(
        modelSimilarity(canonical, tool.name),
        ...(tool.aliases ?? []).map((a) => modelSimilarity(canonical, normalizeToolName(a))),
        canonical.includes("_") ? modelSimilarity(canonical.split("_").pop() ?? "", tool.name.split("_").pop() ?? "") * 0.9 : 0,
      ),
    }))
    .filter((x) => x.score >= 0.62)
    .sort((a, b) => b.score - a.score);
  if (scored.length > 0 && scored[0].score >= 0.82) {
    return { tool: scored[0].tool, suggestions: scored.slice(0, 3).map((s) => ({ name: s.tool.name, score: Number(s.score.toFixed(3)) })) };
  }
  return { suggestions: scored.slice(0, 3).map((s) => ({ name: s.tool.name, score: Number(s.score.toFixed(3)) })) };
}

// ---------------------------------------------------------------------------
// 4. VENDOR PROJECTIONS — one registry, every wire format
// ---------------------------------------------------------------------------

export type ToolFlavor = "openai" | "openai-strict" | "anthropic" | "gemini";

/** OpenAI strict mode rejects most numeric/string constraints and demands
 *  `additionalProperties: false` with every property required. */
export function toStrictSchema(schema: unknown): Json {
  if (Array.isArray(schema)) return { type: "array", items: toStrictSchema(schema[0] ?? {}) };
  if (!isPlainObject(schema)) return {};
  const out: Json = {};
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2 && schema.anyOf.some((b) => isPlainObject(b) && b.type === "null")) {
    // "nullable" unions: strict mode keeps anyOf but each branch must be strict.
    out.anyOf = (schema.anyOf as unknown[]).filter((b) => !(isPlainObject(b) && b.type === "null")).map(toStrictSchema);
    out.anyOf = [...(out.anyOf as unknown[]), { type: "null" }];
    if (typeof schema.description === "string") out.description = schema.description;
    return out;
  }
  if (schema.type !== undefined) out.type = schema.type;
  if (typeof schema.description === "string") out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.const !== undefined) out.const = schema.const;
  if (isPlainObject(schema.properties)) {
    const props: Json = {};
    const required: string[] = [];
    for (const [key, sub] of Object.entries(schema.properties)) {
      props[key] = toStrictSchema(sub);
      required.push(key);
    }
    out.properties = props;
    out.required = required;
    out.additionalProperties = false;
  }
  if (schema.items !== undefined) out.items = toStrictSchema(schema.items);
  if (Array.isArray(schema.prefixItems)) out.prefixItems = (schema.prefixItems as unknown[]).map(toStrictSchema);
  if (schema.$ref !== undefined) out.$ref = schema.$ref;
  if (isPlainObject(schema.$defs)) {
    const defs: Json = {};
    for (const [key, sub] of Object.entries(schema.$defs)) defs[key] = toStrictSchema(sub);
    out.$defs = defs;
  }
  return out;
}

const GEMINI_TYPE_MAP: Record<string, string> = {
  object: "OBJECT",
  array: "ARRAY",
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  null: "NULL",
};

function toGeminiSchema(schema: unknown): Json {
  if (!isPlainObject(schema)) return {};
  const out: Json = {};
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (typeof type === "string" && GEMINI_TYPE_MAP[type]) out.type = GEMINI_TYPE_MAP[type];
  if (typeof schema.description === "string") out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (isPlainObject(schema.properties)) {
    const props: Json = {};
    for (const [key, sub] of Object.entries(schema.properties)) props[key] = toGeminiSchema(sub);
    out.properties = props;
    if (Array.isArray(schema.required)) out.required = schema.required;
  }
  if (schema.items !== undefined) out.items = toGeminiSchema(schema.items);
  if (typeof schema.format === "string") out.format = schema.format;
  return out;
}

export interface ToolProjectionOptions {
  flavor?: ToolFlavor;
  names?: string[];
  includeAdmin?: boolean;
}

/** Project the registry onto a vendor's tool-call wire format. */
export function toToolSpecs(options: ToolProjectionOptions = {}): unknown[] {
  const flavor = options.flavor ?? "openai";
  const wanted = options.names?.length ? new Set(options.names.map(normalizeToolName)) : null;
  const tools = listTools().filter((t) => (options.includeAdmin ? true : !t.admin) && (!wanted || wanted.has(t.name)));
  switch (flavor) {
    case "anthropic":
      return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    case "gemini":
      return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }];
    case "openai-strict":
      return tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: toStrictSchema(t.parameters), strict: true },
      }));
    default:
      return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
}

/** The system-prompt fragment that teaches a model the plane's conventions. */
export function toolPreamble(names?: string[]): string {
  const tools = names?.length ? names.map((n) => getTool(n)?.name ?? normalizeToolName(n)) : listTools().filter((t) => !t.admin).map((t) => t.name);
  return [
    "You have server-side tools executed by the nokey-router tool plane.",
    `Available: ${tools.join(", ")}.`,
    "Call them with a single valid JSON object of arguments; the router executes them and returns the result as a tool message.",
    "Prefer tools to guessing: web_search/web_fetch for current facts, fs_* for durable files, memory_* across conversations, rag_* for large documents, calculate/data/time/crypto for exact computation.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// 5. EXECUTION SANDBOX
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  timeoutMs?: number;
  maxResultBytes?: number;
  caps?: ToolCaps;
  locals?: Json;
  now?: number;
  signal?: AbortSignal;
  /** Presenting the admin secret unlocks `admin: true` tools. */
  admin?: boolean;
  event?: (name: string, attrs?: Json) => void;
  /** Skip schema validation/coercion (used by trusted internal callers). */
  rawArgs?: boolean;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 4_000;
export const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const MAX_ARG_BYTES = 128 * 1024;

/** Recursively halve the largest arrays until the payload fits the cap. */
function capResult(value: unknown, maxBytes: number): { value: JsonValue; truncated: boolean; bytes: number } {
  let text = safeStringify(value);
  if (utf8Bytes(text) <= maxBytes) return { value: value as JsonValue, truncated: false, bytes: utf8Bytes(text) };

  let current: unknown = value;
  for (let pass = 0; pass < 6; pass++) {
    let cut = false;
    const walk = (node: unknown): unknown => {
      if (Array.isArray(node)) {
        if (node.length > 8) {
          cut = true;
          const keep = Math.max(8, Math.floor(node.length / 2));
          const head = node.slice(0, keep).map(walk);
          head.push({ __truncated__: node.length - keep });
          return head;
        }
        return node.map(walk);
      }
      if (isPlainObject(node)) {
        const out: Json = {};
        for (const [k, v] of Object.entries(node)) out[k] = walk(v);
        return out;
      }
      if (typeof node === "string" && node.length > 2048) {
        cut = true;
        return `${node.slice(0, 2048)}…[${node.length - 2048} more chars]`;
      }
      return node;
    };
    current = walk(current);
    text = safeStringify(current);
    if (utf8Bytes(text) <= maxBytes || !cut) break;
  }

  if (utf8Bytes(text) > maxBytes) {
    const preview = text.slice(0, Math.max(512, maxBytes - 256));
    return {
      value: { truncated: true, bytes: utf8Bytes(text), preview: `${preview}…` },
      truncated: true,
      bytes: utf8Bytes(text),
    };
  }
  return { value: current as JsonValue, truncated: true, bytes: utf8Bytes(text) };
}

export function safeStringify(value: unknown, maxBytes = 8 * 1024 * 1024): string {
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return String(v);
      if (typeof v === "number" && !Number.isFinite(v)) return null;
      if (v && typeof v === "object") {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
      }
      return v;
    }) ?? "null";
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}…` : text;
  } catch {
    return String(value);
  }
}

/** Execute one tool call end-to-end: resolve → repair → validate → run → cap. */
export async function executeTool(name: string, rawArgs: unknown, options: ExecuteOptions = {}): Promise<ToolExecution> {
  const started = performance.now();
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));

  const { tool, suggestions } = resolveTool(name);
  if (!tool) {
    // The nearest names go in the message too, not only in the structured
    // field: a model retrying from the text alone still gets the correction.
    const hint = suggestions.length > 0 ? `; did you mean ${suggestions.slice(0, 3).map((x) => `"${x.name}"`).join(", ")}?` : "";
    return {
      ok: false,
      tool: null,
      code: "UNKNOWN_TOOL",
      error: `unknown tool "${String(name).slice(0, 64)}"${hint}`,
      ms: elapsed(),
      suggestions,
    };
  }
  if (tool.admin && !options.admin) {
    return { ok: false, tool: tool.name, code: "ADMIN_REQUIRED", error: `${tool.name} requires the admin secret`, ms: elapsed() };
  }

  if (typeof rawArgs === "string" && utf8Bytes(rawArgs) > MAX_ARG_BYTES) {
    return { ok: false, tool: tool.name, code: "INVALID_ARGUMENTS", error: `arguments exceed ${MAX_ARG_BYTES} bytes`, ms: elapsed(), strategy: "strict" };
  }

  const parsed = options.rawArgs && isPlainObject(rawArgs)
    ? { ok: true, value: rawArgs as JsonValue, strategy: "native" as ParseStrategy, repaired: false, repairs: [], issues: [] }
    : parseToolArguments(rawArgs, tool.parameters, { coerce: true });
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return {
      ok: false,
      tool: tool.name,
      code: "INVALID_ARGUMENTS",
      error: parsed.error ?? "invalid arguments",
      ms: elapsed(),
      strategy: parsed.strategy,
      repaired: parsed.repaired,
      repairs: parsed.repairs,
      issues: parsed.issues.filter((i) => i.severity === "error"),
    };
  }

  // Per-tool deadlines are the default; a caller may tighten but not extend them.
  const toolTimeout = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const timeoutMs = Math.min(options.timeoutMs ?? toolTimeout, toolTimeout);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error("TOOL_TIMEOUT")), timeoutMs);
  const ctx: ToolContext = {
    signal: ctrl.signal,
    now: options.now ?? Date.now(),
    deadlineMs: performance.now() + timeoutMs,
    caps: options.caps,
    locals: options.locals ?? {},
    event: options.event,
  };

  // The deadline promise is armed BEFORE the tool starts, so its rejection is
  // queued first: a tool that resolves politely on abort cannot win the race.
  const deadline = new Promise<never>((_resolve, reject) => {
    ctrl.signal.addEventListener("abort", () => reject(ctrl.signal.reason ?? new Error("TOOL_TIMEOUT")), { once: true });
  });
  try {
    const work = Promise.resolve().then(() => tool.run(parsed.value as Json, ctx));
    const result = await Promise.race([deadline, work]);
    const capped = capResult(result, maxResultBytes);
    return {
      ok: true,
      tool: tool.name,
      result: capped.value,
      ms: elapsed(),
      strategy: parsed.strategy,
      repaired: parsed.repaired,
      repairs: parsed.repairs,
      issues: parsed.issues,
      truncated: capped.truncated,
      bytes: capped.bytes,
    };
  } catch (err) {
    const aborted = ctrl.signal.aborted;
    const reason = ctrl.signal.reason;
    const timedOut = aborted && (reason instanceof Error ? /TOOL_TIMEOUT/.test(reason.message) : true);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      tool: tool.name,
      code: timedOut ? "TIMEOUT" : aborted || /CLIENT_DISCONNECTED|aborted/i.test(message) ? "ABORTED" : "TOOL_ERROR",
      error: message.slice(0, 400),
      ms: elapsed(),
      strategy: parsed.strategy,
      repaired: parsed.repaired,
      repairs: parsed.repairs,
      issues: parsed.issues,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuter);
  }
}

/** Execute several calls at once (parallel tool calls), preserving order. */
// Tools that read or write tenant state. A batch may legitimately be
// `fs_write` then `fs_read` (or `memory_write` then `memory_recall`), so these
// run in call order while purely functional calls stay parallel.
const STATEFUL_TOOL = /^(?:fs_|memory_|rag_|clipboard$|task$)/;

/** True when a call reads or writes tenant state and must keep call order
 *  relative to other stateful calls in the same batch. */
export function isStatefulTool(name: string): boolean {
  return STATEFUL_TOOL.test(normalizeToolName(name));
}

export async function executeToolCalls(
  calls: Array<{ id?: string; name?: string; arguments?: unknown }>,
  options: ExecuteOptions = {},
): Promise<Array<{ id?: string; name: string; execution: ToolExecution }>> {
  const budget = Math.max(1, Math.min(32, calls.length));
  let tail: Promise<unknown> = Promise.resolve();
  const results = calls.slice(0, budget).map((call) => {
    const name = call.name ?? "";
    const run = async () => {
      const execution = await executeTool(name, call.arguments, options);
      return { id: call.id, name: execution.tool ?? (normalizeToolName(name) || name), execution };
    };
    if (!isStatefulTool(name)) return run();
    const ordered = tail.then(run);
    tail = ordered.catch(() => undefined);
    return ordered;
  });
  return Promise.all(results);
}

/** Shape a tool execution into the OpenAI `role: "tool"` message body. */
export function toolResultContent(execution: ToolExecution): string {
  if (execution.ok) {
    return safeStringify(execution.result, DEFAULT_MAX_RESULT_BYTES);
  }
  return safeStringify({
    error: execution.error,
    code: execution.code,
    ...(execution.suggestions?.length ? { did_you_mean: execution.suggestions.map((s) => s.name) } : {}),
    ...(execution.issues?.length ? { issues: execution.issues.slice(0, 8).map((i) => `${i.path || "/"} ${i.message}`) } : {}),
  });
}

// ---------------------------------------------------------------------------
// 6. SKILL MEMORY — the compounding part
// ---------------------------------------------------------------------------

// The kernel's Kalman filter clamps its mean to a TTFT-shaped range
// (50ms–300s) because network latency never legitimately lands below it. Tool
// executions do: a pure computation finishes in tens of microseconds. The
// plane therefore runs the same Bayesian update with tool-scale bounds.
export const TOOL_KALMAN_Q = 0.05;
export const TOOL_KALMAN_R = 0.15;
const TOOL_LOG_MIN = Math.log(0.02);
const TOOL_LOG_MAX = Math.log(120_000);

interface LatencyState {
  mu: number;
  variance: number;
  updatedAtMs: number;
}

function observeToolLatency(state: LatencyState, ms: number, nowMs: number): LatencyState {
  const y = clamp(Math.log(Math.max(1e-3, ms)), TOOL_LOG_MIN, TOOL_LOG_MAX);
  const stale = stalenessHours(state, nowMs);
  const predicted = clamp(state.variance + TOOL_KALMAN_Q * (1 + stale), 0.01, 2.5);
  const gain = predicted / (predicted + TOOL_KALMAN_R);
  return {
    mu: clamp(state.mu + gain * (y - state.mu), TOOL_LOG_MIN, TOOL_LOG_MAX),
    variance: clamp((1 - gain) * predicted, 0.01, 2.5),
    updatedAtMs: nowMs,
  };
}

function toolPredictiveSigma(state: LatencyState, nowMs: number): number {
  const stale = stalenessHours(state, nowMs);
  return clamp(Math.sqrt(state.variance + TOOL_KALMAN_R + TOOL_KALMAN_Q * (1 + stale)), 0.1, 1.5);
}

function toolQuantileMs(mu: number, sigma: number, p: number): number {
  return Math.exp(clamp(mu + sigma * normalQuantile(p), TOOL_LOG_MIN, TOOL_LOG_MAX));
}

/** Round a sub-millisecond latency without flattening it to zero. */
function roundMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return ms >= 10 ? Math.round(ms) : Number(ms.toFixed(2));
}

export interface ToolSkillRecord {
  tool: string;
  calls: number;
  errors: number;
  repairs: number;
  /** Beta-Bernoulli success posterior, discounted toward uniform over 6 h. */
  alpha: number;
  beta: number;
  /** Kalman posterior over ln(execution ms). */
  mu_log_ms: number;
  var_log_ms: number;
  updated_at: number;
  last_ok_at: number;
  last_error: string | null;
  /** Per-error-code counters: the plane learns *how* a tool fails. */
  error_codes: Record<string, number>;
}

export function emptyToolSkill(tool: string, now: number): ToolSkillRecord {
  return {
    tool: normalizeToolName(tool),
    calls: 0,
    errors: 0,
    repairs: 0,
    alpha: 1,
    beta: 1,
    mu_log_ms: Math.log(2),
    var_log_ms: 0.9,
    updated_at: now,
    last_ok_at: 0,
    last_error: null,
    error_codes: {},
  };
}

export interface ToolObservation {
  ok: boolean;
  ms: number;
  repaired?: boolean;
  error?: string | null;
  code?: string | null;
}

/** One Bayesian update of a tool's skill record (Kalman + discounted Beta). */
export function observeToolSkill(record: ToolSkillRecord, obs: ToolObservation, now: number): ToolSkillRecord {
  const posterior = observeToolLatency(
    { mu: record.mu_log_ms, variance: clamp(record.var_log_ms, 0.01, 2.5), updatedAtMs: record.updated_at },
    Math.max(1e-3, obs.ms),
    now,
  );
  const codes = { ...record.error_codes };
  if (!obs.ok && obs.code) codes[obs.code] = Math.min(1_000_000, (codes[obs.code] ?? 0) + 1);
  return {
    ...record,
    calls: Math.min(10_000_000, record.calls + 1),
    errors: Math.min(10_000_000, record.errors + (obs.ok ? 0 : 1)),
    repairs: Math.min(10_000_000, record.repairs + (obs.repaired ? 1 : 0)),
    // Successes are worth slightly less than failures: a tool that starts
    // breaking must fall out of rotation faster than it climbs back in.
    alpha: clamp(obs.ok ? record.alpha * 0.98 + 1 : record.alpha * 0.9, 1, 60),
    beta: clamp(obs.ok ? record.beta * 0.9 : record.beta + 1.4, 1, 60),
    mu_log_ms: posterior.mu,
    var_log_ms: posterior.variance,
    updated_at: now,
    last_ok_at: obs.ok ? now : record.last_ok_at,
    last_error: obs.ok ? null : (obs.error ?? record.last_error)?.slice(0, 200) ?? null,
    error_codes: codes,
  };
}

export interface ToolSkillSummary {
  tool: string;
  calls: number;
  errors: number;
  success_rate: number;
  /** Wilson lower bound: the honest, evidence-weighted reliability floor. */
  competence: number;
  /** Thompson draw — what the router actually samples when ranking. */
  competence_draw: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  repair_rate: number;
  stale_hours: number;
  top_errors: Array<{ code: string; count: number }>;
  last_error: string | null;
}

export function skillSummary(record: ToolSkillRecord, now: number, deterministic = false): ToolSkillSummary {
  const post = discountedPosterior(record.alpha, record.beta, record.updated_at, now);
  const trials = Math.max(0, post.alpha + post.beta - 2);
  const successes = Math.max(0, post.alpha - 1);
  const state = { mu: record.mu_log_ms, variance: clamp(record.var_log_ms, 0.01, 2.5), updatedAtMs: record.updated_at };
  const sigma = toolPredictiveSigma(state, now);
  return {
    tool: record.tool,
    calls: record.calls,
    errors: record.errors,
    success_rate: record.calls > 0 ? Number(clamp((record.calls - record.errors) / record.calls, 0, 1).toFixed(4)) : 0,
    competence: Number(wilsonLowerBound(successes, Math.max(1, trials)).toFixed(4)),
    competence_draw: Number((deterministic ? wilsonLowerBound(successes, Math.max(1, trials)) : sampleBeta(post.alpha, post.beta)).toFixed(4)),
    p50_ms: roundMs(toolQuantileMs(record.mu_log_ms, sigma, 0.5)),
    p95_ms: roundMs(toolQuantileMs(record.mu_log_ms, sigma, 0.95)),
    p99_ms: roundMs(toolQuantileMs(record.mu_log_ms, sigma, 0.99)),
    repair_rate: record.calls > 0 ? Number(clamp(record.repairs / record.calls, 0, 1).toFixed(4)) : 0,
    stale_hours: Number(((now - (record.updated_at || now)) / 3_600_000).toFixed(2)),
    top_errors: Object.entries(record.error_codes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, count]) => ({ code, count })),
    last_error: record.last_error,
  };
}

// --- per-(provider, model) tool competence ---------------------------------
// Kept as a plain struct so it can live inside the existing MeshModelRecord
// without a KV migration: absent fields simply read as "no evidence yet".

export interface TupleToolStats {
  tool_alpha?: number;
  tool_beta?: number;
  tool_pulls?: number;
  tool_repairs?: number;
  tool_last_at?: number;
}

export interface TupleToolObservation {
  /** The tuple produced a well-formed, schema-valid tool call. */
  valid: boolean;
  /** Arguments only parsed after the repair ladder intervened. */
  repaired?: boolean;
}

export function observeTupleToolStats(record: TupleToolStats, obs: TupleToolObservation, now: number): Required<Pick<TupleToolStats, "tool_alpha" | "tool_beta" | "tool_pulls" | "tool_repairs" | "tool_last_at">> {
  const alpha = record.tool_alpha ?? 1;
  const beta = record.tool_beta ?? 1;
  return {
    // A repaired-but-valid call is a half success: the intent was right, the
    // wire format was not. That is exactly the signal worth compounding.
    tool_alpha: clamp(obs.valid ? alpha * 0.97 + (obs.repaired ? 0.6 : 1) : alpha * 0.92, 1, 40),
    tool_beta: clamp(obs.valid ? beta * 0.92 : beta + (obs.repaired ? 0.8 : 1.4), 1, 40),
    tool_pulls: Math.min(1_000_000, (record.tool_pulls ?? 0) + 1),
    tool_repairs: Math.min(1_000_000, (record.tool_repairs ?? 0) + (obs.repaired ? 1 : 0)),
    tool_last_at: now,
  };
}

/** Score contribution for tool-bearing requests. 0 without evidence, so the
 *  generic UCB term still drives exploration of unproven tuples. */
export function toolRoutingBonus(
  stats: TupleToolStats,
  options: { deterministic?: boolean; now: number; weight?: number } = { now: Date.now() },
): number {
  const pulls = stats.tool_pulls ?? 0;
  if (pulls <= 0) return 0;
  const weight = options.weight ?? 0.14;
  const post = discountedPosterior(stats.tool_alpha ?? 1, stats.tool_beta ?? 1, stats.tool_last_at ?? options.now, options.now);
  const draw = options.deterministic
    ? wilsonLowerBound(Math.max(0, post.alpha - 1), Math.max(1, post.alpha + post.beta - 2))
    : sampleBeta(post.alpha, post.beta);
  return Number(((draw - 0.5) * weight).toFixed(5));
}

/** Learned reliability of a tuple specifically at emitting valid tool calls. */
export function tupleToolCompetence(stats: TupleToolStats, now: number): number {
  const pulls = stats.tool_pulls ?? 0;
  if (pulls <= 0) return 0;
  const post = discountedPosterior(stats.tool_alpha ?? 1, stats.tool_beta ?? 1, stats.tool_last_at ?? now, now);
  return Number(wilsonLowerBound(Math.max(0, post.alpha - 1), Math.max(1, post.alpha + post.beta - 2)).toFixed(4));
}

// ---------------------------------------------------------------------------
// 7. CALL PARTITIONING — which tool calls does the router own?
// ---------------------------------------------------------------------------

export interface NormalizedToolCall {
  id: string;
  index: number;
  name: string;
  arguments: string;
  /** Set when the name resolves in the plane's registry. */
  builtin: boolean;
  /** Canonical registry name (differs from `name` for aliases/misspellings). */
  resolved?: string;
}

/** Normalise a completion's tool_calls into a stable, wire-safe shape. */
export function normalizeToolCalls(calls: unknown[]): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  calls.forEach((raw, i) => {
    if (!isPlainObject(raw)) return;
    const fn = isPlainObject(raw.function) ? raw.function : raw;
    const name = asString(fn.name) ?? "";
    if (!name) return;
    const resolved = resolveTool(name).tool?.name;
    let args = fn.arguments;
    if (args === undefined || args === null) args = isPlainObject(fn.parameters) ? fn.parameters : {};
    out.push({
      id: asString(raw.id) ?? `call_${i}_${Math.random().toString(36).slice(2, 10)}`,
      index: asNumber(raw.index) ?? i,
      name,
      arguments: typeof args === "string" ? args : safeStringify(args),
      builtin: Boolean(resolved),
      resolved,
    });
  });
  return out;
}

export interface ToolCallPartition {
  /** Calls the plane can execute itself. */
  mine: NormalizedToolCall[];
  /** Calls that belong to the client and must be returned untouched. */
  theirs: NormalizedToolCall[];
}

/** The router only self-executes when it owns *every* call in the response:
 *  returning a mix of executed and unexecuted calls would break the OpenAI
 *  contract (the client must answer all of them). */
export interface PartitionOptions {
  /** Names the *caller* declared itself. A client tool that shadows a built-in
   *  stays the client's: the plane never hijacks a caller's own API, even when
   *  the model spells the name exactly like a built-in. */
  clientNames?: Iterable<string>;
}

export function partitionToolCalls(calls: unknown[], options: PartitionOptions = {}): ToolCallPartition {
  const shadowed = new Set<string>();
  for (const raw of options.clientNames ?? []) {
    const key = normalizeToolName(String(raw));
    if (key) shadowed.add(key);
  }
  const normalized = normalizeToolCalls(calls);
  const isMine = (c: NormalizedToolCall): boolean => c.builtin && !shadowed.has(normalizeToolName(c.name));
  const mine = normalized.filter(isMine);
  const theirs = normalized.filter((c) => !isMine(c));
  // All-or-nothing per round: executing half of a parallel batch would leave
  // the caller to reconcile a partial assistant turn.
  return theirs.length > 0 ? { mine: [], theirs: normalized } : { mine, theirs: [] };
}

/** Merge client-declared tools with the plane's built-ins, de-duplicated. */
export function mergeToolDeclarations(clientTools: unknown[], options: { names?: string[]; flavor?: ToolFlavor } = {}): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const push = (name: string, spec: unknown) => {
    const key = normalizeToolName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(spec);
  };
  for (const tool of clientTools ?? []) {
    if (!isPlainObject(tool)) continue;
    const fn = isPlainObject(tool.function) ? tool.function : tool;
    const name = asString(fn.name);
    if (!name) continue;
    // A client tool that shadows a built-in wins: never hijack the caller's API.
    push(name, tool);
  }
  for (const spec of toToolSpecs({ flavor: options.flavor ?? "openai", names: options.names })) {
    const s = spec as Json;
    const fn = isPlainObject(s.function) ? s.function : s;
    const name = asString(fn.name) ?? "";
    if (name && !seen.has(normalizeToolName(name))) push(name, spec);
  }
  return out;
}

/** The safe default set a request advertises with `tools: "auto"`.
 *  Chosen for agentic utility, not novelty: web, files, memory, retrieval,
 *  clipboard, planning and exact compute. Admin tools are never auto-attached. */
export const DEFAULT_AUTO_TOOLS = [
  "calculate",
  "clipboard",
  "crypto",
  "data",
  "embed",
  "fs_delete",
  "fs_grep",
  "fs_list",
  "fs_patch",
  "fs_read",
  "fs_write",
  "forge_tool",
  "http_request",
  "memory_forget",
  "memory_graph",
  "memory_recall",
  "memory_write",
  "rag_index",
  "rag_search",
  "task",
  "text",
  "time",
  "web_fetch",
  "web_search",
];

/** The default set, plus every forged tool: a tool created on the fly is
 *  pointless if the next request cannot see it. */
export function defaultAutoToolNames(): string[] {
  const forged = listTools().filter((t) => t.dynamic && !t.admin).map((t) => t.name);
  return [...new Set([...DEFAULT_AUTO_TOOLS, ...forged])];
}

export function resolveAutoToolNames(requested: unknown): string[] | null {
  if (requested === true || requested === "auto" || requested === "*") return defaultAutoToolNames();
  if (typeof requested === "string") {
    const parts = requested.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1 && ["auto", "*", "all", "true"].includes(parts[0].toLowerCase())) {
      return parts[0].toLowerCase() === "all" ? listTools().filter((t) => !t.admin).map((t) => t.name) : defaultAutoToolNames();
    }
    const resolved: string[] = [];
    for (const part of parts) {
      const tool = resolveTool(part).tool;
      if (tool && !tool.admin) resolved.push(tool.name);
    }
    return resolved.length > 0 ? [...new Set(resolved)] : null;
  }
  if (Array.isArray(requested)) {
    const resolved = requested.map((x) => (typeof x === "string" ? resolveTool(x).tool?.name : isPlainObject(x) ? getTool(String((x as Json).name ?? ""))?.name : undefined))
      .filter((x): x is string => Boolean(x));
    return resolved.length > 0 ? [...new Set(resolved)] : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 8. REGISTRATION
// ---------------------------------------------------------------------------
// The kernel owns validation, repair, sandboxing and skill memory. The toolbox
// owns capabilities. Registration is the only seam between them.

registerToolbox(registerTool, { validateJson });
