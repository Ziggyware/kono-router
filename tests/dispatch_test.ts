// deno-lint-ignore-file no-explicit-any
/**
 * End-to-end dispatch tests against a fully mocked upstream registry.
 * No external network is used: globalThis.fetch is replaced, and the real
 * Hono app is exercised through `app.fetch()`.
 *
 * Run: deno test --unstable-kv -A tests/
 */
import { app } from "../main.ts";

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;
const encoder = new TextEncoder();

interface MockState {
  urls: Set<string>;
  chatUrls: Set<string>;
  calls: number;
  responder: (url: string, init: RequestInit | undefined) => Response;
}

let mock: MockState;

function installMock(responder: MockState["responder"]): MockState {
  mock = { urls: new Set(), chatUrls: new Set(), calls: 0, responder };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    mock.calls++;
    mock.urls.add(url);
    if (init?.method === "POST") mock.chatUrls.add(url);
    return Promise.resolve(mock.responder(url, init));
  }) as typeof globalThis.fetch;
  return mock;
}

function restoreMock() {
  globalThis.fetch = realFetch;
}

const LONG_ANSWER =
  "The adaptive stochastic control kernel selected a healthy upstream endpoint and streamed " +
  "a deterministic verification answer across the full keyless relay mesh.";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(content = LONG_ANSWER): Response {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 80) }, index: 0 }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(80) }, index: 0 }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(encoder.encode(c));
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function completionJson(content = LONG_ANSWER): Response {
  return jsonResponse({
    id: "mock", object: "chat.completion", created: 1,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function dead(_url: string, init?: RequestInit): Response {
  // Model discovery must still succeed (with an empty catalog) so the sweep
  // builds synthetic per-endpoint candidates without KV tuples.
  if (!init || init.method !== "POST") return jsonResponse({ data: [] });
  return jsonResponse({ error: { message: "upstream unavailable" } }, 503);
}

function chatCompletion(body: Record<string, unknown>): Request {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function asJson(res: Response): Promise<Record<string, any>> {
  return await res.json() as Record<string, any>;
}

// KV keeps a long-lived resource open and background syncs may outlive a test.
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

// Pick a healthy endpoint from the registry (index chosen away from the head
// of the ranking so the escalation tiers have to reach it).
let healthyUrl: string | null = null;
async function pickHealthyUrl(): Promise<string> {
  if (healthyUrl) return healthyUrl;
  const res = await app.fetch(new Request("https://router.test/v1/endpoints"));
  const data = await asJson(res);
  const list = data.data as Array<{ url: string }>;
  healthyUrl = list[Math.floor(list.length * 0.63)]?.url ?? list[0].url;
  return healthyUrl!;
}

test("GET /v1/endpoints reports every configured registry endpoint", async () => {
  installMock(dead);
  try {
    const res = await app.fetch(new Request("https://router.test/v1/endpoints"));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (!(data.configured_endpoints >= 100)) {
      throw new Error(`expected >= 100 configured endpoints, got ${data.configured_endpoints}`);
    }
    if (!(data.registry_endpoints === 100)) throw new Error(`registry endpoints ${data.registry_endpoints}`);
    if (!(data.sweep_candidates >= data.configured_endpoints)) {
      throw new Error(`sweep candidates ${data.sweep_candidates} < endpoints ${data.configured_endpoints}`);
    }
    const urls = new Set((data.data as Array<{ url: string }>).map((e) => e.url));
    if (urls.size !== data.configured_endpoints) throw new Error("duplicate endpoint coverage");
  } finally {
    restoreMock();
  }
});

test("GET /health exposes coverage and the ASCK control kernel without throwing", async () => {
  installMock(dead);
  try {
    const res = await app.fetch(new Request("https://router.test/health"));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.control_kernel?.name !== "ASCK v1") throw new Error("missing control kernel");
    if (!(data.coverage?.configured_endpoints >= 100)) throw new Error("missing coverage");
    if (!Array.isArray(data.current_best_smart)) throw new Error("missing rankings");
  } finally {
    restoreMock();
  }
});

test("exhaustive sweep attempts ALL endpoints when every upstream is dead, and still returns 200", async () => {
  installMock(dead);
  try {
    const endpoints = await asJson(await app.fetch(new Request("https://router.test/v1/endpoints")));
    const expected = endpoints.configured_endpoints as number;
    const res = await app.fetch(chatCompletion({
      model: "free:fast",
      messages: [{ role: "user", content: "Say hello." }],
      stream: false,
    }));
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const data = await asJson(res);
    if (data.nokey?.degraded !== true) throw new Error("degraded response not labelled");
    if (!String(data.choices?.[0]?.message?.content ?? "").includes("No upstream model endpoint")) {
      throw new Error("degraded response missing honest explanation");
    }
    if (res.headers.get("x-nokey-degraded") !== "1") throw new Error("missing degraded header");
    // Every configured endpoint's chat URL must have been POSTed at least once.
    const covered = (endpoints.data as Array<{ url: string }>)
      .filter((e) => e.url && mock.chatUrls.has(e.url)).length;
    if (covered < expected) {
      throw new Error(`only ${covered}/${expected} endpoints were attempted`);
    }
    if (!(Number(data.nokey.endpoints_attempted) >= expected)) {
      throw new Error(`attempt count ${data.nokey.endpoints_attempted} < ${expected}`);
    }
  } finally {
    restoreMock();
  }
});

test("an arbitrary unknown requested model still completes via a healthy endpoint", async () => {
  const good = await pickHealthyUrl();
  installMock((url, init) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    return url === good ? sseResponse() : jsonResponse({ error: "dead" }, 503);
  });
  try {
    const res = await app.fetch(chatCompletion({
      model: "totally-made-up-frontier-model-9000",
      messages: [{ role: "user", content: "Give me a verification sentence." }],
      stream: false,
    }));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.nokey?.degraded === true) throw new Error("request degraded instead of completing");
    if (!String(data.choices?.[0]?.message?.content ?? "").includes("adaptive stochastic control kernel")) {
      throw new Error(`unexpected content: ${JSON.stringify(data.choices?.[0]?.message)}`);
    }
    if (data.nokey?.requested_model !== "totally-made-up-frontier-model-9000") {
      throw new Error("requested model not reported");
    }
  } finally {
    restoreMock();
  }
});

test("streaming success emits OpenAI chunks and [DONE]", async () => {
  const good = await pickHealthyUrl();
  installMock((url, init) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    return url === good ? sseResponse() : jsonResponse({ error: "dead" }, 503);
  });
  try {
    const res = await app.fetch(chatCompletion({
      model: "free:smart",
      messages: [{ role: "user", content: "Stream a verification sentence." }],
      stream: true,
    }));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("event-stream")) throw new Error("not SSE");
    const text = await res.text();
    if (!text.includes("[DONE]")) throw new Error("missing [DONE]");
    if (!text.includes("adaptive stochastic control kernel")) throw new Error("missing content");
    if (!text.includes('"finish_reason":"stop"')) throw new Error("missing finish_reason");
  } finally {
    restoreMock();
  }
});

test("streaming degradation is a valid 200 SSE stream, not a 502", async () => {
  installMock(dead);
  try {
    const res = await app.fetch(chatCompletion({
      model: "free:reasoning",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }));
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const text = await res.text();
    if (!text.includes("[DONE]")) throw new Error("missing [DONE]");
    if (!text.includes("No upstream model endpoint")) throw new Error("missing explanation");
    // Stream headers leave before routing settles, so degradation is signalled in-band.
    if (!text.includes('"degraded":true')) throw new Error("missing in-band degraded flag");
  } finally {
    restoreMock();
  }
});

test("protocol negotiation: stream:true 400s fall through to a JSON completion", async () => {
  const good = await pickHealthyUrl();
  installMock((url, init) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    if (url !== good) return jsonResponse({ error: "dead" }, 503);
    const payload = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    if (payload.stream === true) return jsonResponse({ error: "streaming not supported" }, 400);
    return completionJson();
  });
  try {
    const res = await app.fetch(chatCompletion({
      model: "free:fast",
      messages: [{ role: "user", content: "Answer with a sentence." }],
      stream: false,
    }));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.nokey?.degraded === true) throw new Error("protocol negotiation did not rescue the request");
    if (!String(data.choices?.[0]?.message?.content ?? "").includes("adaptive stochastic")) {
      throw new Error("negotiated completion missing");
    }
  } finally {
    restoreMock();
  }
});

test("plain-text upstream answers are accepted", async () => {
  const good = await pickHealthyUrl();
  installMock((url, init) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    if (url !== good) return jsonResponse({ error: "dead" }, 503);
    return new Response(LONG_ANSWER, { status: 200, headers: { "content-type": "text/plain" } });
  });
  try {
    const res = await app.fetch(chatCompletion({
      model: "free:fast",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    }));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.nokey?.degraded === true) throw new Error("plain-text response rejected");
    if (!String(data.choices?.[0]?.message?.content ?? "").includes("adaptive stochastic")) {
      throw new Error("plain-text content missing");
    }
  } finally {
    restoreMock();
  }
});

test("malformed / empty bodies are normalised instead of 400ing", async () => {
  installMock((_url, init) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    return sseResponse();
  });
  try {
    const res = await app.fetch(new Request("https://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.nokey?.degraded === true) throw new Error("malformed body degraded");
  } finally {
    restoreMock();
  }
});

test("GET /v1/models advertises model-agnostic routing", async () => {
  installMock(dead);
  try {
    const res = await app.fetch(new Request("https://router.test/v1/models"));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.accepts_any_model !== true) throw new Error("accepts_any_model missing");
    const ids = (data.data as Array<{ id: string }>).map((m) => m.id);
    for (const id of ["free:auto", "free:fast", "nokey-image"]) {
      if (!ids.includes(id)) throw new Error(`missing ${id}`);
    }
  } finally {
    restoreMock();
  }
});

test("image generation under total outage reports still-processing, never a fake image", async () => {
  installMock((_url, init) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    return jsonResponse({ error: "image backend down" }, 503);
  });
  try {
    const res = await app.fetch(new Request("https://router.test/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "some-unknown-image-model", prompt: "a red cube" }),
    }));
    if (res.status !== 503) throw new Error(`status ${res.status}`);
    if (res.headers.get("x-nokey-still-processing") !== "1") throw new Error("missing still-processing header");
    const data = await asJson(res);
    if (data.error?.code !== "image_providers_busy") throw new Error("wrong error code");
    if (data.nokey?.still_processing !== true) throw new Error("still_processing not labelled");
    // No output image may ever claim the providers are unavailable.
    if (data.data) throw new Error("must not emit an image payload when every provider failed");
    if (!(data.nokey.providers_reviewed >= 3)) throw new Error("not all image providers reviewed");
    if (data.nokey.sweeps < 2) throw new Error("backend must re-review the whole chain in multiple sweeps");
    if (!Array.isArray(data.nokey.errors) || !data.nokey.errors.length) throw new Error("errors not reported");
  } finally {
    restoreMock();
  }
});

test("b64_json image requests also report still-processing under total image outage", async () => {
  installMock((_url, init) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    return jsonResponse({ error: "down" }, 503);
  });
  try {
    const res = await app.fetch(new Request("https://router.test/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a blue sphere", response_format: "b64_json" }),
    }));
    if (res.status !== 503) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.nokey?.still_processing !== true) throw new Error("still_processing not labelled");
    if (data.data) throw new Error("must not emit a b64 placeholder image when every provider failed");
  } finally {
    restoreMock();
  }
});

// ---------------------------------------------------------------------------
// Realtime reasoning, parallel tool calls, tracing
// ---------------------------------------------------------------------------

function sseOf(deltas: Array<Record<string, unknown>>, finish = "stop", gapMs = 0): Response {
  const lines = [
    ...deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const l of lines) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        ctrl.enqueue(encoder.encode(l));
      }
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunks(text: string): any[] {
  return text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
}

function mergedToolCalls(frames: any[]): any[] {
  const acc: any[] = [];
  for (const f of frames) {
    for (const t of f.choices?.[0]?.delta?.tool_calls ?? []) {
      const cur = acc[t.index] ??= { id: t.id, type: t.type, function: { name: "", arguments: "" } };
      if (t.id) cur.id = t.id;
      cur.function.name += t.function?.name ?? "";
      cur.function.arguments += t.function?.arguments ?? "";
    }
  }
  return acc;
}

function healthyOnly(good: string, respond: (payload: any) => Response, seen?: any[]) {
  return (url: string, init?: RequestInit) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    if (url !== good) return jsonResponse({ error: "dead" }, 503);
    const payload = JSON.parse(String(init.body));
    seen?.push(payload);
    return respond(payload);
  };
}

test("inline <think> split across chunks streams as reasoning_content in real time", async () => {
  const good = await pickHealthyUrl();
  installMock(healthyOnly(good, () =>
    sseOf([
      { content: "  <thi" },
      { content: "nk>step one, " },
      { content: "step two</thi" },
      { content: "nk>\n\nThe answer: " + LONG_ANSWER },
    ])));
  try {
    const res = await app.fetch(chatCompletion({ model: "free:reasoning", messages: [{ role: "user", content: "think" }], stream: true }));
    const frames = chunks(await res.text());
    const reasoning = frames.map((f) => f.choices[0].delta.reasoning_content ?? "").join("");
    const content = frames.map((f) => f.choices[0].delta.content ?? "").join("");
    if (reasoning !== "step one, step two") throw new Error(`reasoning ${JSON.stringify(reasoning)}`);
    if (!content.startsWith("The answer: ")) throw new Error(`content ${JSON.stringify(content.slice(0, 40))}`);
    if (content.includes("<think>") || content.includes("</think>")) throw new Error("think tags leaked into content");
    if (frames.at(-1)?.nokey?.trace_id?.length !== 32) throw new Error("final chunk missing trace id");
  } finally {
    restoreMock();
  }
});

test("parallel tool calls without upstream indices stream as distinct indexed calls", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(healthyOnly(good, () =>
    sseOf([
      { tool_calls: [{ id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] },
      { tool_calls: [{ function: { arguments: '{"city":' } }] },
      { tool_calls: [{ function: { arguments: '"Paris"}' } }] },
      { tool_calls: [{ id: "call_b", function: { name: "get_time", arguments: { tz: "UTC" } } }] },
    ], "tool_calls"), seen));
  const tools = ["get_weather", "get_time"].map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } }));
  try {
    const res = await app.fetch(chatCompletion({
      model: "free:code", messages: [{ role: "user", content: "weather and time" }], tools, parallel_tool_calls: true, stream: true,
    }));
    const frames = chunks(await res.text());
    const calls = mergedToolCalls(frames);
    if (calls.length !== 2) throw new Error(`expected 2 calls, got ${calls.length}`);
    if (calls[0].id !== "call_a" || calls[0].function.arguments !== '{"city":"Paris"}') throw new Error(JSON.stringify(calls[0]));
    if (calls[1].id !== "call_b" || calls[1].type !== "function" || calls[1].function.arguments !== '{"tz":"UTC"}') throw new Error(JSON.stringify(calls[1]));
    if (frames.at(-1).choices[0].finish_reason !== "tool_calls") throw new Error("finish_reason");
    const last = seen.at(-1);
    if (last.parallel_tool_calls !== true || last.tools?.length !== 2) throw new Error("tool fields not forwarded");
  } finally {
    restoreMock();
  }
});

test("buffered parallel tool calls get ids and null content; tool round-trips survive normalisation", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(healthyOnly(good, () =>
    jsonResponse({
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { function: { name: "get_weather", arguments: { city: "Paris" } } },
            { function: { name: "get_time", arguments: '{"tz":"UTC"}' } },
          ],
        },
      }],
    }), seen));
  try {
    const res = await app.fetch(chatCompletion({
      model: "free:code",
      stream: false,
      tools: [{ type: "function", function: { name: "get_weather" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_x", function: { name: "get_weather", arguments: { city: "Oslo" } } }] },
        { role: "tool", tool_call_id: "call_x", name: "get_weather", content: "4C" },
      ],
    }));
    const data = await asJson(res);
    const msg = data.choices[0].message;
    if (msg.content !== null) throw new Error(`content ${JSON.stringify(msg.content)}`);
    if (msg.tool_calls?.length !== 2) throw new Error("expected 2 tool calls");
    for (const t of msg.tool_calls) {
      if (!/^call_/.test(t.id) || t.type !== "function" || typeof t.function.arguments !== "string") throw new Error(JSON.stringify(t));
    }
    if (msg.tool_calls[0].id === msg.tool_calls[1].id) throw new Error("duplicate ids");
    const up = seen.at(-1).messages;
    if (up[1].tool_calls?.[0]?.function?.arguments !== '{"city":"Oslo"}' || up[1].content !== null) throw new Error(JSON.stringify(up[1]));
    if (up[2].tool_call_id !== "call_x" || up[2].name !== "get_weather") throw new Error(JSON.stringify(up[2]));
  } finally {
    restoreMock();
  }
});

test("stream headers and first bytes arrive before the upstream produces a token", async () => {
  const good = await pickHealthyUrl();
  installMock(healthyOnly(good, () => sseOf([{ content: LONG_ANSWER }], "stop", 300)));
  try {
    const t0 = performance.now();
    const res = await app.fetch(chatCompletion({ model: "free:smart", messages: [{ role: "user", content: "hi" }], stream: true }));
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const elapsed = performance.now() - t0;
    if (!first.startsWith(": trace ")) throw new Error(`first bytes ${JSON.stringify(first)}`);
    if (elapsed >= 300) throw new Error(`first bytes after ${elapsed}ms`);
    if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(res.headers.get("traceparent") ?? "")) throw new Error("traceparent");
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    if (!rest.includes("adaptive stochastic control kernel") || !rest.includes("[DONE]")) throw new Error("stream incomplete");
  } finally {
    restoreMock();
  }
});

test("traces record attempts and protocol negotiation; admin guard and live tail work", async () => {
  const good = await pickHealthyUrl();
  installMock(healthyOnly(good, (p) => p.stream === true ? jsonResponse({ error: "no streaming" }, 400) : completionJson()));
  Deno.env.set("ADMIN_SECRET", "s3cret");
  const admin = { "x-admin-secret": "s3cret" };
  const live = await app.fetch(new Request("https://router.test/v1/traces/live", { headers: admin }));
  const liveReader = live.body!.getReader();
  try {
    const res = await app.fetch(chatCompletion({ model: "free:smart", messages: [{ role: "user", content: "hi" }], stream: false }));
    const data = await asJson(res);
    const id = data.nokey?.trace_id;
    if (!res.headers.get("traceparent")?.includes(id)) throw new Error("traceparent/trace_id mismatch");
    if (!/ttft;dur=\d+, total;dur=\d+/.test(res.headers.get("server-timing") ?? "")) throw new Error("server-timing");

    const denied = await app.fetch(new Request(`https://router.test/v1/traces/${id}`));
    if (denied.status !== 403) throw new Error(`expected 403, got ${denied.status}`);
    const tr = await asJson(await app.fetch(new Request(`https://router.test/v1/traces/${id}`, { headers: admin })));
    const root = tr.spans[0];
    if (root.name !== "chat.completions" || root.status !== "ok" || root.end === null) throw new Error(JSON.stringify(root));
    const won = tr.spans.find((s: any) => s.name === "attempt" && s.attrs.outcome === "won");
    if (!won) throw new Error("no winning attempt span");
    if (!won.events.some((e: any) => e.name === "negotiate")) throw new Error("negotiation not recorded on the attempt");
    if (!tr.spans.some((s: any) => s.name === "tier" && s.parent === root.id)) throw new Error("tier span not parented to root");

    const list = await asJson(await app.fetch(new Request("https://router.test/v1/traces?limit=5", { headers: admin })));
    if (!list.data.some((t: any) => t.id === id)) throw new Error("trace missing from list");

    let tail = "";
    while (!tail.includes(id)) {
      const r = await liveReader.read();
      if (r.done) throw new Error("live tail closed");
      tail += new TextDecoder().decode(r.value);
    }
  } finally {
    await liveReader.cancel();
    Deno.env.delete("ADMIN_SECRET");
    restoreMock();
  }
});

test("concurrent streamed and buffered requests complete independently with distinct traces", async () => {
  const good = await pickHealthyUrl();
  installMock(healthyOnly(good, () => sseOf([{ content: LONG_ANSWER }], "stop", 20)));
  try {
    const results = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const res = await app.fetch(chatCompletion({ model: "free:smart", messages: [{ role: "user", content: `q${i}` }], stream: i % 2 === 0 }));
      const text = await res.text();
      if (!text.includes("adaptive stochastic control kernel")) throw new Error(`request ${i} incomplete`);
      return res.headers.get("traceparent")!.split("-")[1];
    }));
    if (new Set(results).size !== results.length) throw new Error("trace ids collided across concurrent requests");
  } finally {
    restoreMock();
  }
});

test("a silent committed stream emits keepalive comments and still completes", async () => {
  const good = await pickHealthyUrl();
  installMock(healthyOnly(good, () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: LONG_ANSWER.slice(0, 80) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: LONG_ANSWER.slice(80) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    ];
    return new Response(new ReadableStream<Uint8Array>({
      async start(ctrl) {
        ctrl.enqueue(encoder.encode(lines[0]));
        await new Promise((r) => setTimeout(r, 700)); // upstream thinks silently
        ctrl.enqueue(encoder.encode(lines[1] + lines[2]));
        ctrl.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }));
  Deno.env.set("NOKEY_IDLE_MS", "150");
  try {
    const text = await (await app.fetch(chatCompletion({ model: "free:smart", messages: [{ role: "user", content: "hi" }], stream: true }))).text();
    const firstChunk = text.indexOf('"content"'), keep = text.indexOf(": keepalive"), last = text.lastIndexOf('"content"');
    if (!(firstChunk >= 0 && keep > firstChunk && last > keep)) throw new Error("keepalive not emitted between committed chunks");
    if (!text.includes("[DONE]") || !text.includes("relay mesh")) throw new Error("stream incomplete");
  } finally {
    Deno.env.delete("NOKEY_IDLE_MS");
    restoreMock();
  }
});

test("a slow buffered completion keeps the connection alive with leading whitespace and stays valid JSON", async () => {
  const good = await pickHealthyUrl();
  installMock(healthyOnly(good, () =>
    new Response(new ReadableStream<Uint8Array>({
      async start(ctrl) {
        await new Promise((r) => setTimeout(r, 700)); // whole generation before the first byte
        ctrl.enqueue(encoder.encode(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: LONG_ANSWER }, finish_reason: "stop" }] })));
        ctrl.close();
      },
    }), { headers: { "content-type": "application/json" } })));
  Deno.env.set("NOKEY_IDLE_MS", "150");
  try {
    const res = await app.fetch(chatCompletion({ model: "free:smart", messages: [{ role: "user", content: "hi" }], stream: false }));
    if (res.status !== 200 || !res.headers.get("traceparent")) throw new Error("slow path headers");
    const text = await res.text();
    if (!/^ {2,}\{/.test(text)) throw new Error(`expected whitespace keepalives before JSON, got ${JSON.stringify(text.slice(0, 20))}`);
    const data = JSON.parse(text);
    if (!String(data.choices?.[0]?.message?.content).includes("relay mesh") || data.nokey?.degraded !== false) throw new Error("bad body");
  } finally {
    Deno.env.delete("NOKEY_IDLE_MS");
    restoreMock();
  }
});
