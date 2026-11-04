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

export type ToolKind = "compute" | "text" | "json" | "time" | "crypto" | "encode" | "random" | "mesh";

export interface ToolContext {
  signal: AbortSignal;
  now: number;
  deadlineMs: number;
  /** Router-injected capabilities (catalog, health, traces…). */
  locals: Json;
  /** Span hook so tool executions show up in the trace waterfall. */
  event?: (name: string, attrs?: Json) => void;
}

export interface ToolSpec {
  /** Canonical id. `^[a-z0-9_]{1,64}$` so it is valid on every vendor wire. */
  name: string;
  description: string;
  /** JSON Schema (2020-12 subset) for the arguments object. */
  parameters: Json;
  kind: ToolKind;
  /** Extra accepted spellings: dotted, kebab and camelCase variants. */
  aliases?: string[];
  /** Pure function of its arguments — safe to cache and to run in parallel. */
  deterministic?: boolean;
  /** Requires the admin secret to execute over HTTP. */
  admin?: boolean;
  timeoutMs?: number;
  /** Milliseconds of CPU this tool is allowed to spend (defaults to timeout). */
  /** Returns any JSON-serialisable value; the sandbox caps and stringifies it. */
  run: (args: Json, ctx: ToolContext) => unknown;
}

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
    "Prefer a tool over mental arithmetic, JSON surgery or guessing dates: tool output is exact.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// 5. EXECUTION SANDBOX
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  timeoutMs?: number;
  maxResultBytes?: number;
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

  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS * 4);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error("TOOL_TIMEOUT")), timeoutMs);
  const ctx: ToolContext = {
    signal: ctrl.signal,
    now: options.now ?? Date.now(),
    deadlineMs: performance.now() + timeoutMs,
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
export async function executeToolCalls(
  calls: Array<{ id?: string; name?: string; arguments?: unknown }>,
  options: ExecuteOptions = {},
): Promise<Array<{ id?: string; name: string; execution: ToolExecution }>> {
  const budget = Math.max(1, Math.min(32, calls.length));
  const results = await Promise.all(
    calls.slice(0, budget).map(async (call) => {
      const name = call.name ?? "";
      const execution = await executeTool(name, call.arguments, options);
      return { id: call.id, name: execution.tool ?? (normalizeToolName(name) || name), execution };
    }),
  );
  return results;
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

/** Which built-ins should a request advertise? `auto` = the safe default set. */
export const DEFAULT_AUTO_TOOLS = [
  "router_capabilities",
  "math_evaluate",
  "math_statistics",
  "text_similarity",
  "text_extract",
  "json_query",
  "json_validate",
  "time_convert",
  "crypto_digest",
  "encode_transform",
  "random_sample",
];

export function resolveAutoToolNames(requested: unknown): string[] | null {
  if (requested === true || requested === "auto" || requested === "*") return [...DEFAULT_AUTO_TOOLS];
  if (typeof requested === "string") {
    const parts = requested.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1 && ["auto", "*", "all", "true"].includes(parts[0].toLowerCase())) {
      return parts[0].toLowerCase() === "all" ? listTools().filter((t) => !t.admin).map((t) => t.name) : [...DEFAULT_AUTO_TOOLS];
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
// 8. BUILT-IN IMPLEMENTATIONS
// ---------------------------------------------------------------------------

// --- 8.1 expression evaluator (no eval, precedence-climbing, AST-cached) ---

type ExprNode =
  | { k: "num"; v: number }
  | { k: "var"; v: string }
  | { k: "neg"; a: ExprNode }
  | { k: "not"; a: ExprNode }
  | { k: "bin"; op: string; a: ExprNode; b: ExprNode }
  | { k: "call"; name: string; args: ExprNode[] };

const PRECEDENCE: Record<string, number> = {
  "==": 1, "!=": 1, "<": 1, "<=": 1, ">": 1, ">=": 1,
  "+": 2, "-": 2,
  "*": 3, "/": 3, "%": 3, "//": 3,
  "^": 5, "**": 5,
};
const RIGHT_ASSOC = new Set(["^", "**"]);

const CONSTANTS: Record<string, number> = {
  pi: Math.PI, π: Math.PI, tau: Math.PI * 2, e: Math.E, phi: (1 + Math.sqrt(5)) / 2,
  sqrt2: Math.SQRT2, ln2: Math.LN2, ln10: Math.LN10, log2e: Math.LOG2E, log10e: Math.LOG10E,
  inf: Infinity, infinity: Infinity,
};

function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a));
  b = Math.abs(Math.trunc(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  if (n > 170) return Infinity;
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

interface MathFns {
  [name: string]: { arity: number[]; fn: (...args: number[]) => number };
}

function buildMathFns(angleMode: "rad" | "deg"): MathFns {
  const toRad = (x: number) => (angleMode === "deg" ? (x * Math.PI) / 180 : x);
  const fromRad = (x: number) => (angleMode === "deg" ? (x * 180) / Math.PI : x);
  return {
    abs: { arity: [1], fn: Math.abs },
    sign: { arity: [1], fn: Math.sign },
    sqrt: { arity: [1], fn: Math.sqrt },
    cbrt: { arity: [1], fn: Math.cbrt },
    exp: { arity: [1], fn: Math.exp },
    expm1: { arity: [1], fn: Math.expm1 },
    ln: { arity: [1], fn: Math.log },
    log: { arity: [1, 2], fn: (x, base = 10) => (base === Math.E ? Math.log(x) : Math.log(x) / Math.log(base)) },
    log2: { arity: [1], fn: Math.log2 },
    log10: { arity: [1], fn: Math.log10 },
    log1p: { arity: [1], fn: Math.log1p },
    sin: { arity: [1], fn: (x) => Math.sin(toRad(x)) },
    cos: { arity: [1], fn: (x) => Math.cos(toRad(x)) },
    tan: { arity: [1], fn: (x) => Math.tan(toRad(x)) },
    asin: { arity: [1], fn: (x) => fromRad(Math.asin(x)) },
    acos: { arity: [1], fn: (x) => fromRad(Math.acos(x)) },
    atan: { arity: [1], fn: (x) => fromRad(Math.atan(x)) },
    atan2: { arity: [2], fn: (y, x) => fromRad(Math.atan2(y, x)) },
    sinh: { arity: [1], fn: Math.sinh },
    cosh: { arity: [1], fn: Math.cosh },
    tanh: { arity: [1], fn: Math.tanh },
    floor: { arity: [1], fn: Math.floor },
    ceil: { arity: [1], fn: Math.ceil },
    round: { arity: [1, 2], fn: (x, dp = 0) => { const f = 10 ** dp; return Math.round(x * f) / f; } },
    trunc: { arity: [1], fn: Math.trunc },
    pow: { arity: [2], fn: Math.pow },
    hypot: { arity: [1, 2, 3, 4], fn: (...xs) => Math.hypot(...xs) },
    min: { arity: [1, 2, 3, 4, 5, 6], fn: (...xs) => Math.min(...xs) },
    max: { arity: [1, 2, 3, 4, 5, 6], fn: (...xs) => Math.max(...xs) },
    clamp: { arity: [3], fn: (x, lo, hi) => clamp(x, lo, hi) },
    mod: { arity: [2], fn: (a, b) => ((a % b) + b) % b },
    gcd: { arity: [2], fn: gcd },
    lcm: { arity: [2], fn: (a, b) => (gcd(a, b) === 0 ? 0 : Math.abs(a * b) / gcd(a, b)) },
    fact: { arity: [1], fn: factorial },
    factorial: { arity: [1], fn: factorial },
    // Direct access to the ASCK kernel's statistical functions.
    erf: { arity: [1], fn: (x) => erf(x) },
    erfc: { arity: [1], fn: (x) => 1 - erf(x) },
    norm_cdf: { arity: [1], fn: (z) => normalCdf(z) },
    normal_cdf: { arity: [1], fn: (z) => normalCdf(z) },
    norm_pdf: { arity: [1, 2], fn: (x, sd = 1) => Math.exp(-(x * x) / (2 * sd * sd)) / (sd * Math.sqrt(2 * Math.PI)) },
    norm_quantile: { arity: [1], fn: (p) => normalQuantile(p) },
    normal_quantile: { arity: [1], fn: (p) => normalQuantile(p) },
    lognorm_sf: { arity: [3], fn: (t, mu, sigma) => logNormalSf(t, mu, sigma) },
    lognorm_quantile: { arity: [3], fn: (mu, sigma, p) => logNormalQuantileMs(mu, sigma, p) },
  };
}

// The ASCK kernel already exports these; the plane calls them directly so
// there is exactly one implementation of each special function in the repo.

interface Token {
  t: "num" | "id" | "op" | "(" | ")" | ",";
  v: string;
  n?: number;
}

function tokenizeExpression(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[\d.]/.test(ch)) {
      let j = i;
      while (j < n && /[\d._]/.test(src[j])) j++;
      if (j < n && (src[j] === "e" || src[j] === "E")) {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (/\d/.test(src[k] ?? "")) {
          j = k;
          while (j < n && /\d/.test(src[j])) j++;
        }
      }
      const text = src.slice(i, j).replace(/_/g, "");
      const value = Number(text);
      if (!Number.isFinite(value) && text !== "." ) throw new Error(`bad number "${text.slice(0, 24)}"`);
      tokens.push({ t: "num", v: text, n: value });
      i = j;
      continue;
    }
    if (/[A-Za-z_$π]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$π]/.test(src[j])) j++;
      tokens.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["**", "//", "==", "!=", "<=", ">="].includes(two)) {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%^<>!".includes(ch)) {
      tokens.push({ t: "op", v: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "(", v: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: ")", v: ch });
      i++;
      continue;
    }
    if (ch === "," || ch === ";") {
      tokens.push({ t: ",", v: "," });
      i++;
      continue;
    }
    throw new Error(`unexpected character "${ch}" at ${i}`);
  }
  return tokens;
}

const AST_CACHE = new Lru<string, ExprNode>(512);
const MAX_AST_NODES = 4000;

function parseExpression(src: string): ExprNode {
  const cached = AST_CACHE.get(src);
  if (cached) return cached;
  const tokens = tokenizeExpression(src);
  if (tokens.length === 0) throw new Error("empty expression");
  if (tokens.length > MAX_AST_NODES) throw new Error(`expression too long (${tokens.length} tokens)`);
  let pos = 0;
  let nodes = 0;

  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  const parsePrimary = (): ExprNode => {
    const tok = peek();
    if (!tok) throw new Error("unexpected end of expression");
    if (tok.t === "num") {
      eat();
      nodes++;
      return { k: "num", v: tok.n ?? 0 };
    }
    if (tok.t === "(") {
      eat();
      const inner = parseBinary(1);
      if (peek()?.t !== ")") throw new Error("missing closing parenthesis");
      eat();
      return inner;
    }
    if (tok.t === "id") {
      eat();
      nodes++;
      if (peek()?.t === "(") {
        eat();
        const args: ExprNode[] = [];
        if (peek()?.t !== ")") {
          args.push(parseBinary(1));
          while (peek()?.t === ",") {
            eat();
            args.push(parseBinary(1));
          }
        }
        if (peek()?.t !== ")") throw new Error(`missing ) after ${tok.v}(...)`);
        eat();
        if (args.length > 8) throw new Error("too many arguments");
        return { k: "call", name: tok.v.toLowerCase(), args };
      }
      return { k: "var", v: tok.v.toLowerCase() };
    }
    throw new Error(`unexpected token "${tok.v}"`);
  };

  const parseUnary = (): ExprNode => {
    const tok = peek();
    if (tok?.t === "op" && (tok.v === "-" || tok.v === "+" || tok.v === "!")) {
      eat();
      nodes++;
      // Unary binds looser than `^` so that -3^2 === -(3^2) === -9, matching
      // mathematics and every serious calculator, but tighter than `*`.
      const next = peek();
      const operand = next?.t === "op" && ["-", "+", "!"].includes(next.v) ? parseUnary() : parseBinary(5);
      return tok.v === "-" ? { k: "neg", a: operand } : tok.v === "!" ? { k: "not", a: operand } : operand;
    }
    return parsePrimary();
  };

  const parseBinary = (minPrec: number): ExprNode => {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== "op") break;
      const prec = PRECEDENCE[tok.v];
      if (prec === undefined || prec < minPrec) break;
      eat();
      nodes++;
      if (nodes > MAX_AST_NODES) throw new Error("expression too complex");
      const right = parseBinary(RIGHT_ASSOC.has(tok.v) ? prec : prec + 1);
      left = { k: "bin", op: tok.v, a: left, b: right };
    }
    return left;
  };

  const ast = parseBinary(1);
  if (pos < tokens.length) throw new Error(`trailing input at token ${tokens[pos].v}`);
  AST_CACHE.set(src, ast);
  return ast;
}

/** Binary operator application. Division by zero yields NaN, not a throw:
 *  an expression batch reports per-item failures instead of aborting. */
function applyBinary(op: string, a: number, b: number): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? NaN : a / b;
    case "%": return b === 0 ? NaN : a % b;
    case "//": return b === 0 ? NaN : Math.trunc(a / b);
    case "^":
    case "**": return Math.pow(a, b);
    case "==": return a === b ? 1 : 0;
    case "!=": return a !== b ? 1 : 0;
    case "<": return a < b ? 1 : 0;
    case "<=": return a <= b ? 1 : 0;
    case ">": return a > b ? 1 : 0;
    case ">=": return a >= b ? 1 : 0;
    default: throw new Error(`unsupported operator "${op}"`);
  }
}

function evalNode(node: ExprNode, vars: Record<string, number>, fns: MathFns, depth = 0): number {
  if (depth > 64) throw new Error("expression nested too deeply");
  switch (node.k) {
    case "num":
      return node.v;
    case "var": {
      if (node.v in vars) return vars[node.v];
      if (node.v in CONSTANTS) return CONSTANTS[node.v];
      throw new Error(`unknown variable "${node.v}"`);
    }
    case "neg":
      return -evalNode(node.a, vars, fns, depth + 1);
    case "not":
      return evalNode(node.a, vars, fns, depth + 1) === 0 ? 1 : 0;
    case "bin":
      return applyBinary(
        node.op,
        evalNode(node.a, vars, fns, depth + 1),
        evalNode(node.b, vars, fns, depth + 1),
      );
    case "call": {
      const spec = fns[node.name];
      if (!spec) throw new Error(`unknown function "${node.name}"`);
      if (!spec.arity.includes(node.args.length)) {
        throw new Error(`${node.name}() takes ${spec.arity.join(" or ")} argument(s), got ${node.args.length}`);
      }
      const args = node.args.map((a) => evalNode(a, vars, fns, depth + 1));
      return spec.fn(...args);
    }
  }
}

/** Round for display: kills float dust (0.30000000000000004) without losing
 *  real precision, and switches to exponential only when it helps. */
export function formatNumber(value: number, precision = 12): number | string {
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return value;
  const rounded = Number(value.toPrecision(clamp(precision, 1, 17)));
  if (Object.is(rounded, -0)) return 0;
  const abs = Math.abs(rounded);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e16)) return rounded.toExponential(6);
  return rounded;
}

function evaluateOne(expression: string, vars: Record<string, number>, fns: MathFns, precision: number): JsonValue {
  try {
    const value = evalNode(parseExpression(expression), vars, fns);
    return {
      expression,
      ok: true,
      value: Number.isFinite(value) ? value : null,
      formatted: formatNumber(value, precision),
      finite: Number.isFinite(value),
    };
  } catch (err) {
    return { expression, ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- 8.2 statistics -------------------------------------------------------

export interface StatisticsResult extends Json {
  count: number;
  min: number;
  max: number;
  range: number;
  sum: number;
  mean: number;
  variance: number;
  sd: number;
  sem: number;
  cv: number;
  median: number;
  iqr: number;
  mad: number;
  skewness: number;
  kurtosis: number;
  quantiles: Record<string, number>;
  histogram: Array<{ bin_start: number; bin_end: number; count: number }>;
  outliers: Array<{ index: number; value: number }>;
  lognormal?: { mu: number; sigma: number; p50_ms: number; p95_ms: number; p99_ms: number };
}

/** Quantile with linear interpolation between closest ranks (type 7, R/NumPy default). */
export function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const q = clamp(p, 0, 1);
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function computeStatistics(values: number[], quantiles: number[], bins: number, latency: boolean): StatisticsResult {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = n > 0 ? sum / n : NaN;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const variance = n > 1 ? m2 / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const median = quantileSorted(sorted, 0.5);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  const deviations = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  // 1.4826 makes the MAD a consistent estimator of σ under normality.
  const mad = quantileSorted(deviations, 0.5) * 1.4826;
  // Population moments, then the standard small-sample corrections so the
  // numbers match NumPy/Pandas defaults (G1 skew, G2 excess kurtosis).
  const s2 = n > 0 ? m2 / n : 0;
  const b1 = s2 > 0 ? (m3 / n) / Math.pow(s2, 1.5) : 0;
  const g2 = s2 > 0 ? (m4 / n) / (s2 * s2) - 3 : 0;
  const skewness = n > 2 && s2 > 0 ? (b1 * Math.sqrt(n * (n - 1))) / (n - 2) : 0;
  const kurtosis = n > 3 && s2 > 0 ? ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6) : 0;

  const wanted = quantiles.length > 0 ? quantiles : [0.5, 0.9, 0.95, 0.99];
  const quantileOut: Record<string, number> = {};
  for (const p of wanted) quantileOut[`p${Number((p * 100).toFixed(2))}`] = quantileSorted(sorted, p);
  quantileOut.p0 = min;
  quantileOut.p100 = max;

  // Freedman–Diaconis bin width, falling back to Sturges when the IQR is 0.
  let binCount = clamp(Math.round(bins), 1, 64);
  if (!Number.isFinite(bins) || bins <= 0) {
    const width = iqr > 0 ? 2 * iqr * Math.pow(n, -1 / 3) : 0;
    binCount = clamp(width > 0 ? Math.ceil((max - min) / width) : Math.ceil(Math.log2(Math.max(2, n)) + 1), 1, 64);
  }
  const histogram: Array<{ bin_start: number; bin_end: number; count: number }> = [];
  if (n > 0 && Number.isFinite(min) && Number.isFinite(max)) {
    const span = max - min || 1;
    const step = span / binCount;
    for (let b = 0; b < binCount; b++) histogram.push({ bin_start: min + b * step, bin_end: min + (b + 1) * step, count: 0 });
    for (const v of values) {
      const idx = clamp(Math.floor((v - min) / step), 0, binCount - 1);
      histogram[idx].count++;
    }
  }

  // Tukey fences when the IQR is informative. A constant-ish sample has
  // IQR = 0 (and often MAD = 0), where fences would flag nothing at all, so
  // fall back to the modified z-score with a mean-absolute-deviation scale —
  // the standard robust fix for the degenerate case.
  const outliers: Array<{ index: number; value: number }> = [];
  if (iqr > 0) {
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;
    values.forEach((v, index) => {
      if ((v < lowerFence || v > upperFence) && outliers.length < 64) outliers.push({ index, value: v });
    });
  } else if (n > 2) {
    const absDev = values.map((v) => Math.abs(v - median));
    const scale = mad > 0 ? mad / 1.4826 : absDev.reduce((a, b) => a + b, 0) / n;
    if (scale > 0) {
      values.forEach((v, index) => {
        if (Math.abs(0.6745 * (v - median)) / scale > 3.5 && outliers.length < 64) outliers.push({ index, value: v });
      });
    }
  }

  const result: StatisticsResult = {
    count: n,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    range: Number.isFinite(min) && Number.isFinite(max) ? max - min : 0,
    sum,
    mean,
    variance,
    sd,
    sem: n > 0 ? sd / Math.sqrt(n) : 0,
    cv: mean !== 0 ? sd / Math.abs(mean) : 0,
    median,
    iqr,
    mad,
    skewness,
    kurtosis,
    quantiles: quantileOut,
    histogram,
    outliers,
  };

  if (latency && n > 0) {
    const positive = values.filter((v) => v > 0);
    if (positive.length > 1) {
      const logs = positive.map((v) => Math.log(v));
      const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
      const sigma = Math.sqrt(logs.reduce((a, b) => a + (b - mu) ** 2, 0) / (logs.length - 1));
      result.lognormal = {
        mu,
        sigma,
        p50_ms: Math.round(logNormalQuantileMs(mu, sigma, 0.5)),
        p95_ms: Math.round(logNormalQuantileMs(mu, sigma, 0.95)),
        p99_ms: Math.round(logNormalQuantileMs(mu, sigma, 0.99)),
      };
    }
  }
  return result;
}

// --- 8.3 text similarity --------------------------------------------------

export function levenshtein(a: string, b: string, cap = 4096): number {
  const s = a.slice(0, cap);
  const t = b.slice(0, cap);
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = new Uint32Array(t.length + 1);
  let curr = new Uint32Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

export function jaccard(a: string, b: string): number {
  const wa = tokenSet(a);
  const wb = tokenSet(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let overlap = 0;
  for (const t of wa) if (wb.has(t)) overlap++;
  return overlap / Math.max(1, wa.size + wb.size - overlap);
}

export function trigramDice(a: string, b: string): number {
  const grams = (s: string) => {
    const padded = `  ${s.toLowerCase().replace(/\s+/g, " ").trim()} `;
    const out = new Set<string>();
    for (let i = 0; i + 2 < padded.length; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const g of ga) if (gb.has(g)) overlap++;
  return (2 * overlap) / Math.max(1, ga.size + gb.size);
}

export type SimilarityAlgorithm = "combined" | "trigram" | "jaccard" | "levenshtein" | "prefix";

export function similarityScore(a: string, b: string, algorithm: SimilarityAlgorithm = "combined"): number {
  switch (algorithm) {
    case "trigram": return trigramDice(a, b);
    case "jaccard": return jaccard(a, b);
    case "levenshtein": {
      const distance = levenshtein(a, b);
      return 1 - distance / Math.max(1, Math.max(a.length, b.length));
    }
    case "prefix": {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      if (y.startsWith(x) || x.startsWith(y)) return 1;
      let shared = 0;
      while (shared < Math.min(x.length, y.length) && x[shared] === y[shared]) shared++;
      return shared / Math.max(1, Math.max(x.length, y.length));
    }
    default: return modelSimilarity(a, b);
  }
}

// --- 8.4 JSONPath-lite ----------------------------------------------------

type PathStep =
  | { t: "child"; key: string }
  | { t: "index"; i: number }
  | { t: "slice"; from?: number; to?: number; step?: number }
  | { t: "wildcard" }
  | { t: "descend"; key?: string }
  | { t: "filter"; field: string; op: string; value: string };

const PATH_CACHE = new Lru<string, PathStep[]>(1024);

export function compilePath(path: string): PathStep[] {
  const cached = PATH_CACHE.get(path);
  if (cached) return cached;
  const steps: PathStep[] = [];
  let i = 0;
  const src = path.trim();
  if (src.startsWith("$")) i = 1;

  const readQuoted = (): string => {
    const quote = src[i];
    i++;
    let out = "";
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      out += src[i];
      i++;
    }
    i++; // closing quote
    return out;
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === ".") {
      if (src[i + 1] === ".") {
        i += 2;
        if (src[i] === "*") {
          i++;
          steps.push({ t: "descend" });
        } else if (src[i] === "[") {
          steps.push({ t: "descend" });
        } else {
          let key = "";
          while (i < src.length && /[\w$-]/.test(src[i])) key += src[i++];
          steps.push({ t: "descend", key: key || undefined });
        }
        continue;
      }
      i++;
      if (src[i] === "*") {
        i++;
        steps.push({ t: "wildcard" });
        continue;
      }
      let key = "";
      while (i < src.length && /[\w$-]/.test(src[i])) key += src[i++];
      if (!key) throw new Error(`empty child key at ${i} in path`);
      steps.push({ t: "child", key });
      continue;
    }
    if (ch === "[") {
      i++;
      if (src[i] === "*") {
        i++;
        if (src[i] !== "]") throw new Error("expected ] after *");
        i++;
        steps.push({ t: "wildcard" });
        continue;
      }
      if (src[i] === "?") {
        i++;
        if (src[i] !== "(") throw new Error("expected ( after ?");
        i++;
        const close = src.indexOf(")", i);
        if (close < 0) throw new Error("unterminated filter");
        const expr = src.slice(i, close).trim();
        i = close + 1;
        if (src[i] === "]") i++;
        const m = expr.match(/^@\.?([\w$-]+)\s*(==|!=|>=|<=|~=|!~|>|<)\s*(.+)$/);
        if (!m) throw new Error(`unsupported filter "${expr.slice(0, 40)}"`);
        steps.push({ t: "filter", field: m[1], op: m[2], value: m[3].trim().replace(/^["']|["']$/g, "") });
        continue;
      }
      if (src[i] === "'" || src[i] === '"') {
        steps.push({ t: "child", key: readQuoted() });
        if (src[i] === "]") i++;
        continue;
      }
      let spec = "";
      while (i < src.length && src[i] !== "]") spec += src[i++];
      if (src[i] === "]") i++;
      spec = spec.trim();
      if (spec.includes(":")) {
        const [from, to, step] = spec.split(":");
        steps.push({
          t: "slice",
          from: from.trim() === "" ? undefined : Number(from),
          to: to.trim() === "" ? undefined : Number(to),
          step: step?.trim() ? Number(step) : undefined,
        });
        continue;
      }
      const index = Number(spec);
      if (!Number.isFinite(index)) throw new Error(`bad index "${spec.slice(0, 20)}"`);
      steps.push({ t: "index", i: index });
      continue;
    }
    // Bare identifier at the start: "items[0].id" without a leading "$".
    let key = "";
    while (i < src.length && /[\w$-]/.test(src[i])) key += src[i++];
    if (!key) throw new Error(`unexpected character "${src[i]}" at ${i}`);
    steps.push({ t: "child", key });
  }
  PATH_CACHE.set(path, steps);
  return steps;
}

function descendAll(node: unknown, key: string | undefined, out: unknown[], depth: number): void {
  if (depth > MAX_DEPTH || out.length > 5000) return;
  if (Array.isArray(node)) {
    if (key === undefined) out.push(node);
    for (const item of node) descendAll(item, key, out, depth + 1);
    return;
  }
  if (isPlainObject(node)) {
    if (key === undefined) out.push(node);
    else if (node[key] !== undefined) out.push(node[key]);
    for (const value of Object.values(node)) descendAll(value, key, out, depth + 1);
  }
}

function applyStep(step: PathStep, nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  switch (step.t) {
    case "child":
      for (const node of nodes) if (isPlainObject(node) && node[step.key] !== undefined) out.push(node[step.key]);
      break;
    case "index":
      for (const node of nodes) {
        if (!Array.isArray(node)) continue;
        const idx = step.i < 0 ? node.length + step.i : step.i;
        if (idx >= 0 && idx < node.length) out.push(node[idx]);
      }
      break;
    case "slice":
      for (const node of nodes) {
        if (!Array.isArray(node)) continue;
        const sliced = node.slice(step.from, step.to);
        if (step.step && step.step !== 1) out.push(...sliced.filter((_, i) => i % step.step! === 0));
        else out.push(...sliced);
      }
      break;
    case "wildcard":
      for (const node of nodes) {
        if (Array.isArray(node)) out.push(...node);
        else if (isPlainObject(node)) out.push(...Object.values(node));
      }
      break;
    case "descend":
      for (const node of nodes) descendAll(node, step.key, out, 0);
      break;
    case "filter": {
      const compare = (a: unknown): boolean => {
        const want = step.value;
        const numA = typeof a === "number" ? a : Number(a);
        const numB = Number(want);
        const numeric = Number.isFinite(numA) && Number.isFinite(numB) && want.trim() !== "";
        switch (step.op) {
          case "==": return numeric ? numA === numB : String(a) === want.replace(/^["']|["']$/g, "");
          case "!=": return numeric ? numA !== numB : String(a) !== want.replace(/^["']|["']$/g, "");
          case ">": return numeric && numA > numB;
          case ">=": return numeric && numA >= numB;
          case "<": return numeric && numA < numB;
          case "<=": return numeric && numA <= numB;
          case "~=": {
            const re = cachedRegex(want, "i");
            return Boolean(re && re.test(String(a ?? "")));
          }
          case "!~": {
            const re = cachedRegex(want, "i");
            return !(re && re.test(String(a ?? "")));
          }
          default: return false;
        }
      };
      for (const node of nodes) {
        if (Array.isArray(node)) {
          for (const item of node) if (isPlainObject(item) && compare(item[step.field])) out.push(item);
        } else if (isPlainObject(node) && compare(node[step.field])) out.push(node);
      }
      break;
    }
  }
  return out;
}

/** Evaluate a JSONPath-lite expression; returns every match in document order. */
export function queryJson(data: unknown, path: string): unknown[] {
  const steps = compilePath(path);
  let nodes: unknown[] = [data];
  for (const step of steps) {
    nodes = applyStep(step, nodes);
    if (nodes.length === 0) break;
  }
  return nodes;
}

function flattenJson(value: unknown, prefix = "", out: Json = {}, depth = 0): Json {
  if (depth > MAX_DEPTH) return out;
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenJson(v, `${prefix}[${i}]`, out, depth + 1));
    return out;
  }
  out[prefix || "$"] = value as JsonValue;
  return out;
}

// --- 8.5 time -------------------------------------------------------------

const TIME_UNITS_MS: Record<string, number> = {
  ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  y: 31_557_600_000, yr: 31_557_600_000, year: 31_557_600_000, years: 31_557_600_000,
};

/** Parse "1h30m", "-3d", "500 ms", "P1DT2H3M" into milliseconds. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (iso) {
    const [w, d, h, m, s] = [iso[1], iso[2], iso[3], iso[4], iso[5]].map((x) => (x ? Number(x) : 0));
    if (w + d + h + m + s === 0) return null;
    return w * TIME_UNITS_MS.w + d * TIME_UNITS_MS.d + h * TIME_UNITS_MS.h + m * TIME_UNITS_MS.m + s * 1000;
  }
  const re = /(-?\d+(?:\.\d+)?)\s*([a-zµ]+)?/gi;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const value = Number(m[1]);
    const unit = (m[2] ?? "ms").toLowerCase();
    const factor = TIME_UNITS_MS[unit];
    if (factor === undefined) return null;
    total += value * factor;
    matched++;
  }
  return matched > 0 ? total : null;
}

export function humanizeDuration(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  if (abs < 1) return `${sign}${(abs * 1000).toFixed(0)}µs`;
  if (abs < 1000) return `${sign}${abs.toFixed(abs < 10 ? 1 : 0)}ms`;
  const units: Array<[string, number]> = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]];
  const parts: string[] = [];
  let rest = abs;
  for (const [label, size] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count}${label}`);
      rest -= count * size;
    }
    if (parts.length === 3) break;
  }
  if (parts.length === 0) parts.push(`${Math.round(rest)}ms`);
  return sign + parts.join(" ");
}

/** Parse an instant from epoch numbers, ISO strings, or common date formats. */
export function parseInstant(value: unknown, from?: string): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const unit = (from ?? "auto").toLowerCase();
    const factor = unit === "auto" ? guessEpochUnit(value) : TIME_UNITS_MS[unit];
    if (factor === undefined) return null;
    return value * factor;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (/^-?\d+(\.\d+)?$/.test(text)) return parseInstant(Number(text), from);
    const iso = Date.parse(text);
    if (!Number.isNaN(iso)) return iso;
    // Relative durations are accepted as "now + duration".
    const duration = parseDuration(text);
    if (duration !== null) return Date.now() + duration;
  }
  if (value instanceof Date) return value.getTime();
  return null;
}

/** Distinguish epoch seconds from ms/µs/ns by magnitude (year 1973–2286 test). */
export function guessEpochUnit(value: number): number {
  const abs = Math.abs(value);
  if (abs < 1e11) return 1000; // seconds
  if (abs < 1e14) return 1; // milliseconds
  if (abs < 1e17) return 1e-3; // microseconds
  return 1e-6; // nanoseconds
}

function formatInZone(date: Date, timeZone?: string): { iso: string; local: string; zone: string; offset_minutes: number } {
  const iso = date.toISOString();
  let local = iso;
  let zone = "UTC";
  let offsetMinutes = 0;
  const tz = timeZone?.trim();
  try {
    if (tz) {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset",
      });
      const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
      local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}:${parts.second}`;
      zone = tz;
      const offsetText = parts.timeZoneName ?? "";
      const om = offsetText.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
      if (om) offsetMinutes = (om[1] === "-" ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] ?? 0));
      const offsetGuess = (Date.parse(`${local}Z`) - date.getTime()) / 60000;
      if (!om && Number.isFinite(offsetGuess)) offsetMinutes = Math.round(offsetGuess);
    }
  } catch {
    zone = "UTC";
  }
  return { iso, local, zone, offset_minutes: offsetMinutes };
}

// --- 8.6 encoding / crypto ------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function base64ToBytes(text: string): Uint8Array {
  const normalized = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(text: string): Uint8Array {
  const clean = text.replace(/^0x/i, "").replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("invalid hex input");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** ULID: 48-bit ms timestamp + 80 bits of randomness, Crockford base32.
 *  Monotonic within a millisecond so ids stay insertion-ordered. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let ulidLastMs = -1;
let ulidRandom = new Uint8Array(10);

export function ulid(now = Date.now()): string {
  const ms = Math.max(0, Math.trunc(now));
  if (ms === ulidLastMs) {
    // Same millisecond: bump the 80-bit random component so ids stay ordered.
    for (let i = ulidRandom.length - 1; i >= 0; i--) {
      ulidRandom[i] = (ulidRandom[i] + 1) & 0xff;
      if (ulidRandom[i] !== 0) break;
    }
  } else {
    ulidLastMs = ms;
    ulidRandom = new Uint8Array(10);
    crypto.getRandomValues(ulidRandom);
  }
  let time = "";
  let rest = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const bits: number[] = [];
  for (const byte of ulidRandom) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  let random = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    let index = 0;
    for (let j = i; j < i + 5; j++) index = index * 2 + bits[j];
    random += CROCKFORD[index];
  }
  return time + random;
}

/** xmur3 string hash + mulberry32 PRNG: tiny, fast, reproducible. */
export function seededRandom(seed: number | string): () => number {
  let h = 1779033703 ^ String(seed).length;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^ (h >>> 16)) >>> 0;
  if (a === 0) a = 0x9e3779b9;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 9. REGISTRATION OF THE BUILT-IN SET
// ---------------------------------------------------------------------------

let registered = false;

/** Idempotent: importing tools.ts gives you the full built-in plane. */
export function registerBuiltinTools(force = false): void {
  if (registered && !force) return;
  registered = true;

  registerTool({
    name: "math_evaluate",
    aliases: ["math.evaluate", "calculator", "eval", "compute"],
    kind: "compute",
    deterministic: true,
    description:
      "Evaluate arithmetic/math expressions exactly (no LLM arithmetic). Supports + - * / % // ^ **, parentheses, unary minus, comparisons (1/0), constants (pi, e, tau, phi, inf), and functions incl. sqrt, cbrt, exp, ln, log(x,base), log2, log10, sin/cos/tan (+a for arc), sinh/cosh/tanh, floor, ceil, round(x,dp), trunc, sign, pow, hypot, min, max, clamp, mod, gcd, lcm, factorial, erf, erfc, norm_cdf, norm_pdf, norm_quantile, lognorm_sf, lognorm_quantile. Batch with `expressions`.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Single expression, e.g. \"(23*19)+14\" or \"sqrt(2)/2\"." },
        expressions: { type: "array", items: { type: "string" }, maxItems: 64, description: "Batch of expressions; evaluated independently." },
        variables: { type: "object", additionalProperties: { type: "number" }, description: "Named bindings usable inside expressions." },
        angle: { type: "string", enum: ["rad", "deg"], default: "rad", description: "Unit for trig functions." },
        precision: { type: "integer", minimum: 1, maximum: 17, default: 12, description: "Significant digits for the rounded `formatted` value." },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const angle = asString(args.angle) === "deg" ? "deg" : "rad";
      const fns = buildMathFns(angle);
      const precision = clamp(asNumber(args.precision) ?? 12, 1, 17);
      const vars: Record<string, number> = {};
      if (isPlainObject(args.variables)) {
        for (const [k, v] of Object.entries(args.variables)) {
          const n = typeof v === "number" ? v : Number(v);
          if (Number.isFinite(n)) vars[normalizeToolName(k)] = n;
        }
      }
      const list: string[] = Array.isArray(args.expressions) && args.expressions.length > 0
        ? args.expressions.map(String).slice(0, 64)
        : asString(args.expression) ? [asString(args.expression)!] : [];
      if (list.length === 0) throw new Error("provide `expression` or `expressions`");
      const results = list.map((expression) => evaluateOne(expression.slice(0, 4000), vars, fns, precision));
      const first = results[0] as Json;
      return list.length === 1
        ? { ...first, angle, variables: Object.keys(vars).length }
        : { count: results.length, results, angle, variables: Object.keys(vars).length };
    },
  });

  registerTool({
    name: "math_statistics",
    aliases: ["math.statistics", "stats", "statistics", "describe"],
    kind: "compute",
    deterministic: true,
    description:
      "Descriptive statistics for a numeric sample in one pass: count, sum, mean, variance/sd/sem/cv, min/max/range, median, IQR, MAD, skewness, excess kurtosis, any quantiles (type-7 interpolation), a Freedman–Diaconis histogram and Tukey outliers. With `latency: true` it also fits a log-normal and returns p50/p95/p99 in ms — the same law the router's Kalman/hedge kernel assumes.",
    parameters: {
      type: "object",
      properties: {
        values: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 100_000, description: "Numeric sample." },
        quantiles: { type: "array", items: { type: "number", minimum: 0, maximum: 1 }, maxItems: 32, description: "Probabilities to report, e.g. [0.5,0.95,0.99]." },
        bins: { type: "integer", minimum: 1, maximum: 64, description: "Histogram bins; omit for Freedman–Diaconis." },
        latency: { type: "boolean", default: false, description: "Treat values as milliseconds and add a log-normal fit." },
      },
      required: ["values"],
      additionalProperties: false,
    },
    run: (args) => {
      const raw = Array.isArray(args.values) ? args.values : [];
      const values: number[] = [];
      for (const item of raw) {
        const n = typeof item === "number" ? item : Number(item);
        if (Number.isFinite(n)) values.push(n);
        if (values.length >= 100_000) break;
      }
      if (values.length === 0) throw new Error("`values` must contain at least one finite number");
      const quantiles = Array.isArray(args.quantiles) ? args.quantiles.map(Number).filter((q) => Number.isFinite(q)).slice(0, 32) : [];
      const stats = computeStatistics(values, quantiles, asNumber(args.bins) ?? 0, asBool(args.latency) ?? false);
      const rounded = cloneJson(stats as unknown as Json);
      const walk = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(walk);
        if (isPlainObject(node)) {
          const out: Json = {};
          for (const [k, v] of Object.entries(node)) out[k] = walk(v);
          return out;
        }
        return typeof node === "number" ? formatNumber(node, 10) : node;
      };
      return walk(rounded) as JsonValue;
    },
  });

  registerTool({
    name: "text_similarity",
    aliases: ["text.similarity", "similarity", "fuzzy_match", "nearest"],
    kind: "text",
    deterministic: true,
    description:
      "Fuzzy string matching: score two strings, or rank candidates against a query and return the top-k. Algorithms: `combined` (character-trigram Dice blended with token Jaccard — the router's own model-id matcher), `trigram`, `jaccard`, `levenshtein` (normalised edit distance), `prefix`. Use it instead of guessing which of several similar ids/names is closest.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The reference string." },
        candidate: { type: "string", description: "Single string to compare against `query`." },
        candidates: { type: "array", items: { type: "string" }, maxItems: 2000, description: "List to rank against `query`." },
        a: { type: "string", description: "Alternative to `query` for a pairwise score with `b`." },
        b: { type: "string", description: "Alternative to `candidate`." },
        algorithm: { type: "string", enum: ["combined", "trigram", "jaccard", "levenshtein", "prefix"], default: "combined" },
        k: { type: "integer", minimum: 1, maximum: 100, default: 5, description: "How many ranked matches to return." },
        min_score: { type: "number", minimum: 0, maximum: 1, description: "Drop matches below this score." },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const algorithm = (asString(args.algorithm) ?? "combined") as SimilarityAlgorithm;
      const left = asString(args.query) ?? asString(args.a) ?? "";
      const right = asString(args.candidate) ?? asString(args.b);
      const candidates = Array.isArray(args.candidates) ? args.candidates.map(String).slice(0, 2000) : null;
      const minScore = clamp(asNumber(args.min_score) ?? 0, 0, 1);
      const k = clamp(Math.round(asNumber(args.k) ?? 5), 1, 100);
      if (!left) throw new Error("provide `query` (or `a`)");
      if (candidates) {
        const scored = candidates
          .map((value, index) => ({ value, index, score: Number(similarityScore(left, value, algorithm).toFixed(4)) }))
          .filter((m) => m.score >= minScore)
          .sort((x, y) => y.score - x.score || x.index - y.index)
          .slice(0, k);
        return { query: left, algorithm, considered: candidates.length, matches: scored, best: scored[0]?.value ?? null };
      }
      if (right === undefined) throw new Error("provide `candidates`, `candidate` or `b`");
      const score = similarityScore(left, right, algorithm);
      return {
        a: left, b: right, algorithm,
        score: Number(score.toFixed(4)),
        edit_distance: algorithm === "levenshtein" ? levenshtein(left, right) : levenshtein(left.slice(0, 512), right.slice(0, 512)),
      };
    },
  });

  registerTool({
    name: "text_extract",
    aliases: ["text.extract", "regex", "grep", "extract"],
    kind: "text",
    deterministic: true,
    description:
      "Extract structured facts from text with regular expressions. Pass one `pattern` or a list of `patterns` ({name, pattern, flags, group}); returns matches with capture groups and byte offsets. Use it to pull ids, versions, URLs, numbers or emails out of a document instead of transcribing by hand.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 400_000, description: "The haystack." },
        pattern: { type: "string", description: "Single regular expression." },
        patterns: {
          type: "array", maxItems: 24,
          items: {
            type: "object",
            properties: { name: { type: "string" }, pattern: { type: "string" }, flags: { type: "string" }, group: { type: ["integer", "string"] } },
            required: ["pattern"], additionalProperties: false,
          },
        },
        flags: { type: "string", default: "g", description: "Regex flags for `pattern` (g, i, m, s, u)." },
        max: { type: "integer", minimum: 1, maximum: 500, default: 50, description: "Matches to keep per pattern." },
        unique: { type: "boolean", default: false, description: "De-duplicate identical match values." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    run: (args) => {
      const text = asString(args.text) ?? "";
      const max = clamp(Math.round(asNumber(args.max) ?? 50), 1, 500);
      const unique = asBool(args.unique) ?? false;
      const specs: Array<{ name: string; pattern: string; flags: string; group?: string | number }> = [];
      if (Array.isArray(args.patterns)) {
        for (const item of args.patterns.slice(0, 24)) {
          if (!isPlainObject(item)) continue;
          const pattern = asString(item.pattern);
          if (!pattern) continue;
          specs.push({
            name: asString(item.name) ?? `p${specs.length}`,
            pattern,
            flags: asString(item.flags) ?? "g",
            group: (typeof item.group === "number" || typeof item.group === "string") ? item.group : undefined,
          });
        }
      } else if (asString(args.pattern)) {
        specs.push({ name: "match", pattern: asString(args.pattern)!, flags: asString(args.flags) ?? "g" });
      }
      if (specs.length === 0) throw new Error("provide `pattern` or `patterns`");

      const groups: Json[] = [];
      for (const spec of specs) {
        const flags = spec.flags.includes("g") ? spec.flags : `${spec.flags}g`;
        const re = cachedRegex(spec.pattern, flags.replace("y", ""));
        if (!re) {
          groups.push({ name: spec.name, pattern: spec.pattern, ok: false, error: "invalid regular expression", matches: [] });
          continue;
        }
        re.lastIndex = 0;
        const matches: Json[] = [];
        const seen = new Set<string>();
        let m: RegExpExecArray | null;
        let guard = 0;
        while ((m = re.exec(text)) !== null && matches.length < max && guard++ < 20_000) {
          const named = m.groups ? Object.fromEntries(Object.entries(m.groups).map(([k, v]) => [k, v ?? null])) : {};
          let value = m[0];
          if (spec.group !== undefined) {
            const picked = typeof spec.group === "number" ? m[spec.group] : m.groups?.[String(spec.group)];
            if (picked !== undefined) value = picked;
          } else if (m.length > 1 && m[1] !== undefined) value = m[1];
          if (unique) {
            if (seen.has(value)) {
              if (m.index === re.lastIndex) re.lastIndex++;
              continue;
            }
            seen.add(value);
          }
          matches.push({ value, index: m.index, groups: m.length > 1 ? [...m.slice(1)].map((g) => g ?? null) : [], named });
          if (m.index === re.lastIndex) re.lastIndex++;
        }
        groups.push({ name: spec.name, pattern: spec.pattern, ok: true, count: matches.length, matches });
      }
      return { chars: text.length, patterns: groups.length, results: groups };
    },
  });

  registerTool({
    name: "json_query",
    aliases: ["json.query", "jsonpath", "query"],
    kind: "json",
    deterministic: true,
    description:
      "Read values out of a JSON document with a JSONPath-lite expression: `$`, `.child`, `['quoted child']`, `[0]`, `[-1]`, `[1:4]`, `[*]`, `.*`, recursive descent `..name` / `..*`, and filters `[?(@.field==value)]` with == != > >= < <= ~ (regex) !~. `data` may be an object, an array, or a JSON string.",
    parameters: {
      type: "object",
      properties: {
        data: { description: "JSON document (object, array or JSON string)." },
        path: { type: "string", description: "Single JSONPath-lite expression." },
        paths: { type: "array", items: { type: "string" }, maxItems: 32, description: "Several expressions at once." },
        first: { type: "boolean", default: false, description: "Return only the first match per path." },
        flatten: { type: "boolean", default: false, description: "Also return the whole document flattened to dotted keys." },
      },
      required: ["data"],
      additionalProperties: false,
    },
    run: (args) => {
      let data: unknown = args.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          const parsed = parseToolArguments(data, true);
          if (!parsed.ok) throw new Error("`data` is not valid JSON");
          data = parsed.value;
        }
      }
      const paths: string[] = Array.isArray(args.paths) && args.paths.length > 0
        ? args.paths.map(String).slice(0, 32)
        : asString(args.path) ? [asString(args.path)!] : ["$"];
      const first = asBool(args.first) ?? false;
      const results = paths.map((path) => {
        try {
          const matches = queryJson(data, path);
          return { path, ok: true, count: matches.length, matches: first ? (matches[0] ?? null) : matches.slice(0, 500) };
        } catch (err) {
          return { path, ok: false, count: 0, matches: [], error: err instanceof Error ? err.message : String(err) };
        }
      });
      const out: Json = { paths: results.length, results };
      if (paths.length === 1) {
        const single = results[0];
        out.result = single.matches;
        out.count = single.count;
        if (!single.ok) out.error = single.error;
      }
      if (asBool(args.flatten)) out.flattened = flattenJson(data);
      return out;
    },
  });

  registerTool({
    name: "json_validate",
    aliases: ["json.validate", "schema_check", "validate"],
    kind: "json",
    deterministic: true,
    description:
      "Validate a JSON document against a JSON Schema (2020-12 subset: type, enum, const, required, properties, patternProperties, additionalProperties, items/prefixItems, min/max Items, uniqueItems, minimum/maximum (+exclusive), multipleOf, minLength/maxLength, pattern, format, default, allOf/anyOf/oneOf/not, $ref/$defs). With `coerce: true` it also repairs lossless mistakes (\"5\"→5, \"true\"→true, scalar→[scalar], enum case, missing defaults) and returns the fixed document.",
    parameters: {
      type: "object",
      properties: {
        data: { description: "Document to validate (object, array, or JSON string)." },
        schema: { description: "JSON Schema object (or JSON string)." },
        coerce: { type: "boolean", default: false, description: "Repair lossless type mistakes and return the fixed value." },
      },
      required: ["data", "schema"],
      additionalProperties: false,
    },
    run: (args) => {
      const parseMaybe = (value: unknown): unknown => {
        if (typeof value !== "string") return value;
        try {
          return JSON.parse(value);
        } catch {
          const parsed = parseToolArguments(value, true);
          return parsed.ok ? parsed.value : value;
        }
      };
      const data = parseMaybe(args.data);
      const schema = parseMaybe(args.schema);
      const coerce = asBool(args.coerce) ?? false;
      const result = validateJson(data, schema, { coerce });
      return {
        ok: result.ok,
        repaired: result.repaired,
        repairs: result.repairs,
        errors: result.issues.filter((i) => i.severity === "error").slice(0, 40),
        notes: result.issues.filter((i) => i.severity === "repair").slice(0, 40),
        ...(coerce ? { value: result.value } : {}),
      };
    },
  });

  registerTool({
    name: "json_transform",
    aliases: ["json.transform", "reshape", "pick"],
    kind: "json",
    deterministic: true,
    description:
      "Reshape a JSON document without writing code: `pick` / `omit` accept JSONPath-lite expressions, `flatten` returns dotted keys, `sort_keys` orders object keys, `defaults` fills missing top-level keys, and `compact` strips nulls and empty containers.",
    parameters: {
      type: "object",
      properties: {
        data: { description: "JSON document (object, array or JSON string)." },
        pick: { type: "array", items: { type: "string" }, maxItems: 64, description: "Paths to keep." },
        omit: { type: "array", items: { type: "string" }, maxItems: 64, description: "Paths to drop." },
        flatten: { type: "boolean", default: false },
        sort_keys: { type: "boolean", default: false },
        compact: { type: "boolean", default: false },
        defaults: { type: "object", description: "Top-level keys to fill when absent." },
      },
      required: ["data"],
      additionalProperties: false,
    },
    run: (args) => {
      let data: unknown = args.data;
      if (typeof data === "string") {
        const parsed = parseToolArguments(data, true);
        if (!parsed.ok) throw new Error("`data` is not valid JSON");
        data = parsed.value;
      }
      let out: unknown = cloneJson(data);

      const omitPaths = Array.isArray(args.omit) ? args.omit.map(String).slice(0, 64) : [];
      if (omitPaths.length > 0) {
        // Collect the exact values each path resolves to, then drop them.
        const doomed = new Set<string>();
        for (const path of omitPaths) {
          try {
            for (const match of queryJson(out, path)) doomed.add(canonical(match));
          } catch {
            /* an invalid omit path must not fail the whole transform */
          }
        }
        const keyMatches = (key: string) => omitPaths.some((p) => {
          const bare = p.replace(/^\$\.?/, "");
          return key === bare || key.startsWith(`${bare}.`) || key.startsWith(`${bare}[`);
        });
        const dropDeep = (node: unknown): unknown => {
          if (Array.isArray(node)) return node.filter((item) => !doomed.has(canonical(item))).map(dropDeep);
          if (isPlainObject(node)) {
            const kept: Json = {};
            for (const [key, value] of Object.entries(node)) {
              if (keyMatches(key) || doomed.has(canonical(value))) continue;
              kept[key] = dropDeep(value) as JsonValue;
            }
            return kept;
          }
          return node;
        };
        out = dropDeep(out);
      }

      const pickPaths = Array.isArray(args.pick) ? args.pick.map(String).slice(0, 64) : [];
      if (pickPaths.length > 0) {
        const picked: Json = {};
        for (const path of pickPaths) {
          const matches = queryJson(out, path);
          const key = path.replace(/^\$\.?/, "") || path;
          picked[key] = matches.length === 1 ? (matches[0] as JsonValue) : (matches as JsonValue[]);
        }
        out = picked;
      }

      if (isPlainObject(args.defaults) && isPlainObject(out)) {
        for (const [key, value] of Object.entries(args.defaults)) if (out[key] === undefined) out[key] = cloneJson(value);
      }
      if (asBool(args.compact)) {
        const prune = (node: unknown): unknown => {
          if (Array.isArray(node)) return node.map(prune).filter((v) => !(v === null || (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0)));
          if (isPlainObject(node)) {
            const kept: Json = {};
            for (const [k, v] of Object.entries(node)) {
              const pruned = prune(v);
              if (pruned === null || pruned === undefined) continue;
              if (Array.isArray(pruned) && pruned.length === 0) continue;
              if (isPlainObject(pruned) && Object.keys(pruned).length === 0) continue;
              kept[k] = pruned as JsonValue;
            }
            return kept;
          }
          return node;
        };
        out = prune(out);
      }
      if (asBool(args.sort_keys)) {
        const sortDeep = (node: unknown): unknown => {
          if (Array.isArray(node)) return node.map(sortDeep);
          if (isPlainObject(node)) {
            const sorted: Json = {};
            for (const key of Object.keys(node).sort()) sorted[key] = sortDeep(node[key]) as JsonValue;
            return sorted;
          }
          return node;
        };
        out = sortDeep(out);
      }
      const result: Json = { value: out as JsonValue };
      if (asBool(args.flatten)) result.flattened = flattenJson(out);
      result.bytes = utf8Bytes(safeStringify(out));
      return result;
    },
  });

  registerTool({
    name: "time_convert",
    aliases: ["time.convert", "datetime", "timestamp", "now"],
    kind: "time",
    description:
      "Exact date/time arithmetic — never guess a timestamp. Convert epoch s/ms/µs/ns ↔ ISO-8601 ↔ any IANA zone (`tz`), add or subtract durations (\"1h30m\", \"-3d\", \"P1DT2H\"), diff two instants, and get the current time with `now: true`. Returns UTC plus the zoned wall clock and its offset.",
    parameters: {
      type: "object",
      properties: {
        value: { description: "Epoch number, ISO string, or duration string (relative to now)." },
        from: { type: "string", enum: ["auto", "ns", "us", "ms", "s", "m", "h", "d"], default: "auto", description: "Unit of a numeric `value`." },
        to: { type: "string", enum: ["iso", "s", "ms", "us", "ns", "human", "date", "time"], default: "iso" },
        tz: { type: "string", description: "IANA zone name, e.g. \"America/New_York\"." },
        now: { type: "boolean", default: false, description: "Use the current instant instead of `value`." },
        add: { type: "string", description: "Duration to add to the instant (\"-90m\" subtracts)." },
        diff_to: { description: "Second instant; returns the difference between `value` and this." },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const to = asString(args.to) ?? "iso";
      const tz = asString(args.tz);
      let ms: number;
      if (asBool(args.now) || args.value === undefined || args.value === null || args.value === "") {
        ms = Date.now();
      } else {
        const parsed = parseInstant(args.value, asString(args.from));
        if (parsed === null) throw new Error(`cannot parse instant: ${safeStringify(args.value).slice(0, 80)}`);
        ms = parsed;
      }
      const add = asString(args.add);
      if (add) {
        const duration = parseDuration(add);
        if (duration === null) throw new Error(`cannot parse duration: ${add.slice(0, 40)}`);
        ms += duration;
      }
      const date = new Date(ms);
      if (!Number.isFinite(date.getTime())) throw new Error("resulting instant is out of range");
      const zoned = formatInZone(date, tz);

      const out: Json = {
        unix_ms: ms,
        unix_s: Number((ms / 1000).toFixed(6)),
        iso: zoned.iso,
        utc: date.toUTCString(),
        ...(tz ? { local: zoned.local, timezone: zoned.zone, offset_minutes: zoned.offset_minutes } : {}),
      };
      switch (to) {
        case "s": out.result = Math.floor(ms / 1000); break;
        case "ms": out.result = ms; break;
        case "us": out.result = ms * 1000; break;
        case "ns": out.result = ms * 1_000_000; break;
        case "human": out.result = humanizeDuration(ms - Date.now()) + (ms < Date.now() ? " ago" : " from now"); break;
        case "date": out.result = zoned.iso.slice(0, 10); break;
        case "time": out.result = (tz ? zoned.local : zoned.iso).slice(11, 19); break;
        default: out.result = tz ? `${zoned.local} (${zoned.zone})` : zoned.iso;
      }
      out.to = to;
      if (args.diff_to !== undefined) {
        const other = parseInstant(args.diff_to);
        if (other === null) throw new Error("cannot parse `diff_to`");
        const delta = ms - other;
        out.diff = { ms: delta, seconds: Number((delta / 1000).toFixed(3)), human: humanizeDuration(delta), abs_human: humanizeDuration(Math.abs(delta)), sign: delta < 0 ? "earlier" : "later" };
      }
      return out;
    },
  });

  registerTool({
    name: "crypto_digest",
    aliases: ["crypto.digest", "hash", "sha256", "checksum"],
    kind: "crypto",
    deterministic: true,
    description:
      "Hash text with SHA-1/256/384/512 (WebCrypto) and return it hex, base64 or base64url encoded. Use it for checksums, cache keys, de-duplication and content addressing — never invent a digest.",
    parameters: {
      type: "object",
      properties: {
        data: { type: "string", maxLength: 1_000_000, description: "Text to hash (UTF-8)." },
        algorithm: { type: "string", enum: ["sha-1", "sha-256", "sha-384", "sha-512"], default: "sha-256" },
        encoding: { type: "string", enum: ["hex", "base64", "base64url", "all"], default: "hex" },
      },
      required: ["data"],
      additionalProperties: false,
    },
    run: async (args) => {
      const data = asString(args.data) ?? "";
      const algorithm = (asString(args.algorithm) ?? "sha-256").toUpperCase();
      const encoding = asString(args.encoding) ?? "hex";
      const bytes = new TextEncoder().encode(data);
      let digest: ArrayBuffer;
      try {
        digest = await crypto.subtle.digest(algorithm, bytes);
      } catch (err) {
        throw new Error(`digest failed (${algorithm}): ${err instanceof Error ? err.message : String(err)}`);
      }
      const view = new Uint8Array(digest);
      const hex = bytesToHex(view);
      const base64 = bytesToBase64(view);
      const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return {
        algorithm: algorithm.toLowerCase(),
        bytes: bytes.byteLength,
        encoding,
        ...(encoding === "all"
          ? { hex, base64, base64url }
          : { digest: encoding === "hex" ? hex : encoding === "base64" ? base64 : base64url }),
      };
    },
  });

  registerTool({
    name: "crypto_id",
    aliases: ["crypto.id", "uuid", "ulid", "nanoid", "new_id"],
    kind: "crypto",
    description:
      "Generate identifiers: `uuid` (v4), `ulid` (sortable, Crockford base32, monotonic within a millisecond), `nanoid` (custom alphabet/length) or `hex`. Returns `count` ids at once.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["uuid", "ulid", "nanoid", "hex"], default: "uuid" },
        count: { type: "integer", minimum: 1, maximum: 500, default: 1 },
        length: { type: "integer", minimum: 4, maximum: 128, default: 21, description: "Length for `nanoid`/`hex`." },
        prefix: { type: "string", maxLength: 24, description: "Prefix joined with an underscore, e.g. \"call\"." },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const kind = (asString(args.kind) ?? "uuid").toLowerCase();
      const count = clamp(Math.round(asNumber(args.count) ?? 1), 1, 500);
      const length = clamp(Math.round(asNumber(args.length) ?? 21), 4, 128);
      const prefix = asString(args.prefix)?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
      const join = (id: string) => (prefix ? `${prefix}_${id}` : id);
      const ids: string[] = [];
      const now = Date.now();
      for (let i = 0; i < count; i++) {
        switch (kind) {
          case "ulid": ids.push(join(ulid(now + Math.floor(i / 1000)))); break;
          case "nanoid": {
            const bytes = new Uint8Array(length);
            crypto.getRandomValues(bytes);
            let id = "";
            for (const b of bytes) id += B64URL_ALPHABET[b & 63];
            ids.push(join(id));
            break;
          }
          case "hex": {
            const bytes = new Uint8Array(Math.ceil(length / 2));
            crypto.getRandomValues(bytes);
            ids.push(join(bytesToHex(bytes).slice(0, length)));
            break;
          }
          default: ids.push(join(crypto.randomUUID()));
        }
      }
      return { kind, count, ids, ...(count === 1 ? { id: ids[0] } : {}) };
    },
  });

  registerTool({
    name: "encode_transform",
    aliases: ["encode.transform", "base64", "encode", "decode"],
    kind: "encode",
    deterministic: true,
    description:
      "Convert between encodings: utf8, base64, base64url, hex and percent (URL). Give `data` plus `from`/`to`; omit `to` to get every encoding of the input at once. Also reports byte/char lengths.",
    parameters: {
      type: "object",
      properties: {
        data: { type: "string", maxLength: 1_000_000 },
        from: { type: "string", enum: ["utf8", "base64", "base64url", "hex", "percent"], default: "utf8" },
        to: { type: "string", enum: ["utf8", "base64", "base64url", "hex", "percent"] },
      },
      required: ["data"],
      additionalProperties: false,
    },
    run: (args) => {
      const from = (asString(args.from) ?? "utf8").toLowerCase();
      const to = asString(args.to)?.toLowerCase();
      const raw = asString(args.data) ?? "";
      let bytes: Uint8Array;
      try {
        switch (from) {
          case "base64":
          case "base64url": bytes = base64ToBytes(raw); break;
          case "hex": bytes = hexToBytes(raw); break;
          case "percent": bytes = new TextEncoder().encode(decodeURIComponent(raw)); break;
          default: bytes = new TextEncoder().encode(raw);
        }
      } catch (err) {
        throw new Error(`decode failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = new TextDecoder().decode(bytes);
      const base64 = bytesToBase64(bytes);
      const encodings: Json = {
        utf8: text,
        base64,
        base64url: base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        hex: bytesToHex(bytes),
        percent: encodeURIComponent(text),
      };
      return {
        from, to: to ?? "all",
        result: to ? encodings[to] : encodings,
        chars: text.length,
        bytes: bytes.byteLength,
      };
    },
  });

  registerTool({
    name: "encode_jwt",
    aliases: ["encode.jwt", "jwt", "jwt_decode", "token_inspect"],
    kind: "encode",
    deterministic: true,
    description:
      "Decode a JWT's header and payload and interpret its time claims (exp/iat/nbf) — explicitly WITHOUT verifying the signature (no key, no trust). Useful to inspect an upstream token's expiry before a request fails with 401.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", maxLength: 32_768, description: "A compact-serialised JWS (header.payload.signature)." },
      },
      required: ["token"],
      additionalProperties: false,
    },
    run: (args) => {
      const token = (asString(args.token) ?? "").trim();
      const parts = token.split(".");
      if (parts.length < 2) throw new Error("not a compact JWT (expected header.payload.signature)");
      const decodePart = (part: string): JsonValue => {
        try {
          return JSON.parse(new TextDecoder().decode(base64ToBytes(part))) as JsonValue;
        } catch (err) {
          return { __decode_error__: err instanceof Error ? err.message : String(err) };
        }
      };
      const header = decodePart(parts[0]);
      const payload = decodePart(parts[1]);
      const claims = isPlainObject(payload) ? payload : {};
      const now = Date.now();
      const time = (key: string): Json | undefined => {
        const v = claims[key];
        const seconds = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(seconds)) return undefined;
        const ms = seconds * 1000;
        return { seconds, iso: new Date(ms).toISOString(), in_ms: ms - now, human: humanizeDuration(Math.abs(ms - now)) + (ms < now ? " ago" : " from now") };
      };
      return {
        verified: false,
        verification_note: "signature not checked — the plane holds no keys and makes no trust claim",
        segments: parts.length,
        header,
        payload,
        alg: isPlainObject(header) ? header.alg ?? null : null,
        typ: isPlainObject(header) ? header.typ ?? null : null,
        kid: isPlainObject(header) ? header.kid ?? null : null,
        issuer: claims.iss ?? null,
        subject: claims.sub ?? null,
        audience: claims.aud ?? null,
        issued_at: time("iat") ?? null,
        not_before: time("nbf") ?? null,
        expires_at: time("exp") ?? null,
        expired: typeof claims.exp === "number" ? claims.exp * 1000 < now : null,
      };
    },
  });

  registerTool({
    name: "random_sample",
    aliases: ["random.sample", "sample", "shuffle", "random"],
    kind: "random",
    deterministic: true,
    description:
      "Reproducible randomness. With a `seed` the output is deterministic, so an experiment can be re-run exactly. Draws from `uniform`, `normal` (Box–Muller), `exponential`, `beta` or `gumbel`; or samples/shuffles a provided `population` with or without replacement.",
    parameters: {
      type: "object",
      properties: {
        seed: { type: ["string", "number"], description: "Seed for reproducibility; omit for crypto randomness." },
        count: { type: "integer", minimum: 1, maximum: 10_000, default: 1 },
        distribution: { type: "string", enum: ["uniform", "normal", "exponential", "beta", "gumbel"], default: "uniform" },
        min: { type: "number", default: 0 },
        max: { type: "number", default: 1 },
        mean: { type: "number", default: 0 },
        sd: { type: "number", default: 1, exclusiveMinimum: 0 },
        alpha: { type: "number", default: 2, exclusiveMinimum: 0 },
        beta: { type: "number", default: 2, exclusiveMinimum: 0 },
        population: { type: "array", maxItems: 100_000, description: "Values to sample or shuffle." },
        replace: { type: "boolean", default: false, description: "Sample with replacement." },
        shuffle: { type: "boolean", default: false, description: "Fisher–Yates shuffle of `population`." },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const count = clamp(Math.round(asNumber(args.count) ?? 1), 1, 10_000);
      const distribution = (asString(args.distribution) ?? "uniform").toLowerCase();
      const seed = args.seed;
      const rand = seed === undefined || seed === null || seed === "" ? Math.random : seededRandom(seed as number | string);
      const min = asNumber(args.min) ?? 0;
      const max = asNumber(args.max) ?? 1;
      const mean = asNumber(args.mean) ?? 0;
      const sd = Math.max(1e-9, asNumber(args.sd) ?? 1);
      const alpha = Math.max(1e-6, asNumber(args.alpha) ?? 2);
      const betaParam = Math.max(1e-6, asNumber(args.beta) ?? 2);

      const population = Array.isArray(args.population) ? args.population.slice(0, 100_000) : null;
      if (population) {
        if (asBool(args.shuffle)) {
          const arr = [...population];
          for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          return { seed: seed ?? null, operation: "shuffle", count: arr.length, values: arr as JsonValue[] };
        }
        const replace = asBool(args.replace) ?? false;
        const want = Math.min(count, replace ? count : population.length);
        if (!replace && count > population.length) {
          return { seed: seed ?? null, operation: "sample", replace, requested: count, available: population.length, error: "population smaller than count (use replace: true)" };
        }
        const picked: unknown[] = [];
        if (replace) {
          for (let i = 0; i < want; i++) picked.push(population[Math.floor(rand() * population.length)]);
        } else {
          const pool = [...population];
          for (let i = 0; i < want; i++) {
            const j = Math.floor(rand() * pool.length);
            picked.push(pool[j]);
            pool[j] = pool[pool.length - 1];
            pool.pop();
          }
        }
        return { seed: seed ?? null, operation: "sample", replace, count: picked.length, values: picked as JsonValue[] };
      }

      const draws: number[] = [];
      for (let i = 0; i < count; i++) {
        switch (distribution) {
          case "normal": {
            const u1 = Math.max(1e-12, rand());
            const u2 = rand();
            draws.push(mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
            break;
          }
          case "exponential": {
            const lambda = Math.max(1e-9, sd);
            draws.push(-Math.log(Math.max(1e-12, rand())) / lambda);
            break;
          }
          case "beta": {
            // Marsaglia–Tsang gamma sampler, same construction as math.ts.
            const gamma = (shape: number): number => {
              if (shape < 1) return gamma(1 + shape) * Math.pow(rand(), 1 / shape);
              const d = shape - 1 / 3;
              const c = 1 / Math.sqrt(9 * d);
              for (;;) {
                let x = 0;
                let v = 0;
                do {
                  const u1 = Math.max(1e-12, rand());
                  const u2 = rand();
                  x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
                  v = 1 + c * x;
                } while (v <= 0);
                v = v * v * v;
                const u = rand();
                if (u < 1 - 0.0331 * x * x * x * x) return d * v;
                if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
              }
            };
            const x = gamma(alpha);
            const y = gamma(betaParam);
            draws.push(x / (x + y));
            break;
          }
          case "gumbel": {
            const u = clamp(rand(), 1e-12, 1 - 1e-12);
            draws.push(mean + sd * -Math.log(-Math.log(u)));
            break;
          }
          default:
            draws.push(min + rand() * (max - min));
        }
      }
      const values = draws.map((v) => formatNumber(v, 12) as number);
      return {
        seed: seed ?? null,
        distribution,
        count: values.length,
        values: count === 1 ? (values[0] as JsonValue) : (values as JsonValue[]),
        ...(count > 1 ? { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values) } : {}),
      };
    },
  });

  registerTool({
    name: "router_capabilities",
    aliases: ["router.capabilities", "what_can_you_do", "tools_list"],
    kind: "mesh",
    deterministic: true,
    description:
      "Introspect the nokey-router tool plane itself: every registered tool with its schema, learned reliability (Beta posterior + Wilson floor), Kalman-filtered p50/p95/p99 latency, repair rate and top error codes. Ask this instead of guessing which tools exist or which ones are healthy.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Filter by tool kind (compute, text, json, time, crypto, encode, random, mesh)." },
        with_schemas: { type: "boolean", default: false, description: "Include each tool's full JSON Schema." },
        flavor: { type: "string", enum: ["openai", "openai-strict", "anthropic", "gemini"], description: "Also return the registry projected onto a vendor wire format." },
      },
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const skills = isPlainObject(ctx.locals.tool_skills) ? ctx.locals.tool_skills as Record<string, JsonValue> : {};
      const kind = asString(args.kind)?.toLowerCase();
      const now = ctx.now;
      const tools = listTools()
        .filter((t) => !t.admin && (!kind || t.kind === kind))
        .map((t) => {
          const record = skills[t.name];
          const summary = isPlainObject(record) ? skillSummary(record as unknown as ToolSkillRecord, now, true) : null;
          return {
            name: t.name,
            kind: t.kind,
            description: t.description,
            deterministic: t.deterministic ?? false,
            aliases: t.aliases ?? [],
            ...(asBool(args.with_schemas) ? { parameters: t.parameters } : {}),
            ...(summary ? { skill: summary } : {}),
          };
        });
      const out: Json = { count: tools.length, now_iso: new Date(now).toISOString(), tools };
      const flavor = asString(args.flavor);
      if (flavor) out[flavor.replace("-", "_")] = toToolSpecs({ flavor: flavor as ToolFlavor });
      return out;
    },
  });
}

registerBuiltinTools();
