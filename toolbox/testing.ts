// Functional testing of the workspace app, and the build gate that keeps an
// agent working until the app is clean and tested.
//
// Tests run in the user's browser, in a hidden sandboxed copy of the preview:
// the router queues a job in KV (app_test), the dashboard picks it up while a
// chat turn or the workspace is open (app_runner take), runs every case in a
// fresh frame and posts the results back (app_runner done). Two kinds:
//
//   UI cases    tests/**/*.test.json — { name, page?, steps: [...] }: click,
//               type, press, select, check, wait, wait_for, expect, eval.
//   unit tests  **/*.test.{js,ts,jsx,tsx} — test()/it()/describe(), expect(),
//               assert(), imported as modules next to the app's own code.

import { store } from "./store.ts";
import { text, truncate, ulid } from "./util.ts";
import { checkProject } from "./check.ts";
import { allManifests, type Manifest, readAll, workspaceSig } from "./files.ts";
import { latestReport } from "./project.ts";
import type { Json, ToolCaps, ToolSpec } from "./types.ts";

type S = ReturnType<typeof store>;
const live = (all: Manifest[]) => all.filter((m) => !/(^|\/)\.gitkeep$/.test(m.path));

export const UI_TEST = /\.test\.json$/i;
export const UNIT_TEST = /\.test\.(m?js|jsx|tsx?)$/i;
const ACTIONS = ["click", "dblclick", "type", "press", "select", "check", "wait", "wait_for", "expect", "eval"] as const;

export interface UiCase { kind: "ui"; name: string; page?: string; steps: Json[]; source?: string }
export interface UnitCase { kind: "unit"; name: string; files: string[] }
export type TestCase = UiCase | UnitCase;
export interface TestJob { id: string; sig: string; at: number; taken?: number; timeout_ms: number; cases: TestCase[] }
export interface TestSummary { sig: string; at: number; passed: number; failed: number; failures: string[] }

const RUNNER_FRESH_MS = 10_000;
export async function runnerAlive(s: S, caps?: ToolCaps): Promise<boolean> {
  if (caps?.runner) return true;
  const hb = await s.get<{ at: number }>(["app", "runner"]);
  return Boolean(hb && Date.now() - hb.at < RUNNER_FRESH_MS);
}

function checkSteps(steps: unknown, where: string): Json[] {
  if (!Array.isArray(steps) || !steps.length) throw new Error(`${where}: steps must be a non-empty array`);
  return steps.map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: step ${i + 1} must be an object`);
    const acts = ACTIONS.filter((a) => a in (raw as Json));
    if (acts.length !== 1) throw new Error(`${where}: step ${i + 1} needs exactly one action of ${ACTIONS.join(", ")} (got ${JSON.stringify(raw).slice(0, 120)})`);
    return raw as Json;
  });
}

/** Cases in one *.test.json file: a case object, an array of cases, or { cases }. */
export function parseUiFile(path: string, body: string): UiCase[] {
  let j: unknown;
  try { j = JSON.parse(body); } catch (e) { throw new Error(`${path}: invalid JSON — ${(e as Error).message}`); }
  const list = Array.isArray(j) ? j : j && typeof j === "object" && Array.isArray((j as Json).cases) ? (j as Json).cases as unknown[] : [j];
  return list.map((c, i) => {
    const o = (c ?? {}) as Json;
    const name = typeof o.name === "string" && o.name ? o.name : `${path}#${i + 1}`;
    return { kind: "ui", name, ...(typeof o.page === "string" ? { page: o.page } : {}), steps: checkSteps(o.steps, `${path} › ${name}`), source: path };
  });
}

async function collectCases(s: S, all: Manifest[], args: Json): Promise<TestCase[]> {
  const cases: TestCase[] = [];
  const page = typeof args.page === "string" && args.page ? args.page : undefined;
  if (args.steps !== undefined) cases.push({ kind: "ui", name: String(args.name ?? "inline"), ...(page ? { page } : {}), steps: checkSteps(args.steps, "steps") });
  const files = typeof args.file === "string" && args.file ? [args.file.replace(/^\/+/, "")] : args.all === true || !cases.length ? all.map((m) => m.path).filter((p) => UI_TEST.test(p) || UNIT_TEST.test(p)) : [];
  const unit: string[] = [];
  for (const f of files) {
    const m = all.find((x) => x.path === f);
    if (!m) throw new Error(`no such test file: ${f}`);
    if (UI_TEST.test(f)) cases.push(...parseUiFile(f, text(await readAll(s, m))).map((c) => page && !c.page ? { ...c, page } : c));
    else if (UNIT_TEST.test(f)) unit.push(f);
    else throw new Error(`${f} is not a test file (*.test.json for UI steps, *.test.js|ts|jsx|tsx for unit tests)`);
  }
  if (unit.length) cases.push({ kind: "unit", name: "unit tests", files: unit });
  return cases;
}

interface CaseResult { name: string; kind: string; ok: boolean; ms?: number; failure?: Json; errors?: Json[]; tests?: Json[]; skipped?: string }

function summarize(results: CaseResult[]): { passed: number; failed: number; failures: string[] } {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  for (const r of results) {
    if (r.kind === "unit" && Array.isArray(r.tests)) {
      for (const t of r.tests) { if (t.ok) passed++; else { failed++; failures.push(`${t.name}: ${truncate(String(t.message ?? "failed"), 200)}`); } }
      if (!r.ok && !r.tests.some((t) => !t.ok)) { failed++; failures.push(`${r.name}: ${truncate(String(r.failure?.message ?? r.errors?.[0]?.message ?? "failed"), 200)}`); }
      continue;
    }
    if (r.ok) passed++;
    else { failed++; failures.push(`${r.name}: ${truncate(String(r.failure?.message ?? r.errors?.[0]?.message ?? "failed"), 200)}`); }
  }
  return { passed, failed, failures };
}

/** KV values cap at 64 KiB: shed page snapshots first, then detail, never the verdicts. */
function fitResult(raw: Json): Json {
  const results = (Array.isArray(raw.results) ? raw.results : []).slice(0, 60) as CaseResult[];
  const out = { results, ...(raw.error ? { error: String(raw.error).slice(0, 500) } : {}) };
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  if (size() < 60_000) return out;
  for (const r of results) if (r.failure) { delete r.failure.html; }
  if (size() < 60_000) return out;
  out.results = results.map((r) => ({
    name: truncate(String(r.name), 120), kind: r.kind, ok: r.ok, ms: r.ms,
    ...(r.failure ? { failure: { step: r.failure.step, action: r.failure.action, message: truncate(String(r.failure.message ?? ""), 400), text: truncate(String(r.failure.text ?? ""), 300) } } : {}),
    ...(r.errors?.length ? { errors: r.errors.slice(0, 3).map((e) => ({ message: truncate(String(e.message ?? ""), 300), path: e.path, line: e.line })) } : {}),
    ...(r.tests ? { tests: r.tests.slice(0, 80).map((t) => ({ name: truncate(String(t.name), 120), ok: t.ok, ...(t.ok ? {} : { message: truncate(String(t.message ?? ""), 300) }) })) } : {}),
  }));
  return out;
}

export async function latestTests(s: S): Promise<TestSummary | null> {
  return await s.get<TestSummary>(["app", "tests"]);
}

export const testingTools: ToolSpec[] = [
  {
    name: "app_test",
    kind: "files",
    aliases: ["test_app_ui", "run_tests", "e2e_test", "ui_test", "run_app_tests"],
    timeoutMs: 75_000,
    description:
      "Open the workspace app in a fresh hidden browser preview and test it. UI cases are step lists; each step is one action: {click: css} {dblclick: css} {type: css, text, clear?} {press: key, on?: css} {select: css, value} {check: css, value?: bool} {wait: ms} {wait_for: css, timeout_ms?} {expect: css, text?: substring, equals?, count?, visible?, value?, exists?: bool, timeout_ms?} {eval: js expression, equals?} — expect and wait_for retry until they pass (default 2 s). A case fails on the first failing step or on any uncaught error, and reports the step, the message and the page HTML/text at that moment. Pass `steps` inline, `file` for one test file, or `all: true` for every tests file in the workspace: *.test.json (UI cases: {name, page?, steps} or an array) and *.test.js|ts|jsx|tsx unit tests using test()/it()/describe(), expect(v).toBe/toEqual/toContain/toBeTruthy/toThrow/…, assert(). Write tests as files so they can be rerun after every fix.",
    parameters: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "object" }, description: "Inline UI case." },
        name: { type: "string", description: "Name for the inline case." },
        page: { type: "string", description: "Page to open (default: the preview's entry point)." },
        file: { type: "string", description: "One test file." },
        all: { type: "boolean", description: "Run every test file in the workspace (the default when nothing else is given)." },
        timeout_ms: { type: "integer", minimum: 5000, maximum: 60000, default: 30000 },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const all = live(await allManifests(s));
      if (!all.length) throw new Error("workspace is empty — build the app first");
      const cases = await collectCases(s, all, args);
      if (!cases.length) throw new Error('no tests found — write tests/<flow>.test.json ({"name": "...", "steps": [{"click": "#add"}, {"expect": "#count", "text": "1"}]}) or a *.test.js unit test, or pass steps inline');
      const sig = await workspaceSig(s, all);
      const timeout = Math.max(5000, Math.min(60000, Number(args.timeout_ms ?? 30000)));
      const job: TestJob = { id: ulid(), sig, at: Date.now(), timeout_ms: timeout, cases };
      await s.put(["app", "jobs", job.id], job, 120_000);
      const deadline = Math.min(ctx.deadlineMs - 1000, performance.now() + timeout + 4000);
      let result: { results?: CaseResult[]; error?: string } | null = null;
      while (!result && performance.now() < deadline && !ctx.signal.aborted) {
        await new Promise((r) => setTimeout(r, 300));
        result = await s.get(["app", "result", job.id]);
        // Nobody picked the job up within a few seconds: no dashboard is running tests.
        if (!result && performance.now() > deadline - timeout && !(await s.get<TestJob>(["app", "jobs", job.id]))?.taken && !(await runnerAlive(s, ctx.caps))) break;
      }
      if (!result) {
        await s.del(["app", "jobs", job.id]);
        return { ok: false, status: "no_runner", cases: cases.length, message: "No browser picked up the test run: tests execute in the dashboard's hidden preview, which runs while a chat reply is streaming or the workspace panel is open. Static checks (ws_check) still apply." };
      }
      if (result.error) return { ok: false, status: "runner_error", message: result.error };
      const results = result.results ?? [];
      const sum = summarize(results);
      const summary: TestSummary = { sig, at: Date.now(), ...sum, failures: sum.failures.slice(0, 20) };
      await s.put(["app", "tests"], summary, 86_400_000);
      return { ok: sum.failed === 0, status: "ran", sig, passed: sum.passed, failed: sum.failed, results };
    },
  },
  {
    name: "app_runner",
    kind: "files",
    admin: true,
    timeoutMs: 30_000,
    description: "Internal: the dashboard takes queued app_test jobs (op=take, also a liveness heartbeat) and returns their results (op=done). take long-polls: with wait_ms it holds server-side until a job appears instead of making the dashboard hammer the endpoint.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["take", "done"] },
        id: { type: "string" },
        result: { type: "object" },
        wait_ms: { type: "integer", minimum: 0, maximum: 25000, description: "take only: hold the call this long waiting for a job to appear." },
      },
      required: ["op"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      if (args.op === "take") {
        await s.put(["app", "runner"], { at: Date.now() }, 60_000);
        // Long-poll: check the queue, then wait server-side and re-check,
        // so one held request replaces dozens of empty dashboard polls.
        const waitMs = Math.max(0, Math.min(25_000, Number(args.wait_ms ?? 0)));
        const until = performance.now() + waitMs;
        for (;;) {
          // Oldest untaken first; concurrent agents each queue their own job.
          const job = (await s.list<TestJob>(["app", "jobs"], { limit: 20 })).map((r) => r.value).filter((j) => j && !j.taken).sort((a, b) => a.at - b.at)[0];
          if (job) {
            job.taken = Date.now();
            await s.put(["app", "jobs", job.id], job, 120_000);
            return { job };
          }
          if (performance.now() >= until || ctx.signal.aborted) return { job: null };
          await new Promise((r) => setTimeout(r, 750));
        }
      }
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const raw = (args.result ?? {}) as Json;
      await s.put(["app", "result", id], fitResult(raw), 300_000);
      await s.del(["app", "jobs", id]);
      return { stored: true };
    },
  },
];

export interface GateVerdict { done: boolean; message?: string; summary: Json }

/**
 * Is the workspace build finished? In order: static errors, runtime errors of
 * the current files, failing tests, then — when a browser can run them — no
 * passing test run against the current files. The first unmet condition
 * becomes the next instruction to the agent.
 */
export async function buildGate(caps: ToolCaps, opts: { startSig: string; force?: boolean; tests?: boolean; waitRuntimeMs?: number; signal?: AbortSignal }): Promise<GateVerdict> {
  const s = store(caps);
  const all = live(await allManifests(s));
  if (!all.length) return { done: true, summary: { reason: "empty" } };
  const sig = await workspaceSig(s, all);
  if (sig === opts.startSig && !opts.force) return { done: true, summary: { reason: "unchanged" } };
  const files = new Map<string, string | null>();
  await Promise.all(all.map(async (m) => files.set(m.path, m.binary || m.bytes > 512 * 1024 ? null : text(await readAll(s, m)))));
  const check = await checkProject(files, { semantic: true });
  const staticErrors = check.diagnostics.filter((d) => d.severity === "error");
  const runner = await runnerAlive(s, caps);
  let report = await latestReport(s);
  if (runner && opts.waitRuntimeMs) {
    const until = performance.now() + opts.waitRuntimeMs;
    while (report?.sig !== sig && performance.now() < until && !opts.signal?.aborted) {
      await new Promise((r) => setTimeout(r, 300));
      report = await latestReport(s);
    }
  }
  const runtime = report?.sig === sig ? report.errors : [];
  const tests = await latestTests(s);
  const testsCurrent = tests?.sig === sig ? tests : null;
  const hasTests = all.some((m) => UI_TEST.test(m.path) || UNIT_TEST.test(m.path));
  const summary: Json = { static_errors: staticErrors.length, runtime_errors: runtime.length, runner, tests: testsCurrent ? { passed: testsCurrent.passed, failed: testsCurrent.failed } : null, has_tests: hasTests };
  const loc = (p?: string, l?: number, c?: number) => p ? `${p}${l ? `:${l}${c ? `:${c}` : ""}` : ""} ` : "";
  const head = "[build gate] The build is not finished.";
  const tail = "Fix the causes (fs_read/fs_grep, then fs_patch with expect_sha256), then call app_debug with wait_ms and app_test {all: true}. Independent fixes can run in parallel with agent_team. Answer only when everything passes.";
  if (staticErrors.length || runtime.length) {
    return {
      done: false,
      summary,
      message: [
        head,
        ...(staticErrors.length ? [`Static errors (${staticErrors.length}):`, ...staticErrors.slice(0, 15).map((d) => `- ${loc(d.path, d.line, d.col)}${d.message}`)] : []),
        ...(runtime.length ? [`Runtime errors in the live preview (${runtime.length}):`, ...runtime.slice(0, 10).map((e) => `- ${loc(e.path, e.line, e.col)}${e.message}`)] : []),
        tail,
      ].join("\n"),
    };
  }
  if (testsCurrent && testsCurrent.failed > 0) {
    return { done: false, summary, message: [head, `Tests failing against the current files (${testsCurrent.failed} failed, ${testsCurrent.passed} passed):`, ...testsCurrent.failures.slice(0, 12).map((f) => `- ${f}`), "Decide for each whether the app or the test is wrong, fix it, and rerun app_test {all: true}. Answer only when everything passes."].join("\n") };
  }
  if (runner && !testsCurrent && opts.tests !== false) {
    return {
      done: false,
      summary,
      message: [
        "[build gate] The build is clean, but the app has not been opened and tested since the last change.",
        hasTests
          ? "Run app_test {all: true} and fix whatever fails."
          : "Write tests that exercise what the user asked for: tests/<flow>.test.json UI cases ({\"name\", \"steps\": [{\"click\": css}, {\"type\": css, \"text\"}, {\"expect\": css, \"text\"}]}) for each user-visible flow, plus *.test.js unit tests for non-trivial logic. A tester sub-agent (agent_team) can write them while you review. Then run app_test {all: true} and fix whatever fails.",
        "Answer only when the tests pass.",
      ].join("\n"),
    };
  }
  return { done: true, summary };
}
