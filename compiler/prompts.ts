// Planner and joiner prompts. The planner emits the whole DAG in one call
// (no per-step LLM round trip); the joiner reads every result and either
// answers or asks for a replan with a stated reason.
import { safeStringify } from "../tools.ts";
import { truncate } from "../toolbox/util.ts";
import type { NodeRun } from "./types.ts";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

export function plannerMessages(question: string, catalog: string[], observations: string[], maxNodes: number): Msg[] {
  const system = [
    "You are a planning compiler. Translate the task into a DAG of tool calls that a runtime executes in parallel.",
    "Reply with JSON only, no prose:",
    '{"nodes":[{"id":"n1","tool":"<name>","args":{...}}, ...]}',
    "Rules:",
    "- ids are n1, n2, … and unique across rounds (continue numbering after earlier rounds).",
    '- To pass a result forward, set an argument to "$n1" (whole value, typed) or "$n1.field[0].x" (a path into it), or embed "${n1.field}" inside a string.',
    "- A node depends only on the nodes it references. Calls that do not consume each other's output must not reference each other: they run concurrently.",
    "- Earlier-round results can be referenced by their ids.",
    "- Use only the tools listed, with their exact argument names. Never call a tool to write the final answer.",
    `- At most ${maxNodes} nodes. Prefer the fewest calls that fully answer the task. If no tool is needed, return {"nodes":[]}.`,
    "",
    "Tools:",
    ...catalog.map((l) => `- ${l}`),
  ].join("\n");
  const user = observations.length
    ? `Task: ${question}\n\nEarlier rounds:\n${observations.join("\n\n")}\n\nPlan only what is still missing.`
    : `Task: ${question}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function joinerMessages(question: string, observations: string[], mustFinish: boolean): Msg[] {
  const system = [
    "You are the joiner of a planning compiler. Tool results for the task are below.",
    "Reply with JSON only:",
    '{"action":"finish","answer":"<complete answer for the user>"}',
    mustFinish
      ? "This is the final round: answer with what the results support and state plainly what they do not."
      : 'or {"action":"replan","reason":"<what is missing or failed and how to get it>"} when the results cannot support a correct answer.',
    "Ground every claim in the results; never invent values a tool did not return.",
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: `Task: ${question}\n\n${observations.join("\n\n") || "(no tool results)"}` }];
}

/** One executed node as the planner and joiner see it. */
export function observe(r: NodeRun): string {
  const call = `${r.id} = ${r.tool}(${truncate(safeStringify(r.args), 400)})`;
  return r.status === "ok" ? `${call} → ${truncate(safeStringify(r.result), 1500)}` : `${call} → ${r.status} ${r.code ?? ""}: ${r.error ?? ""}`;
}
