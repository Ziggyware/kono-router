// deno-lint-ignore-file no-explicit-any
/**
 * Tool Plane (ASCK-T v1) integration tests: the HTTP surface, the server-side
 * agent loop, and the learning that compounds across requests.
 *
 * The kernel itself (schema validation, the argument repair ladder, the skill
 * filters, the vendor projections) is covered by tests/tools_test.ts; these
 * tests drive it through the real Hono app against a fully mocked upstream
 * registry. No external network is used: globalThis.fetch is replaced.
 *
 * Run: deno test --unstable-kv -A tests/
 */
import { app } from "../main.ts";
import { registerTool, unregisterTool } from "../tools.ts";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function dead(_url: string, init?: RequestInit): Response {
  // Discovery must still succeed (with an empty catalog) so the sweep can build
  // synthetic candidates; every chat POST is refused.
  if (!init || init.method !== "POST") return jsonResponse({ data: [] });
  return jsonResponse({ error: { message: "upstream unavailable" } }, 503);
}

/** One healthy endpoint; every POST to it is recorded and answered in order. */
function scripted(good: string, respond: (payload: any, call: number) => Response, seen?: any[]) {
  return (url: string, init?: RequestInit) => {
    if (!init || init.method !== "POST") return jsonResponse({ data: [] });
    if (url !== good) return jsonResponse({ error: "dead" }, 503);
    const payload = JSON.parse(String(init.body));
    const call = seen?.length ?? 0;
    seen?.push(payload);
    return respond(payload, call);
  };
}

function sseOf(deltas: Array<Record<string, unknown>>, finish = "stop"): Response {
  const lines = [
    ...deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const l of lines) ctrl.enqueue(encoder.encode(l));
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** An upstream completion that asks for a tool call instead of answering. */
function toolCallCompletion(name: string, args: string, id = "call_plane_1"): Response {
  return jsonResponse({
    id: "mock",
    object: "chat.completion",
    created: 1,
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
      },
    }],
  });
}

function answerCompletion(content: string): Response {
  return jsonResponse({
    id: "mock",
    object: "chat.completion",
    created: 1,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  });
}

// The suite authenticates with the key it configures: without a key these
// requests ride the anonymous free tier (50/day per IP in shared KV) and the
// edge rate bucket, which made the tail of this file fail with 429s once the
// free tier shipped. Production behavior is unchanged; tests just present
// the credential they already set in the environment.
const AUTH: Record<string, string> = {
  authorization: `Bearer ${Deno.env.get("ROUTER_API_KEY") ?? "testkey"}`,
};

function chatRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, ...headers },
    body: JSON.stringify(body),
  });
}

async function asJson(res: Response): Promise<any> {
  return await res.json() as any;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await app.fetch(new Request(`https://router.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, ...headers },
    body: JSON.stringify(body),
  }));
  if (res.status !== 200) throw new Error(`${path} -> status ${res.status}`);
  return await asJson(res);
}

async function getJson(path: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await app.fetch(new Request(`https://router.test${path}`, { headers: { ...AUTH, ...headers } }));
  if (res.status !== 200) throw new Error(`${path} -> status ${res.status}`);
  return await asJson(res);
}

function execute(body: unknown, headers: Record<string, string> = {}): Promise<any> {
  return postJson("/v1/tools/execute", body, headers);
}

// KV keeps a long-lived resource open and background skill writes may outlive a
// test, so the sanitizers are relaxed exactly as the dispatch suite does.
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

let healthyUrl: string | null = null;
async function pickHealthyUrl(): Promise<string> {
  if (healthyUrl) return healthyUrl;
  const data = await getJson("/v1/endpoints");
  const list = data.data as Array<{ url: string }>;
  healthyUrl = list[Math.floor(list.length * 0.63)]?.url ?? list[0].url;
  return healthyUrl!;
}

/** Set an env var for the duration of `fn`, restoring the previous value. */
function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  return fn().finally(() => {
    if (prev === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prev);
  });
}

/** Chat-path learning is deliberately fire-and-forget; poll until it lands. */
async function until<T>(probe: () => Promise<T>, want: (value: T) => boolean, what: string, tries = 30): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await probe();
    if (want(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${what} never settled: ${JSON.stringify(last)?.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Registry publication
// ---------------------------------------------------------------------------

test("GET /v1/tools publishes the executable registry, aliases and vendor wire shapes", async () => {
  installMock(dead);
  try {
    const data = await getJson("/v1/tools");
    if (data.object !== "list") throw new Error(`object ${data.object}`);
    if (data.plane !== "asck-t-v2") throw new Error(`plane ${data.plane}`);
    if (data.enabled !== true) throw new Error("plane disabled by default");
    if (!(data.agent.max_rounds >= 1)) throw new Error(`max_rounds ${data.agent.max_rounds}`);
    if (!Array.isArray(data.agent.auto_tools) || !data.agent.auto_tools.includes("calculate")) {
      throw new Error(`auto_tools ${JSON.stringify(data.agent.auto_tools)}`);
    }

    const byName = new Map<string, any>(data.data.map((t: any) => [t.name, t]));
    for (const name of [
      "calculate", "data", "text", "time", "crypto", "web_search", "web_fetch", "http_request",
      "fs_read", "fs_write", "fs_patch", "fs_grep", "fs_list", "fs_delete", "clipboard",
      "memory_write", "memory_recall", "memory_forget", "memory_graph", "rag_index",
      "rag_search", "rag_collections", "embed", "task", "router_capabilities",
      "router_catalog", "router_health", "router_models", "router_endpoints", "router_lane",
    ]) {
      if (!byName.has(name)) throw new Error(`missing tool ${name}`);
    }
    // Every published name has to survive the wire-name rule relays enforce.
    for (const t of data.data) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw new Error(`unsafe tool name ${t.name}`);
      if (typeof t.description !== "string" || t.description.length < 20) throw new Error(`thin description for ${t.name}`);
      if (!Array.isArray(t.aliases)) throw new Error(`aliases missing for ${t.name}`);
      if (typeof t.deterministic !== "boolean" || typeof t.admin !== "boolean") throw new Error(`flags for ${t.name}`);
    }
    const calc = byName.get("calculate");
    if (calc.parameters?.properties?.expression?.type !== "string") throw new Error("schema not published");
    if (!calc.aliases.includes("math.evaluate")) throw new Error(`aliases ${JSON.stringify(calc.aliases)}`);
    if (calc.deterministic !== true) throw new Error("calculate must be deterministic");

    // Vendor projections, one registry.
    if (data.wire.flavor !== "openai") throw new Error(`default flavor ${data.wire.flavor}`);
    const wireMath = data.wire.tools.find((t: any) => t.function?.name === "calculate");
    if (wireMath?.type !== "function") throw new Error("openai projection broken");
    if (!wireMath.function.parameters?.properties?.expression) throw new Error("openai projection lost the schema");

    const slim = await getJson("/v1/tools?schemas=0&flavor=gemini");
    if (slim.data.some((t: any) => "parameters" in t)) throw new Error("schemas=0 still published schemas");
    if (slim.wire.flavor !== "gemini") throw new Error(`flavor ${slim.wire.flavor}`);
    // Gemini wraps the whole registry in one functionDeclarations envelope.
    const gem = slim.wire.tools[0]?.functionDeclarations?.find((t: any) => t.name === "calculate");
    if (gem?.parameters?.properties?.expression?.type !== "STRING") {
      throw new Error(`gemini types not uppercased: ${JSON.stringify(gem)}`);
    }
    if (slim.wire.tools[0]?.functionDeclarations?.length !== slim.count) {
      throw new Error("gemini envelope dropped declarations");
    }

    const strict = await getJson("/v1/tools?flavor=openai-strict");
    const strictMath = strict.wire.tools.find((t: any) => t.function?.name === "calculate");
    if (strictMath?.function?.strict !== true) throw new Error("strict projection did not set strict:true");
    if (strictMath.function.parameters?.additionalProperties !== false) throw new Error("strict projection not closed");
    if (!Array.isArray(strictMath.function.parameters?.required)) throw new Error("strict projection dropped required");

    const anthropic = await getJson("/v1/tools?flavor=anthropic");
    const ant = anthropic.wire.tools.find((t: any) => t.name === "calculate");
    if (!ant?.input_schema?.properties?.expression) throw new Error("anthropic projection missing input_schema");
    if (anthropic.wire.flavor !== "anthropic") throw new Error("anthropic flavor not echoed");
  } finally {
    restoreMock();
  }
});

test("GET /v1/tools hides admin tools unless the deployment's admin secret is presented", async () => {
  installMock(dead);
  try {
    await withEnv("ADMIN_SECRET", "s3cret", async () => {
      const open = await getJson("/v1/tools");
      if (open.data.some((t: any) => t.name === "router_trace")) throw new Error("admin tool published without the secret");
      if (open.wire.tools.some((t: any) => t.function?.name === "router_trace")) throw new Error("admin tool projected onto the wire");

      const wrong = await getJson("/v1/tools", { "x-admin-secret": "nope" });
      if (wrong.data.some((t: any) => t.name === "router_trace")) throw new Error("wrong secret unlocked admin tools");

      const admin = await getJson("/v1/tools", { "x-admin-secret": "s3cret" });
      const trace = admin.data.find((t: any) => t.name === "router_trace");
      if (!trace) throw new Error("admin tool hidden from an authorised admin");
      if (trace.admin !== true) throw new Error("admin tool not flagged");
      if (!admin.wire.tools.some((t: any) => t.function?.name === "router_trace")) throw new Error("admin projection missing");
    });

    // With no admin tier configured at all, mesh tools are ordinary tools.
    await withEnv("ADMIN_SECRET", undefined, async () => {
      const data = await getJson("/v1/tools");
      if (!data.data.some((t: any) => t.name === "router_trace")) throw new Error("no admin tier but tool hidden");
    });
  } finally {
    restoreMock();
  }
});

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

test("POST /v1/tools/execute runs built-ins and reports the repair ladder it used", async () => {
  installMock(dead);
  try {
    const res = await app.fetch(new Request("https://router.test/v1/tools/execute", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ name: "calculate", arguments: { expression: "2^10 + 1" } }),
    }));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(res.headers.get("traceparent") ?? "")) throw new Error("no traceparent");
    const data = await asJson(res);
    if (data.object !== "list" || data.count !== 1 || data.ok !== true) {
      throw new Error(`envelope ${JSON.stringify(data).slice(0, 240)}`);
    }
    const r = data.results[0];
    if (r.name !== "calculate" || r.ok !== true) throw new Error(JSON.stringify(r));
    if (r.result?.value !== 1025) throw new Error(`value ${JSON.stringify(r.result)}`);
    if (r.strategy !== "native") throw new Error(`strategy ${r.strategy}`);
    if (!(r.ms >= 0) || !(r.bytes > 0)) throw new Error(`telemetry ${JSON.stringify(r)}`);
    if (data.trace_id?.length !== 32) throw new Error(`trace_id ${data.trace_id}`);
    if (!(data.totals.calls >= 1)) throw new Error(`totals ${JSON.stringify(data.totals)}`);

    // A batch in OpenAI nesting, an alias spelling, and arguments wrapped in a
    // markdown fence — what real models actually emit.
    const batch = await execute({
      calls: [
        { id: "call_a", function: { name: "calculate", arguments: '```json\n{"expression": "6*7"}\n```' } },
        { id: "call_b", function: { name: "crypto", arguments: { op: "digest", algorithm: "sha-256", data: "abc" } } },
        { id: "call_c", name: "data", arguments: { op: "query", data: { a: { b: [10, 20, 30] } }, path: "$.a.b[1]" } },
      ],
    });
    if (batch.count !== 3 || batch.ok !== true) throw new Error(`batch ${JSON.stringify(batch).slice(0, 400)}`);
    const [a, b, cq] = batch.results;
    if (a.id !== "call_a" || a.result?.value !== 42) throw new Error(JSON.stringify(a));
    if (a.strategy !== "extract") throw new Error(`fenced arguments used strategy ${a.strategy}`);
    if (!a.repairs.includes("fence-or-prose")) throw new Error(`repairs ${JSON.stringify(a.repairs)}`);
    if (b.result?.hex !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
      throw new Error(`digest ${JSON.stringify(b.result)}`);
    }
    if (!String(JSON.stringify(cq.result)).includes("20")) throw new Error(`data query ${JSON.stringify(cq.result)}`);
  } finally {
    restoreMock();
  }
});

test("POST /v1/tools/execute reports failures per call so a model can retry", async () => {
  installMock(dead);
  try {
    const data = await execute({
      calls: [
        { id: "u", name: "get_weather", arguments: { city: "Paris" } },
        { id: "n", name: "json_querry", arguments: { data: {}, path: "$.a" } },
        { id: "i", name: "fs_read", arguments: {} },
        { id: "e", name: "time", arguments: { op: "parse", value: "sometime last tuesday-ish" } },
      ],
    });
    if (data.ok !== false) throw new Error("batch reported ok despite failures");
    const [unknown, nearMiss, invalid, errored] = data.results;

    if (unknown.ok !== false || unknown.code !== "UNKNOWN_TOOL") throw new Error(JSON.stringify(unknown));
    if (!Array.isArray(unknown.suggestions)) throw new Error("suggestions must always be an array");

    // A one-character typo has to come back with the tool the model meant, so
    // the next round can call it instead of guessing again.
    if (nearMiss.ok !== false || nearMiss.code !== "UNKNOWN_TOOL") throw new Error(JSON.stringify(nearMiss));
    if (nearMiss.suggestions?.[0]?.name !== "data") {
      throw new Error(`no fuzzy suggestion for a near miss: ${JSON.stringify(nearMiss.suggestions)}`);
    }
    if (!(nearMiss.suggestions[0].score > 0.6 && nearMiss.suggestions[0].score < 1)) {
      throw new Error(`suggestion score ${nearMiss.suggestions[0].score}`);
    }
    if (!/data/.test(String(nearMiss.error))) throw new Error(`error text lost the suggestion: ${nearMiss.error}`);

    if (invalid.ok !== false || invalid.code !== "INVALID_ARGUMENTS") throw new Error(JSON.stringify(invalid));
    if (!invalid.issues?.some((i: any) => i.keyword === "required" && String(i.path).includes("path"))) {
      throw new Error(`issues ${JSON.stringify(invalid.issues)}`);
    }

    if (errored.ok !== false || errored.code !== "TOOL_ERROR") throw new Error(JSON.stringify(errored));
    if (!/cannot parse instant/i.test(String(errored.error))) throw new Error(`error ${errored.error}`);

    // A tool can succeed while the value it computed failed: the expression
    // evaluator reports per-expression errors instead of throwing.
    const partial = await execute({ name: "calculate", arguments: { expression: "2+" } });
    if (partial.results[0].ok !== true) throw new Error(`expression failure became a tool failure: ${JSON.stringify(partial.results[0])}`);
    if (typeof partial.results[0].result?.error !== "string") throw new Error(`per-expression error lost: ${JSON.stringify(partial.results[0].result)}`);

    // Unusable request bodies stay 200 with a shaped envelope.
    const empty = await execute({});
    if (empty.count !== 1 || empty.results[0].ok !== false || empty.results[0].code !== "UNKNOWN_TOOL") {
      throw new Error(JSON.stringify(empty));
    }
    const unparsable = await app.fetch(new Request("https://router.test/v1/tools/execute", {
      method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: "{not json",
    }));
    if (unparsable.status !== 200) throw new Error(`unparsable body -> ${unparsable.status}`);
    const unparsableBody = await asJson(unparsable);
    if (unparsableBody.results?.[0]?.ok !== false) throw new Error(JSON.stringify(unparsableBody).slice(0, 200));
  } finally {
    restoreMock();
  }
});

test("admin tools refuse to execute without the secret and run with it", async () => {
  installMock(dead);
  try {
    await withEnv("ADMIN_SECRET", "s3cret", async () => {
      const denied = await execute({ name: "router_trace", arguments: { limit: 5 } });
      if (denied.results[0].ok !== false || denied.results[0].code !== "ADMIN_REQUIRED") {
        throw new Error(JSON.stringify(denied.results[0]));
      }
      const allowed = await execute({ name: "router_trace", arguments: { limit: 5 } }, { "x-admin-secret": "s3cret" });
      if (allowed.results[0].ok !== true) throw new Error(JSON.stringify(allowed.results[0]));
      if (!Array.isArray(allowed.results[0].result?.traces)) throw new Error(`trace tool ${JSON.stringify(allowed.results[0].result).slice(0, 200)}`);
    });
  } finally {
    restoreMock();
  }
});

test("execution stays bounded: deadlines are enforced and oversized inputs are clamped", async () => {
  installMock(dead);
  // A tool that outlives its budget must report TIMEOUT rather than hang the
  // request; registered here and removed again so it cannot leak into counts.
  registerTool({
    name: "plane_test_slow",
    kind: "compute",
    description: "test-only tool that resolves long after its deadline has passed",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: (_args, ctx) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ late: true }), 3_000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({ aborted: true });
        });
      }),
  });
  try {
    const slow = await execute({ name: "plane_test_slow", arguments: {}, timeout_ms: 60 });
    if (slow.results[0].ok !== false || slow.results[0].code !== "TIMEOUT") {
      throw new Error(`deadline not enforced: ${JSON.stringify(slow.results[0])}`);
    }
    if (!(slow.results[0].ms >= 50)) throw new Error(`timeout reported too early: ${slow.results[0].ms}ms`);

    // Inclusive bounds are clamped and recorded, so a model cannot make a tool
    // fan out without limit.
    const batch = await execute({ name: "calculate", arguments: { expressions: new Array(5000).fill("1+1") } });
    if (batch.results[0].ok !== true) throw new Error(JSON.stringify(batch.results[0]));
    if (batch.results[0].result.count !== 64) throw new Error(`batch not clamped: ${batch.results[0].result.count}`);
    if (!batch.results[0].repairs.some((r: string) => r.includes("maxItems"))) throw new Error("clamp not reported");

    // The global body limit still applies in front of the plane: an oversized
    // payload is refused at the edge rather than parsed.
    const oversized = await app.fetch(new Request("https://router.test/v1/tools/execute", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ name: "crypto", arguments: { data: "x".repeat(700_000) } }),
    }));
    if (oversized.status !== 413) throw new Error(`oversized body -> ${oversized.status}`);

    const sample = await execute({ name: "crypto", arguments: { op: "id", count: 20_000, bogus: 1 } });
    if (sample.results[0].ok !== true) throw new Error(JSON.stringify(sample.results[0]));
    if (sample.results[0].result.count !== 20) throw new Error(`sample not clamped: ${sample.results[0].result.count}`);
    if (!sample.results[0].repairs.some((r: string) => r.includes("additionalProperties"))) {
      throw new Error("undeclared key was not reported as dropped");
    }

    // A declared default being filled is not damage: `repaired` must stay false.
    const clean = await execute({ name: "calculate", arguments: { expression: "1+1" } });
    if (clean.results[0].ok !== true) throw new Error(JSON.stringify(clean.results[0]));
    if (clean.results[0].repairs.some((r: string) => r.includes("maxItems"))) throw new Error("unexpected clamp");
    const skillAfter = (await getJson("/v1/tools")).skills.calculate;
    if (!(skillAfter.repair_rate < 1)) throw new Error(`default fills counted as damage: ${JSON.stringify(skillAfter)}`);
  } finally {
    unregisterTool("plane_test_slow");
    restoreMock();
  }
});

// ---------------------------------------------------------------------------
// Compounding intelligence
// ---------------------------------------------------------------------------

test("skill memory compounds: repeated executions move calls, competence and latency", async () => {
  installMock(dead);
  try {
    const tool = "crypto";
    for (let i = 0; i < 6; i++) {
      await execute({ name: tool, arguments: { op: "digest", algorithm: "sha-256", data: `sample-${i}` } });
    }
    // One repaired call (single quotes) and one schema failure (missing `data`).
    const repairedCall = await execute({ name: tool, arguments: "{'op': 'digest', 'algorithm': 'sha-256', 'data': 'abc'}" });
    if (repairedCall.results[0].strategy !== "repair") throw new Error(`strategy ${repairedCall.results[0].strategy}`);
    await execute({ name: tool, arguments: { op: "not_an_op" } });

    const data = await getJson("/v1/tools");
    const skill = data.skills[tool];
    if (!skill) throw new Error(`no skill record for ${tool}`);
    if (!(skill.calls >= 8)) throw new Error(`calls ${skill.calls}`);
    if (!(skill.errors >= 1)) throw new Error(`errors ${skill.errors}`);
    if (!(skill.repair_rate > 0 && skill.repair_rate < 1)) throw new Error(`repair_rate ${skill.repair_rate}`);
    if (!(skill.competence > 0 && skill.competence < 1)) throw new Error(`competence ${skill.competence}`);
    if (!(skill.success_rate > skill.competence)) throw new Error("competence is not a lower bound on success");
    if (!(skill.p50_ms > 0 && skill.p95_ms >= skill.p50_ms && skill.p99_ms >= skill.p95_ms)) {
      throw new Error(`latency quantiles ${JSON.stringify(skill)}`);
    }
    if (!skill.top_errors.some((e: any) => e.code === "INVALID_ARGUMENTS")) {
      throw new Error(`top_errors ${JSON.stringify(skill.top_errors)}`);
    }
    if (!(skill.stale_hours >= 0)) throw new Error(`stale_hours ${skill.stale_hours}`);

    // The registry entry carries the same summary and the totals aggregate it.
    const entry = data.data.find((t: any) => t.name === tool);
    if (entry.skill?.calls !== skill.calls) throw new Error("registry skill disagrees with the summary");
    if (!(data.totals.calls >= skill.calls)) throw new Error(`totals.calls ${data.totals.calls}`);
    if (!(data.totals.errors >= skill.errors)) throw new Error(`totals.errors ${data.totals.errors}`);
    if (!(data.totals.repairs >= 1)) throw new Error(`totals.repairs ${data.totals.repairs}`);
    if (!(data.totals.tools >= 19)) throw new Error(`totals.tools ${data.totals.tools}`);
    if (data.totals.instrumented < 1) throw new Error("no instrumented tools");
  } finally {
    restoreMock();
  }
});

test("mesh introspection tools answer from live router state", async () => {
  installMock(dead);
  try {
    const data = await execute({
      calls: [
        { id: "h", name: "router_health", arguments: { section: "tool_plane" } },
        { id: "c", name: "router_catalog", arguments: { mode: "tools", limit: 3 } },
        { id: "m", name: "router_models", arguments: { limit: 5 } },
        { id: "l", name: "router_lane", arguments: { prompt: "write a python function", with_tools: true } },
        { id: "e", name: "router_endpoints", arguments: { limit: 2 } },
        { id: "cap", name: "router_capabilities", arguments: {} },
      ],
    });
    if (data.ok !== true) throw new Error(`mesh tools failed: ${JSON.stringify(data.results).slice(0, 500)}`);
    const [health, catalog, models, lane, endpoints, caps] = data.results;

    if (health.result?.tool_plane?.name !== "ASCK-T v2") {
      throw new Error(`router_health ${JSON.stringify(health.result).slice(0, 240)}`);
    }
    if (!(health.result.tool_plane.builtin_tools >= 19)) throw new Error(`builtin_tools ${health.result.tool_plane.builtin_tools}`);

    if (catalog.result?.mode !== "tools" || catalog.result?.lane !== "free:tools") {
      throw new Error(`router_catalog ${JSON.stringify(catalog.result).slice(0, 240)}`);
    }
    if (!(Array.isArray(catalog.result.candidates) && catalog.result.candidates.length <= 3)) {
      throw new Error(`router_catalog candidates ${JSON.stringify(catalog.result.candidates).slice(0, 200)}`);
    }
    const top = catalog.result.candidates[0];
    if (typeof top?.tool_competence !== "number" || typeof top?.tool_pulls !== "number") {
      throw new Error(`tool evidence missing from the ranking: ${JSON.stringify(top)}`);
    }

    if (!(models.result?.data?.length > 0) || !(models.result.total >= models.result.returned)) {
      throw new Error(`router_models ${JSON.stringify(models.result).slice(0, 240)}`);
    }
    if (lane.result?.tool_aware !== true || typeof lane.result?.mode !== "string") {
      throw new Error(`router_lane ${JSON.stringify(lane.result).slice(0, 240)}`);
    }
    if (!(Array.isArray(lane.result.candidates))) throw new Error("router_lane returned no candidates");
    if (!(endpoints.result?.configured_endpoints >= 100)) {
      throw new Error(`router_endpoints ${JSON.stringify(endpoints.result).slice(0, 240)}`);
    }
    if (!(caps.result?.tools?.length > 0) || !(caps.result.count >= 14)) {
      throw new Error(`router_capabilities ${JSON.stringify(caps.result).slice(0, 240)}`);
    }
    if (caps.result.tools.some((t: any) => t.admin)) throw new Error("capabilities exposed an admin tool to a model");
  } finally {
    restoreMock();
  }
});

// ---------------------------------------------------------------------------
// Chat: the server-side agent loop
// ---------------------------------------------------------------------------

test("chat with tools:\"auto\" attaches built-ins, executes the calls and loops to an answer", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, (_payload, call) =>
    call === 0 ? toolCallCompletion("calculate", '{"expression":"17*3"}') : answerCompletion("Seventeen times three is 51."), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:smart",
      stream: false,
      tools: "auto",
      messages: [{ role: "user", content: "What is 17*3? Use a tool." }],
    }));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data = await asJson(res);
    if (data.nokey?.degraded === true) throw new Error("request degraded instead of completing");
    if (data.choices?.[0]?.message?.content !== "Seventeen times three is 51.") {
      throw new Error(`final answer ${JSON.stringify(data.choices?.[0]?.message)}`);
    }
    if (data.choices[0].finish_reason !== "stop") throw new Error(`finish ${data.choices[0].finish_reason}`);
    if (data.nokey.tool_rounds !== 1) throw new Error(`tool_rounds ${data.nokey.tool_rounds}`);
    if (res.headers.get("x-nokey-tool-rounds") !== "1") throw new Error("missing X-Nokey-Tool-Rounds");
    if (data.telemetry.tool_rounds !== 1) throw new Error(`telemetry ${JSON.stringify(data.telemetry)}`);
    const executed = data.nokey.tools_executed;
    if (executed?.length !== 1) throw new Error(`tools_executed ${JSON.stringify(executed)}`);
    if (executed[0].tool !== "calculate" || executed[0].ok !== true || executed[0].round !== 1) {
      throw new Error(JSON.stringify(executed[0]));
    }
    if (typeof executed[0].ms !== "number" || typeof executed[0].repaired !== "boolean") {
      throw new Error(`execution accounting ${JSON.stringify(executed[0])}`);
    }

    if (seen.length !== 2) throw new Error(`expected exactly 2 upstream calls, saw ${seen.length}`);
    const first = seen[0];
    const firstNames = (first.tools ?? []).map((t: any) => t.function?.name);
    if (!firstNames.includes("calculate") || !firstNames.includes("data")) {
      throw new Error(`auto tools not declared upstream: ${JSON.stringify(firstNames)}`);
    }
    if (!first.messages.some((m: any) => m.role === "system" && /tool/i.test(String(m.content)))) {
      throw new Error(`preamble missing: ${JSON.stringify(first.messages[0])}`);
    }

    // The continuation carries the protocol-correct assistant call + tool result.
    const second = seen[1];
    const assistant = second.messages.at(-2);
    const toolMsg = second.messages.at(-1);
    if (assistant.role !== "assistant" || !Array.isArray(assistant.tool_calls)) {
      throw new Error(`assistant turn ${JSON.stringify(assistant)}`);
    }
    if (assistant.tool_calls[0].id !== "call_plane_1") throw new Error(`call id ${assistant.tool_calls[0].id}`);
    if (toolMsg.role !== "tool" || toolMsg.tool_call_id !== "call_plane_1" || toolMsg.name !== "calculate") {
      throw new Error(`tool turn ${JSON.stringify(toolMsg)}`);
    }
    if (!String(toolMsg.content).includes("51")) throw new Error(`tool content ${toolMsg.content}`);
  } finally {
    restoreMock();
  }
});

test("the agent loop keeps going for several rounds and stops at the round cap", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  // A model that never stops calling tools must be cut off by the round cap,
  // and the cut-off has to look like an ordinary tool_calls completion.
  installMock(scripted(good, () => toolCallCompletion("crypto", '{"op":"id","id_kind":"ulid"}'), seen));
  try {
    await withEnv("NOKEY_TOOL_ROUNDS", "2", async () => {
      const res = await app.fetch(chatRequest({
        model: "free:smart", stream: false, tools: "auto",
        messages: [{ role: "user", content: "keep generating ids" }],
      }));
      const data = await asJson(res);
      if (data.nokey?.degraded === true) throw new Error(`degraded: ${JSON.stringify(data.nokey)}`);
      if (data.choices[0].finish_reason !== "tool_calls") throw new Error(`finish ${data.choices[0].finish_reason}`);
      if (data.nokey.tool_rounds !== 2) throw new Error(`rounds ${data.nokey.tool_rounds}`);
      if (data.nokey.tools_executed?.length !== 2) throw new Error(`executed ${JSON.stringify(data.nokey.tools_executed)}`);
      // 2 rounds of learning + the final pass-through round = 3 upstream calls.
      if (seen.length !== 3) throw new Error(`upstream calls ${seen.length}`);
      const lastToolMsg = seen[2].messages.filter((m: any) => m.role === "tool");
      if (lastToolMsg.length !== 2) throw new Error(`tool turns in round 3: ${lastToolMsg.length}`);
      if (!String(lastToolMsg[1].content).match(/[0-9A-Z]{26}/)) throw new Error(`ulid not returned: ${lastToolMsg[1].content}`);
    });
  } finally {
    restoreMock();
  }
});

test("nokey_preamble:false leaves the message list untouched", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, () => answerCompletion("done"), seen));
  try {
    await postJson("/v1/chat/completions", {
      model: "free:smart", stream: false, tools: "auto", nokey_preamble: false,
      messages: [{ role: "user", content: "hi" }],
    });
    if (seen.length < 1) throw new Error("no upstream call");
    if (seen[0].messages.some((m: any) => m.role === "system" && /tool/i.test(String(m.content)))) {
      throw new Error(`preamble injected anyway: ${JSON.stringify(seen[0].messages)}`);
    }
    if (!(seen[0].tools?.length > 0)) throw new Error("tools not attached");
  } finally {
    restoreMock();
  }
});

test("repaired tool arguments still execute and are attributed to the round", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  // Prose plus a fence plus single quotes is the common failure mode; the
  // ladder has to recover it instead of erroring back at the model.
  const mangled = "Sure! Here you go:\n```json\n{'values': [3, 5, 7, 9, 100]}\n```";
  installMock(scripted(good, (_p, call) =>
    call === 0 ? toolCallCompletion("calculate", mangled) : answerCompletion("the median is 7"), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:smart", stream: false, nokey_tools: ["calculate"],
      messages: [{ role: "user", content: "median of 3,5,7,9,100" }],
    }));
    const data = await asJson(res);
    if (data.choices?.[0]?.message?.content !== "the median is 7") throw new Error(JSON.stringify(data.choices?.[0]));
    const executed = data.nokey.tools_executed?.[0];
    if (!executed || executed.ok !== true) throw new Error(`tools_executed ${JSON.stringify(data.nokey.tools_executed)}`);
    if (executed.repaired !== true) throw new Error("the repair was not attributed to the round");
    const toolMsg = seen[1].messages.at(-1);
    if (!String(toolMsg.content).includes('"median":7')) throw new Error(`tool content ${toolMsg.content}`);
  } finally {
    restoreMock();
  }
});

test("a failed tool call goes back to the model as a tool message, never as a request error", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, (_p, call) =>
    call === 0
      ? toolCallCompletion("time", '{"op":"parse","value":"sometime last tuesday"}', "call_bad")
      : answerCompletion("I could not parse that date."), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:smart", stream: false, tools: "auto",
      messages: [{ role: "user", content: "when was that?" }],
    }));
    const data = await asJson(res);
    if (data.nokey?.degraded === true) throw new Error("a bad tool call degraded the whole request");
    if (data.choices?.[0]?.message?.content !== "I could not parse that date.") throw new Error(JSON.stringify(data.choices?.[0]));
    const executed = data.nokey.tools_executed?.[0];
    if (executed?.ok !== false || executed?.code !== "TOOL_ERROR") throw new Error(`executed ${JSON.stringify(executed)}`);
    if (typeof executed.error !== "string" || executed.error.length === 0) throw new Error("error text lost");

    const toolMsg = seen[1].messages.at(-1);
    if (toolMsg.role !== "tool" || toolMsg.tool_call_id !== "call_bad") throw new Error(JSON.stringify(toolMsg));
    const payload = JSON.parse(String(toolMsg.content));
    if (payload.code !== "TOOL_ERROR" || !/cannot parse instant/i.test(String(payload.error))) {
      throw new Error(`tool error payload ${toolMsg.content}`);
    }
  } finally {
    restoreMock();
  }
});

test("client-owned tool calls pass straight through in a single round", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, () =>
    jsonResponse({
      choices: [{
        index: 0, finish_reason: "tool_calls",
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "call_w", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
        },
      }],
    }), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:smart", stream: false,
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      messages: [{ role: "user", content: "weather in Paris" }],
    }));
    const data = await asJson(res);
    const msg = data.choices[0].message;
    if (data.choices[0].finish_reason !== "tool_calls") throw new Error(`finish ${data.choices[0].finish_reason}`);
    if (msg.content !== null) throw new Error(`content ${JSON.stringify(msg.content)}`);
    if (msg.tool_calls?.length !== 1 || msg.tool_calls[0].function.name !== "get_weather") {
      throw new Error(`tool_calls ${JSON.stringify(msg.tool_calls)}`);
    }
    if (seen.length !== 1) throw new Error(`router executed a client tool: ${seen.length} upstream calls`);
    if (data.nokey.tool_rounds !== undefined) throw new Error("tool_rounds leaked into a passthrough response");
    if (res.headers.get("x-nokey-tool-rounds")) throw new Error("round header leaked into a passthrough response");
  } finally {
    restoreMock();
  }
});

test("a round mixing built-in and client calls is handed back whole, never half-executed", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, () =>
    jsonResponse({
      choices: [{
        index: 0, finish_reason: "tool_calls",
        message: {
          role: "assistant", content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "calculate", arguments: '{"expression":"1+1"}' } },
            { id: "call_2", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
          ],
        },
      }],
    }), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:smart", stream: false, tools: [{ type: "function", function: { name: "get_weather" } }],
      nokey_tools: ["calculate"],
      messages: [{ role: "user", content: "go" }],
    }));
    const data = await asJson(res);
    if (data.choices[0].finish_reason !== "tool_calls") throw new Error(`finish ${data.choices[0].finish_reason}`);
    if (data.choices[0].message.tool_calls?.length !== 2) throw new Error("calls were dropped");
    if (seen.length !== 1) throw new Error(`partial execution: ${seen.length} upstream calls`);
    if (data.nokey.tool_rounds !== undefined) throw new Error("rounds reported for a mixed round");
  } finally {
    restoreMock();
  }
});

test("a client declaration shadows a same-named built-in", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, () => toolCallCompletion("calculate", '{"expression":"1+1"}'), seen));
  try {
    const data = await postJson("/v1/chat/completions", {
      model: "free:smart", stream: false,
      // The caller re-declares a built-in name with its own tool: the plane must
      // hand the call back rather than answer it from its own registry.
      tools: [{
        type: "function",
        function: {
          name: "calculate",
          description: "client-owned calculator",
          parameters: { type: "object", properties: { expression: { type: "string" } } },
        },
      }],
      nokey_tools: ["data"],
      messages: [{ role: "user", content: "go" }],
    });
    if (data.choices[0].finish_reason !== "tool_calls") throw new Error(`finish ${data.choices[0].finish_reason}`);
    if (data.choices[0].message.tool_calls?.length !== 1) throw new Error("call dropped");
    if (seen.length !== 1) throw new Error(`shadowed built-in was executed: ${seen.length} upstream calls`);

    const declared = (seen[0].tools ?? []).map((t: any) => t.function?.name);
    if (declared.filter((n: string) => n === "calculate").length !== 1) {
      throw new Error(`declaration not de-duplicated: ${JSON.stringify(declared)}`);
    }
    const shadow = seen[0].tools.find((t: any) => t.function?.name === "calculate");
    if (shadow.function.description !== "client-owned calculator") throw new Error("built-in overwrote the client declaration");
    if (!declared.includes("data")) throw new Error(`plane tool missing: ${JSON.stringify(declared)}`);
  } finally {
    restoreMock();
  }
});

test("NOKEY_TOOL_ROUNDS=0 turns the plane into pure OpenAI passthrough", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, () => toolCallCompletion("calculate", '{"expression":"1+1"}'), seen));
  try {
    await withEnv("NOKEY_TOOL_ROUNDS", "0", async () => {
      const data = await postJson("/v1/chat/completions", {
        model: "free:smart", stream: false, tools: "auto", messages: [{ role: "user", content: "1+1" }],
      });
      if (data.choices[0].finish_reason !== "tool_calls") throw new Error(`finish ${data.choices[0].finish_reason}`);
      if (seen.length !== 1) throw new Error(`executed anyway: ${seen.length} calls`);
      if (data.nokey.tool_rounds !== undefined) throw new Error("rounds reported while disabled");
      // Tools are still declared upstream, and the preamble is skipped because
      // nothing will execute the calls.
      if (!(seen[0].tools?.length > 0)) throw new Error("tools not declared while rounds are off");
      if (seen[0].messages.some((m: any) => m.role === "system" && /tool/i.test(String(m.content)))) {
        throw new Error("preamble promised execution that cannot happen");
      }
      const listing = await getJson("/v1/tools");
      if (listing.agent.max_rounds !== 0) throw new Error(`max_rounds ${listing.agent.max_rounds}`);
    });

    // Out-of-range and unparsable values are clamped, never trusted.
    await withEnv("NOKEY_TOOL_ROUNDS", "9999", async () => {
      const listing = await getJson("/v1/tools");
      if (listing.agent.max_rounds !== 32) throw new Error(`clamp high ${listing.agent.max_rounds}`);
    });
    await withEnv("NOKEY_TOOL_ROUNDS", "not-a-number", async () => {
      const listing = await getJson("/v1/tools");
      if (listing.agent.max_rounds !== 8) throw new Error(`default ${listing.agent.max_rounds}`);
    });
  } finally {
    restoreMock();
  }
});

test("NOKEY_TOOLS=0 disables the plane without breaking client tool passthrough", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, () => answerCompletion("no tools here"), seen));
  try {
    await withEnv("NOKEY_TOOLS", "0", async () => {
      const listing = await getJson("/v1/tools");
      if (listing.enabled !== false) throw new Error("plane still reported enabled");

      const data = await postJson("/v1/chat/completions", {
        model: "free:smart", stream: false, tools: "auto", messages: [{ role: "user", content: "hi" }],
      });
      if (data.choices?.[0]?.message?.content !== "no tools here") throw new Error(JSON.stringify(data.choices?.[0]));
      if (seen[0].tools !== undefined) throw new Error("built-in tools declared while the plane is off");
      if (seen[0].messages.some((m: any) => m.role === "system" && /tool/i.test(String(m.content)))) {
        throw new Error("preamble injected while the plane is off");
      }
    });

    // Client tools keep working with the plane off — that is passthrough, not a
    // plane feature.
    await withEnv("NOKEY_TOOLS", "0", async () => {
      const passthrough = await postJson("/v1/chat/completions", {
        model: "free:smart", stream: false,
        tools: [{ type: "function", function: { name: "get_weather" } }],
        messages: [{ role: "user", content: "hi" }],
      });
      if (passthrough.choices?.[0]?.message?.content !== "no tools here") throw new Error(JSON.stringify(passthrough.choices?.[0]));
      if (seen.at(-1).tools?.length !== 1) throw new Error(`client tools dropped: ${JSON.stringify(seen.at(-1).tools)}`);
    });
  } finally {
    restoreMock();
  }
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test("streaming drains a tool round quietly, reports it in-band, then streams the answer", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, (_p, call) =>
    call === 0
      ? sseOf([{
        tool_calls: [{
          index: 0, id: "call_s1", type: "function",
          function: { name: "calculate", arguments: '{"expression":"6*7"}' },
        }],
      }], "tool_calls")
      : sseOf([{ content: "The answer is 42." }], "stop"), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:smart", stream: true, tools: "auto",
      messages: [{ role: "user", content: "6*7 over SSE" }],
    }));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!res.headers.get("content-type")?.includes("text/event-stream")) throw new Error("not SSE");
    const text = await res.text();
    if (!text.startsWith(": trace ")) throw new Error(`first bytes ${JSON.stringify(text.slice(0, 40))}`);
    const frames = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));

    const rounds = frames.filter((f) => f.nokey?.type === "tool_round");
    if (rounds.length !== 1) throw new Error(`expected one tool_round frame, got ${rounds.length}`);
    if (!Array.isArray(rounds[0].choices) || rounds[0].choices.length !== 0) {
      throw new Error(`status frame carried choices: ${JSON.stringify(rounds[0].choices)}`);
    }
    if (rounds[0].nokey.round !== 1) throw new Error(`round ${rounds[0].nokey.round}`);
    if (rounds[0].nokey.tools?.[0]?.name !== "calculate" || rounds[0].nokey.tools[0].ok !== true) {
      throw new Error(`tools ${JSON.stringify(rounds[0].nokey.tools)}`);
    }
    if (rounds[0].object !== "chat.completion.chunk") throw new Error(`status object ${rounds[0].object}`);

    // The intermediate turn must never look like assistant output.
    if (frames.some((f) => f.choices?.[0]?.delta?.tool_calls)) throw new Error("streamed the intermediate tool calls");
    const content = frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("");
    if (!content.includes("The answer is 42.")) throw new Error(`content ${JSON.stringify(content)}`);
    const fin = frames.filter((f) => f.choices?.[0]?.finish_reason);
    if (fin.at(-1)?.choices[0].finish_reason !== "stop") throw new Error(`finish ${JSON.stringify(fin)}`);
    if (fin.at(-1)?.nokey?.tool_rounds !== 1) throw new Error(`final meta ${JSON.stringify(fin.at(-1)?.nokey)}`);
    if (!text.trimEnd().endsWith("data: [DONE]")) throw new Error("stream did not end with [DONE]");

    if (seen.length !== 2) throw new Error(`expected 2 upstream calls, saw ${seen.length}`);
    const toolMsg = seen[1].messages.at(-1);
    if (toolMsg.role !== "tool" || !String(toolMsg.content).includes("42")) throw new Error(JSON.stringify(toolMsg));
  } finally {
    restoreMock();
  }
});

test("streamed client tool calls still arrive as indexed deltas with finish_reason tool_calls", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, () => sseOf([
    { tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "get_weather", arguments: '{"ci' } }] },
    { tool_calls: [{ index: 0, function: { arguments: 'ty":"Rome"}' } }] },
    { tool_calls: [{ index: 1, id: "call_c2", type: "function", function: { name: "get_time", arguments: "{}" } }] },
  ], "tool_calls"), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:smart", stream: true,
      tools: [{ type: "function", function: { name: "get_weather" } }, { type: "function", function: { name: "get_time" } }],
      messages: [{ role: "user", content: "weather and time" }],
    }));
    const text = await res.text();
    const frames = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    const merged = new Map<number, any>();
    for (const f of frames) {
      for (const t of f.choices?.[0]?.delta?.tool_calls ?? []) {
        const prev = merged.get(t.index) ?? { id: "", name: "", arguments: "" };
        merged.set(t.index, {
          id: t.id ?? prev.id,
          name: t.function?.name ?? prev.name,
          arguments: prev.arguments + (t.function?.arguments ?? ""),
        });
      }
    }
    if (merged.size !== 2) throw new Error(`merged ${JSON.stringify([...merged])}`);
    if (merged.get(0)?.arguments !== '{"city":"Rome"}') throw new Error(`call 0 ${JSON.stringify(merged.get(0))}`);
    if (merged.get(1)?.name !== "get_time") throw new Error(`call 1 ${JSON.stringify(merged.get(1))}`);
    const fin = frames.filter((f) => f.choices?.[0]?.finish_reason);
    if (fin.at(-1)?.choices[0].finish_reason !== "tool_calls") throw new Error(`finish ${JSON.stringify(fin)}`);
    if (frames.some((f) => f.nokey?.type === "tool_round")) throw new Error("client calls were treated as plane rounds");
    if (seen.length !== 1) throw new Error(`executed client tools: ${seen.length}`);
    if (!text.trimEnd().endsWith("data: [DONE]")) throw new Error("stream did not end with [DONE]");
  } finally {
    restoreMock();
  }
});

test("a streaming round whose calls belong to the client is emitted buffered, not dropped", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  // The plane attached its own tools, but the model called a client tool: the
  // quiet round must stop and hand the calls over.
  installMock(scripted(good, () => sseOf([
    { tool_calls: [{ index: 0, id: "call_mix", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] },
  ], "tool_calls"), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:smart", stream: true,
      tools: [{ type: "function", function: { name: "get_weather" } }], nokey_tools: "auto",
      messages: [{ role: "user", content: "weather" }],
    }));
    const text = await res.text();
    const frames = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    const withCalls = frames.filter((f) => f.choices?.[0]?.delta?.tool_calls);
    if (withCalls.length !== 1) throw new Error(`expected one buffered tool_calls delta, got ${withCalls.length}`);
    if (withCalls[0].choices[0].delta.tool_calls[0].function.name !== "get_weather") {
      throw new Error(JSON.stringify(withCalls[0].choices[0].delta.tool_calls));
    }
    const fin = frames.filter((f) => f.choices?.[0]?.finish_reason);
    if (fin.at(-1)?.choices[0].finish_reason !== "tool_calls") throw new Error(`finish ${JSON.stringify(fin)}`);
    if (frames.some((f) => f.nokey?.type === "tool_round")) throw new Error("reported a round that never ran");
    if (seen.length !== 1) throw new Error(`extra upstream calls: ${seen.length}`);
  } finally {
    restoreMock();
  }
});

// ---------------------------------------------------------------------------
// Routing: the mesh learns which tuples emit valid tool calls
// ---------------------------------------------------------------------------

test("GET /health publishes the tool plane and a tool-ranked best-of list", async () => {
  installMock(dead);
  try {
    const data = await getJson("/health");
    if (data.tool_plane?.name !== "ASCK-T v2") throw new Error(`tool_plane ${JSON.stringify(data.tool_plane)}`);
    if (!(data.tool_plane.builtin_tools >= 19)) throw new Error(`builtin_tools ${data.tool_plane.builtin_tools}`);
    if (data.tool_plane.agent_rounds !== 8) throw new Error(`agent_rounds ${data.tool_plane.agent_rounds}`);
    if (data.tool_plane.auto_tools < 5) throw new Error(`auto_tools ${data.tool_plane.auto_tools}`);
    if (typeof data.tool_plane.learning !== "string") throw new Error("learning not described");
    if (!Array.isArray(data.current_best_tools)) throw new Error("missing current_best_tools");
    if (typeof data.engine !== "string" || !/toolbox|toolplane/.test(data.engine)) throw new Error(`engine ${data.engine}`);

    const models = await getJson("/v1/models");
    const ids = (models.data ?? []).map((m: any) => m.id);
    if (!ids.includes("free:tools")) throw new Error(`free:tools alias missing from ${JSON.stringify(ids.slice(0, 12))}`);
  } finally {
    restoreMock();
  }
});

test("free:tools routes through the tool-aware lane and completes", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, () => answerCompletion("tool lane answer"), seen));
  try {
    const res = await app.fetch(chatRequest({
      model: "free:tools", stream: false, tools: "auto",
      messages: [{ role: "user", content: "what can you call?" }],
    }));
    const data = await asJson(res);
    if (data.nokey?.degraded === true) throw new Error(`degraded: ${JSON.stringify(data.nokey)}`);
    if (data.choices?.[0]?.message?.content !== "tool lane answer") throw new Error(JSON.stringify(data.choices?.[0]));
    if (!(seen[0].tools?.length > 0)) throw new Error("tools not declared on the tool lane");
    if (typeof data.telemetry.tool_competence !== "number" || typeof data.telemetry.tool_pulls !== "number") {
      throw new Error(`telemetry ${JSON.stringify(data.telemetry)}`);
    }
  } finally {
    restoreMock();
  }
});

test("chat traffic teaches the winning tuple's tool posterior", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, (_p, call) =>
    call % 2 === 0
      ? toolCallCompletion("data", '{"op":"validate","data":{"a":1},"schema":{"type":"object"}}', `call_v${call}`)
      : answerCompletion("valid"), seen));
  try {
    const first = await postJson("/v1/chat/completions", {
      model: "free:smart", stream: false, tools: "auto",
      messages: [{ role: "user", content: "validate this" }],
    });
    if (first.choices[0].message.content !== "valid") throw new Error(JSON.stringify(first.choices[0]));
    if (seen.length !== 2) throw new Error(`expected 2 upstream calls, saw ${seen.length}`);
    if (typeof first.telemetry.tool_competence !== "number") throw new Error("competence not reported");

    // The tool itself is instrumented synchronously enough to poll.
    const skill = await until(
      async () => (await getJson("/v1/tools")).skills?.data,
      (s: any) => Boolean(s) && s.calls >= 1 && s.errors === 0,
      "data skill",
    );
    if (!(skill.competence > 0)) throw new Error(`competence never moved: ${JSON.stringify(skill)}`);

    // The tuple-level posterior is written in the background, so a later
    // request has to see it: that is the compounding part of the design.
    const later = await until(
      () => postJson("/v1/chat/completions", {
        model: "free:smart", stream: false, tools: "auto",
        messages: [{ role: "user", content: "validate this again" }],
      }),
      (d: any) => Number(d.telemetry?.tool_pulls ?? 0) >= 1 && Number(d.telemetry?.tool_competence ?? 0) > 0,
      "tuple tool competence",
    );
    if (later.choices[0].message.content !== "valid") throw new Error("polling changed the answer");

    // And the tool-ranked lane has to be able to surface that evidence.
    const catalog = await execute({ name: "router_catalog", arguments: { mode: "tools", limit: 50 } });
    const rows = catalog.results[0].result.candidates as any[];
    if (!rows.some((r) => Number(r.tool_pulls ?? 0) >= 1)) {
      throw new Error(`no tuple in the tool lane shows learned evidence: ${JSON.stringify(rows.slice(0, 3))}`);
    }
  } finally {
    restoreMock();
  }
});

test("tool rounds and direct executions are traced inside the request trace", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, (_p, call) =>
    call === 0 ? toolCallCompletion("crypto", '{"op":"digest","algorithm":"sha-256","data":"abc"}') : answerCompletion("hashed"), seen));
  try {
    const data = await postJson("/v1/chat/completions", {
      model: "free:smart", stream: false, tools: "auto", messages: [{ role: "user", content: "hash abc" }],
    });
    const traceId = data.nokey?.trace_id;
    if (!traceId) throw new Error("no trace id");

    const adminSecret = Deno.env.get("ADMIN_SECRET");
    const adminHeaders: Record<string, string> = adminSecret ? { "x-admin-secret": adminSecret } : {};
    const viaTrace = await execute(
      { name: "router_trace", arguments: { trace_id: traceId } },
      adminHeaders,
    );
    if (viaTrace.results[0].ok !== true) throw new Error(JSON.stringify(viaTrace.results[0]).slice(0, 300));
    const spans = JSON.stringify(viaTrace.results[0].result);
    if (!spans.includes("tool_round")) throw new Error(`no tool_round span: ${spans.slice(0, 400)}`);
    if (!spans.includes("tool_verdict")) throw new Error("no tool_verdict event in the trace");

    // An inbound traceparent is honoured, so a client can stitch its own trace.
    const exec = await execute(
      { name: "time", arguments: { op: "convert", value: "2026-11-04T12:00:00Z" } },
      { traceparent: `00-${traceId}-0123456789abcdef-01` },
    );
    if (exec.results[0].ok !== true) throw new Error(JSON.stringify(exec.results[0]));
    if (exec.trace_id !== traceId) throw new Error(`inbound traceparent not honoured: ${exec.trace_id} != ${traceId}`);
    if (exec.results[0].result.epoch_s !== 1793793600) throw new Error(`epoch_s ${exec.results[0].result.epoch_s}`);
  } finally {
    restoreMock();
  }
});

test("tools:auto never hands a call to the user: undeclared names execute, a spent budget forces an answer", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  installMock(scripted(good, (_p, call) =>
    call === 0
      ? toolCallCompletion("get_weather", '{"city":"Oslo"}')
      : jsonResponse({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "No weather tool; answering directly." } }] }), seen));
  try {
    const data = await asJson(await app.fetch(chatRequest({
      model: "free:smart", stream: false, tools: "auto", nokey_rounds: 1,
      messages: [{ role: "user", content: "weather in Oslo" }],
    })));
    if (data.choices[0].finish_reason !== "stop") throw new Error(`finish ${data.choices[0].finish_reason}`);
    if (data.choices[0].message.tool_calls) throw new Error("calls reached the client");
    if (seen.length !== 2) throw new Error(`expected 2 upstream calls, saw ${seen.length}`);
    const toolMsg = seen[1].messages.at(-1);
    if (toolMsg.role !== "tool" || !String(toolMsg.content).includes("UNKNOWN_TOOL")) throw new Error(JSON.stringify(toolMsg));
    if (seen[1].tool_choice !== "none") throw new Error(`final turn tool_choice ${JSON.stringify(seen[1].tool_choice)}`);
  } finally {
    restoreMock();
  }
});

test("a streamed tool call that arrives after the head committed still runs in-plane", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  const preamble = "Let me work this out carefully before calling the calculator tool for the exact value.";
  installMock(scripted(good, (_p, call) =>
    call === 0
      ? sseOf([{ content: preamble }, { tool_calls: [{ index: 0, id: "call_late", type: "function", function: { name: "calculate", arguments: '{"expression":"6*7"}' } }] }], "tool_calls")
      : sseOf([{ content: "The answer is 42." }]), seen));
  try {
    const text = await (await app.fetch(chatRequest({
      model: "free:smart", stream: true, tools: "auto",
      messages: [{ role: "user", content: "6*7?" }],
    }))).text();
    const frames = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    if (frames.some((f) => f.choices?.[0]?.delta?.tool_calls)) throw new Error("late calls reached the client");
    if (!frames.some((f) => f.nokey?.type === "tool_round")) throw new Error("no tool round reported");
    const fin = frames.filter((f) => f.choices?.[0]?.finish_reason).at(-1);
    if (fin?.choices[0].finish_reason !== "stop") throw new Error(`finish ${JSON.stringify(fin)}`);
    if (seen.length !== 2) throw new Error(`expected 2 upstream calls, saw ${seen.length}`);
    const toolMsg = seen[1].messages.at(-1);
    if (toolMsg.role !== "tool" || !String(toolMsg.content).includes("42")) throw new Error(JSON.stringify(toolMsg));
  } finally {
    restoreMock();
  }
});
