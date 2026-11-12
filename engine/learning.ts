// engine/learning.ts — learning subsystem, partitioned from engine.ts (originally main.ts).

import { emptyCell, effectivePosterior, betaMean, observeCell, shouldPruneLesson, correctionFor, pruneCells } from "../learning.ts";
import type { TaskClass, Lesson, GradedReward } from "../learning.ts";
import { LEARNING_CELLS, TENANT_EVIDENCE_MIN, kv, ARM_CELLS, LESSONS, MAX_LEARN_CELLS } from "../state.ts";
import { learnCellKey, tupleGlobalPosterior, armCellKey, logErr } from "../util.ts";
import { learningKappa, PROVIDER_BREAKER, hydrateL1Cache } from "../main.ts";
import type { MeshModelRecord, LearningCellRecord, ArmCellRecord, PendingDecision } from "../main.ts";
import { executeTool } from "../tools.ts";
import { kalmanObserve, clamp as clampNum, decorrelatedJitter } from "../math.ts";
import { breakerProviderId } from "./providers.ts";
import { atomicUpdateModel } from "./core.ts";







// ---------------------------------------------------------------------------
// ASCK-L — THE LEARNING LOOP. Extends the ASCK posteriors above: every
// router choice (tuple, strategy arm, compute budget, injected lesson) is
// scored by a graded reward with provenance, and the scores live in
// contextual Beta cells in KV, shrunk toward the tuple's global posterior
// by empirical-Bayes pseudo-counts (learning.ts). Learning is pooled
// globally by default; a tenant's own cells only take over once that
// tenant has >= 30 pulls of evidence in the cell. No raw user content is
// ever stored — only classes, signatures, rewards and ids.
// ---------------------------------------------------------------------------

export const LEARN_CELL_PREFIX = "mesh_learning_cells_v1";




export const LEARN_ARM_CELL_PREFIX = "mesh_learning_arm_cells_v1";




export const LESSON_PREFIX = "mesh_lessons_v1";




export const LEARN_TTL_MS = 30_000;





/** Which scope reads for this tenant: its own cells only with real evidence. */
export function scopeFor(tenant: string, tuple: string, cls: TaskClass): string {
  if (tenant && tenant !== "global") {
    const own = LEARNING_CELLS.get(learnCellKey(tenant, tuple, cls));
    if (own && own.pulls >= TENANT_EVIDENCE_MIN) return tenant;
  }
  return "global";
}





export function contextualPosterior(
  r: MeshModelRecord,
  cls: TaskClass,
  tenant: string,
  now: number,
): { alpha: number; beta: number; mean: number; pulls: number; scope: string } {
  const scope = scopeFor(tenant, r.tuple_id, cls);
  const cell = LEARNING_CELLS.get(learnCellKey(scope, r.tuple_id, cls)) ?? emptyCell();
  const eff = effectivePosterior(cell, tupleGlobalPosterior(r, now), learningKappa());
  return { ...eff, mean: betaMean(eff.alpha, eff.beta), pulls: cell.pulls, scope };
}





/** CAS write for learning records (same discipline as the tool skills). */
export async function casLearn<T>(key: Deno.KvKey, seed: () => T, mutator: (cur: T) => T): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await kv.get<T>(key);
    const updated = mutator(entry.value ?? seed());
    const res = await kv.atomic().check(entry).set(key, updated).commit();
    if (res.ok) return updated;
    await new Promise((r) => setTimeout(r, 10 * (attempt + 1) + Math.random() * 10));
  }
  return null;
}





export async function updateLearnCell(scope: string, tuple: string, cls: TaskClass, reward: number, now: number): Promise<void> {
  const k = learnCellKey(scope, tuple, cls);
  const cur = LEARNING_CELLS.get(k) ?? { ...emptyCell(), scope, tuple_id: tuple, task_class: cls };
  LEARNING_CELLS.set(k, { ...observeCell(cur, reward, now), scope, tuple_id: tuple, task_class: cls });
  const saved = await casLearn<LearningCellRecord>(
    [LEARN_CELL_PREFIX, scope, tuple, cls],
    () => ({ ...emptyCell(), scope, tuple_id: tuple, task_class: cls }),
    (c) => ({ ...observeCell(c, reward, now), scope, tuple_id: tuple, task_class: cls }),
  );
  if (saved) LEARNING_CELLS.set(k, saved);
}





export async function updateArmCell(armId: string, cls: TaskClass, reward: number, now: number): Promise<void> {
  const k = armCellKey(armId, cls);
  const cur = ARM_CELLS.get(k) ?? { ...emptyCell(), arm_id: armId, task_class: cls };
  ARM_CELLS.set(k, { ...observeCell(cur, reward, now), arm_id: armId, task_class: cls });
  const saved = await casLearn<ArmCellRecord>(
    [LEARN_ARM_CELL_PREFIX, armId, cls],
    () => ({ ...emptyCell(), arm_id: armId, task_class: cls }),
    (c) => ({ ...observeCell(c, reward, now), arm_id: armId, task_class: cls }),
  );
  if (saved) ARM_CELLS.set(k, saved);
}





export async function updateLessonEfficacy(lesson: Lesson, reward: number, now: number): Promise<void> {
  const next = { ...observeCell(lesson, reward, now), id: lesson.id, taskClass: lesson.taskClass, failureSignature: lesson.failureSignature, correction: lesson.correction, createdAt: lesson.createdAt, pruned: lesson.pruned };
  if (shouldPruneLesson(next)) next.pruned = true;
  LESSONS.set(lesson.id, next);
  await kv.set([LESSON_PREFIX, lesson.id], next).catch(logErr);
}





export function lessonIdFor(cls: TaskClass, signature: string): string {
  let h = 0x811c9dc5;
  const s = `${cls}|${signature}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `lesson_${(h >>> 0).toString(16)}`;
}





/** A verified failure becomes a structured lesson: ledger entry for
 *  efficacy tracking + a memory_write copy through the existing plane. */
export async function writeLesson(cls: TaskClass, signature: string): Promise<void> {
  const id = lessonIdFor(cls, signature);
  if (LESSONS.has(id)) return;
  const lesson: Lesson = {
    ...emptyCell(),
    id,
    taskClass: cls,
    failureSignature: signature,
    correction: correctionFor(signature),
    createdAt: Date.now(),
    pruned: false,
  };
  LESSONS.set(id, lesson);
  await kv.set([LESSON_PREFIX, id], lesson).catch(logErr);
  try {
    await executeTool("memory_write", {
      text: `Router lesson [${cls}] ${signature}: ${lesson.correction}`,
      tags: ["kono-lesson", cls, signature],
      kind: "insight",
      importance: 0.7,
      source: "kono-router-learning",
    }, { caps: { kv, namespace: "router_lessons" }, admin: true });
  } catch (e) {
    logErr(e);
  }
}





/** Bounded KV growth: cap the contextual cells, evicting the stalest. */
export async function compactLearningCells(): Promise<void> {
  if (LEARNING_CELLS.size <= MAX_LEARN_CELLS) return;
  const all = [...LEARNING_CELLS.values()];
  const kept = new Set(pruneCells(all, MAX_LEARN_CELLS, Date.now()).map((c) => learnCellKey(c.scope, c.tuple_id, c.task_class)));
  for (const c of all) {
    const k = learnCellKey(c.scope, c.tuple_id, c.task_class);
    if (!kept.has(k)) {
      LEARNING_CELLS.delete(k);
      await kv.delete([LEARN_CELL_PREFIX, c.scope, c.tuple_id, c.task_class]).catch(() => {});
    }
  }
}





/** Fold one graded reward into every posterior the decision touched. */
export async function recordLearningReward(d: PendingDecision, graded: GradedReward): Promise<void> {
  const now = Date.now();
  await updateLearnCell("global", d.tupleId, d.taskClass, graded.reward, now).catch(logErr);
  if (d.tenant && d.tenant !== "global") {
    await updateLearnCell(d.tenant, d.tupleId, d.taskClass, graded.reward, now).catch(logErr);
  }
  await updateArmCell(d.armId, d.taskClass, graded.reward, now).catch(logErr);
  for (const id of d.lessonIds) {
    const lesson = LESSONS.get(id);
    if (lesson) await updateLessonEfficacy(lesson, graded.reward, now).catch(logErr);
  }
  compactLearningCells().catch(logErr);
}




export const BREAKER_FAIL_THRESHOLD = 6;




export const BREAKER_OPEN_MS = 300000;





// ============================================================================
// 7. ATOMIC TELEMETRY UPDATERS & CANARY VERIFICATION
// ============================================================================

export async function recordTupleSuccess(
  tupleId: string,
  ttftMs: number,
  totalMs: number,
  estTokens: number,
): Promise<void> {
  PROVIDER_BREAKER.delete(breakerProviderId(tupleId));
  const streamDurationSec = Math.max(0.05, (totalMs - ttftMs) / 1000);
  const observedTps = Math.min(800, Math.max(2, estTokens / streamDurationSec));

  const now = Date.now();
  await atomicUpdateModel(tupleId, (r) => {
    // Bayesian state-space update (ASCK v1): the Kalman gain is the optimal
    // learning rate, and the posterior variance feeds the hedge/kill quantiles.
    const posterior = kalmanObserve({
      mu: r.ewma_log_ttft ?? Math.log(Math.max(1, r.ewma_ttft_ms)),
      variance: clampNum(r.ewmv_log_ttft ?? 0.25, 0.01, 2.5),
      updatedAtMs: r.log_ttft_updated_at ?? 0,
    }, ttftMs, now);
    return {
      ...r,
      ewma_log_ttft: posterior.mu,
      ewmv_log_ttft: posterior.variance,
      log_ttft_updated_at: posterior.updatedAtMs,
      last_success_at: now,
      ewma_ttft_ms: Math.exp(posterior.mu),
      ewma_tps: 0.3 * observedTps + 0.7 * r.ewma_tps,
      alpha_success: Math.min(50, (r.alpha_success || 2.0) * 0.95 + 1.0),
      beta_failure: Math.max(1.0, (r.beta_failure || 1.0) * 0.95),
      iq_verified: Math.min(1.0, (r.iq_verified || 0.55) + 0.15),
      success_count: r.success_count + 1,
      failure_streak: 0,
      cooldown_until: 0,
      last_error: null,
    };
  });
}





/** Un-bench everything: clear every tuple cooldown that is still in the
 *  future (plus its failure streak) and drop every open provider breaker.
 *  Returns how many benches were actually lifted, so callers can tell a
 *  rate-limit wall (benches existed) from a genuinely empty catalog
 *  (nothing to reset — retrying would be pointless). */
export async function resetBenchedEndpoints(now = Date.now()): Promise<number> {
  let lifted = 0;
  const records = await hydrateL1Cache().catch(() => null);
  if (records) {
    const jobs: Array<Promise<void>> = [];
    for (const rec of records.values()) {
      if (rec.cooldown_until > now) {
        lifted++;
        jobs.push(atomicUpdateModel(rec.tuple_id, (r) => ({ ...r, cooldown_until: 0, failure_streak: 0 })).catch(() => undefined));
      }
    }
    await Promise.all(jobs);
  }
  for (const [pid, st] of [...PROVIDER_BREAKER]) {
    if (st.openUntil > now || st.fails > 0) { PROVIDER_BREAKER.delete(pid); lifted++; }
  }
  return lifted;
}

export async function recordTupleFailure(tupleId: string, errMsg: string): Promise<void> {
  const now = Date.now();
  const pid = breakerProviderId(tupleId);
  if (pid) {
    const state = PROVIDER_BREAKER.get(pid) || { fails: 0, openUntil: 0 };
    state.fails += 1;
    if (state.fails >= BREAKER_FAIL_THRESHOLD) {
      state.openUntil = now + BREAKER_OPEN_MS;
      state.fails = 0;
      console.warn(`provider breaker OPEN for ${pid} (${BREAKER_OPEN_MS / 1000}s)`);
    }
    PROVIDER_BREAKER.set(pid, state);
  }
  const baseSec = errMsg.includes("429")
    ? 120
    : errMsg.includes("401") || errMsg.includes("403")
    ? 900
    : 60;

  await atomicUpdateModel(tupleId, (r) => {
    const streak = r.failure_streak + 1;
    const backoffMultiplier = Math.min(8, Math.pow(1.5, streak - 1));
    return {
      ...r,
      failure_streak: streak,
      alpha_success: Math.max(1.0, (r.alpha_success || 2.0) * 0.9),
      beta_failure: Math.min(50, (r.beta_failure || 1.0) + 1.5),
      cooldown_until: now + decorrelatedJitter(baseSec * 1000, Math.round(baseSec * backoffMultiplier * 1000), 900_000),
      ewma_ttft_ms: Math.min(18000, r.ewma_ttft_ms * 1.4),
      last_error: errMsg.slice(0, 200),
    };
  });
}
