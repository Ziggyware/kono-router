// Agent compiler: retrieve → K plan samples → MBR → DAG
// execution → join (finish | replan). One planner round trip replaces
// the `depth` sequential round trips ReAct needs for the same DAG.
import { isStatefulTool, safeStringify } from "../tools.ts";
import { lastJson, stripThinking } from "./json.ts";
import { isObj } from "../toolbox/util.ts";
import { MAX_NODES } from "./plan.ts";
import { samplePlans, TEMPS } from "./sample.ts";
import { runPlan } from "./schedule.ts";
import type { CompileOptions, CompileResult, NodeRun, Round, RunMetrics } from "./types.ts";
import { retrieveTools, signatureLine } from "./retrieve.ts";
import { joinerMessages, observe, plannerMessages } from "./prompts.ts";

export type * from "./types.ts";

const clampInt = (v: unknown, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Math.round(typeof v === "number" && Number.isFinite(v) ? v : d)));

const isVerdict = (v: unknown) => isObj(v) && (v.action === "finish" || v.action === "replan" || "answer" in v);

export async function compile(o: CompileOptions): Promise<CompileResult> {
  const started = performance.now();
  const samples = clampInt(o.samples, 1, TEMPS.length, 3);
  const maxRounds = clampInt(o.rounds, 1, 3, 2);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("compile budget exhausted")), clampInt(o.budgetMs, 1_000, 600_000, 120_000));
  o.signal?.addEventListener("abort", () => ctrl.abort(o.signal!.reason), { once: true });
  const tools = retrieveTools(o.question, { k: clampInt(o.k, 1, 40, 12), admin: o.admin ?? false, explicit: o.tools, fallback: o.fallbackTools ?? [] });
  const catalog = tools.map(signatureLine);
  const results = new Map<string, unknown>();
  const toolOfPrior = new Map<string, string>();
  const observations: string[] = [];
  const rounds: Round[] = [];
  let llm = 0;
  let toolCalls = 0;
  let reactTrips = 0;
  let compilerTrips = 0;
  let answer = "";

  try {
    for (let round = 0; round < maxRounds; round++) {
      const last = round === maxRounds - 1;
      const msgs = plannerMessages(o.question, catalog, observations, MAX_NODES);
      const sampled = await samplePlans(o.complete, msgs, samples, new Set(results.keys()), (id) => toolOfPrior.get(id), ctrl.signal);
      llm += samples;
      compilerTrips++;
      const { candidates } = sampled;
      let runs: NodeRun[] = [];
      let metrics: RunMetrics | null = null;

      if (sampled.plan) {
        const plan = sampled.plan;
        const out = await runPlan(plan, results, {
          exec: o.exec,
          concurrency: clampInt(o.concurrency, 1, 16, 6),
          estimateMs: o.estimateMs ?? (() => 50),
          stateful: isStatefulTool,
          signal: ctrl.signal,
        });
        runs = out.runs;
        metrics = out.metrics;
        toolCalls += runs.filter((r) => r.status !== "skipped").length;
        reactTrips += metrics.depth;
        for (const n of plan.nodes) toolOfPrior.set(n.id, n.tool);
        observations.push(`Round ${round + 1}:\n${runs.map(observe).join("\n") || "(plan used no tools)"}`);
      } else {
        observations.push(`Round ${round + 1}: no valid plan.\n${candidates.flatMap((c) => c.errors).slice(0, 12).join("\n")}`);
      }

      // A joiner reply with no verdict JSON (a reasoner that ran out of tokens) gets one retry on another lane.
      let joined: { content: string; model?: string } = { content: "" };
      let v: unknown;
      for (let attempt = 0; attempt < 2 && v === undefined; attempt++) {
        llm++;
        compilerTrips++;
        joined = await o.complete(joinerMessages(o.question, observations, last), { temperature: 0, max_tokens: 3000, signal: ctrl.signal, attempt });
        v = lastJson(joined.content, isVerdict);
      }
      const replan = !last && isObj(v) && v.action === "replan";
      const reason = isObj(v) && typeof v.reason === "string" ? v.reason : undefined;
      rounds.push({
        candidates,
        selected: sampled.selected,
        consensus: sampled.consensus,
        runs,
        metrics,
        join: { action: replan ? "replan" : "finish", reason, model: joined.model },
      });
      if (replan) {
        observations.push(`Joiner asked for a replan: ${reason ?? "results insufficient"}`);
        continue;
      }
      const a = isObj(v) && "answer" in v ? v.answer : undefined;
      answer = a === undefined ? stripThinking(joined.content) : typeof a === "string" ? a : safeStringify(a);
      break;
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    answer,
    tools: tools.map((t) => t.name),
    rounds,
    // ReAct spends one sequential LLM round trip per DAG level plus the final answer; the compiler spends plan + join per round.
    usage: { llm_calls: llm, tool_calls: toolCalls, react_round_trips: reactTrips + 1, compiler_round_trips: compilerTrips },
    ms: Math.round(performance.now() - started),
  };
}
