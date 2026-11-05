// DAG executor: list scheduling by upward rank (HEFT, Topcuoglu et al. 2002)
// over learned tool latencies, bounded concurrency, data-dependency skipping.
import type { Plan } from "./plan.ts";
import { substitute } from "./refs.ts";
import type { ExecResult, NodeRun, RunMetrics, RunOptions } from "./types.ts";

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Runs the plan; successful outputs land in `results` so later rounds can reference them. */
export async function runPlan(plan: Plan, results: Map<string, unknown>, o: RunOptions): Promise<{ runs: NodeRun[]; metrics: RunMetrics }> {
  const node = new Map(plan.nodes.map((n) => [n.id, n]));
  // Stateful tools share a store: chain them in topological order (ordering edge, not data).
  const after = new Map(plan.order.map((id) => [id, new Set(node.get(id)!.deps)]));
  let prev: string | undefined;
  for (const id of plan.order) {
    if (!o.stateful(node.get(id)!.tool)) continue;
    if (prev) after.get(id)!.add(prev);
    prev = id;
  }
  const children = new Map(plan.order.map((id) => [id, [] as string[]]));
  for (const [id, deps] of after) for (const d of deps) children.get(d)!.push(id);
  const rank = new Map<string, number>();
  for (const id of [...plan.order].reverse()) {
    rank.set(id, o.estimateMs(node.get(id)!.tool) + Math.max(0, ...children.get(id)!.map((c) => rank.get(c)!)));
  }

  const t0 = performance.now();
  const runs = new Map<string, NodeRun>();
  const pending = new Map(plan.order.map((id) => [id, after.get(id)!.size]));
  const ready = plan.order.filter((id) => pending.get(id) === 0);
  const running = new Map<string, Promise<string>>();

  const settle = (id: string) => {
    for (const c of children.get(id)!) {
      pending.set(c, pending.get(c)! - 1);
      if (pending.get(c) !== 0) continue;
      const bad = node.get(c)!.deps.find((d) => runs.get(d)?.status !== "ok");
      if (bad) {
        finish(c, { status: "skipped", error: `upstream ${bad} ${runs.get(bad)!.status}`, code: "UPSTREAM_FAILED" }, performance.now(), performance.now());
        settle(c);
      } else ready.push(c);
    }
  };
  const finish = (id: string, r: Pick<NodeRun, "status"> & Partial<NodeRun>, start: number, end: number) => {
    const n = node.get(id)!;
    runs.set(id, { id, tool: n.tool, args: n.args, deps: n.deps, rank_ms: r1(rank.get(id)!), start_ms: r1(start - t0), end_ms: r1(end - t0), ms: r1(end - start), ...r });
  };
  const launch = (id: string): Promise<string> => {
    const n = node.get(id)!;
    const start = performance.now();
    const sub = substitute(n.args, results);
    if (!sub.ok) {
      finish(id, { status: "error", error: sub.error, code: "BAD_REF" }, start, performance.now());
      return Promise.resolve(id);
    }
    return o.exec(n.tool, sub.value, o.signal)
      .catch((e): ExecResult => ({ ok: false, error: String(e?.message ?? e), code: "EXEC_THREW", ms: 0 }))
      .then((x) => {
        if (x.ok) results.set(id, x.result);
        finish(id, x.ok ? { status: "ok", args: sub.value, result: x.result } : { status: "error", args: sub.value, error: x.error, code: x.code }, start, performance.now());
        return id;
      });
  };

  while (ready.length || running.size) {
    ready.sort((a, b) => rank.get(b)! - rank.get(a)!);
    while (ready.length && running.size < o.concurrency) {
      const id = ready.shift()!;
      if (o.signal.aborted) {
        finish(id, { status: "skipped", error: "deadline", code: "DEADLINE" }, performance.now(), performance.now());
        settle(id);
        continue;
      }
      running.set(id, launch(id));
    }
    if (!running.size) continue;
    const done = await Promise.race(running.values());
    running.delete(done);
    settle(done);
  }

  const list = plan.order.map((id) => runs.get(id)!);
  const ran = list.filter((r) => r.status !== "skipped");
  const finishAt = new Map<string, number>();
  const level = new Map<string, number>();
  for (const id of plan.order) {
    const r = runs.get(id)!;
    finishAt.set(id, r.ms + Math.max(0, ...[...after.get(id)!].map((d) => finishAt.get(d)!)));
    level.set(id, 1 + Math.max(0, ...node.get(id)!.deps.map((d) => level.get(d)!)));
  }
  const makespan = Math.max(0, ...list.map((r) => r.end_ms));
  const work = ran.reduce((s, r) => s + r.ms, 0);
  return {
    runs: list,
    metrics: {
      makespan_ms: r1(makespan),
      work_ms: r1(work),
      critical_path_ms: r1(Math.max(0, ...finishAt.values())),
      parallelism: makespan > 0 ? Number((work / makespan).toFixed(2)) : 0,
      depth: Math.max(0, ...level.values()),
    },
  };
}
