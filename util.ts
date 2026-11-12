// util.ts — shared helper functions extracted from main.ts.

import type { TaskClass } from "./learning.ts";
import { discountedPosterior, clamp as clampNum } from "./math.ts";
import { skillSummary, listTools, normalizeToolName } from "./tools.ts";
import type { ToolSkillSummary } from "./tools.ts";
import type { Context } from "hono";
import type { Attrs } from "./trace.ts";
import type { MeshModelRecord, RoutingMode, ToolCallDelta, ServiceJsonEndpoint, Json } from "./main.ts";
import { TOOL_SKILLS } from "./state.ts";



export const learnCellKey = (scope: string, tuple: string, cls: TaskClass) => `${scope}|${tuple}|${cls}`;


export const armCellKey = (arm: string, cls: TaskClass) => `${arm}|${cls}`;



export function tupleGlobalPosterior(r: MeshModelRecord, now: number): { alpha: number; beta: number } {
  return discountedPosterior(
    Number(r.alpha_success || 2.0),
    Number(r.beta_failure || 1.0),
    r.last_success_at ?? r.last_probed ?? now,
    now,
  );
}



/** Learned telemetry for every registered tool, exposed on /v1/tools + /health. */
export function toolSkillsSnapshot(now = Date.now(), deterministic = true): Record<string, ToolSkillSummary> {
  const out: Record<string, ToolSkillSummary> = {};
  for (const [tool, record] of TOOL_SKILLS) out[tool] = skillSummary(record, now, deterministic);
  return out;
}



export function toolPlaneTotals(now = Date.now()): { tools: number; instrumented: number; calls: number; errors: number; repairs: number } {
  let calls = 0;
  let errors = 0;
  let repairs = 0;
  for (const record of TOOL_SKILLS.values()) {
    calls += record.calls;
    errors += record.errors;
    repairs += record.repairs;
  }
  void now;
  return { tools: listTools().length, instrumented: TOOL_SKILLS.size, calls, errors, repairs };
}



export function buildRotatedHeaders(baseHeaders: Record<string, string>): Headers {
  const uaPool = [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36",
    "OpenAI/v1 PythonBindings/1.82.0",
    "continue-dev/1.4.12 (darwin-arm64)",
    "cline/4.1.0 vscode/1.105.0",
    "roo-code/3.18.0 (win32-x64)",
    "opencode-ai/2.6.4 (linux-x64)",
  ];
  const entries = Object.entries({
    "Accept": "application/json, text/event-stream",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "User-Agent": uaPool[Math.floor(Math.random() * uaPool.length)],
    ...baseHeaders,
    "Content-Type": "application/json",
  });

  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const h = new Headers();
  for (const [k, v] of entries) h.set(k, v);
  return h;
}



// Bandit sampling primitives live in ./math.ts (ASCK v1): sampleGamma /
// sampleBeta (Marsaglia–Tsang), discountedPosterior, UCB, Wilson, Gumbel.

export function extractMessageText(messages: Array<{ role: string; content: unknown }>): {
  combinedText: string;
  hasVisionPayload: boolean;
} {
  let hasVisionPayload = false;
  const parts: string[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            parts.push(b.text);
          } else if (
            b.type === "image_url" ||
            b.type === "image" ||
            b.type === "input_image" ||
            b.type === "video_url" ||
            b.type === "input_audio"
          ) {
            hasVisionPayload = true;
          }
        }
      }
    }
  }
  return { combinedText: parts.join("\n"), hasVisionPayload };
}



export function classifyPromptIntent(
  messages: Array<{ role: string; content: unknown }>,
  hasTools = false,
  reasoningEffort?: string,
): RoutingMode {
  if (reasoningEffort === "high" || reasoningEffort === "xhigh" || reasoningEffort === "max") {
    return "reasoning";
  }
  const { combinedText } = extractMessageText(messages);

  if (
    hasTools ||
    /```|function\s+\w+|interface\s+\w+|def\s+\w+|import\s+\{|SELECT\s+.*\s+FROM|cargo\s+build|Deno\.|async\s+function|pub\s+fn\s+|#include\s*</i
      .test(combinedText)
  ) {
    return "code";
  }
  if (
    /prove\s+that|formal\s+proof|theorem|lemma|eigenvalue|hamiltonian|lagrangian|step-by-step\s+derivation|game\s+theory|bayesian|time\s+complexity\s+proof/i
      .test(combinedText)
  ) {
    return "reasoning";
  }
  if (combinedText.length > 1800 || /architect|analyze|differential|rigorous|synthesize|tradeoff/i.test(combinedText)) {
    return "smart";
  }
  return "fast";
}



export function mergeToolCalls(acc: Map<number, ToolCallDelta>, deltas: ToolCallDelta[]): void {
  for (const t of deltas) {
    const cur = acc.get(t.index);
    if (!cur) {
      acc.set(t.index, { ...t, function: { name: t.function?.name, arguments: t.function?.arguments ?? "" } });
      continue;
    }
    if (t.id) cur.id = t.id;
    if (t.type) cur.type = t.type;
    if (t.function?.name) cur.function!.name = t.function.name;
    cur.function!.arguments = (cur.function!.arguments ?? "") + (t.function?.arguments ?? "");
  }
}



export function isEndpointConfigured(endpoint: ServiceJsonEndpoint): boolean {
  const url = endpoint.url.trim();
  if (!url) return false;
  if (!endpoint.baseUrl.trim() && !endpoint.modelsUrl) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\{\{|\{\s*\w|\}\s*\}|%[0-9a-z]{2}/i.test(url)) return false;
  if (url.length > 4096) return false;
  return true;
}



export const logErr = (e: unknown) => console.error("telemetry:", e);


export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));



// ============================================================================
// 7b. TOOL PLANE (ASCK-T) — MESH TOOLS, AGENT LOOP & LEARNED TOOL ROUTING
// ============================================================================
// Three pieces turn `tools` from an opaque passthrough into router capability:
//
//  MESH TOOLS. Implementations from ./tools.ts are registered with closures
//  over live router state, so a model can interrogate the mesh itself
//  (catalog, health, coverage, lane choice, traces) and compute exactly
//  instead of hallucinating arithmetic, dates or digests.
//
//  AGENT LOOP. When a completion's tool calls all resolve to plane built-ins,
//  the router executes them, appends the `role:"tool"` results and re-dispatches
//  — bounded by NOKEY_TOOL_ROUNDS. Calls the router does not own are returned to
//  the client untouched, because the OpenAI contract requires the client to
//  answer every call it is handed. Streaming requests keep standard semantics:
//  tool_calls are piped through, never buffered into a second assistant turn.
//
//  LEARNED ROUTING. Every tool-bearing completion grades the tuple that
//  produced it — did the call name a declared tool, did the arguments parse,
//  did they validate? The verdict feeds a discounted Beta posterior stored on
//  the tuple record, which scoreRecord() then samples for tool-aware requests.
//  That is the compounding part: the mesh gets better at *tools* over time.
// ---------------------------------------------------------------------------

/** Tenant/tool namespace: one header scopes files, memory, RAG and clipboard.
 *  Absent header → a shared namespace, never another tenant's. */
export function toolNamespace(c: Context): string {
  const raw = c.req.header("x-nokey-session") ?? c.req.header("x-session-id") ?? "";
  return normalizeToolName(raw).slice(0, 48) || "shared";
}



/** The plane is on unless an operator explicitly turns it off. */
export function toolPlaneEnabled(): boolean {
  return Deno.env.get("NOKEY_TOOLS") !== "0";
}



/** Server-side tool rounds per request. 0 = pure OpenAI passthrough.
 *  Default 8; a request may ask for more via `nokey_rounds`, up to 32 —
 *  deep agency is per-request, and the loop still ends the moment the
 *  model stops calling tools. NOKEY_TOOL_ROUNDS sets the default. */
export function maxToolRounds(requested?: unknown): number {
  const raw = Deno.env.get("NOKEY_TOOL_ROUNDS");
  const env = raw === undefined || raw.trim() === "" ? 8 : Number(raw);
  const base = Number.isFinite(env) ? env : 8;
  const want = typeof requested === "number" && Number.isFinite(requested) ? requested : base;
  return Math.round(clampNum(want, 0, 32));
}



/** Spans accept scalar attributes only; everything else is stringified. */
export function traceAttrs(attrs: Json): Attrs {
  const out: Attrs = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out[key] = typeof value === "object" && value !== null ? JSON.stringify(value).slice(0, 200) : value as string | number | boolean;
  }
  return out;
}


export const strictErrors = () => Deno.env.get("NOKEY_STRICT_ERRORS") === "1";
