/**
 * ============================================================================
 * KONO TOOL PLANE — JSON SCHEMA SUBSET (validate · coerce · repair)
 * ============================================================================
 * The tool plane's schema-validation engine, extracted verbatim from
 * tools.ts so it can evolve independently of the registry and execution
 * machinery: a JSON Schema 2020-12 subset validator with an optional
 * lossless-coercion repair pass, plus the small shared helpers it is
 * built on (deep clone, pattern cache, byte counting).
 *
 * Design rules (same as tools.ts): pure and side-effect free; O(size of
 * input) with hard caps everywhere; dependencies only ./math.ts (clamp)
 * and ./tools-text.ts (plain-object check, Json). Never imports tools.ts.
 * ============================================================================
 */

import { clamp } from "./math.ts";

import { isPlainObject } from "./tools-text.ts";

import type { Json } from "./tools-text.ts";



export { asNumber, asString };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };



// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const MAX_DEPTH = 24;


/** Validation budget. The HTTP body limit is 512KB, so ~250k scalar nodes is
 *  the most any single payload can hold; the cap only stops pathological
 *  nesting/fan-out, and it reports once instead of per node. */
const MAX_NODES = 250_000;



function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}



function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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
