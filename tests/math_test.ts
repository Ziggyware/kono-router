import {
  clamp,
  conditionalSurvival,
  decorrelatedJitter,
  discountedPosterior,
  erf,
  gumbelNoise,
  hedgePlan,
  kalmanObserve,
  logNormalQuantileMs,
  logNormalSf,
  modelSimilarity,
  normalCdf,
  normalQuantile,
  predictiveQuantileMs,
  predictiveSigma,
  sampleBeta,
  ucbBonus,
  wilsonLowerBound,
} from "../math.ts";

const approx = (a: number, b: number, eps: number, label: string) => {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${label}: expected ${a} ≈ ${b} (±${eps})`);
  }
};

Deno.test("erf / normalCdf / normalQuantile are consistent inverses", () => {
  approx(erf(0), 0, 1e-9, "erf(0)");
  approx(erf(1), 0.84270079, 1e-6, "erf(1)");
  approx(erf(-1), -0.84270079, 1e-6, "erf(-1)");
  approx(normalCdf(0), 0.5, 1e-9, "Φ(0)");
  approx(normalQuantile(0.8), 0.84162123, 1e-6, "Φ⁻¹(0.8)");
  approx(normalQuantile(0.999), 3.0902323, 1e-5, "Φ⁻¹(0.999)");
  for (const z of [-3, -1.5, -0.3, 0, 0.7, 1.28, 2.5]) {
    approx(normalQuantile(normalCdf(z)), z, 1e-6, `roundtrip ${z}`);
  }
  if (!(normalQuantile(0) < 0 && normalQuantile(1) > 0)) {
    throw new Error("degenerate quantiles must be clamped, not infinite");
  }
});

Deno.test("log-normal survival matches its quantile function", () => {
  const mu = Math.log(2500);
  const sigma = 0.5;
  for (const p of [0.1, 0.5, 0.8, 0.95, 0.999]) {
    const t = logNormalQuantileMs(mu, sigma, p);
    approx(logNormalSf(t, mu, sigma), 1 - p, 2e-6, `S(F⁻¹(${p}))`);
  }
  if (!(conditionalSurvival(0, 2500, mu, sigma) < 1)) {
    throw new Error("conditional survival must be a probability");
  }
  // Log-normal conditional survival over a fixed horizon is non-monotone but
  // must stay in [0,1] and increase in the far tail (heavy-tail regime).
  const deep = conditionalSurvival(200_000, 2500, mu, sigma);
  const mid = conditionalSurvival(10_000, 2500, mu, sigma);
  if (!(deep >= mid && deep <= 1)) throw new Error(`tail hazard ${mid} -> ${deep}`);
});

Deno.test("Kalman filter converges, tightens, and regains uncertainty when stale", () => {
  let s = { mu: Math.log(2500), variance: 0.25, updatedAtMs: 1_000 };
  const t0 = 10_000;
  for (let i = 0; i < 40; i++) s = kalmanObserve(s, 800, t0 + i * 1000);
  approx(s.mu, Math.log(800), 0.05, "posterior mean converges");
  const tight = predictiveSigma(s, t0 + 40_000);
  const stale = predictiveSigma(s, t0 + 40_000 + 6 * 3_600_000);
  if (!(stale > tight)) throw new Error(`staleness must inflate sigma: ${tight} -> ${stale}`);
  if (!(predictiveQuantileMs(s, t0 + 40_000, 0.999) < 60_000)) {
    throw new Error("tight posterior must give a short p99.9 deadline");
  }
  if (!(s.variance >= 0.01 && s.variance <= 2.5)) throw new Error("variance out of bounds");
});

Deno.test("discounted Thompson posterior forgets stale evidence", () => {
  const now = 1_700_000_000_000;
  const fresh = discountedPosterior(40, 1, now, now);
  const old = discountedPosterior(40, 1, now - 30 * 24 * 3_600_000, now);
  if (!(fresh.alpha > old.alpha && fresh.alpha > 35)) throw new Error("fresh posterior lost");
  approx(old.alpha, 1, 0.01, "old posterior reverts to uniform prior");
  approx(old.beta, 1, 0.01, "old beta reverts");
  for (let i = 0; i < 100; i++) {
    const b = sampleBeta(fresh.alpha, fresh.beta);
    if (!(b >= 0 && b <= 1)) throw new Error("beta draw out of range");
  }
});

Deno.test("UCB / Wilson / Gumbel are well behaved", () => {
  if (!(ucbBonus(0, 1000) > ucbBonus(100, 1000))) throw new Error("UCB must favour exploration");
  if (!(wilsonLowerBound(90, 100) > wilsonLowerBound(9, 10))) {
    throw new Error("Wilson bound must reward sample size");
  }
  for (let i = 0; i < 100; i++) {
    if (!Number.isFinite(gumbelNoise())) throw new Error("Gumbel draw not finite");
  }
});

Deno.test("survival hedge plan: more alternatives hedge no later, bounds respected", () => {
  const base = {
    mu: Math.log(2500),
    sigma: 0.5,
    tailProbability: 0.2,
    minMs: 100,
    maxMs: 8_000,
    killFloorMs: 4_000,
    killCeilMs: 300_000,
  };
  const one = hedgePlan({ ...base, alternatives: 0 });
  const many = hedgePlan({ ...base, alternatives: 40 });
  if (!(many.hedgeMs <= one.hedgeMs)) {
    throw new Error(`hedge should not get later with more arms: ${one.hedgeMs} -> ${many.hedgeMs}`);
  }
  if (!(many.tail > one.tail)) throw new Error("effective tail mass must grow with spare arms");
  for (const p of [one, many]) {
    if (!(p.hedgeMs >= base.minMs && p.hedgeMs <= base.maxMs)) throw new Error("hedge bounds");
    if (!(p.killMs >= base.killFloorMs && p.killMs <= base.killCeilMs)) throw new Error("kill bounds");
    if (!(p.killMs > 0 && Number.isFinite(p.killMs))) throw new Error("kill not finite");
  }
  const sweep = hedgePlan({
    ...base,
    alternatives: 100,
    tailProbability: 0.45,
    minMs: 60,
    maxMs: 1_200,
    killFloorMs: 6_000,
    killCeilMs: 15_000,
  });
  if (!(sweep.hedgeMs <= 1_200 && sweep.killMs <= 15_000)) throw new Error("sweep policy bounds");
});

Deno.test("model similarity ranks close model ids above unrelated ones", () => {
  approx(modelSimilarity("gpt-4o-mini", "gpt-4o-mini"), 1, 1e-9, "identical");
  const close = modelSimilarity("gpt-4o-mini", "openai/gpt-4o-mini:free");
  const medium = modelSimilarity("gpt-4o-mini", "gpt-4.1");
  const far = modelSimilarity("gpt-4o-mini", "deepseek-r1-distill-qwen-32b");
  if (!(close > medium && medium > far)) {
    throw new Error(`similarity ordering broken: ${close} / ${medium} / ${far}`);
  }
  if (!(far >= 0 && far <= 1)) throw new Error("similarity out of range");
});

Deno.test("decorrelated jitter stays inside its window", () => {
  for (let i = 0; i < 100; i++) {
    const j = decorrelatedJitter(1000, 2000, 10000);
    if (!(j >= 1000 && j <= 6000)) throw new Error(`jitter ${j} out of bounds`);
  }
  approx(clamp(12, 0, 10), 10, 1e-9, "clamp hi");
});
