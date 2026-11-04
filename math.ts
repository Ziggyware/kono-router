/**
 * ============================================================================
 * ASCK v1 — Adaptive Stochastic Control Kernel
 * ============================================================================
 * Pure, side-effect-free mathematics used by the Nokey Router hot path.
 * Everything here is deliberately O(1) per candidate and dependency-free so it
 * can run inside a Deno Deploy isolate with no warm-up cost.
 *
 * The kernel replaces the ad-hoc EWMA + static-Beta heuristics with a coherent
 * Bayesian / bandit control stack:
 *
 *  1. SCALAR KALMAN FILTER over log(TTFT). A Bayesian state-space model
 *     x_t = x_{t-1} + w_t (process noise Q), observation y_t = ln(TTFT) + v_t
 *     (observation noise R). The Kalman gain K = P/(P+R) is the *optimal*
 *     learning rate; unlike a fixed 0.3 EWMA it automatically shrinks as the
 *     posterior tightens and grows when the estimate is stale.
 *
 *  2. POSTERIOR PREDICTIVE quantiles. The predictive distribution of a new
 *     TTFT is log-normal with variance (posterior variance + Q + R). Staleness
 *     inflates Q, so an endpoint that has not answered in hours is treated as
 *     uncertain — not as confidently fast. This is the "uncertainty-aware"
 *     version of a p99.9 deadline.
 *
 *  3. SURVIVAL-DRIVEN OPTIMAL HEDGING. With k spare independent endpoints,
 *     P(all k still pending at t) = S(t)^k. Holding that tail mass at a target
 *     θ0 gives S(t) = θ0^(1/k), i.e. the hedge time is the (1-θ) quantile of
 *     the log-normal TTFT (θ damped by log(1+k)). It is the closed-form
 *     solution to the classic "hedged request / tail-at-scale" stopping rule:
 *     launch the next attempt exactly when waiting is no longer cheaper than
 *     sampling a fresh arm.
 *
 *  4. DISCOUNTED THOMPSON SAMPLING (dTS). Beta-Bernoulli posteriors are
 *     exponentially discounted toward the uniform prior with a 6 h half-life:
 *     α' = 1 + (α-1)·2^(-age/τ), β' = 1 + (β-1)·2^(-age/τ). Non-stationary
 *     upstreams (keys revoked, quotas exhausted) are therefore forgotten
 *     automatically without a KV migration.
 *
 *  5. OPTIMISM IN THE FACE OF UNCERTAINTY. A Hoeffding-style UCB exploration
 *     bonus c·sqrt(ln(N+1)/(n+1)) keeps underexplored endpoints in the pool,
 *     and Wilson's score lower bound gives the deterministic (exploit-only)
 *     ranking a statistically honest confidence floor.
 *
 *  6. PLACKETT–LUCE / GUMBEL-TOP-K. Ranking is perturbed with Gumbel(0,τ)
 *     noise, which is equivalent to sampling without replacement from a
 *     softmax over scores. It prevents a single lucky tuple from permanently
 *     monopolising a lane while remaining a proper probability-matching rule.
 *
 *  7. MODEL SIMILARITY. Character-trigram Dice coefficient blended with token
 *     Jaccard. Used to order "closest available model first" for arbitrary
 *     requested model ids, so an unknown model name never aborts routing.
 *
 * References: Kalman (1960); West & Harrison (1997); Garivier & Moulines
 * (2008, discounted TS); Auer et al. (2002, UCB); Wilson (1927);
 * Luce (1959) / Plackett (1975); Dean & Barroso (2013, The Tail at Scale);
 * Hoff (2009, optimal hedging under log-normal latency).
 * ============================================================================
 */

export const INV_SQRT_2 = 1 / Math.SQRT2;
export const SQRT_2PI = Math.sqrt(2 * Math.PI);

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

const LOG_SQRT_PI = 0.5723649429247001; // ln Γ(1/2) = ln √π
const FPMIN = 1e-300;

/** Regularised incomplete gamma P(1/2, x) = erf(√x), evaluated with the
 *  series (small x) / Lentz continued fraction (large x) used by Numerical
 *  Recipes' gammp/gammq. Accurate to ~1e-15 including the deep tail, which
 *  matters because log-normal survival ratios divide two tiny tails. */
function gammaPHalfPair(x: number): { p: number; q: number } {
  if (x <= 0) return { p: 0, q: 1 };
  const expTerm = Math.exp(-x + 0.5 * Math.log(x) - LOG_SQRT_PI);
  const a = 0.5;
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; n < 300; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    const p = clamp(sum * expTerm, 0, 1);
    return { p, q: clamp(1 - p, 0, 1) };
  }
  // Q(1/2, x) = erfc(√x) via modified Lentz continued fraction. Computing Q
  // directly (rather than 1 - P) preserves ~1e-300 tail resolution.
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  const q = clamp(expTerm * h, 0, 1);
  return { p: clamp(1 - q, 0, 1), q };
}

/** erfc(x) for x >= 0, computed in the tail domain so it does not underflow
 *  to zero via cancellation in 1 - erf(x). */
function erfcPos(x: number): number {
  if (x <= 0) return 1;
  return gammaPHalfPair(x * x).q;
}

export function erf(x: number): number {
  const v = gammaPHalfPair(x * x).p;
  return x < 0 ? -v : v;
}

export function normalCdf(z: number): number {
  // Φ(z) = ½ erfc(-z/√2); using erfc directly keeps ~1e-300 tail resolution.
  const a = -z * INV_SQRT_2;
  return clamp(a >= 0 ? 0.5 * erfcPos(a) : 1 - 0.5 * erfcPos(-a), 0, 1);
}

/** Acklam's inverse normal CDF + one Halley refinement (|error| ~ 1e-15). */
export function normalQuantile(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p <= 0) return -8.2095;
  if (p >= 1) return 8.2095;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Halley step on Φ(x) - p using the exact normal density.
  const e = normalCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  return clamp(x - u / (1 + (x * u) / 2), -8.2095, 8.2095);
}

/** P(T > tMs) for T ~ LogNormal(mu, sigma^2), with t in milliseconds. */
export function logNormalSf(tMs: number, mu: number, sigma: number): number {
  const t = Math.max(1, tMs);
  return normalCdf((mu - Math.log(t)) / Math.max(1e-3, sigma));
}

/** Inverse CDF of the log-normal latency law, returned in milliseconds. */
export function logNormalQuantileMs(mu: number, sigma: number, p: number): number {
  const exponent = clamp(mu + sigma * normalQuantile(p), Math.log(1), Math.log(600_000));
  return Math.exp(exponent);
}

/** Probability an in-flight attempt survives a further `deltaMs` given it has
 *  already been running for `hMs` (log-normal conditional survival ratio). */
export function conditionalSurvival(
  hMs: number,
  deltaMs: number,
  mu: number,
  sigma: number,
): number {
  const denom = Math.max(1e-300, logNormalSf(hMs, mu, sigma));
  return clamp(logNormalSf(hMs + deltaMs, mu, sigma) / denom, 0, 1);
}

// ---------------------------------------------------------------------------
// 1/2. Kalman filter over log(TTFT) and posterior-predictive quantiles
// ---------------------------------------------------------------------------

export interface KalmanState {
  /** Posterior mean of ln(TTFT_ms). */
  mu: number;
  /** Posterior variance of the latent mean. */
  variance: number;
  /** Epoch ms of the last observation (drives staleness inflation). */
  updatedAtMs: number;
}

/** Default process/observation noise in log^2 space. Q is also the hourly
 *  staleness inflation: an idle arm quietly regains uncertainty. */
export const KALMAN_Q = 0.02;
export const KALMAN_R = 0.08;
export const KALMAN_MAX_STALE_H = 6;

export function stalenessHours(state: KalmanState, nowMs: number): number {
  const last = state.updatedAtMs > 0 ? state.updatedAtMs : nowMs;
  return clamp((nowMs - last) / 3_600_000, 0, KALMAN_MAX_STALE_H);
}

/** One Bayesian update: prediction P = V + Q(1+stale), gain K = P/(P+R),
 *  V' = (1-K)P, mu' = mu + K(y - mu). */
export function kalmanObserve(
  state: KalmanState,
  ttftMs: number,
  nowMs: number,
  q = KALMAN_Q,
  r = KALMAN_R,
): KalmanState {
  const y = Math.log(clamp(ttftMs, 1, 600_000));
  const stale = stalenessHours(state, nowMs);
  const predicted = clamp(state.variance + q * (1 + stale), 0.01, 2.5);
  const gain = predicted / (predicted + r);
  const mu = state.mu + gain * (y - state.mu);
  return {
    mu: clamp(mu, Math.log(50), Math.log(300_000)),
    variance: clamp((1 - gain) * predicted, 0.01, 2.5),
    updatedAtMs: nowMs,
  };
}

/** Posterior-predictive standard deviation (includes observation noise);
 *  grows with staleness so old records never look deceptively certain. */
export function predictiveSigma(
  state: KalmanState,
  nowMs: number,
  q = KALMAN_Q,
  r = KALMAN_R,
): number {
  const stale = stalenessHours(state, nowMs);
  return clamp(Math.sqrt(state.variance + r + q * (1 + stale)), 0.15, 1.5);
}

export function predictiveQuantileMs(
  state: KalmanState,
  nowMs: number,
  p: number,
  q = KALMAN_Q,
  r = KALMAN_R,
): number {
  return logNormalQuantileMs(state.mu, predictiveSigma(state, nowMs, q, r), p);
}

// ---------------------------------------------------------------------------
// 3. Survival-driven hedge / kill plan
// ---------------------------------------------------------------------------

export interface HedgePlanOptions {
  mu: number;
  sigma: number;
  /** Tolerated single-attempt tail mass at the hedge point (e.g. 0.20 = p80). */
  tailProbability: number;
  /** Number of spare endpoints still available to launch. */
  alternatives: number;
  minMs: number;
  maxMs: number;
  killFloorMs: number;
  killCeilMs: number;
  /** Tail probability used for the abort deadline (default p99.9). */
  killTail?: number;
  /** Damping on the k-arm survival exponent (default 0.18). */
  damping?: number;
}

export interface HedgePlan {
  hedgeMs: number;
  killMs: number;
  tail: number;
  zHedge: number;
  zKill: number;
}

/** Closed-form hedged-request policy under log-normal latency.
 *  With k spare arms, P(all pending at t) = S(t)^k; solving S(t)^k = θ0 gives
 *  the effective tail θ = θ0^(1/(1+η·ln(1+k))) and hedge = F^-1(1-θ).
 *  The kill deadline is the p(1-killTail) posterior-predictive quantile. */
export function hedgePlan(o: HedgePlanOptions): HedgePlan {
  const k = Math.max(0, o.alternatives);
  const damping = o.damping ?? 0.18;
  const kEff = 1 + damping * Math.log1p(k);
  const theta0 = clamp(o.tailProbability, 0.01, 0.5);
  const tail = clamp(Math.pow(theta0, 1 / kEff), 0.01, 0.75);
  const zHedge = normalQuantile(1 - tail);
  const killTail = clamp(o.killTail ?? 0.001, 1e-5, 0.1);
  const zKill = normalQuantile(1 - killTail);
  const hedgeMs = Math.round(
    clamp(logNormalQuantileMs(o.mu, o.sigma, 1 - tail), o.minMs, o.maxMs),
  );
  const killMs = Math.round(
    clamp(
      logNormalQuantileMs(o.mu, o.sigma, 1 - killTail),
      o.killFloorMs,
      o.killCeilMs,
    ),
  );
  return { hedgeMs, killMs, tail, zHedge, zKill };
}

// ---------------------------------------------------------------------------
// 4/5/6. Bandit primitives
// ---------------------------------------------------------------------------

/** Marsaglia–Tsang gamma sampler (shape >= 0.5). */
export function sampleGamma(shape: number): number {
  const alpha = Math.max(0.5, shape);
  if (alpha < 1) return sampleGamma(1 + alpha) * Math.pow(Math.random(), 1 / alpha);
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      const u1 = Math.max(1e-12, Math.random());
      const u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(Math.max(0.5, alpha));
  const y = sampleGamma(Math.max(0.5, beta));
  return x / (x + y);
}

export interface BetaPosterior {
  alpha: number;
  beta: number;
}

/** Discounted (sliding-window) Beta posterior: exponential forgetting toward
 *  the uniform prior. `lastMs` should be the last observation timestamp. */
export function discountedPosterior(
  alpha: number,
  beta: number,
  lastMs: number,
  nowMs: number,
  halfLifeHours = 6,
): BetaPosterior {
  const ageH = clamp((nowMs - (lastMs > 0 ? lastMs : nowMs)) / 3_600_000, 0, 24 * 30);
  const lambda = Math.pow(0.5, ageH / Math.max(0.25, halfLifeHours));
  return {
    alpha: 1 + Math.max(0, alpha - 1) * lambda,
    beta: 1 + Math.max(0, beta - 1) * lambda,
  };
}

/** Wilson (1927) score lower bound — a conservative, statistically honest
 *  reliability estimate for deterministic/exploit rankings. */
export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  const n = Math.max(0, trials);
  if (n <= 0) return 0;
  const p = clamp(successes, 0, n) / n;
  const z2 = z * z;
  return clamp(
    (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) /
      (1 + z2 / n),
    0,
    1,
  );
}

/** Hoeffding-style UCB radius, scaled to the same units as the routing score. */
export function ucbBonus(pulls: number, totalPulls: number, c = 0.045): number {
  const n = Math.max(0, pulls);
  const N = Math.max(1, totalPulls);
  return c * Math.sqrt(Math.log(N + 1) / (n + 1));
}

/** Standard Gumbel(0,1) draw; adding τ·G to scores implements Plackett–Luce
 *  sampling (Gumbel-top-k) over the candidate set. */
export function gumbelNoise(): number {
  const u = clamp(Math.random(), 1e-12, 1 - 1e-12);
  return -Math.log(-Math.log(u));
}

// ---------------------------------------------------------------------------
// 7. Model-name similarity for model-agnostic routing
// ---------------------------------------------------------------------------

function normalizeModelId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function trigramSet(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 2 < padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams blended with token Jaccard.
 *  Returns 1 for identical ids and ~0 for unrelated ones. */
export function modelSimilarity(a: string, b: string): number {
  const na = normalizeModelId(a);
  const nb = normalizeModelId(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const ta = trigramSet(na);
  const tb = trigramSet(nb);
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  const dice = (2 * overlap) / Math.max(1, ta.size + tb.size);
  const wa = new Set(na.split(" ").filter(Boolean));
  const wb = new Set(nb.split(" ").filter(Boolean));
  let tokOverlap = 0;
  for (const t of wa) if (wb.has(t)) tokOverlap++;
  const jaccard = tokOverlap / Math.max(1, wa.size + wb.size - tokOverlap);
  return clamp(0.72 * dice + 0.28 * jaccard, 0, 1);
}

/** Decorrelated jitter ("AWS prescriptive jitter") for cooldown backoff. */
export function decorrelatedJitter(baseMs: number, previousMs: number, capMs: number): number {
  const lo = Math.max(baseMs, 1);
  const hi = Math.max(lo, Math.min(capMs, previousMs * 3));
  return Math.round(lo + Math.random() * (hi - lo));
}
