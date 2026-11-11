// deno-lint-ignore-file no-explicit-any
/**
 * ASCK-L learning loop — proof tests.
 *
 * The unit tests pin the mechanisms (classifier, reward provenance,
 * shrinkage, VOI gate, lesson pruning). The simulation tests are the
 * spec's proof obligations, run against seeded synthetic arms whose true
 * rewards are known, so every claim is measured rather than asserted:
 *
 *   - Thompson choice over contextual Beta posteriors has sublinear
 *     cumulative regret (fitted exponent < 1), while a non-learning
 *     policy's regret fits an exponent of ~1.
 *   - Empirical-Bayes shrinkage beats unpooled estimation on sparse
 *     cells (lower MSE against known truth).
 *   - After an abrupt drift, the discounted posterior recovers within a
 *     bounded number of pulls.
 *   - VOI escalation fires only when variance is high AND a verifier
 *     exists for the class.
 *   - Lesson pruning removes zero-effect lessons and keeps effective
 *     ones.
 *   - IPS and doubly-robust estimators are unbiased on a known logging
 *     policy.
 *
 * All simulations use mulberry32 seeds: they are deterministic.
 */
import {
  armsForClass,
  betaMean,
  calibrationBuckets,
  chooseThompson,
  classifyTask,
  decideCompute,
  DEFAULT_STRATEGY_ARMS,
  discountCell,
  drEstimate,
  effectivePosterior,
  emptyCell,
  estimateShrinkageKappa,
  evaluateArmPolicies,
  fitRegretExponent,
  gradeReward,
  ipsEstimate,
  mulberry32,
  observeCell,
  posteriorLowerBound,
  pruneCells,
  rankLessons,
  regretCurve,
  rewardPerExtraToken,
  shouldPruneLesson,
  TASK_CLASSES,
  thompsonPropensity,
  type BetaCell,
  type DecisionLog,
  type DecisionRecord,
  type Lesson,
} from "../learning.ts";
import { app } from "../main.ts";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 1. Task context
// ---------------------------------------------------------------------------

Deno.test("classifier: stable small class set, deterministic rules", () => {
  assert(TASK_CLASSES.length <= 12, `class budget exceeded: ${TASK_CLASSES.length}`);
  const cls = (input: Parameters<typeof classifyTask>[0]) => classifyTask(input).taskClass;
  const msg = (content: unknown) => [{ role: "user", content }];

  assert(cls({ messages: msg([{ type: "text", text: "what is this?" }, { type: "image_url", url: "x" }]) }) === "vision", "image part -> vision");
  assert(cls({ messages: msg("```ts\nconst x = 1;\n```") }) === "code", "code fence -> code");
  assert(cls({ messages: msg("the function should return an error when the api endpoint fails to compile") }) === "code", "code tokens -> code");
  assert(cls({ messages: msg("please search the web for today's headlines") }) === "tool", "tool intent -> tool");
  assert(cls({ messages: msg("What is 17 * 3?") }) === "math", "arithmetic -> math");
  assert(cls({ messages: msg("give me the data"), responseFormat: { type: "json_object" } }) === "json", "json_object format -> json");
  assert(cls({ messages: msg("prove the theorem step by step and deduce the conclusion") }) === "reasoning", "proof language -> reasoning");
  assert(cls({ messages: msg("summarize this article for me") }) === "summarize", "summarize intent");
  assert(cls({ messages: msg("write a poem about the sea") }) === "creative", "creative intent");
  assert(cls({ messages: msg("hola, gracias por la ayuda, el problema es una cosa seria") }) === "multilingual", "spanish -> multilingual");
  assert(cls({ messages: msg("the quick brown fox jumps over the lazy dog. ".repeat(60)) }) === "longform", "long prose -> longform");
  assert(cls({ messages: msg("What is the capital of France?") }) === "qa", "factual question -> qa");
  assert(cls({ messages: msg("hello there") }) === "chat", "greeting -> chat");

  // Deterministic: same input, same class, every time.
  const a = classifyTask({ messages: msg("What is 17 * 3?") });
  const b = classifyTask({ messages: msg("What is 17 * 3?") });
  assert(a.taskClass === b.taskClass && a.features.mathTokens === b.features.mathTokens, "classifier must be deterministic");
});

// ---------------------------------------------------------------------------
// 2. Graded reward with provenance
// ---------------------------------------------------------------------------

Deno.test("gradeReward: the generator never grades itself", () => {
  // A self-evaluation is rejected outright.
  assert(gradeReward([{ kind: "self_eval", value: 1, source: "user" }], {}) === null, "self_eval must be rejected");
  // A signal sourced from the tuple being graded is rejected.
  assert(
    gradeReward([{ kind: "completion", value: 1, source: "tuple-9" }], { tupleId: "tuple-9" }) === null,
    "tuple-sourced grade must be rejected",
  );
  // A verifier-kind signal without verifier provenance is rejected.
  assert(
    gradeReward([{ kind: "verifier_math", value: 1, source: "tuple-9" }], { tupleId: "other" }) === null,
    "verifier grade without verifier provenance must be rejected",
  );
  // Non-finite values are rejected, valid ones are a weighted mean in [0,1].
  const g = gradeReward([
    { kind: "verifier_math", value: 1, source: "verifier:calculate", weight: 1.5 },
    { kind: "completion", value: 0.5, source: "router" },
    { kind: "completion", value: Number.NaN, source: "router" },
  ], { tupleId: "tuple-1", armId: "baseline" });
  assert(g !== null && near(g.reward, 0.8, 1e-9), `weighted mean ${g?.reward}`);
  assert(g!.rejected.length === 1, "exactly the NaN signal is rejected");
  const clamped = gradeReward([{ kind: "completion", value: 7, source: "router" }], {});
  assert(clamped?.reward === 1, "values clamp to [0,1]");
});

// ---------------------------------------------------------------------------
// 3. Contextual posterior: shrinkage, discounting, bounded growth
// ---------------------------------------------------------------------------

Deno.test("shrinkage beats unpooled estimation on sparse cells (known truth)", () => {
  const truth = [0.45, 0.5, 0.55, 0.58, 0.6, 0.62, 0.65, 0.7, 0.72, 0.75];
  const trials = 4;
  const reps = 400;
  let mseUnpooled = 0;
  let mseShrunk = 0;
  for (let rep = 0; rep < reps; rep++) {
    const rng = mulberry32(10_000 + rep);
    const samples = truth.map((p) => {
      let s = 0;
      for (let i = 0; i < trials; i++) if (rng() < p) s++;
      return { successes: s, trials };
    });
    const totalS = samples.reduce((a, x) => a + x.successes, 0);
    const totalN = samples.reduce((a, x) => a + x.trials, 0);
    const global = { alpha: 1 + totalS, beta: 1 + (totalN - totalS) };
    const kappa = estimateShrinkageKappa(samples, 8);
    samples.forEach((s, i) => {
      const cell: BetaCell = { alpha: 1 + s.successes, beta: 1 + (s.trials - s.successes), pulls: s.trials, rewardSum: s.successes, lastAt: 0 };
      const unpooled = betaMean(cell.alpha, cell.beta);
      const eff = effectivePosterior(cell, global, kappa);
      const shrunk = betaMean(eff.alpha, eff.beta);
      mseUnpooled += (unpooled - truth[i]) ** 2;
      mseShrunk += (shrunk - truth[i]) ** 2;
    });
  }
  const n = reps * truth.length;
  mseUnpooled /= n;
  mseShrunk /= n;
  console.log(`    shrinkage MSE ${mseShrunk.toFixed(5)} vs unpooled MSE ${mseUnpooled.toFixed(5)}`);
  assert(mseShrunk < mseUnpooled, `shrinkage must win on sparse cells: ${mseShrunk} !< ${mseUnpooled}`);
});

Deno.test("posterior mechanics: discounting forgets, cells stay bounded", () => {
  const now = 1_700_000_000_000;
  let cell = emptyCell();
  for (let i = 0; i < 40; i++) cell = observeCell(cell, 1, now);
  assert(betaMean(cell.alpha, cell.beta) > 0.95, "40 wins -> mean near 1");
  const dayLater = discountCell(cell, now + 24 * 3_600_000);
  assert(dayLater.alpha + dayLater.beta < cell.alpha + cell.beta, "a day of drift shrinks the evidence mass");
  assert(dayLater.alpha > 1 && dayLater.beta >= 1, "discounting decays toward the prior, never below it");

  const cells = Array.from({ length: 50 }, (_, i) => ({ ...emptyCell(), pulls: i, lastAt: now - i * 86_400_000 }));
  const kept = pruneCells(cells, 10, now);
  assert(kept.length === 10 && kept.every((c) => cells.includes(c)), "pruneCells caps and keeps real cells");
  assert(kept[0].pulls >= kept[kept.length - 1].pulls, "pruneCells keeps the most-evidenced cells first");
});

// ---------------------------------------------------------------------------
// 4/5. Bandit choice, exploration floor, regret
// ---------------------------------------------------------------------------

function banditSim(opts: {
  means: number[];
  steps: number;
  seed: number;
  driftAt?: number;
  driftedMeans?: number[];
  stepMs?: number;
}): { records: DecisionRecord[]; choices: string[]; shortfall: Array<{ t: number; regret: number }> } {
  const rng = mulberry32(opts.seed);
  const ids = opts.means.map((_, i) => `arm${i}`);
  const cells = opts.means.map(() => emptyCell());
  const records: DecisionRecord[] = [];
  const choices: string[] = [];
  const shortfall: Array<{ t: number; regret: number }> = [];
  let acc = 0;
  const stepMs = opts.stepMs ?? 0;
  for (let t = 0; t < opts.steps; t++) {
    const now = t * stepMs;
    const means = opts.driftAt !== undefined && t >= opts.driftAt ? opts.driftedMeans! : opts.means;
    const cands = cells.map((c, i) => {
      const d = stepMs > 0 ? discountCell(c, now) : c;
      return { id: ids[i], alpha: d.alpha, beta: d.beta, pulls: c.pulls };
    });
    const choice = chooseThompson(cands, rng, { epsilon: 0.05, resamples: 48 })!;
    const idx = ids.indexOf(choice.id);
    // Expected regret uses the KNOWN arm means: realized Bernoulli rewards
    // would charge even an oracle policy ~oracle*(1-oracle) per pull of
    // pure noise, which swamps the learning signal being measured.
    acc += Math.max(...means) - means[idx];
    shortfall.push({ t: t + 1, regret: Number(acc.toFixed(3)) });
    const reward = rng() < means[idx] ? 1 : 0;
    cells[idx] = observeCell(cells[idx], reward, now);
    choices.push(choice.id);
    records.push({
      traceId: `sim-${t}`,
      ts: t,
      taskClass: "qa",
      action: choice.id,
      tupleId: choice.id,
      propensity: choice.propensity,
      reward,
      expectedReward: betaMean(cands[idx].alpha, cands[idx].beta),
      computeMode: "single",
      lessonIds: [],
    });
  }
  return { records, choices, shortfall };
}

Deno.test("simulation: cumulative regret is sublinear under Thompson choice", () => {
  const { shortfall } = banditSim({ means: [0.8, 0.5], steps: 3000, seed: 42 });
  const sampled = shortfall.filter((_, i) => i % 25 === 0 || i === shortfall.length - 1);
  const exponent = fitRegretExponent(sampled);
  const total = shortfall[shortfall.length - 1].regret;
  console.log(`    expected regret after 3000 pulls: ${total.toFixed(1)} (fitted exponent ${exponent})`);
  assert(exponent < 1, `regret exponent must be sublinear, got ${exponent}`);
  assert(total < 150, `total expected regret ${total} should be a small fraction of 3000 pulls`);

  // Contrast: a policy that never learns (alternating blindly between the
  // same two arms) accrues regret linearly, and the fitter must say so —
  // otherwise the exponent proves nothing.
  const blind = Array.from({ length: 500 }, (_, t) => ({ t: t + 1, regret: 0.15 * (t + 1) }));
  const blindExponent = fitRegretExponent(blind);
  assert(blindExponent > 0.9, `non-learning regret must fit ~linear, got ${blindExponent}`);

  // regretCurve itself: sums the per-decision shortfall against the oracle.
  const recs: DecisionRecord[] = [1, 0, 0.5].map((reward, i) => ({
    traceId: `rc-${i}`,
    ts: i,
    taskClass: "qa",
    action: "arm0",
    tupleId: "arm0",
    propensity: 1,
    reward,
    computeMode: "single",
    lessonIds: [],
  }));
  const curve = regretCurve(recs, () => 0.8);
  assert(near(curve[2].regret, 0 + 0.8 + 0.3, 1e-9), `regretCurve sums shortfalls: ${JSON.stringify(curve)}`);
});

Deno.test("simulation: the router recovers within bounded pulls after abrupt drift", () => {
  const { choices } = banditSim({
    means: [0.85, 0.15],
    driftAt: 1000,
    driftedMeans: [0.15, 0.85],
    steps: 1600,
    seed: 7,
    stepMs: 600_000, // 10 simulated minutes per pull; 6 h half-life forgetting
  });
  const window = choices.slice(1450, 1600);
  const recoveredShare = window.filter((id) => id === "arm1").length / window.length;
  console.log(`    post-drift share of the new best arm (pulls 1450-1600): ${recoveredShare.toFixed(2)}`);
  assert(recoveredShare >= 0.6, `router must recover after drift; new-best share ${recoveredShare}`);
});

Deno.test("exploration floor: no arm starves, propensities are logged honestly", () => {
  const rng = mulberry32(99);
  const cands = [
    { id: "dominant", alpha: 300, beta: 2, pulls: 500 },
    { id: "starved", alpha: 1, beta: 1, pulls: 0 },
  ];
  let floorPicks = 0;
  for (let i = 0; i < 400; i++) {
    const choice = chooseThompson(cands, rng, { epsilon: 0.05, resamples: 48 })!;
    assert(choice.propensity >= 1e-4 && choice.propensity <= 1, `propensity in range: ${choice.propensity}`);
    if (choice.id === "starved") floorPicks++;
  }
  assert(floorPicks > 0, "the least-pulled arm must be reached through the floor");
  const p = thompsonPropensity(cands, "dominant", mulberry32(5));
  assert(p > 0.9 && p <= 1, `dominant arm propensity ${p}`);
});

// ---------------------------------------------------------------------------
// 5 (cont). Compute allocation by value of information
// ---------------------------------------------------------------------------

Deno.test("VOI: escalation fires only when variance is high AND a verifier exists", () => {
  const highVar = { alpha: 2, beta: 2 }; // variance 0.05
  const lowVar = { alpha: 60, beta: 40 }; // variance ~0.0024
  const base = { taskClass: "math" as const, hasVerifier: true, armCompute: "single" as const };
  assert(decideCompute({ ...base, ...highVar }).mode === "verify_retry", "high variance + verifier -> verify loop");
  assert(decideCompute({ ...base, ...highVar, armCompute: "best_of_n" }).mode === "best_of_n", "best-of-n arm + high variance -> best-of-n");
  assert(decideCompute({ ...base, ...highVar, hasVerifier: false }).mode === "single", "no verifier -> never escalate");
  assert(decideCompute({ ...base, ...highVar, hasVerifier: false, armCompute: "best_of_n" }).mode === "single", "no verifier -> never escalate, even for best-of-n arms");
  assert(decideCompute({ ...base, ...lowVar }).mode === "single", "confident posterior -> single-shot");
  assert(decideCompute({ ...base, ...lowVar, armCompute: "verify_retry" }).mode === "verify_retry", "an arm may still request the verify loop");
  assert(decideCompute({ ...base, ...highVar, stream: true }).mode === "single", "streams never escalate");

  // Arms gated by verifier availability at selection time, not just at
  // compute-decision time.
  const withVerifier = armsForClass(DEFAULT_STRATEGY_ARMS, "math", true).map((a) => a.id);
  const without = armsForClass(DEFAULT_STRATEGY_ARMS, "chat", false).map((a) => a.id);
  assert(withVerifier.includes("best_of") && withVerifier.includes("verify"), "verifier classes see the compute arms");
  assert(!without.includes("best_of") && !without.includes("verify"), "verifier-less classes are single-shot only");
});

// ---------------------------------------------------------------------------
// 6. Lesson memory with efficacy tracking
// ---------------------------------------------------------------------------

Deno.test("lessons: zero-effect lessons are pruned, effective ones are kept", () => {
  const rng = mulberry32(1234);
  const mk = (id: string, p: number): Lesson => {
    let cell: BetaCell = emptyCell();
    for (let i = 0; i < 30; i++) cell = observeCell(cell, rng() < p ? 1 : 0, 1000);
    return { ...cell, id, taskClass: "math", failureSignature: "verifier_math:mismatch", correction: "recompute", createdAt: 0, pruned: false };
  };
  const zeroEffect = mk("zero", 0.3);
  const effective = mk("good", 0.85);
  console.log(`    lesson means: zero-effect ${betaMean(zeroEffect.alpha, zeroEffect.beta).toFixed(2)}, effective ${betaMean(effective.alpha, effective.beta).toFixed(2)}`);
  assert(shouldPruneLesson(zeroEffect), "a lesson whose decisions keep failing must be pruned");
  assert(!shouldPruneLesson(effective), "an effective lesson must be kept");

  // Not before a fair trial, and never twice.
  const young: Lesson = { ...zeroEffect, pulls: 5 };
  assert(!shouldPruneLesson(young), "no pruning before 10 injections");
  assert(!shouldPruneLesson({ ...zeroEffect, pruned: true }), "already-pruned lessons are left alone");

  const ranked = rankLessons([zeroEffect, effective], "math", 2, mulberry32(3), true);
  assert(ranked[0].id === "good", "ranking prefers the lesson with proven efficacy");
  assert(rankLessons([zeroEffect, effective], "code", 2, mulberry32(3), true).length === 0, "lessons are class-scoped");
});

// ---------------------------------------------------------------------------
// 7. Off-policy evaluation
// ---------------------------------------------------------------------------

Deno.test("off-policy: IPS and DR are unbiased on a known logging policy", () => {
  const rng = mulberry32(2024);
  const trueMean: Record<string, number> = { A: 0.6, B: 0.3 };
  const logs: DecisionLog[] = Array.from({ length: 20_000 }, () => {
    const action = rng() < 0.7 ? "A" : "B";
    return {
      taskClass: "qa",
      action,
      propensity: action === "A" ? 0.7 : 0.3,
      reward: rng() < trueMean[action] ? 1 : 0,
    };
  });
  const alwaysA = (log: DecisionLog) => (log.action === "A" ? 1 : 0);
  const ips = ipsEstimate(logs, alwaysA);
  const q = (action: string) => {
    const mine = logs.filter((l) => l.action === action);
    return mine.reduce((a, l) => a + l.reward, 0) / mine.length;
  };
  const dr = drEstimate(logs, alwaysA, (log) => q(log.action), () => q("A"));
  console.log(`    IPS ${ips.estimate} (ESS ${ips.effectiveSampleSize}), DR ${dr.estimate}; truth 0.6`);
  assert(near(ips.estimate, 0.6, 0.03), `IPS must be unbiased: ${ips.estimate}`);
  assert(near(dr.estimate, 0.6, 0.03), `DR must be unbiased: ${dr.estimate}`);
  assert(ips.effectiveSampleSize > 1000, "ESS should stay healthy under a 0.7/0.3 logging policy");

  const perArm = evaluateArmPolicies(logs);
  assert(perArm[0].arm === "A" && near(perArm[0].dr, 0.6, 0.05), `per-arm DR ranks A first: ${JSON.stringify(perArm[0])}`);
  assert(near(perArm.find((x) => x.arm === "B")!.dr, 0.3, 0.05), "per-arm DR recovers B's value too");
});

// ---------------------------------------------------------------------------
// Reporting primitives
// ---------------------------------------------------------------------------

Deno.test("reporting: calibration and reward-per-extra-token are computed from records", () => {
  const rec = (expectedReward: number, reward: number, extraTokens = 0): DecisionRecord => ({
    traceId: "t",
    ts: 0,
    taskClass: "math",
    action: "baseline",
    tupleId: "tuple-1",
    propensity: 1,
    reward,
    expectedReward,
    extraTokens,
    computeMode: extraTokens > 0 ? "verify_retry" : "single",
    lessonIds: [],
  });
  const buckets = calibrationBuckets([rec(0.9, 1), rec(0.95, 1), rec(0.1, 0)]);
  assert(buckets[4].n === 2 && buckets[4].realized === 1, "top bucket realized reward");
  assert(buckets[0].n === 1 && buckets[0].realized === 0, "bottom bucket realized reward");
  assert(rewardPerExtraToken([rec(0.5, 0.5)]) === null, "no escalations -> null, not a made-up number");
  const per = rewardPerExtraToken([rec(0.5, 0.9, 100), rec(0.5, 0.7, 100)]);
  assert(per !== null && near(per, 0.003, 1e-9), `reward per extra token ${per}`);
  assert(posteriorLowerBound(90, 10) > posteriorLowerBound(9, 1), "more evidence tightens the Wilson floor upward at equal mean");
});

// ---------------------------------------------------------------------------
// Integration: the wired loop — decisions are logged, feedback joins them,
// arms are data. Driven through the real Hono app against a mocked upstream,
// exactly like the tool-plane suite.
// ---------------------------------------------------------------------------

const itest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const realFetch = globalThis.fetch;
const API: Record<string, string> = { authorization: `Bearer ${Deno.env.get("ROUTER_API_KEY") ?? "testkey"}` };
const ADMIN: Record<string, string> = { "x-admin-secret": "adminkey" };

/** The suite shares one process across files, and dispatch_test.ts deletes
 *  ADMIN_SECRET when it finishes — so these tests pin the secret for their
 *  own duration instead of trusting the ambient environment. */
async function withAdminSecret<T>(fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get("ADMIN_SECRET");
  Deno.env.set("ADMIN_SECRET", "adminkey");
  try {
    return await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("ADMIN_SECRET");
    else Deno.env.set("ADMIN_SECRET", prev);
  }
}

function installScriptedMock(good: string, content: string) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!init || init.method !== "POST") {
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } }));
    }
    if (url !== good) {
      return Promise.resolve(new Response(JSON.stringify({ error: "dead" }), { status: 503, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      id: "mock",
      object: "chat.completion",
      created: 1,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }), { headers: { "content-type": "application/json" } }));
  }) as typeof globalThis.fetch;
}

async function getLearning(): Promise<any> {
  const res = await app.fetch(new Request("https://router.test/v1/learning", { headers: { ...API, ...ADMIN } }));
  assert(res.status === 200, `/v1/learning -> ${res.status}`);
  return await res.json() as any;
}

async function waitForDecision(taskClass: string, exclude: Set<string>, timeoutMs = 12_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const report = await getLearning();
    const found = (report.decisions?.recent ?? []).find((d: any) => d.task_class === taskClass && !exclude.has(d.trace_id));
    if (found) return found;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no fresh ${taskClass} decision logged within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

itest("learning endpoints: admin gate, report shape, arms are data, feedback 404", () => withAdminSecret(async () => {
  const denied = await app.fetch(new Request("https://router.test/v1/learning", { headers: { ...API } }));
  assert(denied.status === 403, `/v1/learning without admin secret -> ${denied.status}`);
  await denied.body?.cancel();

  const report = await getLearning();
  assert(report.engine === "asck-l-v1", `engine ${report.engine}`);
  assert(Array.isArray(report.task_classes) && report.task_classes.length === 12, "report lists the 12 task classes");
  assert(report.arms.definitions.some((a: any) => a.id === "baseline"), "baseline arm is defined");
  assert(typeof report.kappa === "number" && report.kappa >= 2, "empirical-Bayes kappa is reported");
  assert(Array.isArray(report.lessons) && Array.isArray(report.calibration), "lesson ledger + calibration present");

  const add = await app.fetch(new Request("https://router.test/v1/learning/arms", {
    method: "POST",
    headers: { "content-type": "application/json", ...API, ...ADMIN },
    body: JSON.stringify({ id: "careful_verify", label: "Verify and retry", prompt_variant: "verify", compute: "verify_retry" }),
  }));
  assert(add.status === 200, `add arm -> ${add.status}`);
  const after = await getLearning();
  assert(after.arms.definitions.some((a: any) => a.id === "careful_verify"), "an arm added over the API serves without a deploy");

  const missing = await app.fetch(new Request("https://router.test/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...API },
    body: JSON.stringify({ trace_id: "no-such-trace", signal: "thumbs_up" }),
  }));
  assert(missing.status === 404, `feedback for an unknown trace -> ${missing.status}`);
  await missing.body?.cancel();
}));

itest("a chat decision is logged with its class, and delayed feedback joins it exactly once", () => withAdminSecret(async () => {
  const ep = await app.fetch(new Request("https://router.test/v1/endpoints", { headers: { ...API } }));
  assert(ep.status === 200, `/v1/endpoints -> ${ep.status}`);
  const list = ((await ep.json()) as any).data as Array<{ url: string }>;
  const good = list[Math.floor(list.length * 0.63)]?.url ?? list[0].url;
  installScriptedMock(good, "Seventeen times three is 51.");
  try {
    // Decisions persist in KV across runs: only grade the decision THIS
    // run's chat creates, never a stale one (feedback applies exactly once).
    const before = await getLearning();
    const seenTraces = new Set<string>((before.decisions?.recent ?? []).map((d: any) => d.trace_id));
    const res = await app.fetch(new Request("https://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...API },
      body: JSON.stringify({
        model: "free:smart",
        stream: false,
        messages: [{ role: "user", content: "What is 17*3?" }],
      }),
    }));
    assert(res.status === 200, `chat -> ${res.status}`);
    const data = await res.json() as any;
    assert(data.kono?.degraded !== true, "chat must complete against the mock, not degrade");
    assert(data.choices?.[0]?.message?.content === "Seventeen times three is 51.", "mock answer comes back");

    const decision = await waitForDecision("math", seenTraces);
    assert(typeof decision.arm === "string" && decision.arm.length > 0, "decision names its strategy arm");
    assert(decision.arm_propensity >= 1e-4 && decision.arm_propensity <= 1, "arm propensity logged");
    assert(decision.tuple_propensity >= 1e-4 && decision.tuple_propensity <= 1, "tuple propensity logged");
    assert(typeof decision.reward === "number" && decision.reward >= 0 && decision.reward <= 1, "immediate graded reward logged");

    const fb = await app.fetch(new Request("https://router.test/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", ...API },
      body: JSON.stringify({ trace_id: decision.trace_id, signal: "thumbs_up" }),
    }));
    assert(fb.status === 200, `feedback -> ${fb.status}`);
    const fbData = await fb.json() as any;
    assert(fbData.applied === true && fbData.reward === 1 && fbData.task_class === "math", `feedback joins the decision: ${JSON.stringify(fbData)}`);

    const again = await app.fetch(new Request("https://router.test/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", ...API },
      body: JSON.stringify({ trace_id: decision.trace_id, signal: "thumbs_up" }),
    }));
    const againData = await again.json() as any;
    assert(againData.applied === false, "the same decision cannot be graded twice by feedback");

    const report = await getLearning();
    assert(
      report.posteriors.some((p: any) => p.task_class === "math" && p.pulls >= 1),
      "the (tuple, math) posterior moved",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}));
