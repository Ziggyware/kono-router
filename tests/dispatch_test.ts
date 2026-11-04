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
    if (res.headers.get("x-nokey-degraded") !== "1") throw new Error("missing degraded header");
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

test("image generation degrades to a valid local placeholder instead of 502", async () => {
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
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.nokey?.degraded !== true) throw new Error("image degradation not labelled");
    if (!String(data.data?.[0]?.url ?? "").startsWith("data:image/svg+xml;base64,")) {
      throw new Error("placeholder image missing");
    }
    if (!(data.nokey.backends_tried >= 3)) throw new Error("not all image backends tried");
  } finally {
    restoreMock();
  }
});

test("b64_json image requests also stay valid under total image outage", async () => {
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
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (!(typeof data.data?.[0]?.b64_json === "string" && data.data[0].b64_json.length > 50)) {
      throw new Error("b64 placeholder missing");
    }
  } finally {
    restoreMock();
  }
});
