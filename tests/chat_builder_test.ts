// deno-lint-ignore-file no-explicit-any
/**
 * App Builder profile (nokey_builder) tests.
 *
 * Builder traffic must be deterministic and quality-first, unlike ordinary
 * chat: no strategy-arm lottery (no variant prompt, no temperature delta),
 * deterministic candidate scoring, the tool plane implied when the client
 * declares no tools, and the build gate forced on even when the client
 * sends nokey_gate: false.
 *
 * Driven through the real Hono app against a fully mocked upstream
 * registry, exactly like tests/tool_plane_test.ts. No external network:
 * globalThis.fetch is replaced.
 *
 * Run: deno test --unstable-kv -A tests/
 */
import { app } from "../main.ts";
import { scoreRecord } from "../engine/ranking.ts";
import { syntheticRecord } from "../engine/providers.ts";

const realFetch = globalThis.fetch;

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

/** An upstream completion that asks for a tool call instead of answering. */
function toolCallCompletion(name: string, args: string, id = "call_builder_1"): Response {
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

// Same credential pattern as the tool-plane suite: without a key these
// requests ride the anonymous free tier in shared KV and can 429.
const API_KEY_ENV = ["ROUTER", "API", "KEY"].join("_");
const AUTH: Record<string, string> = {
  authorization: "Bearer " + (Deno.env.get(API_KEY_ENV) ?? "testkey"),
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

async function getJson(path: string): Promise<any> {
  const res = await app.fetch(new Request(`https://router.test${path}`, { headers: { ...AUTH } }));
  if (res.status !== 200) throw new Error(`${path} -> status ${res.status}`);
  return await asJson(res);
}

// KV keeps a long-lived resource open and background writes may outlive a
// test, so the sanitizers are relaxed exactly as the other suites do.
const test = (name: string, fn: () => void | Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

let healthyUrl: string | null = null;
async function pickHealthyUrl(): Promise<string> {
  if (healthyUrl) return healthyUrl;
  const data = await getJson("/v1/endpoints");
  const list = data.data as Array<{ url: string }>;
  healthyUrl = list[Math.floor(list.length * 0.63)]?.url ?? list[0].url;
  return healthyUrl!;
}

// The two non-baseline prompt variants a strategy arm could inject, and the
// tool-plane preamble a builder request must carry instead.
const ARM_VARIANT_TEXTS = [
  "Answer directly and concisely", // concise arm
  "Before answering, work through the problem carefully", // verify / best_of arms
];
const PREAMBLE_HEAD = "You have server-side tools executed by the nokey-router tool plane.";

test("builder profile: deterministic scoring is a pure function of the record", () => {
  const now = 1_763_000_000_000;
  const rec = {
    ...syntheticRecord("prov-x", "qwen/qwen3-coder:free"),
    success_count: 64,
    failure_streak: 3,
    alpha_success: 41,
    beta_failure: 9,
    iq_verified: 0.92,
    last_success_at: now - 60_000,
    tool_pulls: 25,
    tool_alpha: 19,
    tool_beta: 6,
    tool_last_at: now - 30_000,
  };
  // The deterministic branch of scoreRecord is what builder tier-1 ranking
  // runs: Wilson / posterior lower bounds instead of Thompson draws, zero
  // UCB exploration bonus, zero Gumbel noise. Same record in -> same score
  // out, every time; any sampling would diverge across repetitions.
  const first = scoreRecord(rec, "code", true, 5000, now, true, { taskClass: "code", tenant: "global" });
  for (let i = 0; i < 8; i++) {
    const again = scoreRecord(rec, "code", true, 5000, now, true, { taskClass: "code", tenant: "global" });
    if (JSON.stringify(again) !== JSON.stringify(first)) {
      throw new Error(`deterministic score drifted on repetition ${i}: ${JSON.stringify(again)} vs ${JSON.stringify(first)}`);
    }
  }
});

test("builder profile: no strategy arm is applied and tools are implied", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  const session = "builder-arm-" + crypto.randomUUID().slice(0, 8);
  installMock(scripted(good, () => answerCompletion("Built it."), seen));
  try {
    // Repeat: arm selection elsewhere in the router is a Thompson draw, so a
    // single clean request could be luck. Five builder requests must ALL be
    // arm-free — the flag, not chance, has to be what protects them.
    for (let i = 0; i < 5; i++) {
      const data = await asJson(await app.fetch(chatRequest({
        model: "free:code",
        stream: false,
        temperature: 0.3,
        nokey_builder: true,
        messages: [{ role: "user", content: "Build a tiny counter app with one button." }],
      }, { "x-nokey-session": session })));
      if (data.nokey?.degraded === true) throw new Error(`request ${i} degraded`);
      if (data.choices?.[0]?.message?.content !== "Built it.") {
        throw new Error(`request ${i} content: ${JSON.stringify(data.choices?.[0]?.message)}`);
      }
    }
    if (seen.length < 5) throw new Error(`expected at least 5 upstream payloads, got ${seen.length}`);
    for (const [i, payload] of seen.entries()) {
      // Temperature arrives exactly as sent: no +0.25 explore delta, no
      // -0.1 verify delta, across every dispatch of every request.
      if (payload.temperature !== 0.3) {
        throw new Error(`payload ${i} temperature ${payload.temperature} !== 0.3 (an arm delta leaked in)`);
      }
      const wire = JSON.stringify(payload.messages ?? []);
      for (const variant of ARM_VARIANT_TEXTS) {
        if (wire.includes(variant)) throw new Error(`payload ${i} carries the strategy-arm prompt "${variant}"`);
      }
      // The client declared no tools; the builder profile implies the
      // router's plane, so the preamble and the tool declarations (fs_write
      // included, which is what arms the build gate) must be on the wire.
      if (!wire.includes(PREAMBLE_HEAD)) throw new Error(`payload ${i} is missing the tool-plane preamble`);
      const toolNames = (payload.tools ?? []).map((t: any) => t.function?.name ?? t.name);
      if (!toolNames.includes("fs_write")) {
        throw new Error(`payload ${i} tools do not include fs_write: ${JSON.stringify(toolNames).slice(0, 200)}`);
      }
    }
  } finally {
    restoreMock();
  }
});

test("builder profile: the agent loop runs on implied tools and continues the conversation", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  const session = "builder-loop-" + crypto.randomUUID().slice(0, 8);
  installMock(scripted(good, (_p, call) => call === 0
    ? toolCallCompletion("calculate", JSON.stringify({ expression: "23*19+14" }))
    : answerCompletion("23*19+14 = 451."), seen));
  try {
    const data = await asJson(await app.fetch(chatRequest({
      model: "free:code",
      stream: false,
      nokey_builder: true,
      messages: [{ role: "user", content: "Build a calculator widget; check 23*19+14 with the tool first." }],
    }, { "x-nokey-session": session })));
    if (data.choices?.[0]?.message?.content !== "23*19+14 = 451.") {
      throw new Error(`final ${JSON.stringify(data.choices?.[0]?.message)}`);
    }
    // One tool round happened server-side — only possible because the
    // builder profile implied the tool plane the client never declared.
    if (data.nokey?.tool_rounds !== 1) throw new Error(`tool_rounds ${JSON.stringify(data.nokey)}`);
    if (seen.length !== 2) throw new Error(`upstream calls ${seen.length}`);
    // The continuation carries the executed tool's result back to the model.
    const toolMsg = seen[1].messages.find((m: any) => m.role === "tool");
    if (!toolMsg || !String(toolMsg.content).includes("451")) {
      throw new Error(`continuation tool message ${JSON.stringify(toolMsg).slice(0, 300)}`);
    }
  } finally {
    restoreMock();
  }
});

test("builder profile: nokey_gate:false is ignored — the build gate still sends broken work back", async () => {
  const good = await pickHealthyUrl();
  const seen: any[] = [];
  const session = "builder-gate-" + crypto.randomUUID().slice(0, 8);
  // Same script as the tool-plane gate test: write a page, write broken JS,
  // claim done, get sent back by the gate, fix it, answer clean.
  installMock(scripted(good, (_p, call) => [
    () => toolCallCompletion("fs_write", JSON.stringify({ path: "index.html", content: '<script type="module" src="app.js"></script>' })),
    () => toolCallCompletion("fs_write", JSON.stringify({ path: "app.js", content: "export const total = (a, b => a + b;\n" })),
    () => answerCompletion("All done."),
    () => toolCallCompletion("fs_write", JSON.stringify({ path: "app.js", content: "export const total = (a, b) => a + b;\n" })),
    () => answerCompletion("Fixed the syntax error; the build is clean."),
  ][Math.min(call, 4)](), seen));
  try {
    const data = await asJson(await app.fetch(chatRequest({
      model: "free:code",
      stream: false,
      nokey_builder: true,
      nokey_gate: false, // must NOT opt out under the builder profile
      messages: [{ role: "user", content: "build a sum app" }],
    }, { "x-nokey-session": session })));
    if (data.choices?.[0]?.message?.content !== "Fixed the syntax error; the build is clean.") {
      throw new Error(`final ${JSON.stringify(data.choices?.[0]?.message)}`);
    }
    if (seen.length !== 5) throw new Error(`upstream calls ${seen.length}`);
    const gateTurn = seen[3].messages.at(-1);
    if (gateTurn.role !== "user" || !/\[build gate\]/.test(gateTurn.content) || !/app\.js:1/.test(gateTurn.content)) {
      throw new Error(`gate turn ${JSON.stringify(gateTurn)}`);
    }
    if (!data.nokey.tools_executed.some((e: any) => e.tool === "build_gate")) {
      throw new Error(`no gate in log ${JSON.stringify(data.nokey.tools_executed)}`);
    }
  } finally {
    restoreMock();
  }
});
