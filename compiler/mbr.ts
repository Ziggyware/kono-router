// Minimum Bayes risk plan selection (Kumar & Byrne 2004). K sampled plans are
// an empirical distribution; the pick maximises expected utility against it.
// Self-consistency (Wang et al. 2022) is the special case of exact-match utility.
import type { Plan } from "./plan.ts";
import { signature } from "./refs.ts";

/** Σmin/Σmax over multiset counts; two empty multisets are identical. */
export function multisetJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  for (const x of a) ca.set(x, (ca.get(x) ?? 0) + 1);
  for (const x of b) cb.set(x, (cb.get(x) ?? 0) + 1);
  let min = 0;
  let max = 0;
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    const x = ca.get(k) ?? 0;
    const y = cb.get(k) ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  return min / max;
}

export interface PlanView { tools: string[]; calls: string[]; size: number }

export function viewOf(plan: Plan, priorTool: (id: string) => string | undefined): PlanView {
  const byId = new Map(plan.nodes.map((n) => [n.id, n.tool]));
  const toolOf = (id: string) => byId.get(id) ?? priorTool(id);
  return { tools: plan.nodes.map((n) => n.tool), calls: plan.nodes.map((n) => signature(n, toolOf)), size: plan.nodes.length };
}

/** Utility u(p,q): exact calls carry half the mass, tool choice the other half, so near-misses in arguments still vote. */
export function utility(p: PlanView, q: PlanView): number {
  return 0.5 * multisetJaccard(p.calls, q.calls) + 0.5 * multisetJaccard(p.tools, q.tools);
}

export interface MbrPick { index: number; scores: number[]; consensus: number | null }

/** `validity` ∈ [0,1] down-weights plans whose literal arguments already fail their schemas. */
export function selectMbr(views: readonly PlanView[], validity: readonly number[]): MbrPick {
  const n = views.length;
  if (n === 0) throw new Error("selectMbr: no candidates");
  if (n === 1) return { index: 0, scores: [validity[0]], consensus: null };
  const u = views.map((p) => views.map((q) => utility(p, q)));
  const scores = views.map((_, i) => validity[i] * u[i].reduce((s, x, j) => (j === i ? s : s + x), 0) / (n - 1));
  let best = 0;
  for (let i = 1; i < n; i++) {
    const d = scores[i] - scores[best];
    if (d > 1e-9 || (Math.abs(d) <= 1e-9 && views[i].size < views[best].size)) best = i;
  }
  let pair = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pair += u[i][j];
  return { index: best, scores: scores.map((s) => Number(s.toFixed(4))), consensus: Number((pair / (n * (n - 1) / 2)).toFixed(4)) };
}
