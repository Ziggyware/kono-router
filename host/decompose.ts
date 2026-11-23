// host/decompose.ts — stage 3: ask the AI to break the request into tiny chunks,
// then distrust the answer completely.
//
// The planner is the only place in the host where a model is allowed to write
// control flow, so it is also the only place with a full validation pass
// (ids, kinds, declared tools only, backward-only dependencies, arg refs) plus
// one bounded repair call. A planner that returns prose, an unknown tool, a
// cycle or nothing at all cannot fail the request: the stage falls back to a
// single answer chunk and says exactly why in the report.

import type {
  BuiltRequest,
  ChatMessage,
  Chunk,
  ChunkPlan,
  HostPorts,
  Json,
  Note,
  RequestLimits,
} from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import {
  abortable,
  clampInt,
  errText,
  extractJson,
  goalText,
  isRecord,
  note,
  preview,
  tailCap,
  withDeadline,
} from "./support.ts";

const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const REF_RE = /\$\{?([a-z][a-z0-9_]{0,23})(?:[./][^}\s"',)]*)?\}?/g;
const MAX_TITLE = 120;
const MAX_PROMPT = 600;
const MIN_PLAN_MS = 1_200;
const PLANNER_MAX_TOKENS = 1_200;
const REPAIR_ECHO_CHARS = 3_000;

export interface PlanValidation {
  chunks: Chunk[];
  rejects: Note[];
  errors: string[];
  rationale: string;
}

function refIds(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(REF_RE)) out.add(match[1]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) refIds(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) refIds(item, out);
    return out;
  }
  return out;
}

function firstUnresolvedRef(value: unknown, known: Map<string, number>): string | null {
  for (const id of refIds(value)) {
    if (!known.has(id)) return `$${id}`;
  }
  return null;
}

function normalizeId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 24);
}

/**
 * Validate a planner reply. Pure, synchronous and exhaustive: it keeps the
 * chunks that are safe to run, rejects the rest with a reason, and returns the
 * errors that a repair call should be told about.
 *
 * Invariants enforced here, in order:
 *   - at most `limits.maxChunks` chunks;
 *   - ids match ID_RE and are unique;
 *   - a "tool" chunk names a tool this request actually declared;
 *   - a "tool" chunk's args reference only already-accepted chunks;
 *   - `needs` only reference already-accepted chunks (so the DAG is acyclic
 *     and the scheduler never has to detect a cycle);
 *   - an "answer" chunk always has a prompt.
 */
export function validatePlan(
  raw: unknown,
  allowedTools: ReadonlySet<string>,
  limits: RequestLimits,
): PlanValidation {
  const rejects: Note[] = [];
  const errors: string[] = [];
  const chunks: Chunk[] = [];
  const seen = new Map<string, number>();

  const obj = isRecord(raw) ? raw : undefined;
  const list = obj && Array.isArray(obj.chunks)
    ? obj.chunks
    : Array.isArray(raw)
    ? raw
    : undefined;
  const rationale = obj && typeof obj.rationale === "string"
    ? tailCap(obj.rationale, 300).text
    : "";

  if (!list) {
    errors.push("reply had no `chunks` array");
    return { chunks, rejects, errors, rationale };
  }
  if (list.length === 0) errors.push("`chunks` was empty");

  for (const [index, item] of list.entries()) {
    if (chunks.length >= limits.maxChunks) {
      rejects.push(note("chunk.capped", `chunk #${index + 1} dropped: plan exceeds ${limits.maxChunks} chunks`));
      continue;
    }
    if (!isRecord(item)) {
      rejects.push(note("chunk.not_object", `chunk #${index + 1} was not an object`));
      continue;
    }

    const id = normalizeId(item.id);
    if (!ID_RE.test(id)) {
      rejects.push(note("chunk.bad_id", `chunk #${index + 1} id ${JSON.stringify(item.id)} is not a usable id`));
      continue;
    }
    if (seen.has(id)) {
      rejects.push(note("chunk.duplicate_id", `chunk id ${id} appeared twice; the second was dropped`));
      continue;
    }

    const kind: "answer" | "tool" | null = item.kind === "tool" || (item.kind === undefined && typeof item.tool === "string")
      ? "tool"
      : item.kind === "answer" || item.kind === undefined
      ? "answer"
      : null;
    if (!kind) {
      rejects.push(note("chunk.bad_kind", `chunk ${id}: kind ${JSON.stringify(item.kind)} is not "tool" or "answer"`));
      continue;
    }

    let tool: string | undefined;
    let args: Json | undefined;
    if (kind === "tool") {
      tool = typeof item.tool === "string" ? item.tool.trim() : "";
      if (!tool || !allowedTools.has(tool)) {
        rejects.push(
          note(
            "chunk.tool_not_declared",
            `chunk ${id} wants tool ${JSON.stringify(tool)}, which this request did not declare`,
          ),
        );
        continue;
      }
      if (item.args !== undefined && !isRecord(item.args)) {
        rejects.push(note("chunk.bad_args", `chunk ${id}: args must be an object`));
        continue;
      }
      args = isRecord(item.args) ? item.args : {};
      const unresolved = firstUnresolvedRef(args, seen);
      if (unresolved) {
        rejects.push(
          note("chunk.ref_unresolved", `chunk ${id} reads ${unresolved}, which is not an earlier chunk`),
        );
        continue;
      }
    }

    const needs: string[] = [];
    if (Array.isArray(item.needs)) {
      for (const need of item.needs) {
        if (typeof need !== "string") continue;
        const dep = need.trim().toLowerCase();
        if (!seen.has(dep)) {
          rejects.push(note("chunk.need_dropped", `chunk ${id}: dependency ${dep} is not an earlier chunk; dropped`));
          continue;
        }
        if (!needs.includes(dep)) needs.push(dep);
      }
    }
    if (args) {
      for (const dep of refIds(args)) {
        if (!needs.includes(dep)) needs.push(dep);
      }
    }

    const title = tailCap(
      typeof item.title === "string" && item.title.trim() ? item.title.trim() : `chunk ${id}`,
      MAX_TITLE,
    ).text;
    const prompt = kind === "answer"
      ? tailCap(
        typeof item.prompt === "string" && item.prompt.trim()
          ? item.prompt.trim()
          : `Answer this part of the request on its own: ${title}`,
        MAX_PROMPT,
      ).text
      : undefined;
    const outputCapChars = clampInt(
      typeof item.outputCapChars === "number" ? item.outputCapChars : limits.maxChunkOutputChars,
      200,
      limits.maxChunkOutputChars,
      limits.maxChunkOutputChars,
    );

    seen.set(id, chunks.length);
    chunks.push({
      id,
      title,
      kind,
      ...(tool ? { tool } : {}),
      ...(args ? { args } : {}),
      needs,
      ...(prompt ? { prompt } : {}),
      outputCapChars,
    });
  }

  return { chunks, rejects, errors, rationale };
}

function plannerSystem(limits: RequestLimits): string {
  return [
    "You are the planning stage of a message router.",
    "Break the user's request into the smallest chunks that can run independently and in parallel.",
    `Rules:`,
    `- 1 to ${limits.maxChunks} chunks. Prefer 2-4. One atomic question means exactly one answer chunk.`,
    `- Every id matches ${ID_RE.source}. Ids are unique and lowercase.`,
    `- Every chunk is kind "tool" or "answer".`,
    `- A "tool" chunk has "tool" (from the catalog) and "args" (an object). Use "$chunkId" or "$chunkId/path" inside args to read an earlier chunk's result.`,
    `- An "answer" chunk has "prompt": one self-contained instruction, at most 300 characters. It must not restate the whole goal.`,
    `- "needs" lists only ids of chunks earlier in the array. No cycles, no forward references.`,
    "Output JSON only, no prose, no code fences:",
    `{"rationale":"why this split","chunks":[{"id":"facts","title":"...","kind":"tool","tool":"...","args":{},"needs":[]},{"id":"draft","title":"...","kind":"answer","prompt":"...","needs":["facts"]}]}`,
  ].join("\n");
}

function plannerMessages(built: BuiltRequest, limits: RequestLimits): ChatMessage[] {
  const goal = tailCap(goalText(built.request.messages, 4_000), 4_000).text;
  const catalog = built.manifest.tools.declared.length > 0
    ? built.manifest.tools.declared
      .slice(0, 24)
      .map((t) => `- ${t.name}: ${preview(t.description, 100) || "(no description)"}`)
      .join("\n")
    : "(no tools declared: every chunk must be kind \"answer\")";
  return [
    { role: "system", content: plannerSystem(limits) },
    { role: "user", content: `GOAL:\n${goal}\n\nTOOLS:\n${catalog}\n\nReturn the JSON plan now.` },
  ];
}

function repairMessages(
  built: BuiltRequest,
  limits: RequestLimits,
  previous: string,
  errors: string[],
): ChatMessage[] {
  const base = plannerMessages(built, limits);
  return [
    ...base,
    { role: "assistant", content: tailCap(previous, REPAIR_ECHO_CHARS).text },
    {
      role: "user",
      content: [
        "That reply was rejected. Fix each problem and return the complete JSON plan again.",
        ...errors.slice(0, 8).map((e) => `- ${e}`),
      ].join("\n"),
    },
  ];
}

function singleChunkPlan(built: BuiltRequest, rationale: string): ChunkPlan {
  const goal = tailCap(goalText(built.request.messages, 2_000), 600).text;
  const chunk: Chunk = {
    id: "answer",
    title: "Answer the request",
    kind: "answer",
    needs: [],
    prompt: goal || "Answer the user's request.",
    outputCapChars: built.request.limits.maxChunkOutputChars,
  };
  return {
    requestId: built.request.id,
    source: "fallback",
    rationale,
    chunks: [chunk],
    plannerAttempts: 0,
    plannerMs: 0,
    rejects: [],
    repairErrors: [],
  };
}

export async function decompose(
  built: BuiltRequest,
  ports: HostPorts,
  ledger: Ledger,
  plannerBudgetMs: number,
): Promise<ChunkPlan> {
  const { request, manifest } = built;
  const limits = request.limits;
  const span = ledger.span("decompose", { budget_ms: Math.round(plannerBudgetMs) });
  const allowed = new Set(manifest.tools.declared.map((t) => t.name));
  const startedMs = Date.now();

  const fallback = (code: string, detail: string, severity: Note["severity"] = "warn"): ChunkPlan => {
    const plan = singleChunkPlan(built, detail);
    plan.plannerAttempts = attempts;
    plan.plannerMs = Date.now() - startedMs;
    const n = note(code, detail, severity, "decompose");
    ledger.addNote(n);
    plan.rejects = [n];
    ledger.emit({
      stage: "decompose",
      phase: "decision",
      attempt: attempts,
      chunkId: plan.chunks[0].id,
      data: { fallback: true, code, source: plan.source },
    });
    span.end(false, { fallback: true, code, attempts });
    return plan;
  };

  let attempts = 0;

  if (request.decompose === false) {
    return fallback("decompose.disabled", "caller disabled decomposition", "info");
  }
  if (plannerBudgetMs < MIN_PLAN_MS) {
    return fallback(
      "decompose.no_budget",
      `planner budget ${Math.round(plannerBudgetMs)}ms is below the ${MIN_PLAN_MS}ms floor`,
      "info",
    );
  }

  let rejected: Note[] = [];
  let repairErrors: string[] = [];
  let previous = "";
  let model: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = attempt === 0 ? Math.round(plannerBudgetMs * 0.7) : Math.round(plannerBudgetMs * 0.3);
    if (budget < 500) break;
    const messages = attempt === 0
      ? plannerMessages(built, limits)
      : repairMessages(built, limits, previous, repairErrors);
    const pin = manifest.candidates[0];
    attempts++;
    ledger.bump("model_calls");
    try {
      const reply = await withDeadline(budget, request.signal, "planner", (signal) =>
        abortable(
          ports.models.complete({
            purpose: attempt === 0 ? "planner" : "repair",
            messages,
            ...(pin ? { model: pin.modelId, tupleId: pin.tupleId } : {}),
            temperature: attempt === 0 ? 0.2 : 0,
            maxTokens: PLANNER_MAX_TOKENS,
            responseFormat: { type: "json_object" },
            deadlineMs: budget,
            signal,
            chunkId: attempt === 0 ? "planner" : "planner_repair",
            attempt,
          }),
          signal,
          "planner",
        ));
      model = reply.model;
      previous = reply.content;
      ledger.emit({
        stage: "decompose",
        phase: "decision",
        attempt,
        model: reply.model,
        tupleId: reply.tupleId,
        ms: reply.ms,
        data: {
          chars: reply.content.length,
          upstream_attempts: reply.upstreamAttempts,
          preview: preview(reply.content, 160),
        },
      });

      const validation = validatePlan(extractJson(reply.content), allowed, limits);
      rejected = validation.rejects;
      repairErrors = validation.errors;
      if (validation.errors.length === 0 && validation.chunks.length > 0) {
        for (const r of rejected) ledger.addNote({ ...r, stage: "decompose" });
        for (const chunk of validation.chunks) {
          ledger.emit({
            stage: "decompose",
            phase: "decision",
            chunkId: chunk.id,
            data: {
              kind: chunk.kind,
              tool: chunk.tool,
              needs: chunk.needs,
              title: chunk.title,
              cap: chunk.outputCapChars,
            },
          });
        }
        const plan: ChunkPlan = {
          requestId: request.id,
          source: "planner",
          rationale: validation.rationale,
          chunks: validation.chunks,
          ...(model ? { plannerModel: model } : {}),
          plannerAttempts: attempts,
          plannerMs: Date.now() - startedMs,
          rejects: rejected,
          repairErrors: [],
        };
        span.end(true, {
          chunks: plan.chunks.length,
          attempts,
          rejects: rejected.length,
          model,
        });
        return plan;
      }
      ledger.emit({
        stage: "decompose",
        phase: "error",
        attempt,
        ok: false,
        data: {
          errors: repairErrors.slice(0, 6),
          rejects: rejected.length,
        },
      });
    } catch (err) {
      if (request.signal.aborted) {
        span.fail(err);
        throw err;
      }
      repairErrors = [errText(err).slice(0, 240)];
      ledger.emit({
        stage: "decompose",
        phase: "error",
        attempt,
        ok: false,
        data: { error: errText(err).slice(0, 240) },
      });
    }
  }

  const why = repairErrors.length > 0
    ? `planner produced no valid plan after ${attempts} attempt(s): ${repairErrors.slice(0, 3).join("; ")}`
    : `planner produced no valid plan after ${attempts} attempt(s)`;
  const plan = fallback("decompose.fallback", why, "degrade");
  if (rejected.length > 0) {
    plan.rejects = [...rejected, ...plan.rejects];
    ledger.emit({
      stage: "decompose",
      phase: "info",
      data: { rejected: rejected.map((r) => r.code).slice(0, 8) },
    });
  }
  return plan;
}

/** Exposed for tests: the exact planner prompt for a built request. */
export function planPromptFor(built: BuiltRequest): ChatMessage[] {
  return plannerMessages(built, built.request.limits);
}

/** Exposed for tests: what the host would send a repair call. */
export function repairPromptFor(built: BuiltRequest, previous: string, errors: string[]): ChatMessage[] {
  return repairMessages(built, built.request.limits, previous, errors);
}

/** Structured plan summary, safe to log. */
export function describePlan(plan: ChunkPlan): Json {
  return {
    source: plan.source,
    chunks: plan.chunks.map((c) => ({ id: c.id, kind: c.kind, tool: c.tool ?? null, needs: c.needs })),
    attempts: plan.plannerAttempts,
    rejects: plan.rejects.length,
    rationale: plan.rationale.slice(0, 200),
  };
}
