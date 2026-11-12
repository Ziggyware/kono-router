// The build loop: browser test jobs (app_test ⇄ app_runner), the build gate,
// and agent_team sub-agents.

import { executeTool, type ToolExecutionOk } from "../tools.ts";
import { buildGate, parseUiFile } from "../toolbox/testing.ts";
import { workspaceSigFor } from "../toolbox/project.ts";
import type { SubagentTask } from "../toolbox/types.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
// deno-lint-ignore no-explicit-any
async function run(name: string, args: unknown, caps: Record<string, unknown>, admin = false): Promise<any> {
  const exec = await executeTool(name, args, { caps, admin });
  if (!exec.ok) throw new Error(`${name} failed: ${exec.code} ${exec.error}`);
  return (exec as ToolExecutionOk).result;
}
const ns = (p: string) => ({ namespace: `${p}_${crypto.randomUUID().slice(0, 8)}` });

Deno.test("UI test files: cases, arrays and { cases }, with step validation", () => {
  const one = parseUiFile("t/a.test.json", JSON.stringify({ name: "adds", steps: [{ click: "#add" }, { expect: "#n", text: "1" }] }));
  assert(one.length === 1 && one[0].name === "adds" && one[0].steps.length === 2, JSON.stringify(one));
  const many = parseUiFile("t/b.test.json", JSON.stringify({ cases: [{ steps: [{ wait: 1 }] }, { name: "x", page: "p.html", steps: [{ eval: "1" }] }] }));
  assert(many[0].name === "t/b.test.json#1" && many[1].page === "p.html", JSON.stringify(many));
  let threw = "";
  try { parseUiFile("t/c.test.json", JSON.stringify({ steps: [{ click: "#a", type: "#b" }] })); } catch (e) { threw = (e as Error).message; }
  assert(/exactly one action/.test(threw), threw);
  threw = "";
  try { parseUiFile("t/d.test.json", "{nope"); } catch (e) { threw = (e as Error).message; }
  assert(/invalid JSON/.test(threw), threw);
});

Deno.test("app_test: a job round-trips through the browser runner and records the outcome", async () => {
  const caps = ns("bt");
  await run("fs_write", { path: "index.html", content: "<button id=add>+</button><b id=n>0</b>" }, caps);
  await run("fs_write", { path: "tests/count.test.json", content: JSON.stringify({ name: "counts", steps: [{ click: "#add" }, { expect: "#n", text: "1" }] }) }, caps);
  await run("fs_write", { path: "src/math.test.js", content: "test('adds', () => expect(1 + 1).toBe(2));" }, caps);
  const pending = run("app_test", { all: true, timeout_ms: 8000 }, caps);
  // Simulated dashboard: take the job, report one failing UI case and passing unit tests.
  let job = null;
  for (let i = 0; i < 40 && !job; i++) { await new Promise((r) => setTimeout(r, 100)); job = (await run("app_runner", { op: "take" }, caps, true)).job; }
  assert(job && job.cases.length === 2 && job.cases[0].kind === "ui" && job.cases[1].kind === "unit" && job.cases[1].files[0] === "src/math.test.js", JSON.stringify(job));
  assert((await run("app_runner", { op: "take" }, caps, true)).job === null, "a taken job is not handed out twice");
  await run("app_runner", { op: "done", id: job.id, result: { results: [
    { name: "counts", kind: "ui", ok: false, failure: { step: 2, action: "expect", message: "#n text is \"0\"", html: "x".repeat(100_000) } },
    { name: "unit tests", kind: "unit", ok: true, tests: [{ name: "adds", ok: true }] },
  ] } }, caps, true);
  const r = await pending;
  assert(r.status === "ran" && !r.ok && r.passed === 1 && r.failed === 1, JSON.stringify(r).slice(0, 400));
  assert(r.results[0].failure.message.includes("#n text"), "failure detail survives the KV size cap");
  const gate = await buildGate(caps, { startSig: "" });
  assert(!gate.done && /Tests failing/.test(gate.message!) && /counts: #n text/.test(gate.message!), String(gate.message));
});

Deno.test("app_test: with no browser runner it says so instead of hanging", async () => {
  const caps = ns("bt_none");
  await run("fs_write", { path: "index.html", content: "<p>hi</p>" }, caps);
  const t0 = performance.now();
  const r = await run("app_test", { steps: [{ expect: "p", text: "hi" }], timeout_ms: 5000 }, caps);
  assert(r.status === "no_runner" && !r.ok && performance.now() - t0 < 9000, JSON.stringify(r));
  const empty = await executeTool("app_test", {}, { caps });
  assert(!empty.ok && /no tests found/.test(empty.error), empty.ok ? "ok" : empty.error);
});

Deno.test("build gate: static → runtime → tests → untested → done", async () => {
  const caps = ns("gate");
  const start = await workspaceSigFor(caps);
  await run("fs_write", { path: "index.html", content: '<script type="module" src="app.js"></script>' }, caps);
  await run("fs_write", { path: "app.js", content: "export const x = (;\n" }, caps);
  let g = await buildGate(caps, { startSig: start });
  assert(!g.done && /Static errors \(1\)/.test(g.message!) && /app\.js:1/.test(g.message!), String(g.message));
  await run("fs_write", { path: "app.js", content: "document.body.append('ok');\n" }, caps);
  const { sig } = await run("fs_list", {}, caps);
  await run("app_report", { sig, page: "index.html", errors: [{ message: "TypeError: boom", path: "app.js", line: 1 }] }, caps, true);
  g = await buildGate(caps, { startSig: start });
  assert(!g.done && /Runtime errors/.test(g.message!) && /app\.js:1 TypeError: boom/.test(g.message!), String(g.message));
  await run("app_report", { sig, page: "index.html", errors: [] }, caps, true);
  g = await buildGate(caps, { startSig: start });
  assert(g.done && g.summary.runner === false, "no runner: tests are not demanded");
  await run("app_runner", { op: "take" }, caps, true); // heartbeat: a browser can run tests
  g = await buildGate(caps, { startSig: start });
  assert(!g.done && /has not been opened and tested/.test(g.message!) && /Write tests/.test(g.message!), String(g.message));
  assert((await buildGate(caps, { startSig: start, tests: false })).done, "sub-agents are not held to tests");
  assert((await buildGate(caps, { startSig: sig })).done, "nothing changed this request: no gate");
});

Deno.test("agent_team: runs sub-agents concurrently, reports each, and never nests", async () => {
  const caps = ns("team");
  const started: number[] = [];
  const sub = async (t: SubagentTask) => {
    started.push(performance.now());
    await new Promise((r) => setTimeout(r, 200));
    if (t.role === "reviewer") throw new Error("upstream down");
    return { role: t.role, ok: true, content: `${t.role} did: ${t.task}`, ms: 200 };
  };
  const t0 = performance.now();
  const r = await run("agent_team", { agents: [{ role: "builder", task: "build the header component" }, { role: "tester", task: "write tests for the header" }, { role: "reviewer", task: "review header code" }] }, { ...caps, subagent: sub });
  assert(performance.now() - t0 < 550 && started.length === 3, "agents run concurrently");
  assert(r.agents === 3 && !r.ok && r.reports[0].content.startsWith("builder did") && r.reports[2].error === "upstream down", JSON.stringify(r));
  const nested = await executeTool("agent_team", { agents: [{ role: "builder", task: "build something here" }] }, { caps });
  assert(!nested.ok && /cannot start their own teams/.test(nested.error), nested.ok ? "ok" : nested.error);
});

Deno.test("app_runner take long-polls: a job queued mid-wait is handed out, an empty wait returns null", async () => {
  const caps = ns("bt_longpoll");
  await run("fs_write", { path: "index.html", content: "<p>hi</p>" }, caps);
  // Start a long-polling take, then queue a job while it is held.
  const takePromise = run("app_runner", { op: "take", wait_ms: 8000 }, caps, true);
  await new Promise((r) => setTimeout(r, 600));
  const pending = run("app_test", { steps: [{ expect: "p", text: "hi" }], timeout_ms: 8000 }, caps);
  const taken = await takePromise;
  assert(taken.job && taken.job.cases.length === 1, `long-poll should receive the queued job: ${JSON.stringify(taken).slice(0, 200)}`);
  await run("app_runner", { op: "done", id: taken.job.id, result: { results: [{ name: "inline", kind: "ui", ok: true }] } }, caps, true);
  const r = await pending;
  assert(r.status === "ran" && r.ok, JSON.stringify(r).slice(0, 200));
  // An empty long-poll waits roughly wait_ms, then returns null (not instantly).
  const t0 = performance.now();
  const empty = await run("app_runner", { op: "take", wait_ms: 1200 }, caps, true);
  const elapsed = performance.now() - t0;
  assert(empty.job === null && elapsed >= 1000 && elapsed < 5000, `empty long-poll elapsed ${Math.round(elapsed)}ms`);
});
