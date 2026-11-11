// engine/mesh.ts — mesh subsystem, partitioned from engine.ts (originally main.ts).

import { AsyncFunction, FORGED_KINDS, serviceJsonLoadError, hydrateImageBlocks, IMAGE_CATALOG, IMAGE_STATS } from "../main.ts";
import type { Json, ForgedToolDef, RoutingMode, ScoredCandidate } from "../main.ts";
import { normalizeToolName, listTools, registerTool, unregisterTool, skillSummary, defaultAutoToolNames, toToolSpecs } from "../tools.ts";
import type { ToolContext, ToolSpec, ToolSkillRecord, ToolFlavor } from "../tools.ts";
import { clamp as clampNum } from "../math.ts";
import { FORGED_TOOLS, kv, honoApp, L1_CACHE, IMAGE_MODELS, IMAGE_BLOCKED } from "../state.ts";
import type { Context } from "hono";
import type { SubagentTask, SubagentResult } from "../toolbox/types.ts";
import { TEAM_ROLES } from "../toolbox/team.ts";
import { errText, classifyPromptIntent, extractMessageText, strictErrors, toolPlaneTotals, maxToolRounds, logErr } from "../util.ts";
import { getTrace, listTraces } from "../trace.ts";
import { getRankedCandidates, endpointCoverage, activeProviderList, hydrateImageCatalog } from "./providers.ts";
import { normalizeMessages } from "./dispatch.ts";
import { pickOpenRouterKey } from "./core.ts";





// ---------------------------------------------------------------------------
// FORGED TOOLS — tools the router creates for itself at runtime.
//
// A forged tool is a ToolSpec whose `run` is compiled from a JavaScript
// function body supplied at forge time — by an admin over HTTP, or by a
// model through the forge_tool meta-tool inside an admin session.
// Definitions persist in Deno KV and hydrate into the registry on a TTL,
// so a tool forged once is callable everywhere the plane runs (the agent
// loop, /v1/tools/execute, router_capabilities) with the same schema
// validation, deadlines and skill telemetry as a built-in.
//
// Trust model: forging is admin-only, because forged code executes in the
// isolate. The compiler shadows the ambient globals that matter (Deno,
// process, globalThis, Function) inside the tool body and hands the
// code a narrow `api` object ({ fetch, kv, namespace, signal, now,
// deadlineMs, locals, event }). That blocks accidents, not adversaries —
// treat forged code as operator code, because it is.
// ---------------------------------------------------------------------------

export const FORGED_TOOL_PREFIX = "mesh_forged_tools_v1";




export const FORGED_TTL_MS = 30_000;




export const FORGED_CODE_MAX = 16_384;





/** Compile a function body into a ToolSpec.run. The body receives `args`
 *  (the schema-validated arguments object) and `api`; its return value is
 *  the tool result. Throws on a syntax error, so an unparseable body can
 *  never register. */
export function compileForgedRun(code: string): (args: Json, ctx: ToolContext) => Promise<unknown> {
  // No "eval" parameter and no strict-mode prelude: `eval` is an illegal
  // binding name in strict mode, and the AsyncFunction constructor would
  // reject the whole body before a line of tool code runs.
  const factory = new AsyncFunction(
    "args", "api", "Deno", "process", "globalThis", "self", "window", "Function",
    code,
  );
  return async (args: Json, ctx: ToolContext) => {
    const api = {
      now: ctx.now,
      signal: ctx.signal,
      deadlineMs: ctx.deadlineMs,
      namespace: ctx.caps?.namespace ?? "shared",
      kv: ctx.caps?.kv,
      fetch: (input: string, init?: Record<string, unknown>) => (ctx.caps?.fetch ?? fetch)(input, init as RequestInit),
      locals: ctx.locals,
      event: ctx.event,
    };
    return await factory(args, api, undefined, undefined, undefined, undefined, undefined, undefined);
  };
}





export function validateForgedDef(input: Json): ForgedToolDef {
  const name = normalizeToolName(String(input.name ?? ""));
  if (!/^[a-z0-9_]{1,64}$/.test(name)) throw new Error(`invalid tool name: ${String(input.name ?? "").slice(0, 64)}`);
  const clash = listTools().find((t) => t.name === name && !t.dynamic);
  if (clash) throw new Error(`"${name}" is a built-in tool and cannot be overwritten`);
  const description = String(input.description ?? "").trim();
  if (!description) throw new Error("a description is required — it is how models decide to call the tool");
  if (description.length > 1024) throw new Error("description exceeds 1024 chars");
  const parameters = (typeof input.parameters === "object" && input.parameters !== null && !Array.isArray(input.parameters))
    ? input.parameters as Json
    : { type: "object", properties: {} };
  const code = String(input.code ?? "");
  if (!code.trim()) throw new Error("code (a JavaScript function body) is required");
  if (code.length > FORGED_CODE_MAX) throw new Error(`code exceeds ${FORGED_CODE_MAX} chars`);
  compileForgedRun(code); // syntax gate: a body that does not parse never registers
  const now = Date.now();
  return {
    name,
    description,
    parameters,
    kind: FORGED_KINDS.has(String(input.kind)) ? String(input.kind) : "compute",
    code,
    deterministic: input.deterministic === true,
    admin: input.admin === true,
    timeout_ms: input.timeout_ms === undefined ? undefined : Math.round(clampNum(Number(input.timeout_ms) || 4000, 100, 30_000)),
    created_at: FORGED_TOOLS.get(name)?.created_at ?? now,
    updated_at: now,
  };
}





export function registerForgedTool(def: ForgedToolDef): void {
  FORGED_TOOLS.set(def.name, def);
  registerTool({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    kind: def.kind as ToolSpec["kind"],
    deterministic: def.deterministic,
    admin: def.admin,
    timeoutMs: def.timeout_ms,
    dynamic: true,
    run: compileForgedRun(def.code),
  });
}





/** Validate, persist and register a forged tool (create or replace). */
export async function forgeTool(input: Json): Promise<ForgedToolDef> {
  const def = validateForgedDef(input);
  await kv.set([FORGED_TOOL_PREFIX, def.name], def);
  registerForgedTool(def);
  return def;
}





/** Remove a forged tool from the registry and KV. Built-ins are refused. */
export async function retireForgedTool(nameRaw: string): Promise<boolean> {
  const name = normalizeToolName(nameRaw);
  if (!FORGED_TOOLS.has(name)) return false;
  FORGED_TOOLS.delete(name);
  unregisterTool(name);
  await kv.delete([FORGED_TOOL_PREFIX, name]);
  return true;
}





/** A sub-agent is an ordinary buffered tool-using completion through this same
 *  router, in the caller's session (shared workspace) with the caller's
 *  credentials, marked one level deeper so it cannot spawn further agents. */
export async function runSubagent(c: Context, t: SubagentTask, depth: number, model: string | undefined, runner: boolean, signal: AbortSignal): Promise<SubagentResult> {
  const t0 = performance.now();
  const headers = new Headers({ "content-type": "application/json", "x-nokey-depth": String(depth) });
  for (const h of ["x-nokey-session", "x-session-id", "authorization", "x-admin-secret", "x-api-key", "x-forwarded-for"]) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  const builds = t.role === "builder" || t.role === "debugger";
  const body = {
    model: t.model || model || "free:code",
    messages: [{ role: "system", content: TEAM_ROLES[t.role] ?? TEAM_ROLES.builder }, { role: "user", content: t.task }],
    tools: "auto",
    nokey_rounds: Math.round(clampNum(Number(t.rounds) || 20, 1, 32)),
    nokey_gate: builds,
    ...(runner ? { nokey_runner: true } : {}),
    stream: false,
  };
  try {
    const res = await honoApp.fetch(new Request(new URL("/v1/chat/completions", c.req.url), { method: "POST", headers, body: JSON.stringify(body), signal }));
    const j = JSON.parse(await res.text()) as Json;
    const msg = ((j.choices as Json[] | undefined)?.[0]?.message ?? {}) as Json;
    const nk = (j.nokey ?? {}) as Json;
    const err = (j.error as Json | undefined)?.message;
    return {
      role: t.role,
      ok: !err && nk.degraded !== true,
      content: String(msg.content ?? "").slice(0, 12_000),
      model: typeof j.model === "string" ? j.model : undefined,
      tool_rounds: typeof nk.tool_rounds === "number" ? nk.tool_rounds : 0,
      tools: Array.isArray(nk.tools_executed) ? (nk.tools_executed as Json[]).map((e) => `${e.tool}${e.ok ? "" : " ✗"}`).slice(0, 60) : [],
      ms: Math.round(performance.now() - t0),
      ...(err ? { error: String(err).slice(0, 300) } : {}),
    };
  } catch (e) {
    return { role: t.role, ok: false, content: "", ms: Math.round(performance.now() - t0), error: errText(e).slice(0, 300) };
  }
}





// ---------------------------------------------------------------------------
// MESH TOOLS — the router's own capabilities, exposed to every model
// ---------------------------------------------------------------------------

export function registerMeshTools(): void {
  registerTool({
    name: "router_catalog",
    aliases: ["router.catalog", "catalog", "mesh_catalog"],
    kind: "mesh",
    description:
      "Rank the nokey-router mesh right now: the live (provider, model) tuples the dispatcher would actually try, with their learned telemetry — effective IQ, reliability draw, EWMA TTFT, expected completion time, and tool-call competence. Use it to answer \"which model should I use?\" with evidence instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "smart", "code", "reasoning", "tools"], default: "smart", description: "Which lane to rank. `tools` ranks by learned tool-call competence." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        provider: { type: "string", description: "Only tuples from this provider id." },
        min_iq: { type: "number", minimum: 0, maximum: 1, description: "Drop tuples below this effective IQ." },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const modeRaw = String(args.mode ?? "smart").toLowerCase();
      const mode: RoutingMode = (["fast", "smart", "code", "reasoning"].includes(modeRaw) ? modeRaw : "smart") as RoutingMode;
      const toolAware = modeRaw === "tools";
      const limit = Math.round(clampNum(Number(args.limit ?? 10), 1, 50));
      const minIq = Number(args.min_iq ?? 0);
      const provider = typeof args.provider === "string" ? args.provider.toLowerCase() : undefined;
      const ranked = await getRankedCandidates(mode, true, false, { toolAware });
      const rows = ranked
        .filter((c) => (!provider || c.providerId.toLowerCase().includes(provider)) && c.iqEffective >= minIq)
        .slice(0, limit)
        .map((c, i) => ({
          rank: i + 1,
          tuple_id: c.tupleId,
          provider: c.providerId,
          model: c.modelId,
          iq_effective: c.iqEffective,
          reliability_draw: c.reliabilityDraw,
          ewma_ttft_ms: c.ewmaTtftMs,
          ewma_tps: c.ewmaTps,
          expected_ms: c.expectedFastMs,
          smart_score: c.smartScore,
          supports_reasoning: c.supportsReasoning,
          supports_vision: c.supportsVision,
          is_coding_specialist: c.isCodingSpecialist,
          context_window: c.contextWindow,
          tool_competence: c.toolCompetence,
          tool_pulls: c.toolPulls,
        }));
      return { mode: toolAware ? "tools" : mode, lane: toolAware ? "free:tools" : `free:${mode}`, count: rows.length, ranked_from: ranked.length, candidates: rows };
    },
  });

  registerTool({
    name: "router_health",
    aliases: ["router.health", "health"],
    kind: "mesh",
    description:
      "Live health of this router deployment: control-kernel configuration, endpoint coverage, auth posture, tool-plane telemetry and the current best tuple per lane. Cheaper and more accurate than asking an operator.",
    parameters: { type: "object", properties: { section: { type: "string", enum: ["all", "coverage", "control_kernel", "tool_plane", "security", "best"], default: "all" } }, additionalProperties: false },
    run: async (args) => {
      const health = await buildHealthPayload();
      const section = String(args.section ?? "all");
      if (section === "all") return health;
      if (section === "best") {
        return Object.fromEntries(Object.entries(health).filter(([k]) => k.startsWith("current_best_")));
      }
      return { [section]: health[section] ?? null };
    },
  });

  registerTool({
    name: "router_models",
    aliases: ["router.models", "models", "list_models"],
    kind: "mesh",
    description:
      "Every model id this router will accept, including the virtual lanes (free:auto, free:fast, free:smart, free:code, free:reasoning, free:tools) and the image models. Optionally filter by substring.",
    parameters: {
      type: "object",
      properties: { filter: { type: "string", description: "Case-insensitive substring, e.g. \"claude\" or \"free:\"." }, limit: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
      additionalProperties: false,
    },
    run: async (args) => {
      const list = await buildModelList();
      const data = Array.isArray(list.data) ? (list.data as Json[]) : [];
      const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : "";
      const limit = Math.round(clampNum(Number(args.limit ?? 200), 1, 500));
      const rows = data.filter((m) => !filter || String(m.id ?? "").toLowerCase().includes(filter)).slice(0, limit);
      return { total: data.length, returned: rows.length, filter: filter || null, accepts_any_model: list.accepts_any_model === true, data: rows };
    },
  });

  registerTool({
    name: "router_endpoints",
    aliases: ["router.endpoints", "endpoints", "coverage"],
    kind: "mesh",
    description:
      "Upstream endpoint coverage: how many keyless endpoints are configured, how many catalog tuples each contributes, and which model hints the exhaustive sweep will try per endpoint.",
    parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } }, additionalProperties: false },
    run: async (args) => {
      const coverage = await endpointCoverage();
      const limit = Math.round(clampNum(Number(args.limit ?? 100), 1, 500));
      return {
        configured_endpoints: coverage.configured_endpoints,
        registry_endpoints: coverage.registry_endpoints,
        catalog_tuples: coverage.catalog_tuples,
        sweep_candidates: coverage.sweep_candidates,
        endpoints: coverage.endpoints.slice(0, limit),
      };
    },
  });

  registerTool({
    name: "router_lane",
    aliases: ["router.lane", "recommend_lane", "route"],
    kind: "mesh",
    description:
      "Ask the router how IT would route a prompt: the intent classifier's lane (fast/smart/code/reasoning), whether tool competence should drive the choice, and the top tuples it would race. Use this before delegating a sub-task to another model.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The user prompt to route." },
        messages: { type: "array", items: { type: "object" }, description: "Full message list, if you have one." },
        with_tools: { type: "boolean", default: false, description: "Rank by learned tool-call competence too." },
        reasoning_effort: { type: "string", description: "Pass through a requested effort level." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 3 },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const messages = Array.isArray(args.messages) && args.messages.length > 0
        ? normalizeMessages(args.messages)
        : [{ role: "user", content: String(args.prompt ?? "") }];
      const withTools = args.with_tools === true;
      const effort = typeof args.reasoning_effort === "string" ? args.reasoning_effort : undefined;
      const mode = classifyPromptIntent(messages, withTools, effort);
      const limit = Math.round(clampNum(Number(args.limit ?? 3), 1, 20));
      const ranked = await getRankedCandidates(mode, true, false, { toolAware: withTools });
      return {
        lane: `free:${mode}`,
        mode,
        tool_aware: withTools,
        classifier: { prompt_chars: extractMessageText(messages).combinedText.length, vision: extractMessageText(messages).hasVisionPayload, reasoning_effort: effort ?? null },
        candidates: ranked.slice(0, limit).map((c) => ({
          tuple_id: c.tupleId, provider: c.providerId, model: c.modelId,
          iq_effective: c.iqEffective, expected_ms: c.expectedFastMs, smart_score: c.smartScore, tool_competence: c.toolCompetence,
        })),
      };
    },
  });

  registerTool({
    name: "router_capabilities",
    aliases: ["router.capabilities", "what_can_you_do", "tools_list", "capabilities"],
    kind: "mesh",
    deterministic: true,
    description:
      "The router's own tool map: every callable tool with its description, aliases and learned reliability (Wilson competence floor, Kalman p50/p95 latency, repair rate). Ask this when unsure what the plane can do, or which tool is healthy right now.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Filter by kind: web, files, memory, rag, vector, clipboard, task, compute, data, text, time, crypto, mesh." },
        with_schemas: { type: "boolean", default: false },
        flavor: { type: "string", enum: ["openai", "openai-strict", "anthropic", "gemini"], description: "Also return the wire projection." },
      },
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const skills = (ctx.locals.tool_skills ?? {}) as Record<string, ToolSkillRecord>;
      const kind = typeof args.kind === "string" ? args.kind.toLowerCase() : "";
      const tools = listTools()
        .filter((t) => !t.admin && (!kind || t.kind === kind))
        .map((t) => {
          const record = skills[t.name];
          return {
            name: t.name,
            kind: t.kind,
            description: t.description,
            aliases: t.aliases ?? [],
            deterministic: t.deterministic ?? false,
            ...(args.with_schemas === true ? { parameters: t.parameters } : {}),
            ...(record ? { skill: skillSummary(record, ctx.now, true) } : {}),
          };
        });
      const out: Json = { count: tools.length, kinds: [...new Set(tools.map((t) => t.kind))], auto_tools: defaultAutoToolNames(), tools };
      if (typeof args.flavor === "string") out[args.flavor.replace("-", "_")] = toToolSpecs({ flavor: args.flavor as ToolFlavor });
      return out;
    },
  });

  registerTool({
    name: "router_trace",
    aliases: ["router.trace", "traces", "inspect_trace"],
    kind: "mesh",
    admin: true,
    description:
      "ADMIN ONLY. Read this isolate's trace ring: recent request traces, or one trace by id with its full span waterfall (rank, tier, negotiation, tool rounds). Requires the admin secret.",
    parameters: {
      type: "object",
      properties: { trace_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 64, default: 10 } },
      additionalProperties: false,
    },
    run: (args) => {
      const id = typeof args.trace_id === "string" ? args.trace_id.trim() : "";
      if (id) {
        const trace = getTrace(id);
        return trace ? { found: true, trace } : { found: false, error: `trace ${id.slice(0, 64)} is not in this isolate's ring` };
      }
      const limit = Math.round(clampNum(Number(args.limit ?? 10), 1, 64));
      return { found: true, count: limit, traces: listTraces(limit) };
    },
  });

  registerTool({
    name: "forge_tool",
    aliases: ["forge.tool", "create_tool", "make_tool", "define_tool"],
    kind: "mesh",
    dynamic: true,
    description:
      "Create a NEW router tool on the fly — or replace one forged earlier — from a JavaScript function body. The tool persists, joins the registry and the auto tool set immediately, and is executed by the plane with schema validation and deadlines like any built-in. The body receives `args` (the validated arguments) and `api` ({ fetch, kv, namespace, signal, now, locals }); its return value is the tool result. Ambient globals (Deno, process, globalThis, Function) are unavailable inside the body.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name: lowercase letters, digits, underscores." },
        description: { type: "string", description: "What the tool does — models read this to decide when to call it." },
        parameters: { type: "object", description: "JSON Schema for the arguments object." },
        code: { type: "string", description: "JavaScript function body. Receives args and api; return the result." },
        kind: { type: "string", enum: ["web", "files", "memory", "rag", "vector", "clipboard", "task", "compute", "data", "text", "time", "crypto", "mesh"] },
        deterministic: { type: "boolean", default: false },
        admin: { type: "boolean", default: false, description: "If true, the forged tool itself needs the admin secret to execute." },
        timeout_ms: { type: "integer", minimum: 100, maximum: 30000 },
      },
      required: ["name", "description", "code"],
      additionalProperties: false,
    },
    run: async (args) => {
      const def = await forgeTool(args);
      return { forged: def.name, kind: def.kind, admin: def.admin ?? false, updated_at: def.updated_at, tools_total: listTools().length, note: "callable from the next tool round onward, and in every later request" };
    },
  });

  registerTool({
    name: "retire_tool",
    aliases: ["retire.tool", "delete_tool", "remove_tool"],
    kind: "mesh",
    admin: true,
    description:
      "ADMIN ONLY. Retire a tool previously created with forge_tool: removes it from the registry and deletes its persisted definition. Built-in tools cannot be retired.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    run: async (args) => {
      const name = String(args.name ?? "");
      const gone = await retireForgedTool(name);
      return gone ? { retired: normalizeToolName(name) } : { retired: null, error: `"${name.slice(0, 64)}" is not a forged tool` };
    },
  });
}




/** The whole /health document, also served to models through `router_health`. */
export async function buildHealthPayload(): Promise<Json> {
  const rankedProviders = new Set<string>();
  const safeRank = async (m: RoutingMode) => {
    try {
      const all = await getRankedCandidates(m, true);
      for (const c of all) rankedProviders.add(c.providerId);
      return all.slice(0, 8);
    } catch (err) {
      console.error(`health rank ${m}:`, err);
      return [];
    }
  };
  // Rank first (this hydrates the catalog on a cold isolate), then report
  // coverage so /health never shows an artificially empty catalog.
  const fastRank = await safeRank("fast");
  const smartRank = await safeRank("smart");
  const codeRank = await safeRank("code");
  const reasoningRank = await safeRank("reasoning");
  // The tools lane is the smart lane ranked by learned tool-call competence.
  const toolsRank = await getRankedCandidates("smart", true, false, { toolAware: true })
    .then((r) => r.slice(0, 8))
    .catch((err) => {
      console.error("health rank tools:", err);
      return [] as ScoredCandidate[];
    });
  const coverage = await endpointCoverage().catch((err) => {
    console.error("health coverage:", err);
    return { configured_endpoints: 0, registry_endpoints: 0, catalog_tuples: L1_CACHE.size, sweep_candidates: 0 };
  });
  return {
    engine: "nokey-sovereign-v6-asck2-toolbox",
    runtime: "deno-deploy-kv-cas-l1",
    control_kernel: {
      name: "ASCK v1",
      ttft_model: "log-normal + scalar Kalman filter",
      reliability: "discounted Thompson sampling (6h half-life)",
      exploration: "UCB + Wilson lower bound + Gumbel/Plackett-Luce",
      hedging: "survival-quantile optimal stopping (tail-at-scale)",
      dispatch_tiers: ["mode-ranked", "cross-lane-proven", "full-catalog", "exhaustive-endpoint-sweep"],
      request_guarantee: "always 200; graceful degraded completion after full sweep",
      strict_errors: strictErrors(),
    },
    tool_plane: {
      name: "ASCK-T v2",
      builtin_tools: toolPlaneTotals().tools,
      instrumented_tools: toolPlaneTotals().instrumented,
      executions: toolPlaneTotals().calls,
      errors: toolPlaneTotals().errors,
      repaired_calls: toolPlaneTotals().repairs,
      auto_tools: defaultAutoToolNames().length,
      agent_rounds: maxToolRounds(),
      learning: "ASCK-L: contextual Beta posteriors per (tuple, task class) with empirical-Bayes shrinkage, strategy arms, VOI compute allocation, lesson memory with efficacy tracking, off-policy logging (IPS/DR)",
    },
    security: {
      auth_enabled: Boolean(Deno.env.get("ROUTER_API_KEY")),
      admin_guard_enabled: Boolean(Deno.env.get("ADMIN_SECRET")),
      openrouter_free_enabled: Boolean(pickOpenRouterKey()),
      l1_cache_entries: L1_CACHE.size,
      service_json_load_error: serviceJsonLoadError,
    },
    coverage: {
      configured_endpoints: coverage.configured_endpoints,
      registry_endpoints: coverage.registry_endpoints,
      catalog_tuples: coverage.catalog_tuples,
      sweep_candidates: coverage.sweep_candidates,
      // Providers with ranked tuples vs. configured: the gap is covered by the exhaustive sweep tier.
      providers_active: (await activeProviderList().catch(() => [])).length,
      providers_ranked: rankedProviders.size,
    },
    current_best_fast: fastRank,
    current_best_smart: smartRank,
    current_best_code: codeRank,
    current_best_reasoning: reasoningRank,
    current_best_tools: toolsRank,
  };
}





/** The advertised model list, shared with the `router_models` mesh tool. */
export async function buildModelList(): Promise<Json> {
  const ranked = await getRankedCandidates("smart", true).catch((err) => {
    console.error("models ranking:", err);
    return [];
  });
  // Any model id is accepted by the chat route; advertise that explicitly.
  const virtualAliases = [
    "free:auto",
    "free:fast",
    "free:smart",
    "free:code",
    "free:reasoning",
    "free:tools",
  ].map((id) => ({
    id,
    object: "model",
    created: 1761523200,
    owned_by: "vajra-mesh-router",
  }));

  const discoveredModels = ranked.map((m) => ({
    id: m.modelId,
    tuple_id: m.tupleId,
    object: "model",
    created: 1761523200,
    owned_by: m.providerId,
    iq_effective: m.iqEffective,
    supports_reasoning: m.supportsReasoning,
    supports_vision: m.supportsVision,
    is_coding_specialist: m.isCodingSpecialist,
    context_window: m.contextWindow,
  }));

  const imageModels = [
    ...IMAGE_MODELS.map((img) => ({ id: img.id, object: "model", created: 1761523200, owned_by: "nokey-image" })),
    ...(await openAIImageBackends().catch(() => [])).map((b) => ({ id: b.id, object: "model", created: 1761523200, owned_by: "nokey-image:" + b.id.split("::")[0] })),
  ];

  return {
    object: "list",
    accepts_any_model: true,
    model_policy: "unknown model ids are routed by trigram/Jaccard similarity and fall back to the exhaustive endpoint sweep",
    data: [...virtualAliases, ...imageModels, ...discoveredModels],
  };
}




export async function openAIImageBackends(): Promise<Array<{ id: string; url: string; headers: Record<string, string>; model: string }>> {
  await hydrateImageCatalog().catch(logErr);
  await hydrateImageBlocks().catch(logErr);
  const providers = new Map((await activeProviderList()).map((p) => [p.id, p]));
  const out: Array<{ id: string; url: string; headers: Record<string, string>; model: string; rate: number }> = [];
  for (const [pid, models] of IMAGE_CATALOG) {
    const p = providers.get(pid);
    if (!p?.imagesUrl) continue;
    for (const model of models) {
      const id = `${pid}::${model}`;
      if (IMAGE_BLOCKED.has(id)) continue;
      const st = IMAGE_STATS.get(id) ?? { ok: 0, fail: 0 };
      out.push({ id, url: p.imagesUrl, headers: p.imageHeaders ?? {}, model, rate: (st.ok + 1) / (st.ok + st.fail + 2) });
    }
  }
  return out.sort((a, b) => b.rate - a.rate);
}
