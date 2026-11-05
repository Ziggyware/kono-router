// Plan grammar (LLMCompiler, Kim et al. 2023): a DAG of tool calls whose
// arguments reference upstream results (see refs.ts).
import { parseToolArguments, resolveTool, validateJson } from "../tools.ts";
import { arr, isObj, str } from "../toolbox/util.ts";
import { ID_RE, walkRefs } from "./refs.ts";
import { lastJson, stripThinking } from "./json.ts";
import type { Json } from "../toolbox/types.ts";

export interface PlanNode {
  id: string;
  tool: string;
  args: Json;
  deps: string[];
  issues: string[];
}
export interface Plan { nodes: PlanNode[]; order: string[] }
export interface PlanParse { ok: boolean; plan?: Plan; errors: string[] }

export const MAX_NODES = 24;
// The planner is told to use n1…nK; an unknown id of that shape is a dangling ref, anything else is literal text.
const CONVENTIONAL = /^n\d+$/;

const listOf = (v: Json): unknown[] => arr(v.nodes ?? v.plan ?? v.steps ?? v.calls);
const isNode = (e: unknown) => isObj(e) && (typeof e.tool === "string" || typeof e.name === "string" || isObj(e.function));
/** A plan is an array of nodes or an object holding one; an empty array is the explicit "no tools needed". */
function isPlanShape(v: unknown): boolean {
  const list = Array.isArray(v) ? (v.length ? v : null) : isObj(v) && Array.isArray(v.nodes ?? v.plan ?? v.steps ?? v.calls) ? listOf(v) : null;
  return list !== null && list.every(isNode);
}

/** Parses a planner reply into a validated, topologically ordered DAG. `prior` = ids with results from earlier rounds. */
export function parsePlan(raw: string, prior: ReadonlySet<string>): PlanParse {
  const v = lastJson(raw, isPlanShape);
  if (v === undefined) return { ok: false, errors: [`no JSON plan in reply: ${JSON.stringify(stripThinking(raw).slice(0, 160))}`] };
  const list = Array.isArray(v) ? v : listOf(v as Json);
  if (list.length > MAX_NODES) return { ok: false, errors: [`plan has ${list.length} nodes; max ${MAX_NODES}`] };
  const errors: string[] = [];
  const drafts = list.filter(isObj).map((e, i) => {
    const id = str(e.id) ?? `n${i + 1}`;
    const fn = isObj(e.function) ? e.function : e;
    const name = str(e.tool ?? fn.name) ?? "";
    let args: unknown = e.args ?? e.arguments ?? fn.arguments ?? e.parameters ?? {};
    if (typeof args === "string") args = parseToolArguments(args).value;
    const { tool, suggestions } = resolveTool(name);
    if (!ID_RE.test(id)) errors.push(`${id}: invalid id`);
    if (!tool) errors.push(`${id}: unknown tool "${name}"${suggestions.length ? ` (did you mean ${suggestions.map((s) => s.name).join(", ")}?)` : ""}`);
    if (!isObj(args)) errors.push(`${id}: args must be an object`);
    return { id, tool: tool?.name ?? name, schema: tool?.parameters, args: (isObj(args) ? args : {}) as Json, explicit: arr(e.deps ?? e.depends_on).filter((d): d is string => typeof d === "string") };
  });
  const ids = new Set<string>();
  for (const d of drafts) {
    if (ids.has(d.id) || prior.has(d.id)) errors.push(`${d.id}: duplicate id`);
    ids.add(d.id);
  }
  const nodes: PlanNode[] = drafts.map((d) => {
    const deps = new Set<string>();
    const add = (id: string) => {
      if (ids.has(id) && id !== d.id) deps.add(id);
      else if (id === d.id) errors.push(`${d.id}: references itself`);
      else if (!prior.has(id) && CONVENTIONAL.test(id)) errors.push(`${d.id}: unknown reference $${id}`);
    };
    walkRefs(d.args, add);
    d.explicit.forEach(add);
    let refs = 0;
    walkRefs(d.args, (id) => { if (ids.has(id) || prior.has(id)) refs++; });
    const issues = refs === 0 && d.schema
      ? validateJson(d.args, d.schema, { coerce: true }).issues.filter((i) => i.severity === "error").map((i) => `${i.path || "/"} ${i.message}`)
      : [];
    return { id: d.id, tool: d.tool, args: d.args, deps: [...deps], issues };
  });
  // Kahn's algorithm: emits a topological order or exposes the cycle.
  const indeg = new Map(nodes.map((n) => [n.id, n.deps.length]));
  const queue = nodes.filter((n) => n.deps.length === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const n of nodes) {
      if (!n.deps.includes(id)) continue;
      indeg.set(n.id, indeg.get(n.id)! - 1);
      if (indeg.get(n.id) === 0) queue.push(n.id);
    }
  }
  if (order.length < nodes.length) errors.push(`cycle among ${nodes.filter((n) => !order.includes(n.id)).map((n) => n.id).join(", ")}`);
  return errors.length ? { ok: false, errors } : { ok: true, plan: { nodes, order }, errors };
}
