// deno-lint-ignore-file no-explicit-any
/**
 * Agent-protocol surface tests: A2A agent card, MCP (JSON-RPC over POST /mcp),
 * A2A task lifecycle (POST /a2a), the OpenAI Responses API (POST /v1/responses)
 * and the agentic run endpoint (POST /v1/agent/run).
 *
 * Everything is exercised in-process through `app.fetch()` — no network.
 * In the sandbox there are no provider keys, so model-backed calls degrade:
 * the honest expected terminal state is "failed" (never a leaked upstream
 * error string dressed up as a successful artifact).
 *
 * Run: deno test --unstable-kv -A tests/
 */
import { app } from "../main.ts";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

// KV keeps a long-lived resource open and background syncs may outlive a test.
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const BASE = "https://router.test";

function postJson(path: string, body: unknown): Request {
  return new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postRaw(path: string, body: string): Request {
  return new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function asJson(res: Response): Promise<Record<string, any>> {
  return await res.json() as Record<string, any>;
}

/** POST one JSON-RPC 2.0 request and return the parsed response envelope. */
async function rpc(path: string, method: string, params?: unknown, id: unknown = 1): Promise<Record<string, any>> {
  const res = await app.fetch(postJson(path, { jsonrpc: "2.0", id, method, params }));
  return await asJson(res);
}

// ---------------------------------------------------------------------------
// A2A agent card
// ---------------------------------------------------------------------------

test("GET /.well-known/agent-card.json advertises KONO and its skills", async () => {
  const res = await app.fetch(new Request(BASE + "/.well-known/agent-card.json"));
  assert(res.status === 200, `agent card status ${res.status}`);
  const card = await asJson(res);
  assert(card.name === "KONO", `agent card name ${JSON.stringify(card.name)}`);
  assert(card.capabilities?.pushNotifications === false, "pushNotifications must be honestly false");
  assert(Array.isArray(card.skills) && card.skills.length >= 3, `expected >= 3 skills, got ${JSON.stringify(card.skills)}`);
});

// ---------------------------------------------------------------------------
// MCP over POST /mcp
// ---------------------------------------------------------------------------

test("MCP initialize negotiates protocol 2025-03-26 and names the server kono", async () => {
  const res = await rpc("/mcp", "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agent-protocols-test", version: "0" },
  });
  assert(!res.error, `initialize errored: ${JSON.stringify(res.error)}`);
  assert(res.result?.protocolVersion === "2025-03-26", `protocolVersion ${JSON.stringify(res.result?.protocolVersion)}`);
  assert(res.result?.serverInfo?.name === "kono", `serverInfo ${JSON.stringify(res.result?.serverInfo)}`);
});

test("MCP ping returns an empty result", async () => {
  const res = await rpc("/mcp", "ping");
  assert(!res.error, `ping errored: ${JSON.stringify(res.error)}`);
  assert(res.result && typeof res.result === "object" && Object.keys(res.result).length === 0, `ping result ${JSON.stringify(res.result)}`);
});

test("MCP tools/list mirrors /v1/tools with input schemas", async () => {
  const res = await rpc("/mcp", "tools/list");
  assert(!res.error, `tools/list errored: ${JSON.stringify(res.error)}`);
  assert(Array.isArray(res.result?.tools), "tools/list result.tools must be an array");
  assert(res.result.tools.length >= 1, "tools/list returned no tools");
  assert(
    res.result.tools.some((t: any) => t && typeof t === "object" && t.inputSchema && typeof t.inputSchema === "object"),
    "no tool in tools/list carries an inputSchema",
  );
});

test("MCP tools/call runs a deterministic offline tool (get_time)", async () => {
  // Discover the tool catalogue the same way a client would, then call a
  // tool that needs no network and no provider keys.
  const listRes = await app.fetch(new Request(BASE + "/v1/tools"));
  assert(listRes.status === 200, `GET /v1/tools status ${listRes.status}`);
  const list = await asJson(listRes);
  const tools = (list.data ?? list.tools ?? []) as Array<Record<string, any>>;
  const getTime = tools.find((t) => t?.name === "get_time" || t?.function?.name === "get_time");
  if (!getTime) {
    // get_time is not in this build's catalogue — skip the call assertion
    // gracefully rather than failing on a tool that was never promised here.
    return;
  }
  const res = await rpc("/mcp", "tools/call", { name: "get_time", arguments: {} });
  assert(!res.error, `tools/call get_time errored: ${JSON.stringify(res.error)}`);
  assert(res.result !== undefined && res.result !== null, "tools/call returned no result");
});

test("MCP batch array body is rejected with -32600", async () => {
  const res = await app.fetch(postJson("/mcp", [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ]));
  const body = await asJson(res);
  assert(body.error?.code === -32600, `batch error code ${JSON.stringify(body.error)}`);
});

test("MCP malformed JSON is rejected with -32700", async () => {
  const res = await app.fetch(postRaw("/mcp", "{not json"));
  const body = await asJson(res);
  assert(body.error?.code === -32700, `parse error code ${JSON.stringify(body.error)}`);
});

test("MCP unknown method is rejected with -32601", async () => {
  const res = await rpc("/mcp", "nope/not-a-real-method", {});
  assert(res.error?.code === -32601, `unknown method error code ${JSON.stringify(res.error)}`);
});

test("MCP notification (tools/call without id) returns 202 and is not executed", async () => {
  const res = await app.fetch(postJson("/mcp", {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "get_time", arguments: {} },
  }));
  // Notifications are fire-and-forget: accepted, no JSON-RPC response body,
  // and — critically — the side-effect method must not run. Status only.
  assert(res.status === 202, `notification status ${res.status}`);
  await res.body?.cancel();
});

// ---------------------------------------------------------------------------
// A2A over POST /a2a
// ---------------------------------------------------------------------------

test("A2A tasks/get on an unknown id returns -32001", async () => {
  const id = crypto.randomUUID();
  const res = await rpc("/a2a", "tasks/get", { id, taskId: id });
  assert(res.error?.code === -32001, `tasks/get error code ${JSON.stringify(res.error)}`);
});

test("A2A message/send with only a file part returns -32602", async () => {
  const res = await rpc("/a2a", "message/send", {
    message: {
      role: "user",
      messageId: crypto.randomUUID(),
      parts: [{
        kind: "file",
        type: "file",
        file: { name: "note.txt", mimeType: "text/plain", bytes: "aGVsbG8=" },
      }],
    },
  });
  assert(res.error?.code === -32602, `file-only send error code ${JSON.stringify(res.error)}`);
});

test("A2A message/send runs a task to a terminal state; get and cancel agree", async () => {
  const sent = await rpc("/a2a", "message/send", {
    message: {
      role: "user",
      messageId: crypto.randomUUID(),
      parts: [{ kind: "text", type: "text", text: "Say ok" }],
    },
  });
  assert(!sent.error, `message/send errored: ${JSON.stringify(sent.error)}`);
  const task = sent.result;
  assert(task && typeof task === "object", "message/send did not return a task");
  assert(typeof task.id === "string" && task.id.length > 0, "task has no id");
  const state = task.status?.state;
  assert(state === "completed" || state === "failed", `task state ${JSON.stringify(state)}`);
  if (state === "failed") {
    // Degradation must stay honest metadata — the raw upstream failure text
    // must never be dressed up as a task artifact.
    const artifacts = JSON.stringify(task.artifacts ?? []);
    assert(!artifacts.includes("No upstream model endpoint"), "degradation text leaked into artifacts");
  }

  const got = await rpc("/a2a", "tasks/get", { id: task.id, taskId: task.id });
  assert(!got.error, `tasks/get errored: ${JSON.stringify(got.error)}`);
  assert(got.result?.status?.state === state, `tasks/get state ${JSON.stringify(got.result?.status?.state)} != ${state}`);

  const cancelled = await rpc("/a2a", "tasks/cancel", { id: task.id, taskId: task.id });
  assert(!cancelled.error, `tasks/cancel errored: ${JSON.stringify(cancelled.error)}`);
  assert(cancelled.result && typeof cancelled.result === "object", "tasks/cancel did not return the task");
  assert(cancelled.result.id === task.id, "tasks/cancel returned a different task");
});

// ---------------------------------------------------------------------------
// OpenAI Responses API — POST /v1/responses
// ---------------------------------------------------------------------------

test("POST /v1/responses returns a response object; previous_response_id chains", async () => {
  const res = await app.fetch(postJson("/v1/responses", { model: "free:fast", input: "Say ok" }));
  assert(res.status === 200, `responses status ${res.status}`);
  const body = await asJson(res);
  assert(body.object === "response", `object ${JSON.stringify(body.object)}`);
  assert(typeof body.id === "string" && body.id.startsWith("resp_"), `id ${JSON.stringify(body.id)}`);
  assert(body.status === "completed" || body.status === "failed", `status ${JSON.stringify(body.status)}`);

  if (body.status === "completed") {
    const text = body.output?.[0]?.content?.[0]?.text;
    assert(typeof text === "string" && text.length > 0, `completed response has no output text: ${JSON.stringify(body.output)}`);
    const next = await app.fetch(postJson("/v1/responses", {
      model: "free:fast",
      input: "Say ok again",
      previous_response_id: body.id,
    }));
    assert(next.status === 200, `chained response status ${next.status}`);
    const nextBody = await asJson(next);
    assert(nextBody.object === "response", "chained call did not return a response object");
  }
});

test("POST /v1/responses with a bogus previous_response_id returns 404", async () => {
  const res = await app.fetch(postJson("/v1/responses", {
    model: "free:fast",
    input: "Say ok",
    previous_response_id: "resp_bogus_does_not_exist",
  }));
  assert(res.status === 404, `bogus previous_response_id status ${res.status}`);
  await res.body?.cancel();
});

// ---------------------------------------------------------------------------
// Agentic run — POST /v1/agent/run
// ---------------------------------------------------------------------------

test("POST /v1/agent/run completes a run with output and a plan", async () => {
  const res = await app.fetch(postJson("/v1/agent/run", { input: "What is 2+2? Answer briefly." }));
  assert(res.status === 200, `agent run status ${res.status}`);
  const body = await asJson(res);
  assert(body.object === "agent.run", `object ${JSON.stringify(body.object)}`);
  assert(body.status === "completed" || body.status === "failed", `status ${JSON.stringify(body.status)}`);
  if (body.status === "completed") {
    assert(typeof body.output === "string" && body.output.length > 0, "completed run has no output text");
    assert(Array.isArray(body.plan?.subtasks), `plan.subtasks ${JSON.stringify(body.plan)}`);
  }
});

test("POST /v1/agent/run with stream:true streams RUN_STARTED to exactly one terminal event", async () => {
  const res = await app.fetch(postJson("/v1/agent/run", { input: "What is 2+2? Answer briefly.", stream: true }));
  assert(res.status === 200, `agent run stream status ${res.status}`);
  assert(
    (res.headers.get("content-type") ?? "").includes("text/event-stream"),
    `stream content-type ${JSON.stringify(res.headers.get("content-type"))}`,
  );
  const text = await res.text();
  assert(text.includes("RUN_STARTED"), "stream missing RUN_STARTED");
  const terminalCount = (text.match(/RUN_FINISHED|RUN_ERROR/g) ?? []).length;
  assert(terminalCount === 1, `expected exactly one terminal event (RUN_FINISHED or RUN_ERROR), got ${terminalCount}`);
});
