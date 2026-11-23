// tests/stall_test.ts — the anti-pause detector.
//
// The first case is the reported failure verbatim: the model writes a plan,
// announces "Let me write the code now.", and stops with finish_reason "stop".
// Everything after it is about not firing on answers that are actually done.
//
//   node --experimental-strip-types tests/stall_test.ts
//   deno run -A tests/stall_test.ts

import {
  detectStall,
  maxStallContinuations,
  nextStallTurn,
  stallNudge,
  stallSummary,
  wantsArtifactRequest,
} from "../engine/stall.ts";

// ---------------------------------------------------------------------------
// harness (same 30 lines as tests/host_routing_test.ts)
// ---------------------------------------------------------------------------

type TestFn = () => Promise<void> | void;
interface Case {
  name: string;
  fn: TestFn;
}
const cases: Case[] = [];
const test = (name: string, fn: TestFn): void => {
  cases.push({ name, fn });
};
function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
function expectEqual(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? `${msg}: ` : ""}expected ${e}, got ${a}`);
}
async function run(): Promise<number> {
  let passed = 0;
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`ok   ${c.name}`);
    } catch (e) {
      failed.push(c.name);
      console.log(`FAIL ${c.name}\n     ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  return failed.length;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** The exact shape the user reported. */
const PAUSED_PLAN = [
  "Let me build:",
  "",
  "- HTML5 Canvas",
  "- Fresnel lens phase mask (concentric rings with phase wrapping)",
  "- Angular spectrum method or Fresnel integral for wave propagation",
  "- Interference between reference wave and object wave to create hologram",
  "- Reconstruction by illuminating hologram with reference wave",
  "",
  "I'll write it as a single self-contained HTML file with comments explaining the quantum mechanics connections.",
  "",
  "Let me check if there's a specific project structure I should follow. The workspace has a bot framework. But the user's request is standalone. I'll create it in the workspace as a new file, perhaps `holographic-fresnel.html` or in a `public/` or `src/` directory.",
  "",
  "Actually, let me just create `src/holographic-fresnel.ts` or an HTML file. Since the workspace seems to be a Node/TS project, maybe I should make it an HTML file that can be opened directly, or a TypeScript module.",
  "",
  "Given the preview entry is src/index.js, maybe I should integrate? No, that's a bot framework. The user's request is unrelated. I'll create a standalone demo file.",
  "",
  "Let me write a complete, single-file HTML solution with:",
  "",
  "- Canvas rendering",
  "- Quantum wave function simulation (complex numbers)",
  "- Fresnel lens phase profile",
  "",
  "I'll make it fully implemented - no TODOs, no placeholders.",
  "",
  "Let me write the code now.",
].join("\n");

const FINISHED_FILE = [
  "Here is the hologram demo.",
  "",
  "```html",
  "<!doctype html>",
  "<html><body><canvas id=c></canvas><script>",
  "const ctx = document.getElementById('c').getContext('2d');",
  "// ... 200 lines ...",
  "</script></body></html>",
  "```",
  "",
  "Open it directly in a browser; the Fresnel phase mask is drawn on the left.",
].join("\n");

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

test("the reported paused plan is a stall", () => {
  const v = detectStall(PAUSED_PLAN, { finish: "stop", hasTools: true, wantsArtifact: true });
  expect(v.stalled, `expected a stall, got ${v.kind}@${v.confidence}`);
  expect(v.confidence >= 0.85, `confidence ${v.confidence}`);
  expect(v.kind === "intent" || v.kind === "plan", `kind ${v.kind}`);
  expect(v.planOnly, "the answer is a plan with no artifact");
  expect(v.lastLine.startsWith("Let me write the code"), `last line: ${v.lastLine}`);
  expect(v.reasons.length > 0, "reasons recorded");
  expect(stallSummary(v).includes("intent") || stallSummary(v).includes("plan"), stallSummary(v));
});

test("a completed artifact is never a stall, even when it ends pleasantly", () => {
  const v = detectStall(`${FINISHED_FILE}\n\nLet me know if you want the TypeScript version.`, {
    finish: "stop",
    hasTools: true,
    wantsArtifact: true,
  });
  expect(!v.stalled, `expected no stall, got ${v.kind}@${v.confidence} (${v.reasons.join("; ")})`);
});

test("a short factual answer is not a stall", () => {
  for (const text of ["Paris.", "42", "It depends on the wavelength.", "Yes — see the note above."]) {
    const v = detectStall(text, { finish: "stop" });
    expect(!v.stalled, `${JSON.stringify(text)} flagged as ${v.kind}@${v.confidence}`);
  }
});

test("a permission question with nothing delivered is a stall", () => {
  const v = detectStall("Shall I proceed with the build?", { finish: "stop" });
  expect(v.stalled, `confidence ${v.confidence}`);
  expectEqual(v.kind, "permission");
});

test("an unterminated code fence is a truncation stall", () => {
  const v = detectStall("```html\n<!doctype html>\n<div id=app>", { finish: "stop", wantsArtifact: true });
  expect(v.stalled, "expected a stall");
  expectEqual(v.kind, "truncated");
  expect(v.unterminatedFence, "fence flagged");
  expect(v.confidence >= 0.9, `confidence ${v.confidence}`);
});

test("finish_reason length is a truncation stall with no other signal", () => {
  const v = detectStall("The resulting interference pattern has", { finish: "length" });
  expect(v.stalled, "expected a stall");
  expectEqual(v.kind, "truncated");
});

test("a long tutorial ending in a future-tense sentence is left alone", () => {
  const body = "Phase wrapping keeps the argument inside (-pi, pi], so the lens profile repeats every "
    + "wavelength of optical path difference. The reconstruction is the squared modulus of the propagated "
    + "field, which is why the twin image appears. ".repeat(6);
  const v = detectStall(`${body}\n\nNext, we'll wire the API.`, { finish: "stop" });
  expect(!v.stalled, `expected no stall, got ${v.kind}@${v.confidence} (${v.reasons.join("; ")})`);
});

test("a colon-terminated heading with nothing under it is a stall", () => {
  const v = detectStall("Here is what I'll do:", { finish: "stop" });
  expect(v.stalled, "expected a stall");
  expect(v.kind === "intent" || v.kind === "colon", `kind ${v.kind}`);
});

test("explaining is not working: 'let me explain' does not stall", () => {
  const v = detectStall("Let me explain why the twin image appears.", { finish: "stop" });
  expect(!v.stalled, `expected no stall, got ${v.kind}@${v.confidence}`);
});

// ---------------------------------------------------------------------------
// the next turn
// ---------------------------------------------------------------------------

test("the first continuation forces a tool call for an artifact request", () => {
  const v = detectStall(PAUSED_PLAN, { finish: "stop", hasTools: true, wantsArtifact: true });
  const turn = nextStallTurn(v, { continuations: 0 }, {
    hasTools: true,
    wantsArtifact: true,
    maxContinuations: 2,
  });
  expect(turn !== null, "expected a continuation");
  if (!turn) return;
  expectEqual(turn.round, 1);
  expectEqual(turn.toolChoice, "required");
  expect(turn.nudge.includes("Continue now"), turn.nudge);
  expect(turn.nudge.includes("Do not restate the plan"), turn.nudge);
  expect(turn.nudge.includes("complete artifact"), turn.nudge);
});

test("the second continuation stops forcing tools, and the budget is finite", () => {
  const v = detectStall(PAUSED_PLAN, { finish: "stop", hasTools: true, wantsArtifact: true });
  const second = nextStallTurn(v, { continuations: 1 }, {
    hasTools: true,
    wantsArtifact: true,
    maxContinuations: 2,
  });
  expect(second !== null, "expected a second continuation");
  if (!second) return;
  expectEqual(second.round, 2);
  expectEqual(second.toolChoice, undefined);
  expectEqual(
    nextStallTurn(v, { continuations: 2 }, { hasTools: true, wantsArtifact: true, maxContinuations: 2 }),
    null,
    "budget exhausted",
  );
});

test("no continuation for a finished answer, or when the feature is disabled", () => {
  const done = detectStall(FINISHED_FILE, { finish: "stop", wantsArtifact: true });
  expectEqual(nextStallTurn(done, { continuations: 0 }, { maxContinuations: 2 }), null, "finished");
  const stalled = detectStall(PAUSED_PLAN, { finish: "stop", wantsArtifact: true });
  expectEqual(nextStallTurn(stalled, { continuations: 0 }, { maxContinuations: 0 }), null, "disabled");
});

test("continuation budget defaults to 2 and clamps", () => {
  expectEqual(maxStallContinuations(), 2);
  expectEqual(maxStallContinuations(0), 0);
  expectEqual(maxStallContinuations(99), 6);
  expectEqual(maxStallContinuations(-3), 0);
});

test("artifact intent is read from the request, not the answer", () => {
  expect(wantsArtifactRequest("build me a hologram demo as a single html file"), "build");
  expect(wantsArtifactRequest("write a Rust parser for this grammar"), "write");
  expect(!wantsArtifactRequest("what is the capital of France?"), "question");
  expect(!wantsArtifactRequest("why does the twin image appear?"), "explanation");
});

test("the nudge is specific about what was said and what to do", () => {
  const v = detectStall("```ts\nexport const a = 1;", { finish: "stop", wantsArtifact: true });
  const nudge = stallNudge(v, { hasTools: true, wantsArtifact: true });
  expect(nudge.includes("cut off mid-way"), nudge);
  expect(nudge.includes("Use the tools"), nudge);
  expect(nudge.length < 600, `nudge too long: ${nudge.length}`);
});

// ---------------------------------------------------------------------------

const meta = import.meta as unknown as { main?: boolean };
const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
const isDirect = meta.main === true || argv.some((a) => a.endsWith("stall_test.ts"));
if (isDirect) {
  const failures = await run();
  if (failures > 0) throw new Error(`${failures} stall test(s) failed`);
}
