// routes/chat-learning.ts — Learning-loop glue extracted from routes/chat.ts.
// Strategy-arm loading, decision persistence, reward finalization, and the
// deterministic math/JSON answer verifiers used by the chat route.
// (Verbatim code motion from chat.ts — no behavior change.)

import { thompsonPropensity, betaMean, gradeReward } from "../learning.ts";
import type { StrategyArm, TaskContext, Lesson, ComputeDecision, RewardSignal, BanditCandidate } from "../learning.ts";
import { evaluate as evaluateCalc } from "../toolbox/calc.ts";
import { parseToolArguments } from "../tools.ts";
import { hydrateLearning } from "../main.ts";
import type { PendingDecision, StoredDecision, ScoredCandidate, Json } from "../main.ts";
import { ARM_DEFS, ARM_CELLS, kv, LEARN_DECISION_PREFIX, DECISION_TTL_MS, L1_CACHE } from "../state.ts";
import { logErr } from "../util.ts";
import { contextualPosterior, recordLearningReward } from "../engine/learning.ts";

export async function loadStrategyArms(): Promise<StrategyArm[]> {
  await hydrateLearning();
  return [...ARM_DEFS.values()];
}



export function armGlobalPosterior(armId: string): { alpha: number; beta: number } {
  let s = 0;
  let f = 0;
  for (const c of ARM_CELLS.values()) {
    if (c.arm_id !== armId) continue;
    s += Math.max(0, c.alpha - 1);
    f += Math.max(0, c.beta - 1);
  }
  return { alpha: 1 + s, beta: 1 + f };
}



export interface LearnCtx {
  traceId: string;
  taskCtx: TaskContext;
  arm: StrategyArm;
  armPropensity: number;
  tenant: string;
  lessons: Lesson[];
  hasVerifier: boolean;
  planeActive: boolean;
  compute: ComputeDecision;
}



export async function saveDecision(d: PendingDecision, reward: number | null): Promise<void> {
  const rec: StoredDecision = {
    traceId: d.traceId,
    ts: d.ts,
    taskClass: d.taskClass,
    action: d.armId,
    tupleId: d.tupleId,
    propensity: d.armPropensity,
    armPropensity: d.armPropensity,
    tuplePropensity: d.tuplePropensity,
    tokens: d.tokens,
    extraTokens: d.extraTokens,
    expectedReward: d.expectedReward,
    computeMode: d.computeMode,
    lessonIds: d.lessonIds,
    tenant: d.tenant,
    reward,
  };
  await kv.set([LEARN_DECISION_PREFIX, d.traceId], rec, { expireIn: DECISION_TTL_MS }).catch(logErr);
}



/** Grade a finished decision and persist everything the loop learns from. */
export async function finalizeLearning(args: {
  ctx: LearnCtx;
  cand: ScoredCandidate;
  ranked: ScoredCandidate[];
  signals: RewardSignal[];
  tokens: number;
  extraTokens: number;
  now: number;
}): Promise<void> {
  const { ctx, cand } = args;
  const top = args.ranked.slice(0, 8);
  if (!top.some((c) => c.tupleId === cand.tupleId)) top.push(cand);
  const cands: BanditCandidate[] = top.map((c) => {
    const rec = L1_CACHE.get(c.tupleId);
    const post = rec
      ? contextualPosterior(rec, ctx.taskCtx.taskClass, ctx.tenant, args.now)
      : { alpha: 2, beta: 1, pulls: 0 };
    return { id: c.tupleId, alpha: post.alpha, beta: post.beta, pulls: post.pulls };
  });
  const winner = cands.find((c) => c.id === cand.tupleId) ?? cands[0];
  const tuplePropensity = thompsonPropensity(cands, cand.tupleId, Math.random, 120);
  const d: PendingDecision = {
    traceId: ctx.traceId,
    ts: args.now,
    taskClass: ctx.taskCtx.taskClass,
    tupleId: cand.tupleId,
    armId: ctx.arm.id,
    tenant: ctx.tenant,
    armPropensity: ctx.armPropensity,
    tuplePropensity,
    tokens: args.tokens,
    extraTokens: args.extraTokens,
    expectedReward: winner ? Number(betaMean(winner.alpha, winner.beta).toFixed(4)) : 0.5,
    computeMode: ctx.compute.mode,
    lessonIds: ctx.lessons.map((l) => l.id),
  };
  if (!d.traceId) return;
  const graded = gradeReward(args.signals, { tupleId: cand.tupleId, armId: ctx.arm.id });
  await saveDecision(d, graded?.reward ?? null);
  if (graded) await recordLearningReward(d, graded);
}



/** Arithmetic verifier: the deterministic calculate evaluator, independent
 *  of whatever model produced the answer. */
export function verifyMathAnswer(userText: string, answer: string): { pass: boolean; expected: number } | null {
  const m = userText.replace(/,/g, "").match(/\d+(?:\.\d+)?(?:\s*[-+*/^%()]\s*\d+(?:\.\d+)?)+/);
  if (!m) return null;
  const expr = m[0].trim();
  if (expr.length > 120) return null;
  let expected: number;
  try {
    expected = evaluateCalc(expr);
  } catch {
    return null;
  }
  if (!Number.isFinite(expected)) return null;
  const nums = (answer.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pass = nums.some((n) => Math.abs(n - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-6));
  return { pass, expected };
}



/** JSON verifier: parse + JSON-schema validation via the tool plane's own
 *  validator — again, code that did not generate the answer. */
export function verifyJsonAnswer(content: string, responseFormat: unknown): { pass: boolean; signature: string } | null {
  let text = content.trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { pass: false, signature: "parse" };
  }
  const rf = (responseFormat ?? {}) as Json;
  const holder = (rf.json_schema ?? {}) as Json;
  const schema = holder.schema ?? (rf.type === "json_schema" ? rf.schema : undefined);
  if (schema !== undefined) {
    const v = parseToolArguments(parsed, schema, { coerce: false });
    return { pass: v.ok, signature: v.ok ? "" : "invalid" };
  }
  return { pass: true, signature: "" };
}
