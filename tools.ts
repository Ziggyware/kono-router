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

import { isPlainObject, repairJsonText } from "./tools-text.ts";

import type { Json } from "./tools-text.ts";

export { repairJsonText, TEXT_CALL_OPENERS, parseTextToolCalls } from "./tools-text.ts";

export type { Json, TextToolCall } from "./tools-text.ts";


export { cloneJson, utf8Bytes, validateJson } from "./tools-schema.ts";

export type { JsonValue, SchemaIssue, ValidateOptions, ValidationResult } from "./tools-schema.ts";

import { asNumber, asString, utf8Bytes, validateJson } from "./tools-schema.ts";

import type { JsonValue, SchemaIssue, ValidateOptions } from "./tools-schema.ts";



// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
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
/** How to change workspace files so the edits land exactly and the app works. */
export const WORKSPACE_DISCIPLINE = [
  "Workspace files are the user's project and its live preview: when asked to build, change or fix code, do it in the workspace with fs_* tools rather than pasting whole files into the reply.",
  "Read before editing (fs_read, or fs_grep to locate), then fs_patch with `old` copied exactly from what you read and expect_sha256 set to the sha256 you read; one fs_patch call can carry several edits to a file.",
  "If an edit is refused, the error says where the anchor diverged or why — correct that edit, do not rewrite the file.",
  "After a set of changes run ws_check (or app_debug, which adds what the live preview observed at runtime), fix every error it reports, and repeat until it is clean; use app_debug with wait_ms to confirm the preview runs the new files.",
  "Then open the app and test it: write tests/<flow>.test.json UI cases for the behaviour the user asked for (and *.test.js unit tests for non-trivial logic), run app_test {all: true}, and fix until they pass. A build is finished only when it is clean and its tests pass; the router checks this and will send you back if not.",
].join(" ");



export const TEAM_DISCIPLINE = "Use agent_team to work in parallel whenever a job has independent parts: builders on separate files or areas, a tester writing tests while you build, a reviewer or researcher alongside; give each agent a self-contained task, then integrate and verify their work.";



export function toolPreamble(names?: string[]): string {
  const tools = names?.length ? names.map((n) => getTool(n)?.name ?? normalizeToolName(n)) : listTools().filter((t) => !t.admin).map((t) => t.name);
  return [
    "You have server-side tools executed by the nokey-router tool plane.",
    `Available: ${tools.join(", ")}.`,
    "Call them with a single valid JSON object of arguments; the router executes them and returns the result as a tool message.",
    "Prefer tools to guessing: web_search/web_fetch for current facts, fs_* for durable files, memory_* across conversations, rag_* for large documents, calculate/data/time/crypto for exact computation.",
    ...(tools.includes("fs_patch") ? [WORKSPACE_DISCIPLINE] : []),
    ...(tools.includes("agent_team") ? [TEAM_DISCIPLINE] : []),
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



/** Rename synonym keys before validation, which would otherwise drop them as undeclared. */
function renameArgs(raw: unknown, aliases: Record<string, string>): unknown {
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { return raw; } }
  if (!isPlainObject(obj)) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const to = aliases[k.toLowerCase()];
    if (to && obj[to] === undefined) out[to] = v; else out[k] = v;
  }
  return out;
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

  if (tool.argAliases) rawArgs = renameArgs(rawArgs, tool.argAliases);
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

  // Per-tool deadlines are the default; an explicit caller timeout (timeout_ms) overrides it either way.
  const toolTimeout = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? toolTimeout;
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
// Workspace checks, app runs/tests and agent teams read (or write) the same
// files, so a batch like fs_write + ws_check sees the write.
const STATEFUL_TOOL = /^(?:fs_|memory_|rag_|ws_|app_|clipboard$|task$|agent_team$)/;



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
    // Tell the model what the repair ladder already fixed, so its next attempt
    // targets what is actually still wrong instead of re-breaking the rest.
    ...(execution.code === "INVALID_ARGUMENTS" && execution.repairs?.length
      ? { already_auto_fixed: execution.repairs.slice(0, 8) }
      : {}),
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
  // Only a caller-declared name belongs to the caller. An undeclared name is a
  // hallucination: the plane executes it (UNKNOWN_TOOL + suggestions) so the
  // model self-corrects instead of the call landing on a human to answer.
  const isMine = (c: NormalizedToolCall): boolean => !shadowed.has(normalizeToolName(c.name));
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
  "agent_team",
  "app_debug",
  "app_test",
  "calculate",
  "clipboard",
  "crypto",
  "data",
  "embed",
  "fs_delete",
  "fs_grep",
  "fs_list",
  "fs_move",
  "fs_patch",
  "fs_read",
  "fs_write",
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
  "ws_check",
];



/** The default set, plus every forged tool: a tool created on the fly is
 *  pointless if the next request cannot see it. */
export function defaultAutoToolNames(): string[] {
  const forged = listTools().filter((t) => t.dynamic && !t.admin).map((t) => t.name);
  return [...new Set([...DEFAULT_AUTO_TOOLS, ...forged])];
}



/** Per-class focus sets for intent-shaped exposure. A bare `tools:"auto"`
 *  request historically shipped all ~30 schemas (~7.5K tokens) on every
 *  attempt of every round, whatever the ask — pure choice overload for a
 *  chat or qa request. Classes whose work is genuinely tool-centric (code,
 *  tool) keep the full set; the rest get the subset their class can use.
 *  Forged (dynamic) tools always ride along: a tool the user created is
 *  intentional, and the speciation population must stay reachable.
 *
 *  Every subset keeps the plane's defining core — workspace files, build
 *  checks, delegation. The class is a one-prompt guess ("build a sum app"
 *  classifies as creative, "plan it with a team" as chat), and stripping
 *  the fs tools or agent_team on a misjudged guess breaks the flows the system exists
 *  for; the savings that matter come from dropping the long tail
 *  (clipboard, embed, rag admin, crypto, http) where it cannot apply. */
const TOOL_PLANE_CORE = [
  "fs_read", "fs_write", "fs_patch", "fs_list", "fs_grep", "ws_check",
  "app_debug", "app_test", "agent_team", "task",
];
const CLASS_TOOL_FOCUS: Record<string, string[]> = {
  chat: [...TOOL_PLANE_CORE, "calculate", "time", "text", "data", "web_search", "web_fetch", "memory_search", "memory_recall"],
  qa: [...TOOL_PLANE_CORE, "calculate", "time", "text", "data", "web_search", "web_fetch", "http_request", "rag_search", "memory_search", "memory_recall"],
  math: [...TOOL_PLANE_CORE, "calculate", "data", "text", "time", "crypto"],
  json: [...TOOL_PLANE_CORE, "data", "text", "calculate", "http_request", "web_fetch", "time"],
  reasoning: [...TOOL_PLANE_CORE, "calculate", "text", "data", "web_search", "web_fetch", "memory_recall", "time"],
  summarize: [...TOOL_PLANE_CORE, "text", "web_fetch", "web_search", "memory_recall", "memory_search", "calculate", "time"],
  longform: [...TOOL_PLANE_CORE, "text", "memory_recall", "memory_search", "web_search", "calculate", "time"],
  creative: [...TOOL_PLANE_CORE, "text", "memory_recall", "memory_search", "web_search", "calculate", "time"],
  multilingual: [...TOOL_PLANE_CORE, "text", "web_search", "web_fetch", "calculate", "time"],
  vision: [...TOOL_PLANE_CORE, "text", "data", "calculate", "time"],
};

/** Shape a resolved auto set for a task class. `code` keeps the full set;
 *  `tool` keeps it and gains the mesh introspection tools, which the
 *  default set never exposed despite their model-facing descriptions. */
export function autoToolsForClass(taskClass: string, all: string[]): string[] {
  if (taskClass === "tool") {
    const extra = ["router_catalog", "router_capabilities"].filter((n) => getTool(n) && !all.includes(n));
    return [...all, ...extra];
  }
  const focus = CLASS_TOOL_FOCUS[taskClass];
  if (!focus) return all;
  const keep = new Set(focus);
  const dynamic = new Set(listTools().filter((t) => t.dynamic && !t.admin).map((t) => t.name));
  return all.filter((n) => keep.has(n) || dynamic.has(n));
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