// host/host.ts — the orchestrator. It owns exactly four things: request ids,
// the master abort/deadline signal, the stage order, and the report ring.
// All routing logic lives in the stages; all state lives in the ledger.

import type {
  ChunkPlan,
  ChunkResult,
  EventSink,
  HostContext,
  HostPorts,
  HostResponse,
  HostRouter,
  RequestLimits,
  RouteReport,
} from "./contracts.ts";
import { Ledger } from "./ledger.ts";
import { intake, mergeLimits } from "./intake.ts";
import { buildRequest } from "./build.ts";
import { decompose } from "./decompose.ts";
import { executePlan } from "./execute.ts";
import { errText, isAbort, note, shortId } from "./support.ts";

export interface HostRouterOptions {
  /** Per-router overrides of the default limits. */
  limits?: Partial<RequestLimits>;
  /** How many reports stay resolvable by `report(id)` (ring, newest kept). */
  retainReports?: number;
}

function emptyPlan(requestId: string, rationale: string): ChunkPlan {
  return {
    requestId,
    source: "fallback",
    rationale,
    chunks: [],
    plannerAttempts: 0,
    plannerMs: 0,
    rejects: [],
    repairErrors: [],
  };
}

function explainReport(r: Omit<RouteReport, "explain">): string {
  const ok = r.chunks.filter((c) => c.status === "ok").length;
  const head =
    `${r.requestId} ${r.modelRequested} → ${r.mode}/${r.taskClass} | ` +
    `plan ${r.planSource} (${r.chunks.length} chunk${r.chunks.length === 1 ? "" : "s"}, ${ok} ok) | ` +
    `calls model ${r.modelCalls} / tool ${r.toolCalls}, retries ${r.retries}, errors ${r.errors} | ` +
    `${Math.round(r.totalMs)}ms of ${Math.round(r.budgetMs)}ms | finish ${r.finish}`;
  const lines = r.chunks.map((c) => {
    const outcome = c.status === "ok" ? `ok ${Math.round(c.ms)}ms` : `${c.status} (${c.code ?? "error"})`;
    const model = c.model ? ` via ${c.model}` : "";
    const tool = c.chunk.tool ? ` tool=${c.chunk.tool}` : "";
    return `  ${c.chunk.id} [${c.chunk.kind}${tool}] → ${outcome}${model}${c.output ? ` ${c.output.length}c` : ""}`;
  });
  const degraded = r.notes.filter((n) => n.severity === "degrade");
  const notes = r.notes.length > 0
    ? `\nnotes: ${r.notes.length}${degraded.length ? ` (${degraded.length} degraded: ${degraded.slice(0, 3).map((n) => n.code).join(", ")})` : ""}`
    : "";
  const stages = `\nstages: ${r.stages.map((s) => `${s.stage} ${Math.round(s.ms)}ms${s.errors ? `/${s.errors}err` : ""}`).join(" · ")}`;
  return [head, ...lines, stages + notes].join("\n");
}

export function createHostRouter(ports: HostPorts, options: HostRouterOptions = {}): HostRouter {
  const limits = mergeLimits(options.limits);
  const retain = Math.max(1, Math.round(options.retainReports ?? 64));
  const clock = ports.clock ?? { now: () => Date.now() };
  const ids = ports.ids ?? { next: (prefix: string) => `${prefix}_${shortId()}` };
  const reports = new Map<string, RouteReport>();

  return {
    async handle(raw: unknown, ctx: HostContext): Promise<HostResponse> {
      const requestId = ids.next("req");
      const startedAt = clock.now();
      const sinks: EventSink[] = ports.events ? [ports.events] : [];
      const ledger = new Ledger({ requestId, startedAt, clock: clock.now, sinks });

      const draft = intake(raw, ctx, limits, ledger);

      // One master signal: caller disconnect, budget expiry, or an internal
      // abort all look the same downstream, which is what makes cleanup simple.
      const master = new AbortController();
      const onCallerAbort = () => master.abort(ctx.signal?.reason ?? new Error("CLIENT_DISCONNECTED"));
      if (ctx.signal) {
        if (ctx.signal.aborted) onCallerAbort();
        else ctx.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      const budgetTimer = setTimeout(
        () => master.abort(new Error(`BUDGET_EXCEEDED: ${draft.budgetMs}ms`)),
        Math.max(1, draft.budgetMs),
      );
      const request = { ...draft, signal: master.signal };

      let plan = emptyPlan(requestId, "no plan: the request failed before decomposition");
      let results: ChunkResult[] = [];
      let content = "";
      let finish: RouteReport["finish"] = "degraded";
      let modelUsed: string | undefined;
      let tupleId: string | undefined;

      try {
        const built = await buildRequest(request, ports, ledger);
        plan = await decompose(built, ports, ledger, built.manifest.budget.plannerMs);
        const outcome = await executePlan(built, plan, ports, ledger, {
          chunkMs: built.manifest.budget.chunkMs,
          synthMs: built.manifest.budget.synthMs,
        });
        results = outcome.results;
        content = outcome.assembled.content;
        finish = outcome.assembled.finish;
        modelUsed = outcome.assembled.modelUsed;
        tupleId = outcome.assembled.tupleId;
      } catch (err) {
        const aborted = isAbort(err) && master.signal.aborted;
        finish = aborted ? "abort" : "degraded";
        content = aborted
          ? `[kono-host] Request aborted before an answer was produced (${errText(err).slice(0, 120)}).`
          : `[kono-host] The host failed before producing an answer. Nothing was fabricated. ${errText(err).slice(0, 200)}`;
        ledger.addNote(
          note(
            aborted ? "request.aborted" : "request.internal_error",
            errText(err).slice(0, 300),
            "degrade",
            "done",
          ),
        );
        ledger.emit({
          stage: "done",
          phase: "error",
          ok: false,
          data: { finish, error: errText(err).slice(0, 240) },
        });
      } finally {
        clearTimeout(budgetTimer);
        ctx.signal?.removeEventListener("abort", onCallerAbort);
      }

      if (finish !== "abort") {
        ledger.emit({
          stage: "done",
          phase: "end",
          ok: finish === "stop",
          data: {
            finish,
            chars: content.length,
            model: modelUsed,
            tuple_id: tupleId,
            chunks: results.length,
          },
        });
      }

      const counters = ledger.counters();
      const totalMs = ledger.elapsed();
      const fields: Omit<RouteReport, "explain"> = {
        requestId,
        traceparent: request.traceparent,
        modelRequested: request.model,
        ...(modelUsed ? { modelUsed } : {}),
        ...(tupleId ? { tupleId } : {}),
        mode: request.mode,
        taskClass: request.taskClass,
        planSource: plan.source,
        stages: ledger.summarize(),
        modelCalls: counters.model_calls,
        toolCalls: counters.tool_calls,
        retries: counters.retries,
        errors: counters.errors,
        chunks: results,
        notes: ledger.notes,
        totalMs,
        budgetMs: request.budgetMs,
        finish,
      };
      const report: RouteReport = { ...fields, explain: () => explainReport(fields) };

      reports.set(requestId, report);
      while (reports.size > retain) {
        const oldest = reports.keys().next();
        if (oldest.done) break;
        reports.delete(oldest.value);
      }

      return { content, finish, report, plan, events: ledger.events };
    },

    report(requestId: string): RouteReport | undefined {
      return reports.get(requestId);
    },
  };
}
