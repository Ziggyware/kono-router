// tests/host_routing_test.ts — the host spine, proven without a network, a key
// or a KV. Runtime-neutral: a ~30-line harness, no `node:test`, no `Deno.test`,
// no imports outside `host/`.
//
//   node --experimental-strip-types tests/host_routing_test.ts
//   deno run -A tests/host_routing_test.ts

import {
  buildRequest,
  createHostRouter,
  decompose,
  intake,
  Ledger,
  memoryPortsWithEvents,
  mergeLimits,
  substituteRefs,
  validatePlan,
} from "../host/index.ts";
import type { ChunkResult, HostEvent, HostPorts, Json } from "../host/index.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type TestFn = () => Promise<void> | void;

interface Case {
  name: string;
  fn: TestFn;
}

const cases: Case[] = [];

export function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

export function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function expectEqual(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? `${msg}: ` : ""}expected ${e}, got ${a}`);
}

export function expectMatch(text: string, re: RegExp, msg = ""): void {
  if (!re.test(text)) {
    throw new Error(`${msg ? `${msg}: ` : ""}expected ${re} in ${JSON.stringify(text.slice(0, 200))}`);
  }
}

export async function run(): Promise<{ passed: number; failed: Array<{ name: string; error: string }> }> {
  const failed: Array<{ name: string; error: string }> = [];
  let passed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`ok   ${c.name}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ name: c.name, error });
      console.log(`FAIL ${c.name}\n     ${error.replace(/\n/g, "\n     ")}`);
    }
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const silentPorts = (): HostPorts => memoryPortsWithEvents([]);

function simpleBody(extra: Json = {}): Json {
  return {
    model: "free:auto",
    tools: "auto",
    messages: [{ role: "user", content: "What is the capital of France?" }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// the spine
// ---------------------------------------------------------------------------

test("a simple request is built, decomposed by the AI, executed and assembled", async () => {
  const events: HostEvent[] = [];
  const router = createHostRouter(memoryPortsWithEvents(events));
  const res = await router.handle(simpleBody(), { tenant: "test" });

  expectEqual(res.finish, "stop", "finish");
  expectEqual(res.plan.source, "planner", "plan source");
  expectEqual(res.plan.chunks.map((c) => c.id), ["facts", "draft", "polish"], "chunk ids");
  expectEqual(res.plan.chunks.map((c) => c.needs), [[], ["facts"], ["draft"]], "dependencies");
  expectMatch(res.content, /\[polish\] answered/, "assembled from the terminal chunk");
  expectEqual(res.report.toolCalls, 1, "tool calls");
  expect(res.report.modelCalls >= 3, `model calls: ${res.report.modelCalls}`);
  expectEqual(res.report.chunks.filter((c) => c.status === "ok").length, 3, "ok chunks");
  expectEqual(res.report.finish, "stop", "report finish");

  // Visibility: one monotonic stream, every stage represented.
  expect(events.length > 10, `event count: ${events.length}`);
  expectEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seq is monotonic");
  const stages = new Set(events.map((e) => e.stage));
  for (const stage of ["intake", "build", "rank", "decompose", "chunk", "assemble", "done"]) {
    expect(stages.has(stage as HostEvent["stage"]), `missing stage ${stage}`);
  }
  const chunkEnds = events.filter((e) => e.stage === "chunk" && e.phase === "end" && e.chunkId);
  expectEqual(chunkEnds.length, 3, "one end event per chunk");
  expect(res.report.explain().includes(res.report.requestId), "explain names the request");
  expectEqual(router.report(res.report.requestId)?.finish, "stop", "report ring");
});

test("a planner that answers in prose degrades to one chunk instead of failing", async () => {
  const ports = memoryPortsWithEvents([], { planner: () => "I would rather not answer in JSON." });
  const res = await createHostRouter(ports).handle(simpleBody(), { tenant: "test" });

  expectEqual(res.finish, "stop", "finish");
  expectEqual(res.plan.source, "fallback", "fallback source");
  expectEqual(res.plan.chunks.length, 1, "single chunk");
  expectEqual(res.plan.plannerAttempts, 2, "bounded attempts");
  expect(res.plan.rejects.some((r) => r.code === "decompose.fallback"), "fallback note");
  expectMatch(res.content, /\[answer\] answered/, "pass-through answer");
  expect(res.report.errors >= 2, "both planner attempts are visible as errors");
});

test("a chunk that names an undeclared tool is rejected, the rest still run", async () => {
  const plan: Json = {
    rationale: "run a shell command, then summarise",
    chunks: [
      { id: "run", title: "Run", kind: "tool", tool: "shell", args: {}, needs: [] },
      { id: "sum", title: "Sum", kind: "answer", needs: ["run"], prompt: "Summarise the result." },
    ],
  };
  const ports = memoryPortsWithEvents([], { planner: () => plan });
  const res = await createHostRouter(ports).handle(simpleBody(), { tenant: "test" });

  expectEqual(res.finish, "stop", "finish");
  expectEqual(res.plan.source, "planner", "plan source");
  expectEqual(res.plan.chunks.map((c) => c.id), ["sum"], "only the safe chunk runs");
  expectEqual(res.plan.chunks[0].needs, [], "orphaned dependency dropped");
  expect(res.plan.rejects.some((r) => r.code === "chunk.tool_not_declared"), "tool reject");
  expect(res.plan.rejects.some((r) => r.code === "chunk.need_dropped"), "need reject");
  expectMatch(res.content, /\[sum\] answered/, "remaining chunk still answers");
});

test("dependency cycles are impossible: needs may only point backwards", () => {
  const v = validatePlan(
    {
      chunks: [
        { id: "a", kind: "answer", prompt: "first", needs: ["b"] },
        { id: "b", kind: "answer", prompt: "second", needs: ["a"] },
      ],
    },
    new Set(),
    mergeLimits(),
  );
  expectEqual(v.chunks.length, 2, "chunks kept");
  expectEqual(v.chunks[0].needs, [], "forward dependency dropped");
  expectEqual(v.chunks[1].needs, ["a"], "backward dependency kept");
  expect(v.rejects.some((r) => r.code === "chunk.need_dropped"), "drop is recorded");
});

test("tool args may only read earlier chunks", () => {
  const v = validatePlan(
    {
      chunks: [
        { id: "late", kind: "tool", tool: "web_lookup", args: { q: "$missing" } },
        { id: "fine", kind: "tool", tool: "web_lookup", args: { q: "static" } },
      ],
    },
    new Set(["web_lookup"]),
    mergeLimits(),
  );
  expectEqual(v.chunks.map((c) => c.id), ["fine"], "unresolved ref rejects the chunk");
  expect(v.rejects.some((r) => r.code === "chunk.ref_unresolved"), "ref reject recorded");
});

test("refs substitute whole values and inline text", () => {
  const result: ChunkResult = {
    chunk: { id: "facts", title: "Facts", kind: "tool", needs: [], outputCapChars: 1_000 },
    status: "ok",
    output: '{"capital":"Paris"}',
    value: { capital: "Paris", tags: ["europe", "france"] },
    ms: 1,
    attempts: 1,
  };
  const results = new Map([["facts", result]]);
  const whole = substituteRefs({ city: "$facts/capital" }, results);
  expect(whole.ok, "whole ref resolves");
  if (whole.ok) expectEqual(whole.value, { city: "Paris" }, "whole ref");
  const inline = substituteRefs({ text: "it is $facts/capital, tags $facts/tags/0" }, results);
  expect(inline.ok, "inline ref resolves");
  if (inline.ok) expectEqual(inline.value, { text: "it is Paris, tags europe" }, "inline ref");
  expectEqual(substituteRefs({ text: "$nope" }, results).ok, false, "missing ref fails");
});

test("a dead tool fails its chunk, skips dependents, and never fabricates an answer", async () => {
  const ports = memoryPortsWithEvents([], {
    tools: {
      web_lookup: () => {
        throw new Error("HTTP_500: upstream exploded");
      },
    },
  });
  const res = await createHostRouter(ports).handle(simpleBody(), { tenant: "test" });

  expectEqual(res.finish, "degraded", "finish");
  expectEqual(res.report.chunks.map((c) => c.status), ["failed", "skipped", "skipped"], "statuses");
  expectEqual(
    res.report.chunks.map((c) => c.code),
    ["tool_error", "dependency_failed", "dependency_failed"],
    "codes",
  );
  expectMatch(res.content, /No chunk of this request produced an answer/, "degraded body");
  expect(res.report.notes.some((n) => n.code === "assemble.degraded"), "degraded note");
  expectEqual(res.report.retries, 1, "the 500 was retried exactly once");
});

test("an aborting caller gets an abort, not an answer", async () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error("CLIENT_DISCONNECTED"));
  const res = await createHostRouter(silentPorts()).handle(simpleBody(), {
    tenant: "test",
    signal: ctrl.signal,
  });
  expectEqual(res.finish, "abort", "finish");
  expectMatch(res.content, /aborted before an answer/, "abort body");
  expect(res.report.notes.some((n) => n.code === "request.aborted"), "abort note");
});

test("too little planner budget falls back before calling a model", async () => {
  const ledger = new Ledger({ requestId: "req_unit", startedAt: Date.now() });
  const ports = silentPorts();
  const request = intake(simpleBody(), { tenant: "test" }, undefined, ledger);
  const built = await buildRequest({ ...request, signal: new AbortController().signal }, ports, ledger);
  const plan = await decompose(built, ports, ledger, 500);
  expectEqual(plan.source, "fallback", "fallback source");
  expect(plan.rejects.some((r) => r.code === "decompose.no_budget"), "budget floor note");
  expectEqual(plan.chunks.length, 1, "single chunk");
});

test("intake tames a hostile body and records every change", () => {
  const ledger = new Ledger({ requestId: "req_intake", startedAt: Date.now() });
  const request = intake(
    {
      model: 42,
      temperature: 9,
      max_tokens: -5,
      messages: [
        { role: "wizard", content: "hello" },
        {
          role: "user",
          content: [{ type: "text", text: "see " }, { type: "image_url", image_url: { url: "x" } }],
        },
        17,
      ],
      tools: [{ name: "ok" }, { name: "" }, "nope"],
    },
    { tenant: "" },
    { maxMessages: 8 },
    ledger,
  );
  expectEqual(request.model, "free:auto", "model default");
  expectEqual(request.tenant, "global", "tenant default");
  expectEqual(request.params.temperature, 2, "temperature clamped");
  expectEqual(request.params.maxTokens, 1, "max_tokens clamped");
  expectEqual(request.messages.length, 2, "non-object message dropped");
  expectEqual(request.messages[0].role, "user", "unknown role coerced");
  expect(request.hasImages, "image part detected");
  expectEqual(request.clientTools.length, 1, "only the valid tool kept");
  const codes = request.notes.map((n) => n.code);
  for (const code of [
    "messages.role",
    "messages.item",
    "tools.bad_name",
    "params.temperature",
    "model.default",
  ]) {
    expect(codes.includes(code), `missing intake note ${code}`);
  }
});

test("a paused answer is continued inside the spine", async () => {
  let calls = 0;
  const events: HostEvent[] = [];
  const ports = memoryPortsWithEvents(events, {
    planner: () => "not json at all",
    answer: () => {
      calls += 1;
      return calls === 1
        ? "Let me build:\n- HTML5 canvas\n- Fresnel lens\nI'll write the code now."
        : "<html>artifact</html>";
    },
  });
  const res = await createHostRouter(ports).handle(
    { model: "free:auto", messages: [{ role: "user", content: "build me an html hologram demo" }] },
    { tenant: "test" },
  );
  expectEqual(res.finish, "stop", "finish");
  expectMatch(res.content, /<html>artifact<\/html>/, "the continuation is appended");
  expect(res.content.includes("Let me build"), "the plan is kept, not discarded");
  expect(res.report.notes.some((n) => n.code === "assemble.continued"), "continuation note");
  expect(!res.report.notes.some((n) => n.code === "assemble.stalled"), "not left flagged as stalled");
  expect(events.some((e) => e.stage === "assemble" && e.chunkId === "continue"), "continuation event");
});

// ---------------------------------------------------------------------------
// direct invocation (node or deno); silent when imported by a test runner
// ---------------------------------------------------------------------------

const meta = import.meta as unknown as { main?: boolean };
const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
const isDirect = meta.main === true || argv.some((a) => a.endsWith("host_routing_test.ts"));

if (isDirect) {
  const { failed } = await run();
  if (failed.length > 0) throw new Error(`${failed.length} host routing test(s) failed`);
}
