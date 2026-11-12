// deno-lint-ignore-file no-explicit-any
/**
 * Tool Speciation tests: promotion math, the probe gauntlet, operator
 * templates, and the full lifecycle (forge → lineage → canary → promotion →
 * retire) against the real registry and KV seam.
 *
 * Run: deno test --unstable-kv -A tests/
 */
import { forgeTool, retireForgedTool } from "../engine/mesh.ts";
import { executeTool } from "../tools.ts";
import {
  admitVariant,
  ensureLineage,
  evaluateLineage,
  getVariant,
  hardenVariant,
  hydrateSpeciation,
  lineageView,
  pickVariant,
  promotionDecision,
  recordVariantObservation,
  runGauntlet,
  speciationConfig,
  variantSkillSummary,
  type ToolVariantDef,
} from "../engine/speciation.ts";
import { emptyToolSkill, observeToolSkill, skillSummary } from "../tools.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert: ${msg}`);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`assertEq: ${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

function summaryWith(calls: number, failures: number, ms: number) {
  let rec = emptyToolSkill("t", 1_000_000);
  for (let i = 0; i < calls; i++) {
    rec = observeToolSkill(rec, { ok: i >= failures, ms, code: i < failures ? "TOOL_ERROR" : null, error: i < failures ? "boom" : null }, 1_000_000 + i);
  }
  return skillSummary(rec, 1_000_000 + calls + 1);
}

function variantDef(partial: Partial<ToolVariantDef>): ToolVariantDef {
  const now = Date.now();
  return {
    name: "spec_unit_tool",
    variant_id: "spec_unit_tool@1-test",
    parent_id: null,
    generation: 1,
    operator: "rewrite",
    origin: "evolution",
    status: "shadow",
    description: "unit test tool",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    code: "return { echo: String(args.text ?? '') };",
    kind: "compute",
    probes: [{ args: { text: "hi" }, expect: { ok: true, result_includes: "hi" } }],
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

Deno.test("promotionDecision: evidence floor, competence, latency gate", () => {
  const cfg = speciationConfig();
  const champ = summaryWith(40, 20, 50);
  const novice = summaryWith(10, 0, 5);
  assert(!promotionDecision(champ, novice, cfg).promote, "10 perfect calls must not promote (evidence floor)");
  const strong = summaryWith(40, 0, 5);
  assert(promotionDecision(champ, strong, cfg).promote, "40/40 fast calls must promote over a 20/40 champion");
  const weak = summaryWith(40, 25, 5);
  assert(!promotionDecision(champ, weak, cfg).promote, "worse competence must not promote");
  const slow = summaryWith(40, 0, 5000);
  const fastChamp = summaryWith(40, 20, 10);
  assert(!promotionDecision(fastChamp, slow, cfg).promote, "a much slower challenger must not promote");
});

Deno.test("gauntlet: effect assertions reject a tool that does nothing", async () => {
  const liar = variantDef({ code: "return {};" });
  const res = await runGauntlet(liar, null);
  assert(!res.pass, "empty result must fail result_includes");
  const honest = variantDef({});
  const ok = await runGauntlet(honest, null);
  assert(ok.pass, `honest tool should pass, got: ${ok.notes.join("; ")}`);
  const probeless = variantDef({ probes: [] });
  const no = await runGauntlet(probeless, null);
  assert(!no.pass, "a variant with no probes must not be admitted");
  const broken = variantDef({ code: "return {{{;" });
  const syn = await runGauntlet(broken, null);
  assert(!syn.pass, "unparseable code must fail the static gate");
});

Deno.test("harden operator: wraps behavior, retries, stays within the code cap", async () => {
  const parent = variantDef({ operator: "original", status: "champion", code: "return { echo: String(args.text ?? '') };" });
  const hardened = hardenVariant(parent);
  assert(hardened, "harden must produce a variant");
  assertEq(hardened!.operator, "harden", "operator label");
  const res = await runGauntlet(hardened!, parent);
  assert(res.pass, `hardened variant should pass the gauntlet: ${res.notes.join("; ")}`);
});

Deno.test("lifecycle: forge → canary → measured promotion → retire", async () => {
  const name = "spec_lifecycle_echo";
  await retireForgedTool(name).catch(() => false);
  const def = await forgeTool({
    name,
    description: "echoes text back",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    code: "return { echo: String(args.text ?? '') };",
    kind: "compute",
  });
  const lin = await ensureLineage(def);
  const champId = lin.champion;
  assert(champId.includes("@0-") || champId.includes("@"), "generation-0 champion exists");

  // Champion path works before any speciation activity.
  const exec1 = await executeTool(name, { text: "yo" });
  assert(exec1.ok && JSON.stringify(exec1.result).includes("yo"), "champion executes");

  // Build a challenger from the champion and admit it through the gauntlet.
  const champ = getVariant(champId)!;
  const challenger = hardenVariant(champ)!;
  challenger.probes = [{ args: { text: "hi" }, expect: { ok: true, result_includes: "hi" } }];
  const admit = await admitVariant(challenger);
  assert(admit.pass, `challenger admitted: ${admit.notes.join("; ")}`);
  assertEq(getVariant(challenger.variant_id)!.status, "canary", "challenger is a canary");

  // Measured evidence: challenger flawless, champion coin-flip.
  for (let i = 0; i < 40; i++) await recordVariantObservation(challenger.variant_id, { ok: true, ms: 5 });
  for (let i = 0; i < 40; i++) await recordVariantObservation(champId, { ok: i % 2 === 0, ms: 50, error: "flaky", code: "TOOL_ERROR" });
  assert(variantSkillSummary(challenger.variant_id).competence > variantSkillSummary(champId).competence, "challenger out-scores champion");

  const actions = await evaluateLineage(name);
  assert(actions.some((a) => a.includes("promoted")), `promotion happened: ${actions.join(" | ")}`);
  const view = await lineageView(name);
  assertEq((view as any).champion, challenger.variant_id, "lineage champion flipped");

  const exec2 = await executeTool(name, { text: "still works" });
  assert(exec2.ok, "tool still executes after promotion");

  // Retire deletes the lineage entirely.
  await retireForgedTool(name);
  assertEq(await lineageView(name), null, "lineage deleted with the tool");
});

Deno.test("kill switch + champion floor: pickVariant honors both", async () => {
  const name = "spec_switch_echo";
  await retireForgedTool(name).catch(() => false);
  const def = await forgeTool({
    name,
    description: "echo for switch tests",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    code: "return { echo: String(args.text ?? '') };",
    kind: "compute",
  });
  const lin = await ensureLineage(def);
  const champ = getVariant(lin.champion)!;
  const challenger = hardenVariant(champ)!;
  challenger.probes = [{ args: { text: "hi" }, expect: { ok: true, result_includes: "hi" } }];
  await admitVariant(challenger);
  await hydrateSpeciation(true);

  Deno.env.set("KONO_SPECIATION_CHAMPION_FLOOR", "0");
  const pick = pickVariant(name, {});
  assert(pick && pick.variant_id === challenger.variant_id, "floor 0 routes to the canary");

  Deno.env.set("KONO_SPECIATION", "off");
  assertEq(pickVariant(name, {}), null, "kill switch forces the champion path");
  Deno.env.delete("KONO_SPECIATION");
  Deno.env.delete("KONO_SPECIATION_CHAMPION_FLOOR");
  await retireForgedTool(name);
});

Deno.test("specialize shape: eligibility follows the sampled arg patterns", async () => {
  const { specializeShape, specializeVariant } = await import("../engine/speciation.ts");
  const lin = (arg_patterns: Record<string, number>) => ({
    name: "spec_probe", champion: "spec_probe@0-x", variants: [], pinned: false, arg_patterns, updated_at: 0,
  });
  assert(specializeShape(lin({})) === null, "no samples → ineligible");
  assert(specializeShape(lin({ "a": 30 })) === null, "one shape only → nothing to specialize against");
  assert(specializeShape(lin({ "a": 10, "a,b": 9 })) === null, "under 20 samples → ineligible");
  assert(specializeShape(lin({ "a": 12, "a,b": 11, "a,b,c": 2 })) === null, "no dominant shape → ineligible");
  const dom = specializeShape(lin({ "a,b": 30, "a": 10, "a,b,c": 5 }));
  assert(dom !== null && dom.shape === "a,b" && dom.keys.join(",") === "a,b" && dom.share > 0.6, `dominant shape ${JSON.stringify(dom)}`);
  // Ineligible lineage → the operator itself is a no-op (no model call).
  const parent = {
    name: "spec_probe", variant_id: "spec_probe@0-x", parent_id: null, generation: 0,
    operator: "original", origin: "forge", status: "champion", description: "d",
    parameters: { type: "object", properties: {} }, code: "return 1;", kind: "compute",
    deterministic: true, admin: false, probes: [], created_at: 0, updated_at: 0,
  } as unknown as ToolVariantDef;
  assert(await specializeVariant(parent, lin({ "a": 3 })) === null, "specialize no-ops without a dominant shape");
});
