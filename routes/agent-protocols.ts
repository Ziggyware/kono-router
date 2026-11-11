// routes/agent-protocols.ts — Agent protocol surfaces extracted as a new area:
// A2A agent card, MCP Streamable HTTP, A2A JSON-RPC, and the OpenAI Responses
// adapter. main.ts calls registerAgentProtocols() to register these routes.
// Nothing here executes work directly: every call is re-dispatched in-process
// through honoApp.request (the routes/ops.ts pattern), so sub-calls inherit
// routing, learning, quota, free-tier and traces exactly as external calls do.

import { honoApp, kv, SSE_HEADERS } from "../state.ts";

// deno-lint-ignore no-explicit-any
type Ctx = any;
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const DAY_MS = 86_400_000;
const TASK_KEY = "kono_agent_task_v1";
const RESPONSE_KEY = "kono_response_v1";
const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);
const JSON_HEADERS = { "Content-Type": "application/json" };

// ---------------------------------------------------------------------------
// Internal dispatch — the canonical way this router calls itself. Forwards
// ONLY the caller's identity headers (never server-side credentials), pins
// x-forwarded-for to the real caller IP so free-tier/rate limits bill the
// caller, and bumps x-nokey-depth so nested dispatch can bound recursion.
// ---------------------------------------------------------------------------
async function internalCall(c: Ctx, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  for (const h of ["authorization", "x-admin-secret", "x-nokey-session", "x-session-id", "traceparent"]) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }
  headers["x-forwarded-for"] = c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
  headers["x-nokey-depth"] = String((parseInt(c.req.header("x-nokey-depth") || "0", 10) || 0) + 1);
  return await honoApp.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

// A degraded dispatch produced NO model answer — its body is a status notice,
// never content. Detected via header or the body's nokey.degraded flag.
function isDegraded(res: Response, body: Json | null): boolean {
  return res.headers.get("x-nokey-degraded") !== null || body?.nokey?.degraded === true;
}

// Constant-time compare for the shared router key (length folded into the diff).
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length, 1);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i % Math.max(a.length, 1)) || 0) ^ (b.charCodeAt(i % Math.max(b.length, 1)) || 0);
  }
  return diff === 0;
}

// Auth for /mcp and /a2a only, and only when ROUTER_API_KEY is configured:
// no token at all → proceed anonymously (the forwarded IP's free tier pays
// for internal /v1 calls); a token that is present but wrong → 401.
function authGate(c: Ctx): Response | null {
  const key = Deno.env.get("ROUTER_API_KEY");
  if (!key) return null;
  const auth = c.req.header("authorization");
  if (!auth) return null;
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
  if (timingSafeEqual(token, key)) return null;
  return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401, headers: JSON_HEADERS });
}

// Caller identity for task/response ownership: sha256 of the strongest
// identity header present. Foreign-owned ids are indistinguishable from
// unknown ids — no existence leak across callers.
async function ownerKey(c: Ctx): Promise<string> {
  const src = c.req.header("authorization") || c.req.header("x-nokey-session") ||
    c.req.header("x-session-id") || "anon";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing shared by /mcp and /a2a.
// ---------------------------------------------------------------------------
function rpcOk(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), { status: 200, headers: JSON_HEADERS });
}
function rpcErr(id: unknown, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), { status, headers: JSON_HEADERS });
}

// Parses the request body as a single JSON-RPC object, or returns the error
// response to send. Batches are rejected: this server is deliberately simple.
async function parseRpc(c: Ctx): Promise<{ rpc: Json } | { error: Response }> {
  const raw = await c.req.raw.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: rpcErr(null, -32700, "Parse error", 400) };
  }
  if (Array.isArray(parsed)) return { error: rpcErr(null, -32600, "JSON-RPC batching is not supported", 400) };
  if (!parsed || typeof parsed !== "object") return { error: rpcErr(null, -32600, "Invalid Request", 400) };
  return { rpc: parsed as Json };
}

// Notifications (no id) are acknowledged with 202 and NEVER executed — the
// only ones with meaning here are notifications/initialized and
// notifications/cancelled, and both are no-ops on a stateless server.
function isNotification(rpc: Json): boolean {
  return !("id" in rpc) || rpc.id === undefined;
}

// ---------------------------------------------------------------------------
// Endpoint 1 — A2A agent card. Generated, public, no auth.
// ---------------------------------------------------------------------------
function handleAgentCard(c: Ctx): Response {
  return c.json({
    name: "KONO",
    description: "Keyless orchestration router: one endpoint, every model, no keys. Speaks OpenAI chat, MCP, A2A, AG-UI and the Responses API.",
    url: "/",
    version: "1.0.0",
    protocolVersion: "0.2.5",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      { id: "chat", name: "Keyless multi-model chat", description: "Lane-routed chat across free providers", tags: ["chat", "llm"] },
      { id: "tools", name: "Tool plane", description: "Built-in and runtime-forged tools via MCP or /v1/tools", tags: ["tools", "mcp"] },
      { id: "agent-run", name: "Multi-agent run", description: "Plan, parallel workers, verify, synthesize — AG-UI events at POST /v1/agent/run", tags: ["agents", "orchestration"] },
      { id: "images", name: "Image generation", description: "POST /v1/images/generations", tags: ["images"] },
    ],
    authentication: { schemes: ["bearer"] },
  });
}

// ---------------------------------------------------------------------------
// Endpoint 2 — MCP Streamable HTTP (stateless: no server-initiated stream,
// no session). Tool failures are tool results with isError, never transport
// errors — that distinction is what lets MCP clients recover.
// ---------------------------------------------------------------------------
async function handleMcp(c: Ctx): Promise<Response> {
  const parsed = await parseRpc(c);
  if ("error" in parsed) return parsed.error;
  const rpc = parsed.rpc;
  if (isNotification(rpc)) return new Response(null, { status: 202 });
  const gate = authGate(c);
  if (gate) return gate;
  const id = rpc.id;
  const params = (rpc.params ?? {}) as Json;
  switch (rpc.method) {
    case "initialize":
      return rpcOk(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "kono", version: "1.0.0" },
      });
    case "ping":
      return rpcOk(id, {});
    case "tools/list": {
      // /v1/tools already admin-filters the list for this caller — relay as-is.
      const res = await internalCall(c, "/v1/tools");
      const j = await res.json().catch(() => null) as Json | null;
      const data = Array.isArray(j?.data) ? j.data as Json[] : [];
      return rpcOk(id, {
        tools: data.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters ?? { type: "object", properties: {} },
        })),
      });
    }
    case "tools/call": {
      if (typeof params.name !== "string" || !params.name) return rpcErr(id, -32602, "params.name is required");
      const args = params.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return rpcErr(id, -32602, "params.arguments must be an object");
      const res = await internalCall(c, "/v1/tools/execute", { name: params.name, arguments: args });
      const j = await res.json().catch(() => null) as Json | null;
      const first = Array.isArray(j?.results) ? j.results[0] as Json | undefined : undefined;
      if (!first) return rpcOk(id, { content: [{ type: "text", text: "tool execution failed" }], isError: true });
      if (first.ok) {
        const text = typeof first.result === "string" ? first.result : JSON.stringify(first.result ?? null);
        return rpcOk(id, { content: [{ type: "text", text }], isError: false });
      }
      return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(first.error ?? first) }], isError: true });
    }
    default:
      return rpcErr(id, -32601, "Method not found");
  }
}

// ---------------------------------------------------------------------------
// Endpoint 3 — A2A JSON-RPC. Tasks persist in KV (24h TTL, refreshed on every
// write, writes only on state transitions); runners live in a module-level
// registry so tasks/cancel can abort in-flight work. Terminal states are
// sticky: a cancel that lands mid-run wins over the runner's result.
// ---------------------------------------------------------------------------
type AgentTask = {
  id: string;
  contextId: string;
  owner: string;
  state: string;
  artifacts: Json[];
  model: string | null;
  degraded: boolean;
  createdAt: number;
  updatedAt: number;
  history: Json[];
  message?: Json;
};

const RUNNERS = new Map<string, AbortController>();

async function persistTask(task: AgentTask): Promise<void> {
  task.updatedAt = Date.now();
  await kv.set([TASK_KEY, task.id], task, { expireIn: DAY_MS });
}

async function loadTask(id: string): Promise<AgentTask | null> {
  const v = (await kv.get([TASK_KEY, id])).value as AgentTask | null;
  return v && typeof v === "object" ? v : null;
}

function publicTask(t: AgentTask): Json {
  const status: Json = { state: t.state, timestamp: new Date(t.updatedAt).toISOString() };
  if (t.message) status.message = t.message;
  return {
    id: t.id,
    contextId: t.contextId,
    status,
    artifacts: t.artifacts,
    history: t.history ?? [],
    metadata: { model: t.model, degraded: t.degraded },
  };
}

// Runs a task submitted → working → (completed | failed | canceled). `emit`,
// when given (message/stream), receives status-update / artifact-update
// result objects; the final status-update is emitted exactly once, here.
async function runTask(c: Ctx, task: AgentTask, text: string, ctrl: AbortController, emit?: (ev: Json) => void): Promise<AgentTask> {
  RUNNERS.set(task.id, ctrl);
  const statusFrame = (state: string, final: boolean) =>
    emit?.({ kind: "status-update", taskId: task.id, contextId: task.contextId, status: { state }, final });
  try {
    task.state = "working";
    await persistTask(task);
    statusFrame("working", false);
    try {
      const res = await internalCall(c, "/v1/chat/completions", {
        model: task.model ?? "free:auto",
        messages: [{ role: "user", content: text }],
        tools: "auto",
      }, ctrl.signal);
      const j = await res.json().catch(() => null) as Json | null;
      if (ctrl.signal.aborted) {
        task.state = "canceled";
      } else if (res.status >= 400 || isDegraded(res, j)) {
        task.state = "failed";
        task.degraded = isDegraded(res, j);
      } else {
        const msg = (j?.choices as Json[] | undefined)?.[0]?.message as Json | undefined;
        const actual = typeof j?.model === "string" ? j.model : task.model;
        task.model = actual ?? null;
        task.artifacts = [{
          artifactId: crypto.randomUUID(),
          parts: [{ type: "text", text: typeof msg?.content === "string" ? msg.content : "" }],
          metadata: { model: actual ?? null },
        }];
        task.state = "completed";
      }
    } catch {
      task.state = ctrl.signal.aborted ? "canceled" : "failed";
    }
    if (task.state === "failed") {
      // Never relay the degradation body as if it were a model answer.
      task.message = { role: "agent", parts: [{ type: "text", text: "upstream degraded: no model answer was produced" }] };
    }
    // Terminal-state stickiness: if a cancel persisted while we ran, it wins.
    const cur = await loadTask(task.id);
    if (cur && cur.state === "canceled" && task.state !== "canceled") {
      statusFrame("canceled", true);
      return cur;
    }
    await persistTask(task);
    if (task.state === "completed" && task.artifacts[0]) {
      emit?.({ kind: "artifact-update", taskId: task.id, contextId: task.contextId, artifact: task.artifacts[0] });
    }
    statusFrame(task.state, true);
    return task;
  } finally {
    RUNNERS.delete(task.id);
  }
}

// Shared message/send validation + task creation. Returns either an error
// response, an existing task to return as-is (idempotent resend), or a fresh
// submitted task plus its extracted text.
async function prepareSend(c: Ctx, rpc: Json): Promise<{ error: Response } | { existing: AgentTask } | { task: AgentTask; text: string }> {
  const params = (rpc.params ?? {}) as Json;
  const msg = params.message as Json | undefined;
  if (!msg || !Array.isArray(msg.parts)) return { error: rpcErr(rpc.id, -32602, "message with parts is required") };
  let text = "";
  for (const p of msg.parts as Json[]) {
    if (p?.type === "text") text += typeof p.text === "string" ? p.text : "";
    else if (p?.type === "file" || p?.type === "data") return { error: rpcErr(rpc.id, -32602, "only text parts are supported") };
  }
  text = text.trim();
  if (!text) return { error: rpcErr(rpc.id, -32602, "message text is empty") };
  const owner = await ownerKey(c);
  const taskId = typeof params.id === "string" && params.id ? params.id : crypto.randomUUID();
  const existing = await loadTask(taskId);
  if (existing) {
    if (existing.owner !== owner) return { error: rpcErr(rpc.id, -32602, "task id already exists") };
    return { existing };
  }
  const meta = (params.metadata ?? {}) as Json;
  const task: AgentTask = {
    id: taskId,
    contextId: typeof params.contextId === "string" && params.contextId ? params.contextId : crypto.randomUUID(),
    owner,
    state: "submitted",
    artifacts: [],
    model: typeof meta.model === "string" && meta.model ? meta.model : "free:auto",
    degraded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [msg],
  };
  await persistTask(task);
  return { task, text };
}

async function a2aSend(c: Ctx, rpc: Json): Promise<Response> {
  const prep = await prepareSend(c, rpc);
  if ("error" in prep) return prep.error;
  if ("existing" in prep) return rpcOk(rpc.id, publicTask(prep.existing));
  const done = await runTask(c, prep.task, prep.text, new AbortController());
  return rpcOk(rpc.id, publicTask(done));
}

// message/stream: same run as message/send, framed as JSON-RPC SSE events.
// Exactly one terminal frame is guaranteed, even on error.
function a2aSendStream(c: Ctx, rpc: Json, prep: { existing?: AgentTask; task?: AgentTask; text?: string }): Response {
  const enc = new TextEncoder();
  const ctrl = new AbortController();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(streamCtrl) {
      let terminalSent = false;
      const send = (result: Json) => {
        if (result.final === true) terminalSent = true;
        try {
          streamCtrl.enqueue(enc.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result })}\n\n`));
        } catch { /* client gone */ }
      };
      const onAbort = () => ctrl.abort();
      c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
      stop = () => c.req.raw.signal.removeEventListener("abort", onAbort);
      (async () => {
        try {
          if (prep.existing) {
            const t = prep.existing;
            if (t.state === "completed" && t.artifacts[0]) {
              send({ kind: "artifact-update", taskId: t.id, contextId: t.contextId, artifact: t.artifacts[0] });
            }
            send({ kind: "status-update", taskId: t.id, contextId: t.contextId, status: { state: t.state }, final: true });
          } else if (prep.task && prep.text !== undefined) {
            send({ kind: "status-update", taskId: prep.task.id, contextId: prep.task.contextId, status: { state: "submitted" }, final: false });
            await runTask(c, prep.task, prep.text, ctrl, send);
          }
        } catch {
          // fall through: the finally below guarantees the terminal frame
        } finally {
          if (!terminalSent) {
            send({ kind: "status-update", taskId: prep.task?.id ?? prep.existing?.id ?? "", contextId: prep.task?.contextId ?? prep.existing?.contextId ?? "", status: { state: "failed" }, final: true });
          }
          stop();
          try { streamCtrl.close(); } catch { /* already closed */ }
        }
      })();
    },
    cancel: () => {
      ctrl.abort();
      stop();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

// tasks/resubscribe: replay the current state for terminal tasks; for a
// working task, poll KV every second and emit on change until terminal.
function a2aResubscribe(c: Ctx, rpc: Json, task: AgentTask): Response {
  const enc = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(streamCtrl) {
      let stopped = false;
      const send = (state: string, final: boolean) => {
        try {
          streamCtrl.enqueue(enc.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: { kind: "status-update", taskId: task.id, contextId: task.contextId, status: { state }, final } })}\n\n`));
        } catch { /* client gone */ }
      };
      const close = () => {
        stop();
        try { streamCtrl.close(); } catch { /* already closed */ }
      };
      stop = () => { stopped = true; };
      c.req.raw.signal.addEventListener("abort", close, { once: true });
      (async () => {
        if (TERMINAL_STATES.has(task.state)) {
          send(task.state, true);
          close();
          return;
        }
        let last = task.state;
        send(last, false);
        const deadline = Date.now() + 600_000; // 10 min cap
        while (!stopped && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          if (stopped) break;
          const cur = await loadTask(task.id).catch(() => null);
          if (!cur) { send("failed", true); close(); return; }
          if (cur.state !== last) {
            last = cur.state;
            send(last, TERMINAL_STATES.has(last));
            if (TERMINAL_STATES.has(last)) { close(); return; }
          }
        }
        if (!stopped) { send(last, true); close(); }
      })();
    },
    cancel: () => stop(),
  });
  return new Response(body, { headers: SSE_HEADERS });
}

// Loads a task for tasks/get / tasks/cancel / tasks/resubscribe with the
// owner check folded in: unknown and foreign-owned both read as TaskNotFound.
async function loadOwnedTask(c: Ctx, rpc: Json): Promise<{ task: AgentTask } | { error: Response }> {
  const params = (rpc.params ?? {}) as Json;
  if (typeof params.id !== "string" || !params.id) return { error: rpcErr(rpc.id, -32602, "params.id is required") };
  const task = await loadTask(params.id);
  if (!task || task.owner !== await ownerKey(c)) return { error: rpcErr(rpc.id, -32001, "TaskNotFound") };
  return { task };
}

async function handleA2a(c: Ctx): Promise<Response> {
  const parsed = await parseRpc(c);
  if ("error" in parsed) return parsed.error;
  const rpc = parsed.rpc;
  if (isNotification(rpc)) return new Response(null, { status: 202 });
  const gate = authGate(c);
  if (gate) return gate;
  switch (rpc.method) {
    case "message/send":
      return await a2aSend(c, rpc);
    case "message/stream": {
      const prep = await prepareSend(c, rpc);
      if ("error" in prep) return prep.error;
      return a2aSendStream(c, rpc, prep);
    }
    case "tasks/get": {
      const got = await loadOwnedTask(c, rpc);
      return "error" in got ? got.error : rpcOk(rpc.id, publicTask(got.task));
    }
    case "tasks/cancel": {
      const got = await loadOwnedTask(c, rpc);
      if ("error" in got) return got.error;
      const task = got.task;
      if (TERMINAL_STATES.has(task.state)) return rpcOk(rpc.id, publicTask(task));
      RUNNERS.get(task.id)?.abort();
      task.state = "canceled";
      await persistTask(task);
      return rpcOk(rpc.id, publicTask(task));
    }
    case "tasks/resubscribe": {
      const got = await loadOwnedTask(c, rpc);
      if ("error" in got) return got.error;
      return a2aResubscribe(c, rpc, got.task);
    }
    default:
      return rpcErr(rpc.id, -32601, "Method not found");
  }
}

// ---------------------------------------------------------------------------
// Endpoint 4 — OpenAI Responses adapter over /v1/chat/completions. Plain
// completions only (no tool plane), with the conversation chain persisted in
// KV so previous_response_id can resume it. Under /v1, so the router's own
// middleware auth + free tier already applied before we run.
// ---------------------------------------------------------------------------
function responsesObject(id: string, itemId: string, status: string, model: string | null, text: string | null, prevId: string | null, error?: Json): Json {
  const obj: Json = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: text === null ? [] : [{
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    previous_response_id: prevId,
    usage: null,
  };
  if (error) obj.error = error;
  return obj;
}

const DEGRADED_ERROR = { code: "upstream_degraded", message: "No upstream model endpoint returned a valid completion" };

// Converts Responses `input` (+ optional instructions) into chat messages.
function responsesMessages(body: Json): { messages: Json[] } | { error: string } {
  const messages: Json[] = [];
  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input as Json[]) {
      if (!item || typeof item !== "object") continue;
      let content = "";
      if (typeof item.content === "string") content = item.content;
      else if (Array.isArray(item.content)) {
        content = (item.content as Json[])
          .filter((p) => p?.type === "input_text" || p?.type === "text")
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("");
      }
      messages.push({ role: typeof item.role === "string" ? item.role : "user", content });
    }
  } else {
    return { error: "input is required (string or message array)" };
  }
  return { messages };
}

async function handleResponses(c: Ctx): Promise<Response> {
  const body = await c.req.json().catch(() => null) as Json | null;
  if (!body) return c.json({ error: { message: "invalid JSON body" } }, 400);
  const owner = await ownerKey(c);
  const prevId = typeof body.previous_response_id === "string" && body.previous_response_id ? body.previous_response_id : null;
  const converted = responsesMessages(body);
  if ("error" in converted) return c.json({ error: { message: converted.error } }, 400);
  let messages = converted.messages;
  if (prevId) {
    const stored = (await kv.get([RESPONSE_KEY, prevId])).value as { owner: string; messages: Json[] } | null;
    if (!stored || stored.owner !== owner) return c.json({ error: { message: "previous_response_id not found" } }, 404);
    messages = [...stored.messages, ...messages];
  }
  const model = typeof body.model === "string" && body.model ? body.model : "free:auto";
  const chatBody: Json = { model, messages };
  if (typeof body.temperature === "number") chatBody.temperature = body.temperature;
  if (typeof body.max_output_tokens === "number") chatBody.max_tokens = body.max_output_tokens;

  if (body.stream === true) return responsesStream(c, chatBody, messages, model, prevId, owner);

  const id = "resp_" + crypto.randomUUID();
  const itemId = "msg_" + crypto.randomUUID();
  const res = await internalCall(c, "/v1/chat/completions", chatBody);
  const j = await res.json().catch(() => null) as Json | null;
  if (isDegraded(res, j)) {
    return c.json(responsesObject(id, itemId, "failed", model, null, prevId, DEGRADED_ERROR), 200);
  }
  if (res.status >= 400) {
    return c.json(j ?? { error: { message: `upstream HTTP ${res.status}` } }, res.status);
  }
  const msg = (j?.choices as Json[] | undefined)?.[0]?.message as Json | undefined;
  const text = typeof msg?.content === "string" ? msg.content : null;
  if (text === null) {
    return c.json(responsesObject(id, itemId, "failed", model, null, prevId, DEGRADED_ERROR), 200);
  }
  const actual = typeof j?.model === "string" ? j.model : model;
  const chain = [...messages, { role: "assistant", content: text }];
  await kv.set([RESPONSE_KEY, id], { owner, messages: chain, createdAt: Date.now() }, { expireIn: DAY_MS });
  return c.json(responsesObject(id, itemId, "completed", actual, text, prevId), 200);
}

// Streaming Responses: translate the chat SSE stream into the Responses
// event sequence (created → output_text.delta* → output_text.done →
// completed), or a single response.failed if the upstream degraded.
function responsesStream(c: Ctx, chatBody: Json, messages: Json[], model: string, prevId: string | null, owner: string): Response {
  const id = "resp_" + crypto.randomUUID();
  const itemId = "msg_" + crypto.randomUUID();
  const enc = new TextEncoder();
  const ctrl = new AbortController();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(streamCtrl) {
      const send = (s: string) => {
        try { streamCtrl.enqueue(enc.encode(s)); } catch { /* client gone */ }
      };
      const onAbort = () => ctrl.abort();
      c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
      stop = () => c.req.raw.signal.removeEventListener("abort", onAbort);
      send(`event: response.created\ndata: ${JSON.stringify(responsesObject(id, itemId, "in_progress", model, null, prevId))}\n\n`);
      (async () => {
        let full = "";
        let actual = model;
        let degraded = false;
        try {
          const res = await internalCall(c, "/v1/chat/completions", { ...chatBody, stream: true }, ctrl.signal);
          if (res.headers.get("x-nokey-degraded")) degraded = true;
          if (!res.body) {
            degraded = true;
          } else {
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
              let idx;
              while ((idx = buf.indexOf("\n\n")) >= 0) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (frame.startsWith(":")) continue; // comment / heartbeat frame
                for (const line of frame.split("\n")) {
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;
                  const j = JSON.parse(payload) as Json;
                  if (j?.nokey?.degraded === true) { degraded = true; continue; }
                  if (typeof j?.model === "string") actual = j.model;
                  const choices = j?.choices as Json[] | undefined;
                  if (!choices || choices.length === 0) continue;
                  const delta = (choices[0]?.delta as Json | undefined)?.content;
                  if (typeof delta === "string" && delta) {
                    full += delta;
                    send(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta })}\n\n`);
                  }
                }
              }
            }
          }
        } catch {
          if (!ctrl.signal.aborted) degraded = true;
        }
        try {
          if (ctrl.signal.aborted) return;
          if (degraded) {
            const failed = responsesObject(id, itemId, "failed", model, null, prevId, DEGRADED_ERROR);
            send(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: failed })}\n\n`);
          } else {
            send(`event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: full })}\n\n`);
            const doneObj = responsesObject(id, itemId, "completed", actual, full, prevId);
            send(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: doneObj })}\n\n`);
            const chain = [...messages, { role: "assistant", content: full }];
            await kv.set([RESPONSE_KEY, id], { owner, messages: chain, createdAt: Date.now() }, { expireIn: DAY_MS });
          }
        } finally {
          stop();
          try { streamCtrl.close(); } catch { /* already closed */ }
        }
      })();
    },
    cancel: () => {
      ctrl.abort();
      stop();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

export function registerAgentProtocols() {
  honoApp.get("/.well-known/agent-card.json", handleAgentCard);
  honoApp.post("/mcp", handleMcp);
  honoApp.get("/mcp", () =>
    rpcErr(null, -32601, "Method not allowed: this MCP server is stateless and offers no server-initiated stream", 405));
  honoApp.post("/a2a", handleA2a);
  honoApp.post("/v1/responses", handleResponses);
}
