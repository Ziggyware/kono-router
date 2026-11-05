// Plan sampling: K planner calls in one parallel round trip at spread
// temperatures (and lanes, by `attempt`), parsed, then reduced to one plan by MBR.
import { type Plan, parsePlan } from "./plan.ts";
import { selectMbr, viewOf } from "./mbr.ts";
import type { Msg } from "./prompts.ts";

export type Complete = (messages: Msg[], o: { temperature: number; max_tokens: number; signal: AbortSignal; attempt: number }) => Promise<{ content: string; model?: string }>;
export interface Candidate { model?: string; ok: boolean; nodes: number; errors: string[]; mbr?: number }
export interface Sampled { candidates: Candidate[]; plan: Plan | null; selected: number | null; consensus: number | null }

export const TEMPS = [0.2, 0.6, 0.9, 1.0, 1.1];

export async function samplePlans(
  complete: Complete,
  msgs: Msg[],
  samples: number,
  prior: ReadonlySet<string>,
  priorTool: (id: string) => string | undefined,
  signal: AbortSignal,
): Promise<Sampled> {
  const settled = await Promise.allSettled(TEMPS.slice(0, samples).map((temperature, attempt) => complete(msgs, { temperature, max_tokens: 4000, signal, attempt })));
  const parsed = settled.map((s) => s.status === "fulfilled"
    ? { model: s.value.model, ...parsePlan(s.value.content, prior) }
    : { model: undefined, ok: false, plan: undefined, errors: [`planner call failed: ${String((s.reason as Error)?.message ?? s.reason)}`] });
  const candidates: Candidate[] = parsed.map((p) => ({ model: p.model, ok: p.ok, nodes: p.plan?.nodes.length ?? 0, errors: p.errors.slice(0, 8) }));
  const valid = parsed.flatMap((p, i) => (p.ok && p.plan ? [{ plan: p.plan, i }] : []));
  if (!valid.length) return { candidates, plan: null, selected: null, consensus: null };
  // Literal arguments that already fail their schema lower a plan's weight; refs are only checkable at run time.
  const validity = valid.map(({ plan }) => plan.nodes.length ? plan.nodes.filter((n) => n.issues.length === 0).length / plan.nodes.length : 1);
  const pick = selectMbr(valid.map(({ plan }) => viewOf(plan, priorTool)), validity);
  valid.forEach((x, j) => (candidates[x.i].mbr = pick.scores[j]));
  return { candidates, plan: valid[pick.index].plan, selected: valid[pick.index].i, consensus: pick.consensus };
}
