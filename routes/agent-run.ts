// routes/agent-run.ts — bounded multi-agent orchestration over this router's
// own chat plane. main.ts calls registerAgentRun() to attach the route.
//
// POST /v1/agent/run
//   PLAN       1 chat call  → JSON plan of ≤ 4 independent subtasks
//   WORKERS    ≤ 4 chat calls in parallel (tools:"auto"), one per subtask
//   VERIFY     1 chat call  → pass/fail; on fail, failed workers re-run ONCE
//   RETRY      ≤ 4 chat calls (only the failed workers, only once)
//   SYNTHESIZE 1 chat call  → the final answer
//
// Hard bound: 1 + 4 + 1 + 4 + 1 = 11 chat calls worst case, typically 7.
// Every sub-call goes in-process through honoApp.request (the ops.ts
// /v1/agent/compile precedent), so runs inherit routing, learning, quota,
// free-tier accounting and traces instead of bypassing them.
//
// Degradation is never dressed up as an answer: any sub-call that comes back
// degraded fails the whole run honestly (status "failed" / RUN_ERROR) rather
// than letting placeholder text flow into the synthesis.

import { honoApp, kv, SSE_HEADERS } from "../state.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatMessage = { role: string; content: string };

type ToolExec = Record<string, unknown>;

type ChatResult = {
  content: string;
  model: string;
  degraded: boolean;
  toolsExecuted: ToolExec[];
};

type Subtask = { id: string; title: string; detail: string };

type Step = {
  name: string;
  status: "completed" | "failed";
  ms: number;
  tools_executed?: ToolExec[];
};

type RunState = {
  plan: Subtask[];
  steps: Step[];
  chatCalls: number;
};

type Hooks = {
  stepStarted?: (name: string) => void;
  stepFinished?: (step: Step) => void;
};

// Minimal structural view of the Hono context this module needs.
type ChatCtx = {
  req: {
    header: (name: string) => string | undefined;
    raw: { signal: AbortSignal };
  };
};

/** A sub-call came back degraded — no upstream really answered. */
export class DegradedError extends Error {
  readonly code = "upstream_degraded";
  constructor() {
    super("upstream_degraded");
    this.name = "DegradedError";
  }
}

// ---------------------------------------------------------------------------
// Internal chat call — the canonical sibling-module contract (see ops.ts).
// Forwards ONLY the caller's identity/billing headers, the request's
// traceparent when present, a normalized x-forwarded-for, and an incremented
// x-nokey-depth so nested runs stay visible (and bounded) downstream.
// ---------------------------------------------------------------------------

async function internalChat(
  c: ChatCtx,
  opts: { model: string; messages: ChatMessage[]; signal?: AbortSignal; tools?: string },
): Promise<ChatResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const h of ["authorization", "x-admin-secret", "x-nokey-session", "x-session-id"]) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }
  const traceparent = c.req.header("traceparent");
  if (traceparent) headers["traceparent"] = traceparent;
  headers["x-forwarded-for"] = c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
  const depth = Number.parseInt(c.req.header("x-nokey-depth") ?? "0", 10);
  headers["x-nokey-depth"] = String((Number.isFinite(depth) ? depth : 0) + 1);

  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };
  if (opts.tools) payload.tools = opts.tools;

  const res = await honoApp.request("/v1/chat/completions", {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) {
    throw new Error(`chat call failed: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (res.headers.get("x-nokey-degraded")) throw new DegradedError();
  const j = await res.json() as {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    nokey?: { degraded?: unknown; tools_executed?: unknown };
  };
  if (j.nokey?.degraded === true) throw new DegradedError();
  const content = j.choices?.[0]?.message?.content;
  return {
    content: typeof content === "string" ? content : "",
    model: typeof j.model === "string" ? j.model : opts.model,
    degraded: false,
    toolsExecuted: Array.isArray(j.nokey?.tools_executed) ? j.nokey.tools_executed as ToolExec[] : [],
  };
}

// ---------------------------------------------------------------------------
// Small parsing helpers. Model output is untrusted text: a bad plan falls
// back to "just do the goal", a bad verdict counts as a pass — a formatting
// slip by one sub-call must never fail the whole run.
// ---------------------------------------------------------------------------

function extractJson(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  return a >= 0 && b > a ? tryParse(text.slice(a, b + 1)) : null;
}

function parsePlan(text: string, goal: string): Subtask[] {
  const parsed = extractJson(text);
  const raw = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
  const subtasks: Subtask[] = [];
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : "";
    const detail = typeof o.detail === "string" && o.detail.trim() ? o.detail.trim() : title;
    if (!detail) continue;
    subtasks.push({ id: `st_${subtasks.length + 1}`, title: title || detail.slice(0, 80), detail });
  }
  // Fallback: one subtask that IS the goal — the run proceeds, just un-split.
  return subtasks.length ? subtasks : [{ id: "st_1", title: "Complete the goal", detail: goal }];
}

function parseVerdict(text: string, plan: Subtask[]): { fail: boolean; failedIds: string[] } {
  const parsed = extractJson(text);
  if (!parsed) return { fail: false, failedIds: [] }; // unparseable → pass
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict.toLowerCase() : "";
  const fail = verdict === "fail" || verdict === "failed" || parsed.pass === false;
  if (!fail) return { fail: false, failedIds: [] };
  const ids = Array.isArray(parsed.failed)
    ? parsed.failed.filter((x): x is string => typeof x === "string" && plan.some((s) => s.id === x))
    : [];
  // A fail with no named culprits re-runs everything once — still in budget.
  return { fail: true, failedIds: ids.length ? ids : plan.map((s) => s.id) };
}

function toolName(t: ToolExec): string {
  return typeof t.name === "string" ? t.name : typeof t.tool === "string" ? t.tool : "unknown_tool";
}

// ---------------------------------------------------------------------------
// The run itself. Mutates `state` (plan / steps / chatCalls) as it goes so a
// failed run can still report honest partial progress.
// ---------------------------------------------------------------------------

async function executeRun(args: {
  c: ChatCtx;
  goal: string;
  model: string;
  signal?: AbortSignal;
  state: RunState;
  hooks?: Hooks;
}): Promise<{ output: string; model: string }> {
  const { c, goal, model, signal, state, hooks } = args;
  const call = (messages: ChatMessage[], tools?: string) => {
    state.chatCalls++;
    return internalChat(c, { model, messages, signal, tools });
  };
  const timed = async <T>(name: string, fn: () => Promise<{ value: T; tools?: ToolExec[] }>): Promise<T> => {
    hooks?.stepStarted?.(name);
    const t0 = performance.now();
    try {
      const { value, tools } = await fn();
      const step: Step = { name, status: "completed", ms: Math.round(performance.now() - t0) };
      if (tools && tools.length) step.tools_executed = tools;
      state.steps.push(step);
      hooks?.stepFinished?.(step);
      return value;
    } catch (err) {
      const step: Step = { name, status: "failed", ms: Math.round(performance.now() - t0) };
      state.steps.push(step);
      hooks?.stepFinished?.(step);
      throw err;
    }
  };

  // PLAN ————————————————————————————————————————————————————————————————
  const planText = await timed("plan", async () => ({ value: (await call([
    {
      role: "system",
      content: "You are a planning agent. Split the user's goal into at most 4 INDEPENDENT subtasks " +
        "that can be executed in parallel and later combined. Respond with ONLY a JSON object: " +
        '{"subtasks":[{"title":"short title","detail":"self-contained instructions"}]}. No prose.',
    },
    { role: "user", content: goal },
  ])).content }));
  state.plan = parsePlan(planText, goal);

  // WORKERS —————————————————————————————————————————————————————————————
  type WorkerOut = { subtask: Subtask; content: string; tools: ToolExec[] };
  const runWorker = (subtask: Subtask, stepName: string): Promise<WorkerOut> =>
    timed(stepName, async () => {
      const r = await call([
        {
          role: "system",
          content: "You are a worker agent executing one subtask of a larger goal. " +
            "Use tools when they help. Return a complete, self-contained result for your subtask only.",
        },
        { role: "user", content: `Goal: ${goal}\n\nYour subtask: ${subtask.title} — ${subtask.detail}` },
      ], "auto");
      return { value: { subtask, content: r.content, tools: r.toolsExecuted }, tools: r.toolsExecuted };
    });
  const workers: WorkerOut[] = await Promise.all(
    state.plan.map((s) => runWorker(s, `worker:${s.id}`)),
  );
  const combined = () =>
    workers.map((w) => `## ${w.subtask.id} — ${w.subtask.title}\n${w.content}`).join("\n\n");

  // VERIFY (+ one bounded retry of the failed workers) ————————————————————
  const verdictText = await timed("verify", async () => ({ value: (await call([
    {
      role: "system",
      content: "You are a strict verifier. Judge whether the combined worker output fully and " +
        'correctly satisfies the goal. Respond with ONLY a JSON object: {"verdict":"pass"} or ' +
        '{"verdict":"fail","failed":["st_1"],"notes":"what is wrong"}. No prose.',
    },
    { role: "user", content: `Goal: ${goal}\n\nCombined worker output:\n${combined()}` },
  ])).content }));
  const verdict = parseVerdict(verdictText, state.plan);
  if (verdict.fail) {
    const targets = state.plan.filter((s) => verdict.failedIds.includes(s.id));
    const retried = await Promise.all(targets.map((s) => runWorker(s, `retry:${s.id}`)));
    for (const r of retried) {
      const i = workers.findIndex((w) => w.subtask.id === r.subtask.id);
      if (i >= 0) workers[i] = r;
    }
  }

  // SYNTHESIZE ——————————————————————————————————————————————————————————
  const synth = await timed("synthesize", async () => {
    const r = await call([
      {
        role: "system",
        content: "You are the synthesis agent. Using the verified worker results, write the final " +
          "answer to the user's goal. Be complete and direct; do not mention the internal process.",
      },
      { role: "user", content: `Goal: ${goal}\n\nWorker results:\n${combined()}` },
    ]);
    return { value: r, tools: r.toolsExecuted };
  });
  return { output: synth.content, model: synth.model };
}

// Best-effort run record in KV (inspectable later; never blocks the answer).
function persistRun(runId: string, record: Record<string, unknown>): void {
  kv.set(["agent_runs", runId], record, { expireIn: 7 * 86_400_000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerAgentRun() {
  honoApp.post("/v1/agent/run", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      input?: unknown;
      messages?: unknown;
      model?: unknown;
      stream?: unknown;
    };

    // Goal: explicit input wins, else the last user message's content.
    let goal = typeof body.input === "string" ? body.input.trim() : "";
    if (!goal && Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i] as { role?: unknown; content?: unknown };
        if (m?.role === "user" && typeof m.content === "string") {
          goal = m.content.trim();
          break;
        }
      }
    }
    if (!goal) {
      return c.json({ error: { message: "input (or a user message) is required" } }, 400);
    }
    const model = typeof body.model === "string" && body.model ? body.model : "free:smart";
    const runId = `run_${crypto.randomUUID()}`;
    const state: RunState = { plan: [], steps: [], chatCalls: 0 };
    const wantsStream = body.stream === true ||
      (c.req.header("accept") ?? "").includes("text/event-stream");

    // ——— Non-streaming: run to completion, answer once. ———————————————————
    if (!wantsStream) {
      try {
        const { output, model: outModel } = await executeRun({
          c, goal, model, signal: c.req.raw.signal, state,
        });
        const result = {
          id: runId,
          object: "agent.run",
          status: "completed",
          model: outModel,
          output,
          plan: { subtasks: state.plan },
          steps: state.steps,
          usage: { chat_calls: state.chatCalls },
        };
        persistRun(runId, result);
        return c.json(result);
      } catch (err) {
        const degraded = err instanceof DegradedError;
        const failed = {
          id: runId,
          object: "agent.run",
          status: "failed",
          model,
          output: null,
          error: degraded ? "upstream_degraded" : "run_failed",
          plan: { subtasks: state.plan },
          steps: state.steps,
          usage: { chat_calls: state.chatCalls },
        };
        persistRun(runId, failed);
        return c.json(failed);
      }
    }

    // ——— Streaming: AG-UI events over SSE (traces.ts stream pattern). ——————
    // Tool events are synthesized AFTER each step's chat call returns, from
    // that call's nokey.tools_executed, labeled in order — by design, since
    // the in-process chat call only reports tools once it completes.
    const enc = new TextEncoder();
    const ac = new AbortController();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (s: string) => {
          try {
            ctrl.enqueue(enc.encode(s));
          } catch {
            stop();
          }
        };
        const sendEvent = (ev: Record<string, unknown>) => send(`data: ${JSON.stringify(ev)}\n\n`);
        const hb = setInterval(() => send(": hb\n\n"), 15_000);
        stop = () => {
          clearInterval(hb);
          ac.abort();
        };
        c.req.raw.signal.addEventListener("abort", () => {
          stop();
          try {
            ctrl.close();
          } catch { /* already closed */ }
        }, { once: true });

        const hooks: Hooks = {
          stepStarted: (name) => sendEvent({ type: "STEP_STARTED", stepName: name }),
          stepFinished: (step) => {
            sendEvent({ type: "STEP_FINISHED", stepName: step.name });
            (step.tools_executed ?? []).forEach((t, i) => {
              const toolCallId = `${runId}-${step.name}-${i}`;
              sendEvent({ type: "TOOL_CALL_START", toolCallId, toolCallName: toolName(t) });
              sendEvent({
                type: "TOOL_CALL_RESULT",
                toolCallId,
                content: JSON.stringify({ ok: t.ok ?? true, ms: t.ms ?? 0 }),
              });
            });
          },
        };

        (async () => {
          sendEvent({ type: "RUN_STARTED", threadId: runId, runId });
          try {
            const { output, model: outModel } = await executeRun({
              c, goal, model, signal: ac.signal, state, hooks,
            });
            const messageId = `${runId}-msg`;
            sendEvent({ type: "TEXT_MESSAGE_START", messageId });
            sendEvent({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: output });
            sendEvent({ type: "TEXT_MESSAGE_END", messageId });
            persistRun(runId, {
              id: runId, object: "agent.run", status: "completed", model: outModel,
              output, steps: state.steps, usage: { chat_calls: state.chatCalls },
            });
            sendEvent({ type: "RUN_FINISHED", threadId: runId, runId, result: { output } });
          } catch (err) {
            const degraded = err instanceof DegradedError;
            sendEvent({
              type: "RUN_ERROR",
              message: degraded ? "upstream_degraded" : (err instanceof Error ? err.message : "run_failed"),
              code: degraded ? "upstream_degraded" : "run_failed",
            });
          } finally {
            clearInterval(hb);
            try {
              ctrl.close();
            } catch { /* already closed */ }
          }
        })();
      },
      cancel: () => stop(),
    });
    return new Response(stream, { headers: SSE_HEADERS });
  });
}
