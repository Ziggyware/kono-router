// engine/ranking.ts — candidate scoring and ranking, extracted from engine/providers.ts.

import type { MeshModelRecord, ScoredCandidate, RoutingMode } from "../main.ts";
import { posteriorLowerBound } from "../learning.ts";
import type { TaskClass } from "../learning.ts";
import { clamp as clampNum, predictiveSigma, discountedPosterior, wilsonLowerBound, sampleBeta, ucbBonus, gumbelNoise } from "../math.ts";
import { toolRoutingBonus, tupleToolCompetence } from "../tools.ts";
import { contextualPosterior } from "./learning.ts";





// ---------------------------------------------------------------------------
// Provider diversity + circuit breaker.
// Dispatch races waves of 3 candidates drawn from the head of the ranked
// list, 9 attempts max. If one provider's tuples fill the head (a big free
// catalog with optimistic latency priors does exactly this), a provider-level
// outage -- dead key, exhausted quota -- fails every wave and the request
// returns 502 even while other providers are healthy. Two guards:
//  1. interleaveByProvider round-robins the ranked list across providers so
//     every wave spans multiple providers, preserving per-provider order.
//  2. PROVIDER_BREAKER excludes a provider from ranking for 5 minutes after
//     6 consecutive tuple failures, and clears on its next success.
// ---------------------------------------------------------------------------
export function interleaveByProvider(sorted: ScoredCandidate[]): ScoredCandidate[] {
  const byProvider = new Map<string, ScoredCandidate[]>();
  for (const cand of sorted) {
    const bucket = byProvider.get(cand.providerId);
    if (bucket) bucket.push(cand);
    else byProvider.set(cand.providerId, [cand]);
  }
  const queues = [...byProvider.values()];
  const out: ScoredCandidate[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        progressed = true;
      }
    }
  }
  return out;
}





export function breakerProviderId(tupleId: string): string {
  return tupleId.split("::")[0] || "";
}





// ---------------------------------------------------------------------------
// ASCK v1 scoring: discounted Thompson sampling + Kalman predictive quantiles
// + UCB exploration + Plackett–Luce (Gumbel) rank sampling. Pure function of
// one catalog record, reused by the lane ranker and the exhaustive sweep.
// ---------------------------------------------------------------------------
/** Population mean of the capability prior (the untiered base score). */
export const IQ_POPULATION_MEAN = 0.56;




/** Share of a claimed prior believed before any evidence. */
export const IQ_CREDIBILITY_FLOOR = 0.4;




export function scoreRecord(
  r: MeshModelRecord,
  mode: RoutingMode,
  deterministic: boolean,
  totalPulls: number,
  now: number,
  toolAware = false,
  learning?: { taskClass: TaskClass; tenant: string },
): ScoredCandidate {
  const iqPrior = Number(r.iq_prior);
  // Capability estimate on the prior's own scale: the model-name prior is a
  // claim, shrunk toward the population mean by how much this tuple has
  // earned trust. iq_verified runs 0.55 (unproven, or a failed canary) to 1.0
  // (canary passed / repeated completions); a tuple that never completed a
  // request is unproven whatever sync stored. Unproven keeps 40% of its
  // distance from the mean, fully trusted keeps all of it, so an unverified
  // headline name no longer outranks a proven workhorse and mode bonuses
  // (code, reasoning) decide within the unproven pack.
  const trust = r.success_count > 0 ? clampNum((Number(r.iq_verified) - 0.55) / 0.45, 0, 1) : 0;
  const credibility = IQ_CREDIBILITY_FLOOR + (1 - IQ_CREDIBILITY_FLOOR) * trust;
  const iqEffective = Number((IQ_POPULATION_MEAN + credibility * (iqPrior - IQ_POPULATION_MEAN)).toFixed(3));
  const ewmaTtftMs = Number(r.ewma_ttft_ms);
  const ewmaTps = Math.max(1.0, Number(r.ewma_tps));

  // Kalman posterior over ln(TTFT); staleness inflates predictive sigma.
  const logTtftMu = r.ewma_log_ttft ?? Math.log(Math.max(1, ewmaTtftMs));
  const logTtftSigma = predictiveSigma({
    mu: logTtftMu,
    variance: clampNum(r.ewmv_log_ttft ?? 0.25, 0.01, 2.5),
    updatedAtMs: r.log_ttft_updated_at ?? 0,
  }, now);

  // Discounted Beta-Bernoulli posterior (6 h half-life). Stale glory decays
  // back to the uniform prior, so a dead key cannot coast for weeks.
  const post = discountedPosterior(
    Number(r.alpha_success || 2.0),
    Number(r.beta_failure || 1.0),
    r.last_success_at ?? r.last_probed ?? now,
    now,
  );
  const pulls = Math.max(0, r.success_count + r.failure_streak);
  const reliabilityDraw = deterministic
    ? wilsonLowerBound(Math.max(0, post.alpha - 1), Math.max(1, post.alpha + post.beta - 2))
    : sampleBeta(post.alpha, post.beta);
  const exploration = deterministic ? 0 : ucbBonus(pulls, totalPulls);
  const plackettLuce = deterministic ? 0 : 0.012 * gumbelNoise();

  const expectedFastMs = Math.round(
    (ewmaTtftMs + (250 / ewmaTps) * 1000) / Math.max(0.35, reliabilityDraw),
  );
  const latencyPenalty = Math.max(0, (expectedFastMs - 8500) / 42000);
  const isLfmSmall = /lfm-2\.5-2\.6b/i.test(r.model_id);
  const codeBonus = mode === "code"
    ? (r.is_coding_specialist ? 0.085 : isLfmSmall ? -0.25 : 0)
    : 0;
  const reasoningBonus = mode === "reasoning" && r.supports_reasoning ? 0.095 : 0;
  const thompsonBonus = (reliabilityDraw - 0.5) * 0.12;
  // Compounding tool intelligence: a Thompson draw over this tuple's own
  // tool-call posterior (0 with no evidence, so exploration still wins there).
  const toolBonus = toolAware ? toolRoutingBonus(r, { deterministic, now }) : 0;
  // ASCK-L: the contextual (tuple, task class) posterior, shrunk toward this
  // tuple's global posterior — the router learns which tuple is best *for
  // this kind of task*, not just which tuple answers at all.
  let learningBonus = 0;
  let learningMean: number | undefined;
  let learningPulls: number | undefined;
  if (learning) {
    const ctxPost = contextualPosterior(r, learning.taskClass, learning.tenant, now);
    const draw = deterministic ? posteriorLowerBound(ctxPost.alpha, ctxPost.beta) : sampleBeta(ctxPost.alpha, ctxPost.beta);
    learningBonus = (draw - 0.5) * 0.10;
    learningMean = Number(ctxPost.mean.toFixed(4));
    learningPulls = ctxPost.pulls;
  }
  const smartScore = Number(
    (iqEffective + codeBonus + reasoningBonus + thompsonBonus + toolBonus + learningBonus + exploration + plackettLuce - latencyPenalty)
      .toFixed(4),
  );

  return {
    tupleId: r.tuple_id,
    providerId: r.provider_id,
    modelId: r.model_id,
    iqEffective,
    supportsReasoning: Boolean(r.supports_reasoning),
    supportsVision: Boolean(r.supports_vision),
    isCodingSpecialist: Boolean(r.is_coding_specialist),
    contextWindow: Number(r.context_window || 128000),
    reliabilityDraw: Number(reliabilityDraw.toFixed(3)),
    ewmaTtftMs: Math.round(ewmaTtftMs),
    ewmaTps: Number(ewmaTps.toFixed(1)),
    logTtftMu,
    logTtftSigma,
    expectedFastMs,
    smartScore,
    toolCompetence: toolAware || (r.tool_pulls ?? 0) > 0 ? tupleToolCompetence(r, now) : 0,
    toolPulls: r.tool_pulls ?? 0,
    ...(learningMean !== undefined ? { learningMean, learningPulls } : {}),
  };
}





export function totalCatalogPulls(catalog: Map<string, MeshModelRecord>): number {
  let n = 0;
  for (const r of catalog.values()) n += Math.max(1, r.success_count + r.failure_streak);
  return n;
}
