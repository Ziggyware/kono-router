// host/intake.ts — stage 1. Accept anything the caller sends and return a
// HostRequest that the rest of the host can trust: valid roles, string content,
// clamped sampling params, a real budget, a real signal, and a note for every
// single thing that had to be changed.
//
// Intake never throws for a bad body and never 400s. A router that refuses
// malformed input is a router that cannot be put in front of chat clients.

import type {
  ChatMessage,
  HostContext,
  HostRequest,
  Json,
  Note,
  RequestLimits,
  Role,
  RoutingMode,
  SamplingParams,
  TaskClass,
  ToolCall,
  ToolDecl,
  ToolsRequest,
} from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import {
  DEFAULT_LIMITS,
  clampInt,
  clampNum,
  elide,
  isRecord,
  newTraceparent,
  note,
  shortId,
} from "./support.ts";

const VALID_ROLES = new Set<Role>(["system", "user", "assistant", "tool"]);
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;
const MAX_NOTES = 64;

const CODE_RE =
  /```|function\s+\w+|interface\s+\w+|class\s+\w+|def\s+\w+|import\s+[{(\w]|SELECT\s+.+\s+FROM|async\s+function|pub\s+fn\s+|#include\s*<|=>/i;
const MATH_RE =
  /\bprove\b|\btheorem\b|\blemma\b|\bderivative\b|\bintegral\b|\beigenvalue\b|\bmatrix\b|\bequation\b|\bprobability\b|\bmodulo\b|\bprime\b|\bgeometry\b/i;
const JSON_RE = /\bjson\b|\bschema\b|valid\s+json/i;
const REASON_RE =
  /\bprove\s+that\b|step[- ]by[- ]step|\btradeoff\b|\banaly[sz]e\b|\barchitect\b|\bderive\b/i;

/** Budgets by lane. A caller can always override with `budgetMs`. */
const MODE_BUDGET_MS: Record<RoutingMode, number> = {
  fast: 60_000,
  smart: 180_000,
  code: 300_000,
  reasoning: 600_000,
};

/** Legacy field names kept working: pre-rename clients still send `nokey_*`. */
const ALIASED_FIELDS = [
  "tools",
  "rounds",
  "builder",
  "gate",
  "runner",
  "tests",
  "preamble",
  "decompose",
];

interface NoteSink {
  (n: Note): void;
}

function makeNoteSink(notes: Note[]): NoteSink {
  let capped = false;
  return (n: Note) => {
    if (notes.length < MAX_NOTES) notes.push(n);
    else if (!capped) {
      capped = true;
      notes.push(note("notes.capped", `more than ${MAX_NOTES} notes; later notes dropped`, "info"));
    }
  };
}

function flattenContent(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (content === null || content === undefined) return { text: "", images: 0 };
  if (Array.isArray(content)) {
    let text = "";
    let images = 0;
    for (const part of content) {
      if (typeof part === "string") {
        text += part;
        continue;
      }
      if (!isRecord(part)) continue;
      const type = part.type;
      if (type === "text" && typeof part.text === "string") text += part.text;
      else if (type === "image_url" || type === "input_image" || type === "image") {
        images++;
        text += "⟦image⟧";
      } else if (typeof part.text === "string") text += part.text;
    }
    return { text, images };
  }
  if (isRecord(content)) return { text: JSON.stringify(content), images: 0 };
  return { text: String(content), images: 0 };
}

function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : item;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    const args =
      typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    out.push({
      id: typeof item.id === "string" && item.id ? item.id : `call_${shortId()}`,
      type: "function",
      function: { name, arguments: args },
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeTools(raw: unknown, limits: RequestLimits, push: NoteSink): ToolDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolDecl[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= limits.maxTools) {
      push(note("tools.capped", `more than ${limits.maxTools} tools declared; extras dropped`));
      break;
    }
    if (!isRecord(item)) {
      push(note("tools.not_object", "a tool declaration was not an object and was dropped"));
      continue;
    }
    const fn = isRecord(item.function) ? item.function : item;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!TOOL_NAME_RE.test(name)) {
      push(note("tools.bad_name", `tool name ${JSON.stringify(name).slice(0, 40)} is unusable`));
      continue;
    }
    if (seen.has(name)) {
      push(note("tools.duplicate", `duplicate tool declaration for ${name}`));
      continue;
    }
    seen.add(name);
    out.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      source: "client",
    });
  }
  return out;
}

function classify(
  text: string,
  hasTools: boolean,
  hasImages: boolean,
  params: SamplingParams,
  model: string,
): { mode: RoutingMode; taskClass: TaskClass } {
  const lower = model.toLowerCase();
  const effort = (params.reasoningEffort ?? "").toLowerCase();
  const wantsJson = isRecord(params.responseFormat) &&
    params.responseFormat.type === "json_object";

  let taskClass: TaskClass = "chat";
  if (hasImages) taskClass = "vision";
  else if (hasTools) taskClass = "tool";
  else if (wantsJson || JSON_RE.test(text)) taskClass = "json";
  else if (MATH_RE.test(text)) taskClass = "math";
  else if (CODE_RE.test(text)) taskClass = "code";
  else if (REASON_RE.test(text) || text.length > 1800) taskClass = "reasoning";

  let mode: RoutingMode;
  if (lower.includes("fast")) mode = "fast";
  else if (lower.includes("code")) mode = "code";
  else if (lower.includes("reason") || lower.includes("think")) mode = "reasoning";
  else if (lower.includes("smart")) mode = "smart";
  else if (effort === "high" || effort === "xhigh" || effort === "max") mode = "reasoning";
  else if (taskClass === "code") mode = "code";
  else if (taskClass === "reasoning") mode = "reasoning";
  else if (text.length > 1800 || REASON_RE.test(text)) mode = "smart";
  else mode = "fast";

  return { mode, taskClass };
}

function capMessages(
  messages: ChatMessage[],
  limits: RequestLimits,
  push: NoteSink,
): ChatMessage[] {
  let out = messages.map((m) => ({ ...m }));
  let truncatedMessages = 0;

  for (const message of out) {
    if (typeof message.content === "string" && message.content.length > limits.maxMessageChars) {
      const { text } = elide(message.content, limits.maxMessageChars);
      message.content = text;
      truncatedMessages++;
    }
  }
  if (truncatedMessages > 0) {
    push(
      note(
        "messages.elided",
        `${truncatedMessages} message(s) exceeded ${limits.maxMessageChars} chars and were middle-elided`,
      ),
    );
  }

  const totalChars = () =>
    out.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);

  let droppedForChars = 0;
  while (totalChars() > limits.maxRequestChars && out.length > 1) {
    const index = out.findIndex((m) => m.role !== "system");
    if (index < 0) break;
    out.splice(index, 1);
    droppedForChars++;
  }
  if (droppedForChars > 0) {
    push(
      note(
        "messages.dropped_for_size",
        `${droppedForChars} oldest message(s) dropped to fit ${limits.maxRequestChars} chars`,
        "degrade",
      ),
    );
  }

  if (out.length > limits.maxMessages) {
    const systems = out.filter((m) => m.role === "system").slice(0, 8);
    const budgetForRest = Math.max(1, limits.maxMessages - systems.length);
    const rest = out.filter((m) => m.role !== "system").slice(-budgetForRest);
    const dropped = out.length - systems.length - rest.length;
    out = [...systems, ...rest];
    push(note("messages.trimmed", `${dropped} older message(s) trimmed; newest kept`));
  }

  return out;
}

export function mergeLimits(overrides?: Partial<RequestLimits>): RequestLimits {
  const merged: RequestLimits = { ...DEFAULT_LIMITS, ...(overrides ?? {}) };
  return {
    maxMessages: clampInt(merged.maxMessages, 1, 512, DEFAULT_LIMITS.maxMessages),
    maxRequestChars: clampInt(merged.maxRequestChars, 500, 1_000_000, DEFAULT_LIMITS.maxRequestChars),
    maxMessageChars: clampInt(merged.maxMessageChars, 200, 1_000_000, DEFAULT_LIMITS.maxMessageChars),
    maxModelCalls: clampInt(merged.maxModelCalls, 1, 64, DEFAULT_LIMITS.maxModelCalls),
    maxChunks: clampInt(merged.maxChunks, 1, 32, DEFAULT_LIMITS.maxChunks),
    maxConcurrency: clampInt(merged.maxConcurrency, 1, 16, DEFAULT_LIMITS.maxConcurrency),
    maxChunkMs: clampInt(merged.maxChunkMs, 500, 900_000, DEFAULT_LIMITS.maxChunkMs),
    maxToolMs: clampInt(merged.maxToolMs, 100, 900_000, DEFAULT_LIMITS.maxToolMs),
    maxChunkOutputChars: clampInt(
      merged.maxChunkOutputChars,
      200,
      200_000,
      DEFAULT_LIMITS.maxChunkOutputChars,
    ),
    maxTools: clampInt(merged.maxTools, 0, 256, DEFAULT_LIMITS.maxTools),
  };
}

export function intake(
  raw: unknown,
  ctx: HostContext,
  limitsIn: Partial<RequestLimits> | undefined,
  ledger: Ledger,
): HostRequest {
  const limits = mergeLimits(limitsIn);
  const notes: Note[] = [];
  const push = makeNoteSink(notes);
  const span = ledger.span("intake");

  const body: Json = isRecord(raw) ? { ...raw } : {};
  if (!isRecord(raw)) push(note("body.not_object", "request body was not an object", "warn"));

  for (const field of ALIASED_FIELDS) {
    const legacy = `nokey_${field}`;
    if (body[`kono_${field}`] === undefined && body[legacy] !== undefined) {
      body[`kono_${field}`] = body[legacy];
    }
  }

  // ---- messages ----------------------------------------------------------
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    push(note("messages.not_array", "messages was not an array; ignored", "warn"));
  }
  const messages: ChatMessage[] = [];
  let hasImages = false;
  let badRoles = 0;
  for (const item of rawMessages) {
    if (!isRecord(item)) {
      push(note("messages.item", "a message was not an object and was dropped"));
      continue;
    }
    const roleText = typeof item.role === "string" ? item.role.toLowerCase() : "";
    const role: Role = VALID_ROLES.has(roleText as Role) ? (roleText as Role) : "user";
    if (roleText && role !== roleText) badRoles++;

    const flat = flattenContent(item.content ?? item.text);
    if (flat.images > 0) hasImages = true;

    const message: ChatMessage = {
      role,
      content: flat.text.length > 0 ? flat.text : null,
    };
    const calls = normalizeToolCalls(item.tool_calls);
    if (calls) {
      message.tool_calls = calls;
      if (message.content === "") message.content = null;
    }
    if (typeof item.tool_call_id === "string") message.tool_call_id = item.tool_call_id;
    if (typeof item.name === "string") message.name = item.name;
    messages.push(message);
  }
  if (badRoles > 0) {
    push(note("messages.role", `${badRoles} unknown role(s) coerced to "user"`));
  }
  if (messages.length === 0) {
    const fallback = typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim()
      : "Please reply with a short acknowledgement.";
    messages.push({ role: "user", content: fallback });
    push(note("messages.empty", "no usable messages; a prompt fallback was inserted"));
  }

  const kept = capMessages(messages, limits, push);

  // ---- model, mode, task class -------------------------------------------
  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : "free:auto";
  if (typeof body.model !== "string") {
    push(note("model.default", "no model requested; using free:auto", "info"));
  }
  const promptText = kept
    .filter((m) => m.role === "user" || m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  // ---- tools -------------------------------------------------------------
  const rawTools = body.tools;
  const clientTools = normalizeTools(Array.isArray(rawTools) ? rawTools : [], limits, push);
  let toolsRequested: ToolsRequest = "none";
  if (Array.isArray(rawTools) && rawTools.length > 0) toolsRequested = "explicit";
  const autoAsk =
    rawTools === "auto" ||
    rawTools === true ||
    rawTools === "*" ||
    body.kono_tools !== undefined ||
    rawTools === "kono_tools";
  if (autoAsk) toolsRequested = clientTools.length > 0 ? "explicit" : "auto";

  const params: SamplingParams = (() => {
    const p: SamplingParams = {};
    if (typeof body.temperature === "number") {
      p.temperature = clampNum(body.temperature, 0, 2, 0.7);
      if (p.temperature !== body.temperature) {
        push(note("params.temperature", `temperature clamped to ${p.temperature}`));
      }
    }
    const maxTokens = typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : undefined;
    if (maxTokens !== undefined) {
      p.maxTokens = clampInt(maxTokens, 1, 32_000, 1_024);
      if (p.maxTokens !== Math.round(maxTokens)) {
        push(note("params.max_tokens", `max_tokens clamped to ${p.maxTokens}`));
      }
    }
    if (typeof body.top_p === "number") p.topP = clampNum(body.top_p, 0, 1, 1);
    if (body.tool_choice !== undefined) p.toolChoice = body.tool_choice;
    if (isRecord(body.response_format)) p.responseFormat = body.response_format;
    if (typeof body.reasoning_effort === "string") p.reasoningEffort = body.reasoning_effort;
    if (typeof body.parallel_tool_calls === "boolean") {
      p.parallelToolCalls = body.parallel_tool_calls;
    }
    return p;
  })();

  const { mode, taskClass } = classify(promptText, kept.some((m) => m.tool_calls), hasImages, params, model);

  // ---- budget, limits, signal -------------------------------------------
  const requestedBudget = typeof ctx.budgetMs === "number"
    ? ctx.budgetMs
    : typeof body.kono_budget_ms === "number"
    ? body.kono_budget_ms
    : MODE_BUDGET_MS[mode];
  const budgetMs = clampInt(requestedBudget, 2_000, 1_800_000, MODE_BUDGET_MS[mode]);
  if (budgetMs !== Math.round(requestedBudget)) {
    push(note("budget.clamped", `budget clamped to ${budgetMs}ms`, "info"));
  }

  const decompose = body.kono_decompose === false ? false : undefined;
  const stream = body.stream === true;
  const traceparent = ctx.traceparent || newTraceparent();
  const tenant = ctx.tenant || "global";

  const request: HostRequest = {
    id: ledger.requestId,
    startedAt: ledger.startedAt,
    tenant,
    traceparent,
    model,
    mode,
    taskClass,
    stream,
    messages: kept,
    hasImages,
    clientTools,
    toolsRequested,
    params,
    budgetMs,
    limits,
    signal: ctx.signal ?? new AbortController().signal,
    notes,
    raw: body,
    ...(decompose === false ? { decompose } : {}),
  };

  for (const n of notes) ledger.addNote(n.stage ? n : { ...n, stage: "intake" });
  ledger.emit({
    stage: "intake",
    phase: "decision",
    data: {
      model,
      mode,
      task_class: taskClass,
      stream,
      messages_in: rawMessages.length,
      messages_kept: kept.length,
      tools_requested: toolsRequested,
      client_tools: clientTools.length,
      has_images: hasImages,
      budget_ms: budgetMs,
      notes: notes.length,
    },
  });
  span.end(true, { notes: notes.length });
  return request;
}
