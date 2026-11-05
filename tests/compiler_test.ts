// deno-lint-ignore-file no-explicit-any
// Agent compiler: plan grammar, MBR selection, DAG scheduling, the
// plan→execute→join→replan loop, and the HTTP route against a mocked mesh.
import { app } from "../main.ts";
import { registerTool, unregisterTool } from "../tools.ts";
import { parsePlan } from "../compiler/plan.ts";
import { substitute } from "../compiler/refs.ts";
import { multisetJaccard, selectMbr, viewOf } from "../compiler/mbr.ts";
import { runPlan } from "../compiler/schedule.ts";
import { bm25Rank, retrieveTools } from "../compiler/retrieve.ts";
import { compile } from "../compiler/index.ts";
import { listTools } from "../tools.ts";

const test = (name: string, fn: () => Promise<void> | void) => Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const none = new Set<string>();

registerTool({
  name: "cc_wait",
  kind: "compute",
  description: "test-only: waits ms then echoes value",
  parameters: { type: "object", properties: { ms: { type: "integer" }, value: {} }, required: ["ms"] },
  run: async (a) => { await sleep(Number(a.ms)); return { value: a.value ?? null }; },
});
addEventListener("unload", () => unregisterTool("cc_wait"));

test("parsePlan: fenced JSON, refs become edges, topological order", () => {
  const raw = '```json\n{"nodes":[{"id":"n3","tool":"cc_wait","args":{"ms":1,"value":"${n1.value}+$n2"}},' +
    '{"id":"n1","tool":"cc_wait","args":{"ms":1,"value":2}},{"id":"n2","tool":"calculator","args":{"expression":"1+1"}}]}\n```';
  const p = parsePlan(raw, none);
  assert(p.ok, p.errors.join(";"));
  const n3 = p.plan!.nodes.find((n) => n.id === "n3")!;
  assert(n3.deps.join() === "n1", `inline-only deps ${n3.deps}`); // "+$n2" is not a whole-string ref
  assert(p.plan!.nodes.find((n) => n.id === "n2")!.tool === "calculate", "alias resolved");
  assert(p.plan!.order.indexOf("n1") < p.plan!.order.indexOf("n3"), "topological");
});

test("parsePlan: rejects cycles, dangling refs, unknown tools with suggestions", () => {
  const cyc = parsePlan('[{"id":"n1","tool":"cc_wait","args":{"ms":1,"value":"$n2"}},{"id":"n2","tool":"cc_wait","args":{"ms":1,"value":"$n1"}}]', none);
  assert(!cyc.ok && cyc.errors.some((e) => e.startsWith("cycle")), cyc.errors.join());
  const dang = parsePlan('[{"id":"n1","tool":"cc_wait","args":{"ms":1,"value":"$n9"}}]', none);
  assert(dang.errors.some((e) => e.includes("unknown reference $n9")), dang.errors.join());
  assert(parsePlan('[{"id":"n2","tool":"cc_wait","args":{"ms":1,"value":"$n1"}}]', new Set(["n1"])).ok, "prior refs allowed");
  const unk = parsePlan('[{"id":"n1","tool":"calculat","args":{}}]', none);
  assert(unk.ok || unk.errors.some((e) => e.includes("calculate")), unk.errors.join());
});

test("substitute: typed whole refs, inline text, imagined .result wrapper", () => {
  const r = new Map<string, unknown>([["n1", { value: 451, list: [7] }]]);
  const s = substitute({ a: "$n1.value", b: "v=${n1.list[0]}", c: "$n1.result.value", d: "$5" }, r);
  assert(s.ok && s.value.a === 451 && s.value.b === "v=7" && s.value.c === 451 && s.value.d === "$5", JSON.stringify(s));
  assert(!substitute({ a: "$n1.nope" }, r).ok, "missing path is an error");
});

test("MBR: consensus plan wins regardless of node ids; outlier loses", () => {
  const mk = (raw: string) => viewOf(parsePlan(raw, none).plan!, () => undefined);
  const a = mk('[{"id":"n1","tool":"calculate","args":{"expression":"2+2"}},{"id":"n2","tool":"cc_wait","args":{"ms":1,"value":"$n1"}}]');
  const b = mk('[{"id":"x","tool":"calculate","args":{"expression":"2+2"}},{"id":"y","tool":"cc_wait","args":{"ms":1,"value":"$x"}}]');
  const c = mk('[{"id":"n1","tool":"cc_wait","args":{"ms":5,"value":"four"}}]');
  assert(multisetJaccard(a.calls, b.calls) === 1, "id-free signatures match");
  const pick = selectMbr([c, a, b], [1, 1, 1]);
  assert(pick.index === 1 && pick.scores[0] < pick.scores[1], JSON.stringify(pick));
});

test("runPlan: independent nodes overlap, data flows, failures skip only dependents", async () => {
  const p = parsePlan(JSON.stringify([
    { id: "n1", tool: "cc_wait", args: { ms: 60, value: 1 } },
    { id: "n2", tool: "cc_wait", args: { ms: 60, value: 2 } },
    { id: "n3", tool: "cc_wait", args: { ms: 60, value: 3 } },
    { id: "n4", tool: "cc_wait", args: { ms: 1, value: ["$n1.value", "$n2.value"] } },
    { id: "n5", tool: "cc_wait", args: { ms: "bad" } },
    { id: "n6", tool: "cc_wait", args: { ms: 1, value: "$n5" } },
  ]), none);
  assert(p.ok, p.errors.join());
  const { executeTool } = await import("../tools.ts");
  const results = new Map<string, unknown>();
  const { runs, metrics } = await runPlan(p.plan!, results, {
    exec: async (t, a) => { const x = await executeTool(t, a); return x.ok ? { ok: true, result: x.result, ms: x.ms } : { ok: false, error: x.error, code: x.code, ms: x.ms }; },
    concurrency: 4, estimateMs: () => 10, stateful: () => false, signal: new AbortController().signal,
  });
  const by = Object.fromEntries(runs.map((r) => [r.id, r]));
  assert(JSON.stringify((by.n4.result as any).value) === "[1,2]", JSON.stringify(by.n4));
  assert(by.n5.status === "error" && by.n6.status === "skipped" && by.n3.status === "ok", JSON.stringify(runs.map((r) => r.status)));
  assert(metrics.makespan_ms < 150 && metrics.parallelism > 1.8 && metrics.depth === 2, JSON.stringify(metrics));
});

test("retrieval: BM25 ranks the relevant tool first", () => {
  assert(bm25Rank("evaluate an arithmetic expression", listTools())[0].name === "calculate", "calculate first");
  assert(retrieveTools("zzqx", { k: 3, admin: false, fallback: ["calculate"] })[0].name === "calculate", "fallback");
});

test("compile: invalid plan → replan → parallel execution → grounded answer", async () => {
  let plans = 0;
  const out = await compile({
    question: "double 21 and triple 5, then sum",
    samples: 2,
    rounds: 3,
    tools: ["cc_wait", "calculate"],
    complete: (msgs) => Promise.resolve((() => {
      if (msgs[0].content.startsWith("You are the joiner")) {
        const obs = msgs[1].content;
        return obs.includes('"value":57') ? { content: '{"action":"finish","answer":"57"}' } : { content: '{"action":"replan","reason":"no sum yet"}' };
      }
      plans++;
      if (plans <= 2) return { content: "[{\"id\":\"n1\",\"tool\":\"nope\"}]" };
      return { content: JSON.stringify({ nodes: [
        { id: "n1", tool: "calculate", args: { expression: "21*2" } },
        { id: "n2", tool: "calculate", args: { expression: "5*3" } },
        { id: "n3", tool: "calculate", args: { expression: "a+b", variables: { a: "$n1.value", b: "$n2.value" } } },
      ] }) };
    })()),
    exec: async (t, a) => { const { executeTool } = await import("../tools.ts"); const x = await executeTool(t, a); return { ok: x.ok, result: x.ok ? x.result : undefined, error: x.ok ? undefined : x.error, ms: x.ms }; },
  });
  assert(out.answer === "57", JSON.stringify(out));
  assert(out.rounds.length === 2 && out.rounds[0].selected === null && out.rounds[1].runs.every((r) => r.status === "ok"), JSON.stringify(out.rounds));
  assert(out.usage.react_round_trips === 3 && out.usage.tool_calls === 3, JSON.stringify(out.usage));
});

test("POST /v1/agent/compile runs end to end through the mesh", async () => {
  const realFetch = globalThis.fetch;
  const AUTH = { authorization: `Bearer ${Deno.env.get("ROUTER_API_KEY") ?? "testkey"}` };
  const reply = (content: string) => new Response(JSON.stringify({ id: "m", object: "chat.completion", created: 1, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] }), { headers: { "content-type": "application/json" } });
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    if (!init || init.method !== "POST") return Promise.resolve(new Response('{"data":[]}', { headers: { "content-type": "application/json" } }));
    const body = JSON.parse(String(init.body));
    const sys = String(body.messages?.[0]?.content ?? "");
    if (sys.startsWith("You are the joiner")) return Promise.resolve(reply('{"action":"finish","answer":"451"}'));
    if (sys.startsWith("You are a planning compiler")) return Promise.resolve(reply('{"nodes":[{"id":"n1","tool":"calculate","args":{"expression":"(23*19)+14"}}]}'));
    return Promise.resolve(reply("ok"));
  }) as typeof fetch;
  try {
    const res = await app.fetch(new Request("https://router.test/v1/agent/compile", {
      method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ question: "what is (23*19)+14", samples: 2, rounds: 1 }),
    }));
    const j: any = await res.json();
    assert(res.status === 200 && j.answer === "451", JSON.stringify(j).slice(0, 600));
    assert((j.rounds[0].runs[0].result as any).value === 451 && j.rounds[0].consensus === 1, JSON.stringify(j.rounds[0]));
    const tr: any = await (await app.fetch(new Request(`https://router.test/v1/traces/${j.trace_id}`, { headers: AUTH }))).json();
    assert(JSON.stringify(tr).includes("chat.completions"), "sub-requests nest in the compile trace");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("lastJson: reasoning prose with quoted fragments yields the final plan; prose alone is no plan", async () => {
  const { lastJson } = await import("../compiler/json.ts");
  const prose = 'Need decide. values: [] maybe {"expression":"2+2"} hmm.\n<think>try {"nodes":[{"tool":"x"}]}</think>\nFinal:\n{"nodes":[{"id":"n1","tool":"calculate","args":{"expression":"2+2"}}]}\nDone.';
  const v: any = lastJson(prose, (x: any) => Array.isArray(x?.nodes));
  assert(v?.nodes?.[0]?.args?.expression === "2+2", JSON.stringify(v));
  const p = parsePlan("We can compute manually. values: [] so no need.", none);
  assert(!p.ok && p.errors[0].startsWith("no JSON plan"), JSON.stringify(p));
  assert(parsePlan('{"nodes":[]}', none).ok, "explicit empty plan");
  const cut = parsePlan('{"nodes":[{"id":"n1","tool":"calculate","args":{"expression":"2+2"}}', none);
  assert(cut.ok && cut.plan!.nodes.length === 1, JSON.stringify(cut));
});
