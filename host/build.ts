// host/build.ts — stage 2: grow the accepted request into a full one.
//
// "Building up" means four concrete things, in this order:
//   1. decide which tools this request may use (client wins, builtin fills in);
//   2. assemble the system text the router owns, highest priority first;
//   3. ask the candidate port who could answer it, and keep the ranked list;
//   4. split the wall clock into planner / chunk / synthesis budgets.
//
// Build returns a BuildManifest alongside the wire messages: the manifest is
// the receipt. If a later stage looks wrong, the manifest says which decision
// made it look that way.

import { REQUEST_POLICY } from "../engine/request-policy.ts";
import type {
  BudgetSplit,
  BuildManifest,
  BuiltRequest,
  CandidateRef,
  ChatMessage,
  HostPorts,
  HostRequest,
  PromptPart,
  RankQuery,
  TaskClass,
  ToolDecl,
  ToolSelection,
} from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import { byteLen, digest, errText, note, preview, raceSoft, tailCap } from "./support.ts";

/** Builtin tools a task class can actually use. `tool` gets everything: the
 *  caller asked for the plane, not for a guess about the plane. */
const CLASS_TOOL_HINTS: Record<TaskClass, string[]> = {
  chat: ["web"],
  code: ["fs_", "shell", "code", "test"],
  math: ["calc", "data", "unit"],
  json: ["json", "calc"],
  tool: ["*"],
  vision: [],
  reasoning: ["calc", "web"],
};

const FALLBACK_PREAMBLE =
  "You have server-side tools. Call one with a single valid JSON object of arguments; " +
  "the host executes it and returns the result. Prefer a tool over guessing.";

const LESSON_CHARS = 600;
const BRIEF_CHARS = 1_200;
const VARIANT_CHARS = 400;

function pickAuto(tools: ToolDecl[], taskClass: TaskClass, max: number): string[] {
  const hints = CLASS_TOOL_HINTS[taskClass];
  if (hints.includes("*")) return tools.slice(0, max).map((t) => t.name);
  const chosen: string[] = [];
  for (const tool of tools) {
    if (chosen.length >= max) break;
    if (hints.some((h) => tool.name.toLowerCase().startsWith(h))) chosen.push(tool.name);
  }
  return chosen;
}

function selectTools(request: HostRequest, ports: HostPorts, ledger: Ledger): ToolSelection {
  const dropped: ToolSelection["dropped"] = [];
  const byName = new Map<string, ToolDecl>();
  for (const tool of request.clientTools) byName.set(tool.name, tool);

  const auto: string[] = [];
  if (request.toolsRequested === "auto" || request.toolsRequested === "explicit") {
    const available = ports.tools.list();
    const wanted = pickAuto(available, request.taskClass, request.limits.maxTools);
    for (const name of wanted) {
      const decl = available.find((t) => t.name === name);
      if (!decl) continue;
      if (byName.has(name)) {
        dropped.push(note("tools.shadowed", `builtin ${name} not added: client supplied its own`));
        continue;
      }
      byName.set(name, { ...decl, source: "builtin" });
      auto.push(name);
    }
    if (request.toolsRequested === "auto" && auto.length === 0) {
      dropped.push(note("tools.none_available", "auto tools requested but no builtin matched", "info"));
    }
  }

  const declared = [...byName.values()].slice(0, request.limits.maxTools);
  ledger.emit({
    stage: "build",
    phase: "decision",
    data: {
      tool_source: request.toolsRequested,
      client: request.clientTools.length,
      auto: auto.length,
      declared: declared.length,
      names: declared.map((t) => t.name).slice(0, 24),
    },
  });
  return { declared, auto, dropped };
}

interface PromptBlock {
  id: "variant" | "lessons" | "workspace" | "preamble";
  text: string;
  /** 0 = dropped first when the prompt is too large. */
  priority: number;
}

async function collectPrompt(
  request: HostRequest,
  selection: ToolSelection,
  ports: HostPorts,
  ledger: Ledger,
): Promise<PromptBlock[]> {
  const blocks: PromptBlock[] = [];
  const prompt = ports.prompt;

  if (prompt?.variant) {
    const text = await raceSoft(Promise.resolve(prompt.variant(request)), 400);
    if (text && text.trim()) {
      blocks.push({ id: "variant", text: tailCap(text.trim(), VARIANT_CHARS).text, priority: 1 });
    }
  }
  if (prompt?.lessons) {
    const lessons = await raceSoft(Promise.resolve(prompt.lessons(request)), 600);
    if (lessons && lessons.length > 0) {
      const text = tailCap(
        `Lessons learned from verified failures on similar tasks:\n${lessons
          .slice(0, 2)
          .map((l) => `- ${l}`)
          .join("\n")}`,
        LESSON_CHARS,
      ).text;
      blocks.push({ id: "lessons", text, priority: 2 });
    }
  }
  if (prompt?.workspaceBrief && selection.declared.length > 0) {
    const brief = await raceSoft(Promise.resolve(prompt.workspaceBrief(request)), 1_200);
    if (brief && brief.trim()) {
      blocks.push({ id: "workspace", text: tailCap(brief.trim(), BRIEF_CHARS).text, priority: 3 });
    }
  }
  if (selection.declared.length > 0) {
    const text = prompt?.preamble
      ? await raceSoft(Promise.resolve(prompt.preamble(selection.declared.map((t) => t.name))), 400)
      : FALLBACK_PREAMBLE;
    if (text && text.trim()) {
      blocks.push({ id: "preamble", text: tailCap(text.trim(), 2_000).text, priority: 4 });
    }
  }
  ledger.emit({
    stage: "build",
    phase: "decision",
    data: {
      prompt_blocks: blocks.map((b) => ({ id: b.id, bytes: byteLen(b.text), digest: digest(b.text) })),
    },
  });
  return blocks;
}

function splitBudget(totalMs: number): BudgetSplit {
  const plannerMs = Math.min(20_000, Math.max(2_000, Math.round(totalMs * 0.15)));
  const chunkMs = Math.min(120_000, Math.max(6_000, Math.round(totalMs * 0.55)));
  const synthMs = Math.max(3_000, totalMs - plannerMs - chunkMs);
  return { totalMs, plannerMs, chunkMs, synthMs };
}

function dedupeCandidates(list: CandidateRef[], query: RankQuery): CandidateRef[] {
  const seen = new Set<string>(query.exclude);
  const out: CandidateRef[] = [];
  for (const cand of list) {
    if (!cand || typeof cand.tupleId !== "string") continue;
    if (seen.has(cand.tupleId)) continue;
    if (query.requiresTools && !cand.supportsTools) continue;
    if (query.requiresVision && !cand.supportsVision) continue;
    seen.add(cand.tupleId);
    out.push(cand);
    if (out.length >= query.limit) break;
  }
  return out;
}

export async function buildRequest(
  request: HostRequest,
  ports: HostPorts,
  ledger: Ledger,
): Promise<BuiltRequest> {
  const span = ledger.span("build", { model: request.model, mode: request.mode });
  const notes = [...request.notes];

  const selection = selectTools(request, ports, ledger);
  notes.push(...selection.dropped);

  const blocks = await collectPrompt(request, selection, ports, ledger);

  // ---- assemble the wire messages ----------------------------------------
  const hasPolicy = request.messages.some((m) => m.role === "system" && m.content === REQUEST_POLICY);
  const totalChars = () =>
    (hasPolicy ? 0 : REQUEST_POLICY.length) + blocks.reduce((n, b) => n + b.text.length, 0) +
    request.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);

  // Router text yields before the caller's messages, least important first.
  const dropOrder: PromptBlock["id"][] = ["workspace", "lessons", "variant", "preamble"];
  for (const id of dropOrder) {
    if (totalChars() <= request.limits.maxRequestChars) break;
    const index = blocks.findIndex((b) => b.id === id);
    if (index < 0) continue;
    blocks.splice(index, 1);
    notes.push(
      note("prompt.dropped", `${id} text dropped to stay under ${request.limits.maxRequestChars} chars`, "degrade"),
    );
  }

  const systemMessages: ChatMessage[] = blocks.map((b) => ({ role: "system", content: b.text }));
  const messages: ChatMessage[] = hasPolicy
    ? [...systemMessages, ...request.messages]
    : [{ role: "system", content: REQUEST_POLICY }, ...systemMessages, ...request.messages];

  const promptParts: PromptPart[] = [
    ...(!hasPolicy ? [{ source: "policy" as const, bytes: byteLen(REQUEST_POLICY), digest: digest(REQUEST_POLICY), preview: preview(REQUEST_POLICY) }] : []),
    ...blocks.map((b) => ({
      source: b.id as PromptPart["source"],
      bytes: byteLen(b.text),
      digest: digest(b.text),
      preview: preview(b.text),
    })),
    ...request.messages.map((m) => {
      const text = typeof m.content === "string" ? m.content : "";
      return {
        source: "client" as const,
        bytes: byteLen(text),
        digest: digest(`${m.role}:${text}`),
        preview: preview(`${m.role}: ${text}`),
      };
    }),
  ];

  // ---- candidates --------------------------------------------------------
  const rankSpan = ledger.span("rank", { mode: request.mode, task_class: request.taskClass });
  const query: RankQuery = {
    mode: request.mode,
    taskClass: request.taskClass,
    tenant: request.tenant,
    requiresTools: selection.declared.length > 0,
    requiresVision: request.hasImages,
    limit: 8,
    exclude: [],
  };
  let candidates: CandidateRef[] = [];
  try {
    candidates = dedupeCandidates(await ports.candidates.rank(query), query);
  } catch (err) {
    notes.push(note("rank.failed", `rank() threw: ${errText(err).slice(0, 200)}`, "warn"));
  }
  if (candidates.length === 0 && ports.candidates.sweep) {
    try {
      candidates = dedupeCandidates(await ports.candidates.sweep(query), query);
      if (candidates.length > 0) {
        notes.push(note("rank.swept", "rank() was empty; used the sweep pool", "info"));
      }
    } catch (err) {
      notes.push(note("rank.sweep_failed", `sweep() threw: ${errText(err).slice(0, 200)}`, "warn"));
    }
  }
  if (candidates.length === 0) {
    notes.push(
      note(
        "rank.empty",
        "no candidate endpoints; the model port must resolve a lane itself",
        "warn",
      ),
    );
  }
  const head = candidates[0];
  rankSpan.end(true, {
    candidates: candidates.length,
    head: head?.tupleId,
    head_model: head?.modelId,
    requires_tools: query.requiresTools,
  });

  const budget = splitBudget(request.budgetMs);
  const manifest: BuildManifest = {
    modelRequested: request.model,
    mode: request.mode,
    taskClass: request.taskClass,
    candidates,
    tools: selection,
    prompt: promptParts,
    params: request.params,
    budget,
    limits: request.limits,
    notes,
  };

  ledger.emit({
    stage: "build",
    phase: "decision",
    data: {
      messages: messages.length,
      system_messages: systemMessages.length,
      chars: totalChars(),
      prompt_digest: digest(promptParts.map((p) => p.digest).join("|")),
      budget,
      notes: notes.length,
    },
  });
  span.end(true, { candidates: candidates.length, notes: notes.length });

  return { request: { ...request, notes }, messages, manifest };
}

/** Exposed for tests and for callers that want the split without a request. */
export function budgetFor(totalMs: number): BudgetSplit {
  return splitBudget(totalMs);
}
