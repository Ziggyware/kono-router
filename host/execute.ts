// host/execute.ts — stage 4 and 5: run the chunks, then assemble one answer.
//
// Execution rules that make this stage safe to point at production:
//   - a chunk runs only after its `needs` are ok; a failed dependency turns the
//     dependent into `skipped` instead of a confusing cascade of errors;
//   - every chunk and every tool call has its own deadline derived from the
//     request signal, and the concurrency cap is a real semaphore;
//   - one bounded retry, only for errors that are plausibly transient;
//   - the model-call budget is shared by the whole request and is checked
//     before each call, so a planner cannot starve the answer;
//   - assembly never invents an answer: no ok chunks means a degraded body
//     that names the failures.
//
// Every decision lands in the ledger with the chunk id attached, which is what
// turns "the router answered" into "chunk draft called model X, took 812ms,
// read chunks facts+lookup".

import type {
  Assembled,
  BuiltRequest,
  ChatMessage,
  Chunk,
  ChunkPlan,
  ChunkResult,
  HostPorts,
  Json,
  ToolResult,
} from "./contracts.ts";
import type { Ledger } from "./ledger.ts";
import { detectStall, nextStallTurn, wantsArtifactRequest } from "../engine/stall.ts";
import {
  abortable,
  errText,
  goalText,
  isRecord,
  note,
  safeStringify,
  tailCap,
  withDeadline,
} from "./support.ts";

export interface ExecuteOptions {
  chunkMs: number;
  synthMs: number;
}

export interface ExecuteOutcome {
  results: ChunkResult[];
  assembled: Assembled;
}

const DEP_OUTPUT_CHARS = 2_000;
const RETRYABLE = /timeout|deadline|429|rate.?limit|ECONN|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket|5\d\d/i;

const WHOLE_REF = /^\$\{?([a-z][a-z0-9_]{0,23})(?:[./]([^}]*))?\}?$/;
const INLINE_REF = /\$\{?([a-z][a-z0-9_]{0,23})(?:[./]([^}\s"',)]*))?\}?/g;

function pathGet(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cursor: unknown = value;
  for (const part of path.split(/[./]/)) {
    for (const segment of part.replace(/\[(\d+)\]/g, ".$1").split(".")) {
      if (!segment) continue;
      if (Array.isArray(cursor)) {
        const index = Number(segment);
        if (!Number.isInteger(index)) return undefined;
        cursor = cursor[index];
      } else if (isRecord(cursor)) {
        cursor = cursor[segment];
      } else {
        return undefined;
      }
    }
  }
  return cursor;
}

/** `$facts`, `$facts/items/0/title`, `${facts.count}` → the earlier chunk's
 *  value. Whole-string refs keep their type; inline refs become text. */
export function substituteRefs(
  value: unknown,
  results: ReadonlyMap<string, ChunkResult>,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const lookup = (id: string): ChunkResult => {
    const res = results.get(id);
    if (!res || res.status !== "ok") throw new Error(`REF_UNAVAILABLE: $${id}`);
    return res;
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = v.match(WHOLE_REF);
      if (whole) {
        const res = lookup(whole[1]);
        return pathGet(res.value !== undefined ? res.value : res.output, whole[2]);
      }
      return v.replace(INLINE_REF, (_match, id: string, path?: string) => {
        const res = lookup(id);
        const got = pathGet(res.value !== undefined ? res.value : res.output, path);
        return typeof got === "string" ? got : safeStringify(got, 4_000);
      });
    }
    if (Array.isArray(v)) return v.map(visit);
    if (isRecord(v)) {
      const out: Json = {};
      for (const [key, item] of Object.entries(v)) out[key] = visit(item);
      return out;
    }
    return v;
  };
  try {
    return { ok: true, value: visit(value) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function createSemaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

function chunkMessages(
  built: BuiltRequest,
  chunk: Chunk,
  deps: ChunkResult[],
  index: number,
  total: number,
): ChatMessage[] {
  const system =
    `You are running chunk ${index + 1} of ${total} of a routed request. ` +
    "Do only this chunk's job, as briefly as the job allows, and never restate the overall goal. " +
    "The host runs tools; you do not.";
  const earlier = deps
    .filter((d) => d.status === "ok")
    .map((d) => `## ${d.chunk.id} — ${d.chunk.title}\n${tailCap(d.output, DEP_OUTPUT_CHARS).text}`)
    .join("\n\n");
  const user = [
    `GOAL (context only, do not answer it):\n${tailCap(goalText(built.request.messages, 1_500), 1_500).text}`,
    earlier ? `EARLIER CHUNKS:\n${earlier}` : "",
    `YOUR CHUNK (${chunk.id} — ${chunk.title}):\n${chunk.prompt ?? chunk.title}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * A plan whose answer chunks form a chain (draft → polish → final) has exactly
 * one terminal answer, and that answer already consumed everything before it.
 * Collapsing the chain to it is both the cheapest and the most faithful
 * assembly: no extra model call, no re-summarising, no lost nuance.
 */
function terminalAnswer(ordered: ChunkResult[]): ChunkResult | undefined {
  const ok = ordered.filter((r) => r.status === "ok");
  const okIds = new Set(ok.map((r) => r.chunk.id));
  const consumed = new Set<string>();
  for (const r of ok) for (const dep of r.chunk.needs) consumed.add(dep);
  const terminals = ok.filter((r) => r.chunk.kind === "answer" && !consumed.has(r.chunk.id));
  if (terminals.length !== 1) return undefined;
  const terminal = terminals[0];
  const byId = new Map(ok.map((r) => [r.chunk.id, r]));
  const ancestors = new Set<string>();
  const stack = [...terminal.chunk.needs];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (ancestors.has(id) || !okIds.has(id)) continue;
    ancestors.add(id);
    const dep = byId.get(id);
    if (dep) stack.push(...dep.chunk.needs);
  }
  for (const r of ok) {
    if (r.chunk.id === terminal.chunk.id) continue;
    if (!ancestors.has(r.chunk.id)) return undefined;
  }
  return terminal;
}

function degradationText(results: ChunkResult[]): string {
  const failures = results
    .filter((r) => r.status !== "ok")
    .slice(0, 6)
    .map((r) => `${r.chunk.id}: ${r.code ?? "error"}${r.error ? ` — ${r.error.slice(0, 140)}` : ""}`)
    .join("; ");
  return (
    "[kono-host] No chunk of this request produced an answer, so nothing was fabricated. " +
    `Chunks attempted: ${results.length}. ${failures || "No failure detail was recorded."} ` +
    "Retry, or check GET /health for live endpoint coverage."
  );
}

export async function executePlan(
  built: BuiltRequest,
  plan: ChunkPlan,
  ports: HostPorts,
  ledger: Ledger,
  options: ExecuteOptions,
): Promise<ExecuteOutcome> {
  const { request } = built;
  const limits = request.limits;
  const span = ledger.span("chunk", {
    chunks: plan.chunks.length,
    source: plan.source,
    concurrency: limits.maxConcurrency,
    chunk_ms: options.chunkMs,
  });
  const results = new Map<string, ChunkResult>();
  const gate = createSemaphore(limits.maxConcurrency);
  let modelCalls = 0;

  const takeModelCall = (): boolean => {
    if (modelCalls >= limits.maxModelCalls) {
      ledger.addNote(
        note("chunk.model_budget", `model call budget ${limits.maxModelCalls} reached`, "degrade", "chunk"),
      );
      return false;
    }
    modelCalls++;
    ledger.bump("model_calls");
    return true;
  };

  const finishChunk = (result: ChunkResult): ChunkResult => {
    results.set(result.chunk.id, result);
    ledger.emit({
      stage: "chunk",
      phase: result.status === "ok" ? "end" : "error",
      chunkId: result.chunk.id,
      ok: result.status === "ok",
      ms: result.ms,
      model: result.model,
      attempt: result.attempts,
      data: {
        status: result.status,
        kind: result.chunk.kind,
        tool: result.chunk.tool,
        chars: result.output.length,
        code: result.code,
        error: result.error?.slice(0, 240),
      },
    });
    return result;
  };

  const runToolChunk = async (chunk: Chunk, deps: ChunkResult[]): Promise<ChunkResult> => {
    const t0 = Date.now();
    const byId = new Map(deps.map((d) => [d.chunk.id, d]));
    const args = substituteRefs(chunk.args ?? {}, byId);
    if (!args.ok) {
      return finishChunk({
        chunk,
        status: "failed",
        output: "",
        ms: Date.now() - t0,
        attempts: 0,
        error: args.error,
        code: "ref_unresolved",
      });
    }
    const timeoutMs = Math.min(limits.maxToolMs, options.chunkMs);
    let attempts = 0;
    let lastError = "";
    let lastCode = "tool_failed";
    while (attempts < 2) {
      attempts++;
      const started = Date.now();
      try {
        const value: ToolResult = await withDeadline(
          timeoutMs,
          request.signal,
          `tool:${chunk.tool}`,
          (signal) =>
            abortable(
              ports.tools.execute(chunk.tool as string, args.value as Json, {
                signal,
                tenant: request.tenant,
                timeoutMs,
              }),
              signal,
              `tool:${chunk.tool}`,
            ),
        );
        ledger.bump("tool_calls");
        ledger.emit({
          stage: "chunk",
          phase: "decision",
          chunkId: chunk.id,
          attempt: attempts - 1,
          ok: value.ok,
          ms: value.ms || Date.now() - started,
          data: { tool: chunk.tool, code: value.code, ok: value.ok },
        });
        if (value.ok) {
          const text = tailCap(safeStringify(value.value), chunk.outputCapChars);
          return finishChunk({
            chunk,
            status: "ok",
            output: text.text,
            value: value.value,
            ms: Date.now() - t0,
            attempts,
          });
        }
        lastError = value.error ?? "tool reported failure";
        lastCode = value.code ?? "tool_failed";
      } catch (err) {
        if (request.signal.aborted) throw err;
        lastError = errText(err);
        lastCode = /DEADLINE|timeout/i.test(lastError) ? "tool_timeout" : "tool_threw";
        ledger.emit({
          stage: "chunk",
          phase: "error",
          chunkId: chunk.id,
          attempt: attempts - 1,
          ok: false,
          ms: Date.now() - started,
          data: { tool: chunk.tool, error: lastError.slice(0, 240) },
        });
      }
      if (attempts === 1 && RETRYABLE.test(lastError)) {
        ledger.bump("retries");
        ledger.emit({
          stage: "chunk",
          phase: "retry",
          chunkId: chunk.id,
          attempt: 1,
          data: { tool: chunk.tool, reason: lastError.slice(0, 160) },
        });
        continue;
      }
      break;
    }
    return finishChunk({
      chunk,
      status: "failed",
      output: "",
      ms: Date.now() - t0,
      attempts,
      error: lastError,
      code: lastCode,
    });
  };

  const runAnswerChunk = async (
    chunk: Chunk,
    deps: ChunkResult[],
    index: number,
  ): Promise<ChunkResult> => {
    const t0 = Date.now();
    // A fallback plan is a pass-through: the caller's own messages, no framing.
    const passThrough = plan.source === "fallback" && plan.chunks.length === 1;
    const messages = passThrough
      ? built.messages
      : chunkMessages(built, chunk, deps, index, plan.chunks.length);
    const pin = built.manifest.candidates[0];
    let attempts = 0;
    let lastError = "";
    let lastCode = "model_failed";
    while (attempts < 2) {
      if (!takeModelCall()) {
        return finishChunk({
          chunk,
          status: "failed",
          output: "",
          ms: Date.now() - t0,
          attempts,
          error: `model call budget ${limits.maxModelCalls} exhausted`,
          code: "model_call_budget",
        });
      }
      attempts++;
      const started = Date.now();
      try {
        const reply = await withDeadline(
          options.chunkMs,
          request.signal,
          `chunk:${chunk.id}`,
          (signal) =>
            abortable(
              ports.models.complete({
                purpose: "chunk",
                messages,
                ...(pin ? { model: pin.modelId, tupleId: pin.tupleId } : {}),
                temperature: request.params.temperature ?? 0.3,
                maxTokens: request.params.maxTokens ?? 1_200,
                deadlineMs: options.chunkMs,
                signal,
                chunkId: chunk.id,
                attempt: attempts - 1,
              }),
              signal,
              `chunk:${chunk.id}`,
            ),
        );
        const text = tailCap(reply.content, chunk.outputCapChars);
        ledger.emit({
          stage: "chunk",
          phase: "decision",
          chunkId: chunk.id,
          attempt: attempts - 1,
          model: reply.model,
          tupleId: reply.tupleId,
          ms: reply.ms,
          data: {
            chars: reply.content.length,
            upstream_attempts: reply.upstreamAttempts,
            truncated: text.truncated,
            prompt_tokens: reply.usage?.promptTokens,
            completion_tokens: reply.usage?.completionTokens,
          },
        });
        if (!reply.content.trim()) {
          lastError = "model returned empty content";
          lastCode = "empty_content";
          if (attempts < 2) {
            ledger.bump("retries");
            ledger.emit({
              stage: "chunk",
              phase: "retry",
              chunkId: chunk.id,
              attempt: attempts,
              data: { reason: lastCode },
            });
            continue;
          }
          break;
        }
        return finishChunk({
          chunk,
          status: "ok",
          output: text.text,
          value: reply.content,
          ms: Date.now() - t0,
          attempts,
          model: reply.model,
        });
      } catch (err) {
        if (request.signal.aborted) throw err;
        lastError = errText(err);
        lastCode = /DEADLINE/i.test(lastError) ? "chunk_timeout" : "model_threw";
        ledger.emit({
          stage: "chunk",
          phase: "error",
          chunkId: chunk.id,
          attempt: attempts - 1,
          ok: false,
          ms: Date.now() - started,
          data: { error: lastError.slice(0, 240) },
        });
        if (attempts < 2 && RETRYABLE.test(lastError)) {
          ledger.bump("retries");
          ledger.emit({
            stage: "chunk",
            phase: "retry",
            chunkId: chunk.id,
            attempt: attempts,
            data: { reason: lastError.slice(0, 160) },
          });
          continue;
        }
        break;
      }
    }
    return finishChunk({
      chunk,
      status: "failed",
      output: "",
      ms: Date.now() - t0,
      attempts,
      error: lastError,
      code: lastCode,
    });
  };

  // ---- schedule ----------------------------------------------------------
  const promises = new Map<string, Promise<ChunkResult>>();
  for (const [index, chunk] of plan.chunks.entries()) {
    const deps = chunk.needs
      .map((id) => promises.get(id))
      .filter((p): p is Promise<ChunkResult> => p !== undefined);
    const promise = (async () => {
      ledger.emit({
        stage: "chunk",
        phase: "start",
        chunkId: chunk.id,
        data: { kind: chunk.kind, tool: chunk.tool, needs: chunk.needs, index },
      });
      const depResults = await Promise.all(deps);
      const failedDep = depResults.find((d) => d.status !== "ok");
      if (failedDep) {
        return finishChunk({
          chunk,
          status: "skipped",
          output: "",
          ms: 0,
          attempts: 0,
          error: `DEPENDENCY_FAILED: ${failedDep.chunk.id}`,
          code: "dependency_failed",
        });
      }
      return gate(() =>
        chunk.kind === "tool" ? runToolChunk(chunk, depResults) : runAnswerChunk(chunk, depResults, index)
      );
    })();
    promises.set(chunk.id, promise);
  }

  await Promise.all([...promises.values()]);
  const ordered = plan.chunks
    .map((c) => results.get(c.id))
    .filter((r): r is ChunkResult => r !== undefined);

  // ---- assemble ----------------------------------------------------------
  const assembleSpan = ledger.span("assemble", { chunks: ordered.length });
  const okChunks = ordered.filter((r) => r.status === "ok");
  const okAnswers = okChunks.filter((r) => r.chunk.kind === "answer");
  const pick = (r: ChunkResult): Assembled => ({
    content: r.output,
    finish: "stop",
    ...(r.model ? { modelUsed: r.model } : {}),
  });

  let assembled: Assembled;
  if (okChunks.length === 0) {
    assembled = { content: degradationText(ordered), finish: "degraded" };
    ledger.addNote(
      note("assemble.degraded", `${ordered.length} chunk(s) produced no usable output`, "degrade", "assemble"),
    );
  } else if (okAnswers.length === 1) {
    assembled = pick(okAnswers[0]);
    ledger.emit({
      stage: "assemble",
      phase: "decision",
      chunkId: okAnswers[0].chunk.id,
      ok: true,
      data: { path: "single_answer" },
    });
  } else if (terminalAnswer(ordered)) {
    const terminal = terminalAnswer(ordered) as ChunkResult;
    assembled = pick(terminal);
    ledger.emit({
      stage: "assemble",
      phase: "decision",
      chunkId: terminal.chunk.id,
      ok: true,
      data: { path: "chain_collapse", chunks: okChunks.length },
    });
  } else if (okAnswers.length === 0) {
    assembled = {
      content: okChunks
        .map((r) => `## ${r.chunk.title}\n${r.output}`)
        .join("\n\n"),
      finish: "stop",
    };
    ledger.emit({ stage: "assemble", phase: "decision", ok: true, data: { path: "tool_outputs" } });
  } else {
    const join = (): Assembled => ({
      content: okAnswers.map((r) => `## ${r.chunk.title}\n${r.output}`).join("\n\n"),
      finish: "stop",
    });
    if (modelCalls >= limits.maxModelCalls) {
      assembled = join();
      ledger.addNote(
        note("assemble.joined", "no model budget left for synthesis; chunk outputs were joined", "warn", "assemble"),
      );
      ledger.emit({ stage: "assemble", phase: "decision", ok: true, data: { path: "join_budget" } });
    } else {
      modelCalls++;
      ledger.bump("model_calls");
      const sections = okAnswers
        .map((r) => `## ${r.chunk.id} — ${r.chunk.title}\n${tailCap(r.output, 4_000).text}`)
        .join("\n\n");
      try {
        const reply = await withDeadline(
          options.synthMs,
          request.signal,
          "synthesize",
          (signal) =>
            abortable(
              ports.models.complete({
                purpose: "synthesize",
                messages: [
                  {
                    role: "system",
                    content:
                      "You are the synthesis stage. Combine the chunk results into one direct answer " +
                      "to the user's request. Do not mention chunks, do not repeat headings, do not invent facts.",
                  },
                  {
                    role: "user",
                    content: `REQUEST:\n${tailCap(goalText(request.messages, 2_000), 2_000).text}\n\nCHUNK RESULTS:\n${sections}`,
                  },
                ],
                temperature: 0.2,
                maxTokens: request.params.maxTokens ?? 1_500,
                deadlineMs: options.synthMs,
                signal,
                chunkId: "synthesize",
                attempt: 0,
              }),
              signal,
              "synthesize",
            ),
        );
        assembled = {
          content: reply.content.trim() || join().content,
          finish: "stop",
          modelUsed: reply.model,
          ...(reply.tupleId ? { tupleId: reply.tupleId } : {}),
        };
        ledger.emit({
          stage: "assemble",
          phase: "decision",
          chunkId: "synthesize",
          ok: true,
          ms: reply.ms,
          model: reply.model,
          data: { path: "synthesize", chars: assembled.content.length },
        });
      } catch (err) {
        if (request.signal.aborted) throw err;
        assembled = join();
        ledger.addNote(
          note("assemble.synth_failed", `synthesis failed, chunks joined: ${errText(err).slice(0, 200)}`, "degrade", "assemble"),
        );
        ledger.emit({
          stage: "assemble",
          phase: "error",
          chunkId: "synthesize",
          ok: false,
          data: { path: "join_after_error" },
        });
      }
    }
  }

  // ---- anti-pause --------------------------------------------------------
  // The same failure the route handles: an answer that announces the work and
  // then stops. The spine keeps it inside the call budget, records it like any
  // other call, and appends the continuation instead of discarding the plan the
  // model already wrote.
  // The continuation is a plain answer turn with no tools attached, so the
  // nudge must not promise them: `hasTools` stays false here even when the plan
  // used tools earlier.
  const wantsArtifact = wantsArtifactRequest(goalText(request.messages, 2_000));
  const stall = detectStall(assembled.content, { hasTools: false, wantsArtifact });
  const turn = nextStallTurn(stall, { continuations: 0 }, {
    hasTools: false,
    wantsArtifact,
    maxContinuations: 1,
    allowToolForce: false,
  });
  if (turn && assembled.finish === "stop" && modelCalls < limits.maxModelCalls) {
    modelCalls++;
    ledger.bump("model_calls");
    ledger.emit({
      stage: "assemble",
      phase: "retry",
      chunkId: "continue",
      attempt: 1,
      data: { kind: stall.kind, confidence: stall.confidence, chars: assembled.content.length },
    });
    const pin = built.manifest.candidates[0];
    try {
      const reply = await withDeadline(options.synthMs, request.signal, "continue", (signal) =>
        abortable(
          ports.models.complete({
            purpose: "chunk",
            messages: [
              ...built.messages,
              { role: "assistant", content: assembled.content },
              { role: "user", content: turn.nudge },
            ],
            ...(pin ? { model: pin.modelId, tupleId: pin.tupleId } : {}),
            temperature: request.params.temperature ?? 0.3,
            maxTokens: request.params.maxTokens ?? 1_500,
            deadlineMs: options.synthMs,
            signal,
            chunkId: "continue",
            attempt: 0,
          }),
          signal,
          "continue",
        ));
      if (reply.content.trim()) {
        assembled = {
          ...assembled,
          content: `${assembled.content}\n\n${reply.content.trim()}`,
          ...(reply.model ? { modelUsed: reply.model } : {}),
        };
        ledger.addNote(
          note(
            "assemble.continued",
            `answer paused (${stall.kind}@${stall.confidence}); continued on ${reply.model}`,
            "info",
            "assemble",
          ),
        );
        ledger.emit({
          stage: "assemble",
          phase: "decision",
          chunkId: "continue",
          ok: true,
          ms: reply.ms,
          model: reply.model,
          data: { kind: stall.kind, added_chars: reply.content.trim().length },
        });
      }
    } catch (err) {
      if (request.signal.aborted) throw err;
      ledger.addNote(
        note("assemble.continue_failed", errText(err).slice(0, 200), "warn", "assemble"),
      );
    }
  } else if (stall.stalled) {
    ledger.addNote(
      note(
        "assemble.stalled",
        `answer still pauses after ${turn ? "the continuation budget" : "no continuation"}: ${stall.kind}@${stall.confidence}`,
        "degrade",
        "assemble",
      ),
    );
  }

  assembleSpan.end(assembled.finish !== "degraded", {
    finish: assembled.finish,
    chars: assembled.content.length,
    ok_chunks: okChunks.length,
  });
  span.end(assembled.finish !== "degraded", {
    chunks: ordered.length,
    ok: okChunks.length,
    finish: assembled.finish,
    model_calls: modelCalls,
  });

  return { results: ordered, assembled };
}
