// engine/speciation.ts — TOOL SPECIATION: forged tools as evolving populations.
//
// A forged tool today is a singleton: one name, one body, replaced wholesale
// on re-forge. Speciation keeps a population of variants per canonical name.
// The champion serves from the exact KV key it always has
// (["mesh_forged_tools_v1", name]); challengers take a canary slice of live
// traffic, are scored with the same Bayesian skill machinery the plane keeps
// for whole tools (separate store, so canonical totals never double-count),
// and are promoted or retired on measured evidence. An hourly evolution
// cycle generates new variants with defined mutation operators and admits
// them only through a probe gauntlet whose assertions check *effects*, not
// just "didn't throw".
//
// Design + rationale: ~/workspace/your_files/tool-speciation-spec.md
// Every mechanism here is borrowed from something already in this codebase:
// the forge (engine/mesh.ts), ToolSkillRecord (tools.ts), Thompson draws
// (learning.ts), guarded Deno.cron cycles (main.ts), subagent-style internal
// completions (runSubagent). The novelty is the composition.
//
// Hard rules, in code order:
//  - admin tools and built-ins never speciate;
//  - with speciation disabled, or no lineage, or no canaries, a tool call is
//    byte-identical to the pre-speciation path;
//  - evolution never edits the champion in place — it only adds challengers;
//  - retired variants are kept (lineage is history); only retire_tool deletes.

import { kv, FORGED_TOOLS, TOOL_SKILLS, honoApp } from "../state.ts";
import { emptyToolSkill, observeToolSkill, skillSummary, normalizeToolName } from "../tools.ts";
import type { ToolSkillRecord, ToolSkillSummary, ToolContext } from "../tools.ts";
import type { Json, ForgedToolDef } from "../main.ts";
import { hydrateForgedTools } from "../main.ts";
import { compileForgedRun, validateForgedDef } from "./mesh.ts";
import { clamp as clampNum } from "../math.ts";
import { errText } from "../util.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeCase {
  args: Json;
  expect: {
    ok: boolean;
    result_includes?: string;
    result_path?: string;
    max_ms?: number;
  };
}

export type VariantOperator = "original" | "rewrite" | "param" | "compose" | "specialize" | "harden" | "manual";
export type VariantStatus = "shadow" | "canary" | "champion" | "retired";

export interface ToolVariantDef {
  name: string;
  variant_id: string;
  parent_id: string | null;
  generation: number;
  operator: VariantOperator;
  origin: "human" | "model" | "evolution";
  status: VariantStatus;
  description: string;
  parameters: Json;
  code: string;
  kind: string;
  deterministic?: boolean;
  admin?: boolean;
  timeout_ms?: number;
  probes: ProbeCase[];
  gauntlet_note?: string;
  created_at: number;
  updated_at: number;
}

export interface ToolLineage {
  name: string;
  champion: string;
  variants: string[];
  pinned: boolean;
  disabled?: boolean;
  /** Arg-key pattern counts (keys only, never values) — fuel for the
   *  specialize operator; sampled in the dispatch wrapper. */
  arg_patterns?: Record<string, number>;
  updated_at: number;
}

export interface EvolutionReport {
  at: number;
  targets: string[];
  actions: string[];
  mutations: number;
}

// ---------------------------------------------------------------------------
// Storage keys + config
// ---------------------------------------------------------------------------

export const TOOL_VARIANT_PREFIX = "mesh_tool_variants_v1";
export const TOOL_LINEAGE_PREFIX = "mesh_tool_lineage_v1";
export const VARIANT_SKILL_PREFIX = "mesh_variant_skills_v1";
export const EVOLUTION_PREFIX = "mesh_tool_evolution_v1";

export interface SpeciationConfig {
  enabled: boolean;
  championFloor: number;
  maxVariants: number;
  minCallsPromote: number;
  retireCalls: number;
  cycleBudget: number;
  mutatorModel: string;
  probeDeadlineMs: number;
}

/** Env number where an explicit "0" is meaningful (the champion floor) —
 *  the usual `Number(x) || dflt` idiom would silently restore the default. */
function envNum(name: string, dflt: number): number {
  const raw = Deno.env.get(name);
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/** Read at call time so the kill switch (and tests) take effect immediately. */
export function speciationConfig(): SpeciationConfig {
  return {
    enabled: Deno.env.get("KONO_SPECIATION") !== "off",
    championFloor: clampNum(envNum("KONO_SPECIATION_CHAMPION_FLOOR", 0.7), 0, 0.99),
    maxVariants: Math.round(clampNum(envNum("KONO_SPECIATION_MAX_VARIANTS", 4), 1, 16)),
    minCallsPromote: Math.round(clampNum(envNum("KONO_SPECIATION_MIN_CALLS", 30), 1, 10_000)),
    retireCalls: Math.round(clampNum(envNum("KONO_SPECIATION_RETIRE_CALLS", 50), 1, 100_000)),
    cycleBudget: Math.round(clampNum(envNum("KONO_SPECIATION_CYCLE_BUDGET", 3), 0, 32)),
    mutatorModel: Deno.env.get("KONO_SPECIATION_MUTATOR") || "free:code",
    probeDeadlineMs: Math.round(clampNum(envNum("KONO_SPECIATION_PROBE_MS", 2000), 100, 30_000)),
  };
}

export function speciationEnabled(): boolean {
  return speciationConfig().enabled;
}

// ---------------------------------------------------------------------------
// In-isolate caches (same stale-while-revalidate discipline as the forge)
// ---------------------------------------------------------------------------

const LINEAGES = new Map<string, ToolLineage>();
const VARIANTS = new Map<string, ToolVariantDef>();
const VARIANT_SKILLS = new Map<string, ToolSkillRecord>();
const COMPILED = new Map<string, (args: Json, ctx: ToolContext) => Promise<unknown>>();
let speciationHydratedAt = 0;
let speciationRefresh: Promise<void> | null = null;
const SPECIATION_TTL_MS = 30_000;

async function refreshSpeciation(): Promise<void> {
  const lineages = new Map<string, ToolLineage>();
  for await (const entry of kv.list<ToolLineage>({ prefix: [TOOL_LINEAGE_PREFIX] })) {
    if (entry.value && typeof entry.value.name === "string") lineages.set(entry.value.name, entry.value);
  }
  const variants = new Map<string, ToolVariantDef>();
  for await (const entry of kv.list<ToolVariantDef>({ prefix: [TOOL_VARIANT_PREFIX] })) {
    if (entry.value && typeof entry.value.variant_id === "string") variants.set(entry.value.variant_id, entry.value);
  }
  const skills = new Map<string, ToolSkillRecord>();
  for await (const entry of kv.list<ToolSkillRecord>({ prefix: [VARIANT_SKILL_PREFIX] })) {
    if (entry.value && typeof entry.value.tool === "string") skills.set(entry.value.tool, entry.value);
  }
  LINEAGES.clear(); for (const [k, v] of lineages) LINEAGES.set(k, v);
  VARIANTS.clear(); for (const [k, v] of variants) VARIANTS.set(k, v);
  VARIANT_SKILLS.clear(); for (const [k, v] of skills) VARIANT_SKILLS.set(k, v);
  speciationHydratedAt = Date.now();
}

/** Warm isolate never blocks on kv.list; a cold one hydrates once (the
 *  house stale-while-revalidate shape). pickVariant is synchronous and
 *  fire-and-forgets this; readers that need fresh state pass force. */
export function hydrateSpeciation(force = false): Promise<void> {
  const refresh = () => (speciationRefresh ??= refreshSpeciation()
    .catch((e) => console.error("speciation refresh:", e))
    .finally(() => { speciationRefresh = null; }));
  if (force || (LINEAGES.size === 0 && VARIANTS.size === 0)) return refresh();
  if (Date.now() - speciationHydratedAt >= SPECIATION_TTL_MS) refresh().catch((e) => console.error("speciation refresh:", e));
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function saveLineage(lin: ToolLineage): Promise<void> {
  lin.updated_at = Date.now();
  LINEAGES.set(lin.name, lin);
  await kv.set([TOOL_LINEAGE_PREFIX, lin.name], lin);
}

async function saveVariant(def: ToolVariantDef): Promise<void> {
  def.updated_at = Date.now();
  VARIANTS.set(def.variant_id, def);
  COMPILED.delete(def.variant_id);
  await kv.set([TOOL_VARIANT_PREFIX, def.name, def.variant_id], def);
}

export async function getLineage(nameRaw: string): Promise<ToolLineage | null> {
  const name = normalizeToolName(nameRaw);
  await hydrateSpeciation();
  return LINEAGES.get(name) ?? null;
}

export function getVariant(variantId: string): ToolVariantDef | null {
  return VARIANTS.get(variantId) ?? null;
}

function variantIdFor(name: string, generation: number): string {
  return `${name}@${generation}-${Math.random().toString(36).slice(2, 8)}`;
}

function defToVariant(def: ForgedToolDef, fields: Partial<ToolVariantDef>): ToolVariantDef {
  const now = Date.now();
  return {
    name: def.name,
    variant_id: fields.variant_id ?? variantIdFor(def.name, fields.generation ?? 0),
    parent_id: fields.parent_id ?? null,
    generation: fields.generation ?? 0,
    operator: fields.operator ?? "original",
    origin: fields.origin ?? "human",
    status: fields.status ?? "champion",
    description: def.description,
    parameters: def.parameters,
    code: def.code,
    kind: def.kind,
    deterministic: def.deterministic,
    admin: def.admin,
    timeout_ms: def.timeout_ms,
    probes: fields.probes ?? [],
    created_at: fields.created_at ?? def.created_at ?? now,
    updated_at: now,
  };
}

/** Snapshot the current champion def as generation 0, if no lineage exists. */
export async function ensureLineage(def: ForgedToolDef): Promise<ToolLineage> {
  await hydrateSpeciation();
  const existing = LINEAGES.get(def.name);
  if (existing) return existing;
  const gen0 = defToVariant(def, { generation: 0, operator: "original", status: "champion" });
  const lin: ToolLineage = {
    name: def.name,
    champion: gen0.variant_id,
    variants: [gen0.variant_id],
    pinned: false,
    updated_at: Date.now(),
  };
  await saveVariant(gen0);
  await saveLineage(lin);
  return lin;
}

/** Called by forgeTool after every (re-)forge: human/model edits join the
 *  lineage as a new champion instead of erasing history. The previous
 *  champion is kept as a retired variant. */
export async function recordManualVariant(def: ForgedToolDef, origin: "human" | "model"): Promise<void> {
  if (!speciationEnabled() || def.admin) return;
  await hydrateSpeciation();
  const lin = LINEAGES.get(def.name);
  if (!lin) { await ensureLineage(def); return; }
  const champ = VARIANTS.get(lin.champion);
  if (champ && champ.code === def.code && champ.description === def.description) return; // same def, nothing new
  const generation = Math.max(0, ...lin.variants.map((id) => VARIANTS.get(id)?.generation ?? 0)) + 1;
  const manual = defToVariant(def, { generation, operator: "manual", origin, status: "champion", parent_id: lin.champion });
  if (champ && champ.status === "champion") { champ.status = "retired"; await saveVariant(champ); }
  await saveVariant(manual);
  lin.champion = manual.variant_id;
  lin.variants.push(manual.variant_id);
  await saveLineage(lin);
}

/** Called by retireForgedTool: the only path that deletes lineage. */
export async function cleanupLineage(nameRaw: string): Promise<void> {
  const name = normalizeToolName(nameRaw);
  await hydrateSpeciation();
  const lin = LINEAGES.get(name);
  if (lin) {
    for (const id of lin.variants) {
      VARIANTS.delete(id);
      COMPILED.delete(id);
      await kv.delete([TOOL_VARIANT_PREFIX, name, id]).catch(() => undefined);
      await kv.delete([VARIANT_SKILL_PREFIX, id]).catch(() => undefined);
      VARIANT_SKILLS.delete(id);
    }
    LINEAGES.delete(name);
  }
  await kv.delete([TOOL_LINEAGE_PREFIX, name]).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Per-variant skill records (own store: canonical totals never double-count)
// ---------------------------------------------------------------------------

async function atomicVariantSkill(
  variantId: string,
  mutator: (current: ToolSkillRecord) => ToolSkillRecord,
  maxRetries = 3,
): Promise<void> {
  const key = [VARIANT_SKILL_PREFIX, variantId];
  const now = Date.now();
  const seeded = VARIANT_SKILLS.get(variantId) ?? emptyToolSkill(variantId, now);
  VARIANT_SKILLS.set(variantId, mutator(seeded));
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const entry = await kv.get<ToolSkillRecord>(key);
    const updated = mutator(entry.value ?? emptyToolSkill(variantId, now));
    const res = await kv.atomic().set(key, updated).commit();
    if (res.ok) { VARIANT_SKILLS.set(variantId, updated); return; }
    await new Promise((r) => setTimeout(r, 10 * (attempt + 1) + Math.random() * 15));
  }
}

export async function recordVariantObservation(
  variantId: string,
  obs: { ok: boolean; ms: number; error?: string | null; code?: string | null },
): Promise<void> {
  try {
    await atomicVariantSkill(variantId, (rec) =>
      observeToolSkill(rec, { ok: obs.ok, ms: obs.ms, error: obs.ok ? null : obs.error ?? null, code: obs.ok ? null : obs.code ?? null }, Date.now()));
  } catch (err) {
    console.error("[speciation] variant skill update failed:", err);
  }
}

export function variantSkillSummary(variantId: string, now = Date.now()): ToolSkillSummary {
  const rec = VARIANT_SKILLS.get(variantId) ?? emptyToolSkill(variantId, now);
  return skillSummary(rec, now);
}

// ---------------------------------------------------------------------------
// Dispatch: variant selection + execution (called from the forge wrapper)
// ---------------------------------------------------------------------------

/** Arg-key sampler: records which argument *shapes* a tool is called with
 *  (sorted key names only — never values). Persisted lazily by the cycle. */
export function sampleArgPattern(name: string, args: Json): void {
  const lin = LINEAGES.get(name);
  if (!lin) return;
  const shape = Object.keys(args ?? {}).sort().join(",");
  lin.arg_patterns = lin.arg_patterns ?? {};
  lin.arg_patterns[shape] = Math.min(1_000_000, (lin.arg_patterns[shape] ?? 0) + 1);
  const total = Object.values(lin.arg_patterns).reduce((a, b) => a + b, 0);
  if (total % 50 === 0) void kv.set([TOOL_LINEAGE_PREFIX, name], lin).catch(() => undefined);
}

/** Pick a non-champion variant for this call, or null to run the champion.
 *  Synchronous by design: the plane cannot stall on evolution bookkeeping.
 *  The champion floor is a guaranteed share; the rest is Thompson-split
 *  among canaries on their measured posteriors. */
export function pickVariant(name: string, locals: Json | undefined): ToolVariantDef | null {
  if (!speciationEnabled()) return null;
  void hydrateSpeciation();
  const lin = LINEAGES.get(name);
  if (!lin || lin.disabled || lin.pinned) return null;
  const pin = locals?.tool_variant;
  if (typeof pin === "string") {
    const pinned = VARIANTS.get(pin);
    if (pinned && pinned.name === name && pinned.status !== "retired") return pinned;
  }
  const canaries = lin.variants
    .map((id) => VARIANTS.get(id))
    .filter((v): v is ToolVariantDef => !!v && v.status === "canary");
  if (canaries.length === 0) return null;
  const cfg = speciationConfig();
  if (Math.random() < cfg.championFloor) return null;
  const now = Date.now();
  let best: ToolVariantDef | null = null;
  let bestDraw = -1;
  for (const v of canaries) {
    const rec = VARIANT_SKILLS.get(v.variant_id);
    // No evidence yet: optimistic prior so fresh canaries get explored.
    const draw = rec && rec.calls > 0 ? skillSummary(rec, now).competence_draw : 0.55 + Math.random() * 0.1;
    if (draw > bestDraw) { bestDraw = draw; best = v; }
  }
  return best;
}

function compiledFor(def: ToolVariantDef): (args: Json, ctx: ToolContext) => Promise<unknown> {
  let run = COMPILED.get(def.variant_id);
  if (!run) {
    run = compileForgedRun(def.code);
    COMPILED.set(def.variant_id, run);
  }
  return run;
}

/** Execute a picked variant and record the outcome on *its* skill record.
 *  Errors propagate exactly like a champion error — the plane's handling
 *  (deadlines, error codes, canonical skill record) is untouched. */
export async function runVariantExecution(def: ToolVariantDef, args: Json, ctx: ToolContext): Promise<unknown> {
  const t0 = performance.now();
  try {
    const result = await compiledFor(def)(args, ctx);
    void recordVariantObservation(def.variant_id, { ok: true, ms: Math.max(0, Math.round(performance.now() - t0)) });
    return result;
  } catch (err) {
    void recordVariantObservation(def.variant_id, {
      ok: false,
      ms: Math.max(0, Math.round(performance.now() - t0)),
      error: errText(err).slice(0, 200),
      code: "TOOL_ERROR",
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The gauntlet — candidate admission. Effect assertions, not "didn't throw":
// a variant that succeeds by doing less must fail here, not win.
// ---------------------------------------------------------------------------

export interface GauntletResult { pass: boolean; notes: string[] }

function probeCtx(deadlineMs: number): ToolContext {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("PROBE_TIMEOUT")), deadlineMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    signal: ctrl.signal,
    now: Date.now(),
    deadlineMs: performance.now() + deadlineMs,
    locals: {},
    caps: { kv: kv as never, namespace: "speciation-probe" },
    event: undefined,
  } as ToolContext;
}

function resultPathValue(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

async function runProbe(run: (args: Json, ctx: ToolContext) => Promise<unknown>, probe: ProbeCase, deadlineMs: number): Promise<string | null> {
  const t0 = performance.now();
  let result: unknown;
  let threw: string | null = null;
  try {
    result = await run(probe.args, probeCtx(deadlineMs));
  } catch (err) {
    threw = errText(err).slice(0, 160);
  }
  const ms = performance.now() - t0;
  if (probe.expect.ok && threw) return `expected success, threw: ${threw}`;
  if (!probe.expect.ok && !threw) return "expected failure, but the call succeeded";
  if (threw) return null;
  if (probe.expect.max_ms !== undefined && ms > probe.expect.max_ms) return `probe took ${Math.round(ms)}ms > max_ms ${probe.expect.max_ms}`;
  if (probe.expect.result_includes !== undefined) {
    const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
    if (!text.includes(probe.expect.result_includes)) return `result does not include ${JSON.stringify(probe.expect.result_includes)}`;
  }
  if (probe.expect.result_path !== undefined && resultPathValue(result, probe.expect.result_path) === undefined) {
    return `result path ${probe.expect.result_path} is missing`;
  }
  return null;
}

export async function runGauntlet(candidate: ToolVariantDef, parent: ToolVariantDef | null): Promise<GauntletResult> {
  const notes: string[] = [];
  try {
    validateForgedDef({
      name: candidate.name,
      description: candidate.description,
      parameters: candidate.parameters,
      code: candidate.code,
      kind: candidate.kind,
      deterministic: candidate.deterministic,
      admin: candidate.admin,
      timeout_ms: candidate.timeout_ms,
    });
  } catch (err) {
    return { pass: false, notes: [`static gate: ${errText(err).slice(0, 200)}`] };
  }
  const probes = candidate.probes.length > 0 ? candidate.probes : parent?.probes ?? [];
  if (probes.length === 0) {
    return { pass: false, notes: ["no probes: a variant that cannot prove an effect cannot take live traffic"] };
  }
  const cfg = speciationConfig();
  const run = compileForgedRun(candidate.code);
  for (const [i, probe] of probes.slice(0, 10).entries()) {
    const failure = await runProbe(run, probe, cfg.probeDeadlineMs);
    if (failure) return { pass: false, notes: [`probe ${i}: ${failure}`] };
  }
  notes.push(`${Math.min(probes.length, 10)} probes passed`);
  // Differential note: if the parent *fails* a probe the candidate passes,
  // that is an improvement signal worth recording (not a rejection).
  if (parent && (candidate.operator === "rewrite" || candidate.operator === "harden")) {
    try {
      const parentRun = compileForgedRun(parent.code);
      for (const probe of probes.slice(0, 10)) {
        const failure = await runProbe(parentRun, probe, cfg.probeDeadlineMs);
        if (failure) { notes.push(`differential: parent fails a probe the candidate passes (${failure})`); break; }
      }
    } catch { /* a parent that no longer compiles is its own signal; ignore */ }
  }
  return { pass: true, notes };
}

/** Gauntlet + persist. Passing candidates enter as canaries; failures stay
 *  shadow with the reason recorded on the def. */
export async function admitVariant(candidate: ToolVariantDef): Promise<GauntletResult> {
  await hydrateSpeciation();
  const lin = LINEAGES.get(candidate.name) ?? await ensureLineage(FORGED_TOOLS.get(candidate.name) ?? (() => { throw new Error(`unknown forged tool ${candidate.name}`); })());
  const parent = VARIANTS.get(candidate.parent_id ?? "") ?? VARIANTS.get(lin.champion) ?? null;
  const result = await runGauntlet(candidate, parent);
  candidate.status = result.pass ? "canary" : "shadow";
  candidate.gauntlet_note = result.notes.join("; ").slice(0, 500);
  if (!lin.variants.includes(candidate.variant_id)) lin.variants.push(candidate.variant_id);
  await saveVariant(candidate);
  await saveLineage(lin);
  return result;
}

// ---------------------------------------------------------------------------
// Variation operators
// ---------------------------------------------------------------------------

function baseVariant(parent: ToolVariantDef, operator: VariantOperator, fields: Partial<ToolVariantDef>): ToolVariantDef {
  const now = Date.now();
  return {
    name: parent.name,
    variant_id: variantIdFor(parent.name, parent.generation + 1),
    parent_id: parent.variant_id,
    generation: parent.generation + 1,
    operator,
    origin: "evolution",
    status: "shadow",
    description: parent.description,
    parameters: parent.parameters,
    code: parent.code,
    kind: parent.kind,
    deterministic: parent.deterministic,
    admin: parent.admin,
    timeout_ms: parent.timeout_ms,
    probes: parent.probes,
    created_at: now,
    updated_at: now,
    ...fields,
  };
}

/** harden: wrap the parent body in a deterministic shell — one retry on
 *  transient errors, oversized string results clamped. Pure template. */
export function hardenVariant(parent: ToolVariantDef): ToolVariantDef | null {
  const code = [
    "const __parentRun = async (args, api) => {",
    parent.code,
    "};",
    "const __transient = (e) => /timeout|rate.?limit|temporar|network|econn|fetch failed|overloaded|503|502/i.test(String((e && e.message) || e));",
    "let __lastErr;",
    "for (let __i = 0; __i < 2; __i++) {",
    "  try {",
    "    const __r = await __parentRun(args, api);",
    "    const __s = typeof __r === 'string' ? __r : null;",
    "    if (__s && __s.length > 60000) return __s.slice(0, 60000) + '…[clamped by harden variant]';",
    "    return __r;",
    "  } catch (e) { __lastErr = e; if (!__transient(e) || __i === 1) throw e; }",
    "}",
    "throw __lastErr;",
  ].join("\n");
  if (code.length > 16_384) return null;
  return baseVariant(parent, "harden", { code });
}

/** The specialize operator's fuel, made legible: the dominant argument shape
 *  of a lineage, when the sampled patterns prove one shape dominates. Pure —
 *  eligibility is ≥20 samples, ≥2 distinct shapes, dominant share ≥50%. */
export function specializeShape(lin: ToolLineage): { shape: string; keys: string[]; share: number; total: number } | null {
  const patterns = lin.arg_patterns ?? {};
  const entries = Object.entries(patterns);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (total < 20 || entries.length < 2) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [shape, count] = entries[0];
  const share = count / total;
  if (share < 0.5) return null;
  return { shape, keys: shape ? shape.split(",") : [], share, total };
}

/** specialize: a model rewrites the body around the *measured* dominant
 *  argument shape — a direct fast path for the shape most callers actually
 *  send, with the original logic preserved for every other shape. The probe
 *  gauntlet still decides admission, so a "specialization" that changes
 *  behavior for any probed input never leaves shadow. */
export async function specializeVariant(parent: ToolVariantDef, lin: ToolLineage): Promise<ToolVariantDef | null> {
  const dom = specializeShape(lin);
  if (!dom) return null;
  const prompt = [
    `Tool: ${parent.name}`,
    `Description: ${parent.description}`,
    `Parameters schema: ${JSON.stringify(parent.parameters).slice(0, 1500)}`,
    `Measured argument shapes (sorted key names, values never recorded): ${JSON.stringify(lin.arg_patterns ?? {}).slice(0, 800)}`,
    `Dominant shape: keys [${dom.keys.join(", ")}] account for ${Math.round(dom.share * 100)}% of ${dom.total} sampled calls.`,
    "Produce a specialized variant: when the incoming args carry exactly the dominant key set, take a direct minimal path (precomputed lookups, no generic branching); for ANY other key set, fall back to logic equivalent to the current body. Behavior and return shape must be identical for every input — only the common path gets faster/simpler.",
    "Current body:",
    parent.code,
  ].join("\n");
  const raw = await mutateWithModel(prompt);
  if (!raw) return null;
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.code !== "string" || !parsed.code.trim()) return null;
  const probes = Array.isArray(parsed.probes)
    ? (parsed.probes as Json[]).filter((p) => p && typeof p === "object" && "args" in p && "expect" in p).slice(0, 6) as unknown as ProbeCase[]
    : [];
  return baseVariant(parent, "specialize", {
    code: String(parsed.code),
    description: typeof parsed.description === "string" && parsed.description.trim() ? String(parsed.description).slice(0, 1024) : parent.description,
    probes: probes.length ? probes : parent.probes,
  });
}

/** param: mutate the non-code genome. Timeout follows the measured latency:
 *  a champion whose p95 crowds its deadline gets headroom; one with slack
 *  gets tightened so failures surface faster. Description untouched here —
 *  wording mutations ride the rewrite operator, where a model can do them
 *  deliberately instead of by template. */
export function paramVariant(parent: ToolVariantDef): ToolVariantDef | null {
  const summary = variantSkillSummary(parent.variant_id);
  const current = parent.timeout_ms ?? 4000;
  let next = current;
  if (summary.calls >= 10 && summary.p95_ms > current * 0.8) next = Math.min(30_000, Math.round(current * 1.5));
  else if (summary.calls >= 10 && summary.p95_ms < current * 0.25) next = Math.max(500, Math.round(current * 0.6));
  if (next === current) next = current >= 8000 ? 4000 : 8000; // unexplored timeout: try the other standard setting
  if (next === parent.timeout_ms) return null;
  return baseVariant(parent, "param", { timeout_ms: next });
}

const MUTATOR_SYSTEM =
  "You are the mutation operator for a tool-evolution system. You receive one JavaScript tool body, its measured failure modes, and its latency. " +
  "Rewrite the body to be more robust and no slower, preserving its behavior and return shape. " +
  "Reply with a single JSON object, no prose: {\"code\": \"<new function body>\", \"description\": \"<one-sentence tool description>\", \"probes\": [{\"args\": {...}, \"expect\": {\"ok\": true, \"result_includes\": \"...\"}}]}. " +
  "Probes are executable proof: 2-4 calls with effect assertions a correct implementation must satisfy. The code is a function body receiving (args, api); api has fetch, kv, namespace, now, signal. Code must stay under 16000 characters.";

async function mutateWithModel(prompt: string): Promise<string | null> {
  const cfg = speciationConfig();
  try {
    const res = await honoApp.fetch(new Request("http://kono.internal/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.mutatorModel,
        messages: [
          { role: "system", content: MUTATOR_SYSTEM },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    }));
    const j = await res.json().catch(() => null) as Json | null;
    const choices = (j?.choices as Json[] | undefined) ?? [];
    const content = (choices[0]?.message as Json | undefined)?.content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): Json | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)) as Json; } catch { return null; }
}

/** rewrite: a model rewrites the body, aimed at the parent's *measured*
 *  failures (top error codes + latency from its skill record). */
export async function rewriteVariant(parent: ToolVariantDef): Promise<ToolVariantDef | null> {
  const summary = variantSkillSummary(parent.variant_id);
  const canonRec = TOOL_SKILLS.get(parent.name);
  const canon = canonRec ? skillSummary(canonRec, Date.now()) : null;
  const topErrors = (summary.top_errors.length ? summary.top_errors : canon?.top_errors ?? [])
    .map((e) => `${e.code}×${e.count}`).join(", ") || "none recorded";
  const prompt = [
    `Tool: ${parent.name}`,
    `Description: ${parent.description}`,
    `Parameters schema: ${JSON.stringify(parent.parameters).slice(0, 1500)}`,
    `Measured: calls=${Math.max(summary.calls, canon?.calls ?? 0)}, success_rate=${canon?.success_rate ?? summary.success_rate}, p50_ms=${summary.p50_ms}, p95_ms=${summary.p95_ms}`,
    `Top failure modes: ${topErrors}; last error: ${summary.last_error ?? canon?.last_error ?? "none"}`,
    "Current body:",
    parent.code,
  ].join("\n");
  const raw = await mutateWithModel(prompt);
  if (!raw) return null;
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.code !== "string" || !parsed.code.trim()) return null;
  const probes = Array.isArray(parsed.probes)
    ? (parsed.probes as Json[]).filter((p) => p && typeof p === "object" && "args" in p && "expect" in p).slice(0, 6) as unknown as ProbeCase[]
    : [];
  return baseVariant(parent, "rewrite", {
    code: String(parsed.code),
    description: typeof parsed.description === "string" && parsed.description.trim() ? String(parsed.description).slice(0, 1024) : parent.description,
    probes: probes.length ? probes : parent.probes,
  });
}

// ---------------------------------------------------------------------------
// Selection: promotion + retirement on measured evidence
// ---------------------------------------------------------------------------

/** Pure decision — the testable heart of selection. A challenger promotes
 *  only on enough calls, a strictly better Wilson floor, and no material
 *  latency regression. */
export function promotionDecision(
  champ: ToolSkillSummary,
  can: ToolSkillSummary,
  cfg: SpeciationConfig = speciationConfig(),
): { promote: boolean; reason: string } {
  if (can.calls < cfg.minCallsPromote) return { promote: false, reason: `insufficient evidence (${can.calls}/${cfg.minCallsPromote} calls)` };
  if (can.competence <= champ.competence) return { promote: false, reason: `competence ${can.competence} does not beat champion ${champ.competence}` };
  if (champ.calls >= cfg.minCallsPromote && can.p95_ms > champ.p95_ms * 1.25) {
    return { promote: false, reason: `latency regression (p95 ${can.p95_ms}ms vs champion ${champ.p95_ms}ms)` };
  }
  return { promote: true, reason: `competence ${can.competence} > champion ${champ.competence} on ${can.calls} calls` };
}

async function applyPromotion(lin: ToolLineage, winner: ToolVariantDef): Promise<void> {
  const { registerForgedTool } = await import("./mesh.ts");
  const oldChamp = VARIANTS.get(lin.champion);
  if (oldChamp && oldChamp.variant_id !== winner.variant_id && oldChamp.status === "champion") {
    oldChamp.status = "canary"; // the deposed champion can win its seat back
    await saveVariant(oldChamp);
  }
  winner.status = "champion";
  await saveVariant(winner);
  const def: ForgedToolDef = {
    name: winner.name,
    description: winner.description,
    parameters: winner.parameters,
    kind: winner.kind,
    code: winner.code,
    deterministic: winner.deterministic,
    admin: winner.admin,
    timeout_ms: winner.timeout_ms,
    created_at: winner.created_at,
    updated_at: Date.now(),
  };
  await kv.set(["mesh_forged_tools_v1", winner.name], def);
  FORGED_TOOLS.set(winner.name, def);
  registerForgedTool(def);
  lin.champion = winner.variant_id;
  await saveLineage(lin);
}

/** Evaluate one tool's population: retire proven losers, promote a proven
 *  winner. Returns human-readable actions taken. */
export async function evaluateLineage(nameRaw: string): Promise<string[]> {
  const actions: string[] = [];
  if (!speciationEnabled()) return actions;
  await hydrateSpeciation();
  const name = normalizeToolName(nameRaw);
  const lin = LINEAGES.get(name);
  if (!lin) return actions;
  const cfg = speciationConfig();
  const champDef = VARIANTS.get(lin.champion);
  if (!champDef) return actions;
  const champSummary = variantSkillSummary(lin.champion);
  // A fresh champion has no variant-keyed record yet; fall back to the
  // canonical tool record so a proven champion is not judged as a novice.
  const canonRec = TOOL_SKILLS.get(name);
  const champEffective = champSummary.calls > 0 || !canonRec ? champSummary : skillSummary(canonRec, Date.now());
  for (const id of [...lin.variants]) {
    const v = VARIANTS.get(id);
    if (!v || v.status !== "canary") continue;
    const s = variantSkillSummary(id);
    if (s.calls >= cfg.retireCalls && s.competence < champEffective.competence * 0.85) {
      v.status = "retired";
      await saveVariant(v);
      actions.push(`${name}: retired ${id} (competence ${s.competence} after ${s.calls} calls)`);
      continue;
    }
    const decision = promotionDecision(champEffective, s, cfg);
    if (decision.promote) {
      await applyPromotion(lin, v);
      actions.push(`${name}: promoted ${id} (${decision.reason})`);
      break; // one promotion per evaluation; the new champion resets the field
    }
  }
  return actions;
}

/** Manual promotion (admin): gauntlet first for shadows, thresholds waived. */
export async function promoteVariantManual(nameRaw: string, variantId: string): Promise<{ ok: boolean; message: string }> {
  await hydrateSpeciation();
  const name = normalizeToolName(nameRaw);
  const lin = LINEAGES.get(name);
  const v = VARIANTS.get(variantId);
  if (!lin || !v || v.name !== name) return { ok: false, message: "variant not found" };
  if (v.status === "champion") return { ok: false, message: "already champion" };
  if (v.status === "shadow") {
    const parent = VARIANTS.get(lin.champion) ?? null;
    const g = await runGauntlet(v, parent);
    if (!g.pass) return { ok: false, message: `gauntlet failed: ${g.notes.join("; ")}` };
  }
  if (v.status === "retired") return { ok: false, message: "retired variants cannot promote" };
  await applyPromotion(lin, v);
  return { ok: true, message: `promoted ${variantId}` };
}

export async function retireVariantById(nameRaw: string, variantId: string): Promise<boolean> {
  await hydrateSpeciation();
  const name = normalizeToolName(nameRaw);
  const lin = LINEAGES.get(name);
  const v = VARIANTS.get(variantId);
  if (!lin || !v || v.name !== name || v.status === "champion") return false;
  v.status = "retired";
  await saveVariant(v);
  return true;
}

export async function setPin(nameRaw: string, pinned: boolean): Promise<boolean> {
  const lin = await getLineage(nameRaw);
  if (!lin) return false;
  lin.pinned = pinned;
  await saveLineage(lin);
  return true;
}

// ---------------------------------------------------------------------------
// Views (routes + the tool_lineage meta-tool read these)
// ---------------------------------------------------------------------------

export async function lineageView(nameRaw: string, includeCode = false): Promise<Json | null> {
  await hydrateSpeciation();
  const name = normalizeToolName(nameRaw);
  const lin = LINEAGES.get(name);
  if (!lin) return null;
  const now = Date.now();
  return {
    name,
    champion: lin.champion,
    pinned: lin.pinned,
    disabled: lin.disabled ?? false,
    arg_patterns: lin.arg_patterns ?? {},
    variants: lin.variants.map((id) => {
      const v = VARIANTS.get(id);
      if (!v) return { variant_id: id, missing: true };
      const s = variantSkillSummary(id, now);
      return {
        variant_id: id,
        parent_id: v.parent_id,
        generation: v.generation,
        operator: v.operator,
        origin: v.origin,
        status: v.status,
        description: v.description,
        timeout_ms: v.timeout_ms ?? null,
        probes: v.probes.length,
        gauntlet_note: v.gauntlet_note ?? null,
        skill: { calls: s.calls, errors: s.errors, success_rate: s.success_rate, competence: s.competence, p50_ms: s.p50_ms, p95_ms: s.p95_ms, top_errors: s.top_errors },
        ...(includeCode ? { code: v.code } : { code_bytes: v.code.length }),
        created_at: v.created_at,
        updated_at: v.updated_at,
      };
    }),
  };
}

export async function speciationOverview(): Promise<Json> {
  await hydrateSpeciation();
  const reports: EvolutionReport[] = [];
  for await (const entry of kv.list<EvolutionReport>({ prefix: [EVOLUTION_PREFIX] })) {
    if (entry.value) reports.push(entry.value);
  }
  reports.sort((a, b) => b.at - a.at);
  return {
    enabled: speciationEnabled(),
    config: speciationConfig() as unknown as Json,
    tools: [...LINEAGES.values()].map((lin) => ({
      name: lin.name,
      champion: lin.champion,
      pinned: lin.pinned,
      variants: lin.variants.map((id) => ({ variant_id: id, status: VARIANTS.get(id)?.status ?? "missing" })),
    })),
    recent_cycles: reports.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// The evolution cycle
// ---------------------------------------------------------------------------

function selectTargets(budget: number): string[] {
  const now = Date.now();
  const scored: Array<{ name: string; score: number }> = [];
  for (const def of FORGED_TOOLS.values()) {
    if (def.admin) continue;
    const rec = TOOL_SKILLS.get(def.name);
    if (!rec) continue;
    const s = skillSummary(rec, now);
    if (s.calls < 30) continue;
    // Worst competence first; high-traffic slow tools next. Lower = needier.
    const score = s.competence * 1000 - Math.min(500, s.calls / 10) + (s.p95_ms > 3000 ? -100 : 0);
    scored.push({ name: def.name, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, budget).map((t) => t.name);
}

export async function runEvolutionCycle(opts: { toolName?: string; budget?: number } = {}): Promise<EvolutionReport> {
  const at = Date.now();
  const cfg = speciationConfig();
  const report: EvolutionReport = { at, targets: [], actions: [], mutations: 0 };
  if (!cfg.enabled) { report.actions.push("speciation disabled (KONO_SPECIATION=off)"); return report; }
  await hydrateForgedTools().catch(() => undefined);
  await hydrateSpeciation();
  const budget = opts.budget ?? cfg.cycleBudget;
  const targets = opts.toolName ? [normalizeToolName(opts.toolName)] : selectTargets(budget);
  report.targets = targets;
  for (const name of targets) {
    if (report.mutations >= budget) break;
    const def = FORGED_TOOLS.get(name);
    if (!def || def.admin) { report.actions.push(`${name}: skipped (not a forged tool or admin)`); continue; }
    const lin = await ensureLineage(def);
    if (lin.pinned || lin.disabled) { report.actions.push(`${name}: skipped (pinned/disabled)`); continue; }
    report.actions.push(...await evaluateLineage(name));
    const liveCount = lin.variants.filter((id) => { const s = VARIANTS.get(id)?.status; return s === "champion" || s === "canary"; }).length;
    if (liveCount >= cfg.maxVariants) { report.actions.push(`${name}: population at cap (${liveCount}/${cfg.maxVariants})`); continue; }
    const champ = VARIANTS.get(lin.champion);
    if (!champ) continue;
    // Operator choice: harden when the champion's failures look transient,
    // param when its timeout is untested/mismatched, rewrite otherwise —
    // rewrite is also the only cold-start operator (it brings its own probes).
    const champSummary = variantSkillSummary(lin.champion);
    const transientish = champSummary.top_errors.some((e) => /TIMEOUT|TOOL_ERROR/i.test(e.code)) && champ.probes.length > 0;
    let candidate: ToolVariantDef | null = null;
    if (transientish) candidate = hardenVariant(champ);
    if (!candidate && champ.probes.length > 0) candidate = paramVariant(champ);
    // specialize rides the arg-pattern telemetry: when one argument shape
    // dominates and no specialize variant is already in play, aim the
    // mutator at that shape before spending it on a generic rewrite.
    if (!candidate && specializeShape(lin) &&
      !lin.variants.some((id) => { const v = VARIANTS.get(id); return v && v.operator === "specialize" && v.status !== "retired"; })) {
      candidate = await specializeVariant(champ, lin);
    }
    if (!candidate) candidate = await rewriteVariant(champ);
    if (!candidate) { report.actions.push(`${name}: no candidate produced (mutator unavailable or operator no-op)`); continue; }
    const result = await admitVariant(candidate);
    report.mutations++;
    report.actions.push(`${name}: ${candidate.operator} variant ${candidate.variant_id} ${result.pass ? "admitted as canary" : `held in shadow (${result.notes.join("; ")})`}`);
    // Persist any arg-pattern samples gathered since the last cycle.
    await saveLineage(lin);
  }
  await kv.set([EVOLUTION_PREFIX, String(at)], report).catch(() => undefined);
  return report;
}
