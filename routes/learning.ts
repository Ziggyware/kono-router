// routes/learning.ts — Learning route registrations extracted from main.ts.
// main.ts calls registerLearning() at the position of this area's first route, preserving registration order.

import { gradeReward, failureSignature, effectivePosterior, betaMean, posteriorLowerBound, regretCurve, fitRegretExponent, calibrationBuckets, rewardPerExtraToken, evaluateArmPolicies } from "../learning.ts";
import type { DecisionRecord, TaskClass, StrategyArm } from "../learning.ts";
import { clamp as clampNum } from "../math.ts";
import { honoApp, kv, LEARN_DECISION_PREFIX, DECISION_TTL_MS, LEARNING_CELLS, L1_CACHE, ARM_CELLS, TENANT_EVIDENCE_MIN, ARM_DEFS, LESSONS, MAX_LEARN_CELLS, LEARN_ARM_DEF_PREFIX } from "../state.ts";
import { hydrateLearning, hydrateL1Cache, learningKappa } from "../main.ts";
import type { Json, StoredDecision, PendingDecision } from "../main.ts";
import { recordLearningReward, writeLesson } from "../engine/learning.ts";
import { requireAdmin } from "../engine/core.ts";
import { logErr, tupleGlobalPosterior } from "../util.ts";


export const FEEDBACK_TTL_MS = 24 * 3_600_000;



// ---------------------------------------------------------------------------
// ASCK-L — delayed rewards and the learning report.
// POST /v1/feedback joins an explicit or implicit grade to the decision
// that produced an answer, through its trace id, inside a TTL window.
// GET /v1/learning (admin) exposes what the loop has actually learned:
// per-class posteriors, arm shares, the regret curve, calibration, the
// off-policy estimates and the lesson ledger — as data, not adjectives.
// ---------------------------------------------------------------------------

export const FEEDBACK_VALUES: Record<string, { value: number; weight: number; kind: string }> = {
  thumbs_up: { value: 1, weight: 1.5, kind: "feedback" },
  thumbs_down: { value: 0, weight: 1.5, kind: "feedback" },
  regenerate: { value: 0.15, weight: 0.6, kind: "implicit" },
  edit: { value: 0.25, weight: 0.6, kind: "implicit" },
  abandon: { value: 0.1, weight: 0.5, kind: "implicit" },
};

export function registerLearning() {


honoApp.post("/v1/feedback", async (c) => {
  const body = await c.req.json().catch(() => ({} as Json)) as Json;
  const traceId = typeof body.trace_id === "string" ? body.trace_id : "";
  const signalName = typeof body.signal === "string" ? body.signal : "";
  const spec = FEEDBACK_VALUES[signalName];
  if (!traceId || !spec) {
    return c.json({ error: { message: "expected { trace_id, signal: thumbs_up|thumbs_down|regenerate|edit|abandon }" } }, 400);
  }
  const entry = await kv.get<StoredDecision>([LEARN_DECISION_PREFIX, traceId]);
  const d = entry.value;
  if (!d) return c.json({ error: { message: "no decision recorded for that trace id" } }, 404);
  if (Date.now() - d.ts > FEEDBACK_TTL_MS) {
    return c.json({ applied: false, reason: "feedback window expired", trace_id: traceId });
  }
  if (d.feedbackApplied) {
    return c.json({ applied: false, reason: "feedback already applied", trace_id: traceId });
  }
  // The grade's source is fixed server-side ("user"): a caller cannot dress
  // a self-grade up as feedback, and the arm under test can never be the
  // source of its own reward.
  const graded = gradeReward(
    [{ kind: spec.kind, value: spec.value, weight: spec.weight, source: "user" }],
    { tupleId: d.tupleId, armId: d.action },
  );
  if (!graded) return c.json({ applied: false, reason: "signal rejected", trace_id: traceId });
  const pending: PendingDecision = {
    traceId: d.traceId,
    ts: d.ts,
    taskClass: d.taskClass,
    tupleId: d.tupleId,
    armId: d.action,
    tenant: d.tenant,
    armPropensity: d.armPropensity,
    tuplePropensity: d.tuplePropensity,
    tokens: d.tokens ?? 0,
    extraTokens: d.extraTokens ?? 0,
    expectedReward: d.expectedReward ?? 0.5,
    computeMode: d.computeMode,
    lessonIds: d.lessonIds,
  };
  await recordLearningReward(pending, graded);
  if (signalName === "thumbs_down") {
    writeLesson(d.taskClass, failureSignature("feedback", "thumbs_down")).catch(logErr);
  }
  await kv.set([LEARN_DECISION_PREFIX, traceId], { ...d, reward: graded.reward, feedbackApplied: true }, { expireIn: DECISION_TTL_MS }).catch(logErr);
  return c.json({ applied: true, trace_id: traceId, reward: graded.reward, task_class: d.taskClass, tuple: d.tupleId, arm: d.action });
});


honoApp.get("/v1/learning", requireAdmin, async (c) => {
  await hydrateLearning(true).catch(logErr);
  await hydrateL1Cache(false).catch(() => {});
  const now = Date.now();
  const kappa = learningKappa();

  const decisions: StoredDecision[] = [];
  for await (const e of kv.list<StoredDecision>({ prefix: [LEARN_DECISION_PREFIX] })) {
    if (e.value?.traceId) decisions.push(e.value);
  }
  decisions.sort((a, b) => a.ts - b.ts);
  const rewarded = decisions.filter((d) => d.reward !== null && d.reward !== undefined);
  const asRecords: DecisionRecord[] = rewarded.map((d) => ({
    traceId: d.traceId,
    ts: d.ts,
    taskClass: d.taskClass,
    action: d.action,
    tupleId: d.tupleId,
    propensity: d.propensity,
    reward: d.reward as number,
    tokens: d.tokens,
    extraTokens: d.extraTokens,
    expectedReward: d.expectedReward,
    computeMode: d.computeMode,
    lessonIds: d.lessonIds,
  }));

  // Per-(tuple, class) posteriors against each tuple's global posterior.
  const posteriors = [...LEARNING_CELLS.values()]
    .filter((cell) => cell.scope === "global")
    .map((cell) => {
      const rec = L1_CACHE.get(cell.tuple_id);
      const global = rec ? tupleGlobalPosterior(rec, now) : { alpha: 2, beta: 1 };
      const eff = effectivePosterior(cell, global, kappa);
      return {
        tuple_id: cell.tuple_id,
        task_class: cell.task_class,
        pulls: cell.pulls,
        mean: Number(betaMean(eff.alpha, eff.beta).toFixed(4)),
        lower_bound: Number(posteriorLowerBound(eff.alpha, eff.beta).toFixed(4)),
        variance: Number((eff.alpha * eff.beta / ((eff.alpha + eff.beta) ** 2 * (eff.alpha + eff.beta + 1))).toFixed(4)),
        alpha: Number(eff.alpha.toFixed(2)),
        beta: Number(eff.beta.toFixed(2)),
        last_at: cell.lastAt,
      };
    })
    .sort((a, b) => b.pulls - a.pulls)
    .slice(0, 200);

  const bestByClass = new Map<TaskClass, number>();
  for (const p of posteriors) {
    bestByClass.set(p.task_class, Math.max(bestByClass.get(p.task_class) ?? 0, p.mean));
  }
  const curve = regretCurve(asRecords, (cls) => bestByClass.get(cls) ?? 0.5);
  const sampledCurve = curve.filter((_, i) => i % Math.max(1, Math.floor(curve.length / 50)) === 0 || i === curve.length - 1);

  // Arm shares per class: where the bandit actually sends traffic.
  const armCells = [...ARM_CELLS.values()].map((cell) => ({
    arm: cell.arm_id,
    task_class: cell.task_class,
    pulls: cell.pulls,
    mean: Number(betaMean(cell.alpha, cell.beta).toFixed(4)),
  }));
  const shares: Record<string, Record<string, number>> = {};
  for (const cell of armCells) {
    const byClass = armCells.filter((x) => x.task_class === cell.task_class);
    const total = byClass.reduce((a, x) => a + x.pulls, 0);
    (shares[cell.task_class] ??= {})[cell.arm] = total > 0 ? Number((cell.pulls / total).toFixed(3)) : 0;
  }

  return c.json({
    object: "learning",
    engine: "asck-l-v1",
    task_classes: ["chat", "qa", "code", "math", "tool", "vision", "json", "reasoning", "multilingual", "longform", "summarize", "creative"],
    kappa,
    exploration_floor: 0.05,
    tenant_evidence_min: TENANT_EVIDENCE_MIN,
    posteriors,
    tenant_cells: [...LEARNING_CELLS.values()].filter((x) => x.scope !== "global").length,
    arms: {
      definitions: [...ARM_DEFS.values()],
      cells: armCells,
      shares,
    },
    regret: {
      curve: sampledCurve,
      exponent: fitRegretExponent(curve),
      total: curve.length ? curve[curve.length - 1].regret : 0,
      decisions: asRecords.length,
    },
    calibration: calibrationBuckets(asRecords),
    reward_per_extra_token: rewardPerExtraToken(asRecords),
    off_policy: evaluateArmPolicies(asRecords.map((r) => ({ ...r }))),
    lessons: [...LESSONS.values()].map((l) => ({
      id: l.id,
      task_class: l.taskClass,
      failure_signature: l.failureSignature,
      correction: l.correction,
      pulls: l.pulls,
      mean: Number(betaMean(l.alpha, l.beta).toFixed(4)),
      pruned: l.pruned,
      created_at: l.createdAt,
    })),
    decisions: {
      stored: decisions.length,
      rewarded: rewarded.length,
      recent: decisions.slice(-20).map((d) => ({
        trace_id: d.traceId,
        ts: d.ts,
        task_class: d.taskClass,
        tuple: d.tupleId,
        arm: d.action,
        arm_propensity: d.armPropensity,
        tuple_propensity: d.tuplePropensity,
        compute_mode: d.computeMode,
        expected_reward: d.expectedReward,
        reward: d.reward,
        tokens: d.tokens,
        extra_tokens: d.extraTokens,
      })),
    },
    caps: { max_cells: MAX_LEARN_CELLS, cells: LEARNING_CELLS.size, decision_ttl_days: 7, feedback_ttl_hours: 24 },
  });
});


honoApp.post("/v1/learning/arms", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({} as Json)) as Json;
  const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
  if (!/^[a-z0-9_]{1,48}$/.test(id)) return c.json({ error: { message: "arm id must match [a-z0-9_]{1,48}" } }, 400);
  const variant = ["plain", "verify", "concise"].includes(String(body.prompt_variant)) ? String(body.prompt_variant) as StrategyArm["promptVariant"] : "plain";
  const compute = ["single", "verify_retry", "best_of_n"].includes(String(body.compute)) ? String(body.compute) as StrategyArm["compute"] : "single";
  const armDef: StrategyArm = {
    id,
    label: typeof body.label === "string" ? body.label.slice(0, 120) : id,
    promptVariant: variant,
    temperatureDelta: Number(clampNum(Number(body.temperature_delta) || 0, -1, 1).toFixed(2)),
    compute,
    enabled: body.enabled !== false,
    ...(Array.isArray(body.classes) ? { classes: (body.classes as unknown[]).filter((x): x is TaskClass => typeof x === "string").slice(0, 12) as TaskClass[] } : {}),
  };
  await kv.set([LEARN_ARM_DEF_PREFIX, id], armDef);
  ARM_DEFS.set(id, armDef);
  return c.json({ arm: armDef, total_arms: ARM_DEFS.size });
});
}
