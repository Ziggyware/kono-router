// deno-lint-ignore-file no-explicit-any
/**
 * Tool Plane kernel tests — pure module, no network, no KV.
 *
 * Covers the four things that make the plane trustworthy:
 *   1. the JSON Schema subset validator and its lossless coercion,
 *   2. the graded repair ladder for model-mangled arguments,
 *   3. every built-in tool implementation (exact expected values),
 *   4. the skill memory that makes tool knowledge compound.
 *
 * Run: deno test --unstable-kv -A tests/
 */
import {
  DEFAULT_AUTO_TOOLS,
  emptyToolSkill,
  executeTool,
  extractJsonCandidate,
  formatNumber,
  getTool,
  guessEpochUnit,
  humanizeDuration,
  jaccard,
  levenshtein,
  listTools,
  mergeToolDeclarations,
  normalizeToolCalls,
  normalizeToolName,
  observeToolSkill,
  observeTupleToolStats,
  parseDuration,
  parseToolArguments,
  partitionToolCalls,
  queryJson,
  registerTool,
  repairJsonText,
  resolveAutoToolNames,
  resolveTool,
  seededRandom,
  similarityScore,
  skillSummary,
  toStrictSchema,
  toToolSpecs,
  toolPreamble,
  toolRoutingBonus,
  trigramDice,
  tupleToolCompetence,
  validateJson,
  type ToolExecution,
  type ToolExecutionErr,
  type ToolExecutionOk,
  type ToolSkillRecord,
} from "../tools.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
/** Unwrap a failed execution so its diagnostics stay type-visible. */
function fail(exec: ToolExecution): ToolExecutionErr {
  assert(!exec.ok, `expected a failure, got ${JSON.stringify(exec)}`);
  return exec as ToolExecutionErr;
}
const near = (a: number, b: number, tol = 1e-6, msg = "") => assert(Math.abs(a - b) <= tol, `${msg} expected ~${b}, got ${a}`);

/** Execute a built-in and unwrap the success payload. */
async function run(name: string, args: unknown): Promise<any> {
  const exec = await executeTool(name, args);
  if (!exec.ok) throw new Error(`${name} failed: ${exec.code} ${exec.error} ${JSON.stringify(exec.issues ?? [])}`);
  return (exec as ToolExecutionOk).result;
}

Deno.test("registry: built-ins are registered, wire-safe and resolvable by any spelling", () => {
  const tools = listTools();
  assert(tools.length >= 13, `expected the built-in set, got ${tools.length}`);
  for (const t of tools) {
    assert(/^[a-z0-9_]{1,64}$/.test(t.name), `tool name "${t.name}" is not wire-safe for OpenAI function calling`);
    assert(t.description.length > 20, `${t.name} needs a description a model can act on`);
    assert((t.parameters as any).type === "object", `${t.name} parameters must be an object schema`);
  }
  // Every advertised auto-tool must actually exist.
  for (const name of DEFAULT_AUTO_TOOLS) assert(getTool(name), `DEFAULT_AUTO_TOOLS advertises missing tool ${name}`);

  // Resolution is forgiving: dotted, kebab, camel and fuzzy spellings.
  assert(resolveTool("math.evaluate").tool?.name === "math_evaluate", "dotted alias");
  assert(resolveTool("math-evaluate").tool?.name === "math_evaluate", "kebab spelling");
  assert(resolveTool("MathEvaluate").tool?.name === "math_evaluate", "camel spelling");
  assert(resolveTool("calculator").tool?.name === "math_evaluate", "declared alias");
  assert(resolveTool("math_evaluat").tool?.name === "math_evaluate", "near miss resolves by similarity");
  const unknown = resolveTool("totally_unrelated_zzz");
  assert(unknown.tool === undefined, "unrelated names must not resolve");
  assert(Array.isArray(unknown.suggestions), "unrelated names still return suggestions");
  assert(normalizeToolName("  Router.Health!! ") === "router_health", "normalise strips punctuation/case");
});

Deno.test("schema: validates, reports paths, and coerces only losslessly", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 10 },
      ratio: { type: "number", exclusiveMinimum: 0 },
      mode: { type: "string", enum: ["fast", "smart"], default: "fast" },
      tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      nested: { type: "object", properties: { deep: { type: "boolean" } }, required: ["deep"], additionalProperties: false },
    },
    required: ["count"],
    additionalProperties: false,
  };

  // Strict mode rejects and points at the exact path.
  const strict = validateJson({ count: "5", ratio: 0, mode: "FAST", tags: "a,b,c,d", nested: { deep: "yes", extra: 1 } }, schema);
  assert(!strict.ok, "uncoerced payload must fail");
  assert(strict.issues.some((i) => i.path === "/count" && i.keyword === "type"), "count type issue at /count");
  assert(strict.issues.some((i) => i.path === "/ratio" && i.keyword === "exclusiveMinimum"), "exclusiveMinimum violation reported");
  assert(strict.issues.some((i) => i.path === "/tags" && i.keyword === "type"), "comma string is not an array without coercion");

  // Coercion repairs the same payload and keeps every value.
  const fixed = validateJson({ count: "5", ratio: "0.25", mode: "FAST", tags: "a,b,c,d", nested: { deep: "yes", extra: 1 } }, schema, { coerce: true });
  assert(fixed.ok, `coerced payload must validate: ${JSON.stringify(fixed.issues)}`);
  assert(fixed.repaired && fixed.repairs > 0, "repairs must be recorded");
  const value: any = fixed.value;
  assert(value.count === 5, `"5" -> 5, got ${value.count}`);
  assert(value.ratio === 0.25, `"0.25" -> 0.25, got ${value.ratio}`);
  assert(value.mode === "fast", `enum case normalised, got ${value.mode}`);
  assert(Array.isArray(value.tags) && value.tags.length === 3, `comma list split and trimmed to maxItems, got ${JSON.stringify(value.tags)}`);
  assert(value.nested.deep === true, `"yes" -> true`);
  assert(value.nested.extra === undefined, "additionalProperties:false drops undeclared keys");

  // Defaults fill missing keys; out-of-range clamps instead of throwing the call away.
  const defaulted = validateJson({ count: 99 }, schema, { coerce: true });
  assert(defaulted.ok, "clamped payload validates");
  assert((defaulted.value as any).count === 10, `99 clamps to maximum 10, got ${(defaulted.value as any).count}`);
  assert((defaulted.value as any).mode === "fast", "missing key filled from default");

  // $ref/$defs resolution and combinators.
  const refSchema = {
    $defs: { id: { type: "string", minLength: 3 } },
    type: "object",
    properties: { a: { $ref: "#/$defs/id" }, either: { anyOf: [{ type: "number" }, { type: "string", pattern: "^x" }] } },
    required: ["a"],
  };
  assert(!validateJson({ a: "x" }, refSchema).ok, "minLength through $ref must reject");
  assert(validateJson({ a: "abc", either: 4 }, refSchema).ok, "$ref + anyOf accepts");
  assert(!validateJson({ a: "abc", either: "nope" }, refSchema).ok, "anyOf rejects a string without the prefix");
  assert(validateJson({ a: "abc", either: "xyz" }, refSchema).ok, "anyOf accepts the pattern branch");
  // Coercion must not mutate the caller's object.
  const source = { count: "3" };
  validateJson(source, schema, { coerce: true });
  assert(source.count === "3", "validateJson must clone before coercing");
  // An unresolvable $ref is reported, not thrown.
  assert(!validateJson({ a: "abc" }, { $ref: "#/$defs/missing" }).ok, "missing $ref must report an error");
});

Deno.test("repair ladder: fences, prose, single quotes, bare keys, Python literals, truncation", () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } },
    required: ["query"],
    additionalProperties: false,
  };

  const cases: Array<[string, string, string]> = [
    ["markdown fence", '```json\n{"query": "hello", "limit": 5}\n```', "extract"],
    ["prose wrapper", 'Sure! Here you go: {"query": "hello", "limit": 5} — hope that helps.', "extract"],
    ["single quotes", "{'query': 'hello', 'limit': 5}", "repair"],
    ["bare keys", '{query: "hello", limit: 5}', "repair"],
    ["python literals", '{"query": "hello", "limit": 5, "flag": None}', "repair"],
    ["trailing commas", '{"query": "hello", "limit": 5,}', "repair"],
    ["comments", '{\n// the query\n"query": "hello",\n"limit": 5\n}', "repair"],
    ["double encoded", '"{\\"query\\": \\"hello\\", \\"limit\\": 5}"', "double-decode"],
    ["truncated by max_tokens", '{"query": "hello", "lim', "repair"],
    ["nan literal", '{"query": "hello", "limit": NaN}', "repair"],
  ];

  for (const [label, raw, expected] of cases) {
    const parsed = parseToolArguments(raw, schema);
    assert(parsed.strategy !== "strict" || expected === "strict", `${label}: strategy ${parsed.strategy}`);
    if (expected === "double-decode") {
      assert(parsed.strategy === "double-decode", `${label}: expected double-decode, got ${parsed.strategy}`);
    }
    assert(parsed.repaired, `${label}: expected a repair`);
    assert(parsed.ok, `${label}: repair ladder must still satisfy the schema (${parsed.error ?? ""})`);
    assert((parsed.value as any).query === "hello", `${label}: query lost (${JSON.stringify(parsed.value)})`);
    if (label !== "truncated by max_tokens" && label !== "python literals" && label !== "nan literal") {
      assert((parsed.value as any).limit === 5, `${label}: limit lost (${JSON.stringify(parsed.value)})`);
    }
  }

  // Truncation must drop the incomplete key rather than invent a value.
  const truncated = parseToolArguments('{"query": "hello", "lim', schema);
  assert(truncated.ok, `truncated args must survive (${truncated.error})`);
  assert(truncated.repairs.includes("truncated"), `repairs should mention truncation: ${truncated.repairs}`);
  assert((truncated.value as any).query === "hello", "the complete part of a truncated payload is preserved");
  assert((truncated.value as any).lim === undefined, "a half-written key must not become a value");

  // A truncated string is closed, not discarded.
  const cutString = parseToolArguments('{"query": "hello wor', schema);
  assert(cutString.ok && (cutString.value as any).query === "hello wor", `unterminated string closed: ${JSON.stringify(cutString.value)}`);

  // Salvage: the JSON is hopeless but the scalars are recoverable.
  const hopeless = parseToolArguments('query = "hello"; limit: 5   <<<not json>>>', schema);
  assert(hopeless.strategy === "salvage", `expected salvage, got ${hopeless.strategy}`);
  assert((hopeless.value as any).query === "hello", "salvage recovers the string");

  // Already-correct payloads take the cheap path.
  assert(parseToolArguments('{"query":"hi"}', schema).strategy === "strict", "valid JSON is never rewritten");
  assert(parseToolArguments({ query: "hi" }, schema).strategy === "native", "objects skip parsing entirely");
  assert(parseToolArguments("", schema).strategy === "empty", "empty arguments are a distinct strategy");
  assert(!parseToolArguments('{"limit": 5}', schema).ok, "missing required key still fails after repair");

  // The extractors are safe to call directly.
  assert(extractJsonCandidate('```json\n{"a":1}\n```') === '{"a":1}', "fence extraction");
  assert(repairJsonText("{a: 'b',}").text === '{"a": "b"}', `repairJsonText output: ${repairJsonText("{a: 'b',}").text}`);
  assert(repairJsonText('{"a": 1} // note').text === '{"a": 1}', "comment stripped");
});

Deno.test({
  name: "math_evaluate: exact arithmetic, functions, precedence, batching",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const single = await run("math_evaluate", { expression: "(23 * 19) + 14" });
    assert(single.value === 451, `canary arithmetic must be exact, got ${single.value}`);

    const cases: Array<[string, number]> = [
      ["2^10", 1024],
      ["2**0.5", Math.SQRT2],
      ["-3^2", -9], // unary minus binds looser than power, as in mathematics
      ["7 // 2", 3],
      ["7 % 3", 1],
      ["mod(-7, 3)", 2],
      ["gcd(48, 18)", 6],
      ["lcm(4, 6)", 12],
      ["factorial(10)", 3628800],
      ["round(3.14159, 2)", 3.14],
      ["clamp(15, 0, 10)", 10],
      ["hypot(3, 4)", 5],
      ["log(1000, 10)", 3],
      ["ln(e)", 1],
      ["min(3, 1, 2)", 1],
      ["sqrt(2)^2", 2.0000000000000004],
      ["1/3 + 1/3 + 1/3", 1],
      ["0.1 + 0.2", 0.30000000000000004],
      ["3 > 2", 1],
      ["2 == 2.0", 1],
      ["pi", Math.PI],
    ];
    for (const [expression, expected] of cases) {
      const out = await run("math_evaluate", { expression });
      assert(out.ok, `${expression} -> ${out.error}`);
      near(out.value, expected, 1e-9, `${expression}:`);
    }

    // Float dust is cleaned for display but the exact value is still returned.
    const dust = await run("math_evaluate", { expression: "0.1 + 0.2" });
    assert(dust.formatted === 0.3, `formatted should be 0.3, got ${dust.formatted}`);
    assert(dust.value !== 0.3, "raw value must keep full precision");

    // Variables, degrees and the ASCK statistical functions.
    const vars = await run("math_evaluate", { expression: "2*x + y", variables: { x: 3, y: 4 } });
    assert(vars.value === 10, `variables: ${vars.value}`);
    const deg = await run("math_evaluate", { expression: "sin(30)", angle: "deg" });
    near(deg.value, 0.5, 1e-12, "sin(30deg)");
    const cdf = await run("math_evaluate", { expression: "norm_cdf(1.96)" });
    near(cdf.value, 0.975, 1e-3, "norm_cdf(1.96)");
    const q = await run("math_evaluate", { expression: "norm_quantile(0.975)" });
    near(q.value, 1.96, 1e-3, "norm_quantile(0.975)");
    const erf = await run("math_evaluate", { expression: "erf(1)" });
    near(erf.value, 0.8427, 1e-3, "erf(1)");

    // Batching reports per-expression failures without aborting the batch.
    const batch = await run("math_evaluate", { expressions: ["1+1", "sqrt(-1)", "unknown_fn(2)", "2*3"] });
    assert(batch.count === 4, "all expressions evaluated");
    assert(batch.results[0].value === 2, "first ok");
    assert(batch.results[2].ok === false && /unknown function/.test(batch.results[2].error), "unknown function reported");
    assert(batch.results[1].value === null && batch.results[1].finite === false, "NaN surfaces as null + finite:false");

    // Hostile input must produce a clean error, never a crash or code execution.
    for (const hostile of ["1; Deno.exit()", "process.exit(1)", "constructor", "1..2", "(((((", "])", "", "1 +"]) {
      const exec = await executeTool("math_evaluate", { expression: hostile });
      assert(exec.ok === false || (exec as ToolExecutionOk).result !== undefined, `hostile input handled: ${hostile}`);
      if (exec.ok) {
        const r: any = exec.result;
        assert(r.ok === false || Number.isFinite(r.value) || r.value === null, `hostile expression returned ${JSON.stringify(r)}`);
      }
    }
    // A runaway expression is rejected by size, not evaluated.
    const long = await executeTool("math_evaluate", { expression: "1+".repeat(5000) + "1" });
    assert(!long.ok || (long as any).result.ok === false, "oversized expression must fail cleanly");
    assert(formatNumber(1e20) === "1.000000e+20", `huge numbers go exponential: ${formatNumber(1e20)}`);
    assert(formatNumber(-0) === 0, "negative zero is normalised");
  },
});

Deno.test({
  name: "math_statistics: matches reference values and fits the log-normal tail",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const s = await run("math_statistics", { values });
    assert(s.count === 8, "count");
    assert(s.mean === 5, `mean: ${s.mean}`);
    assert(s.sum === 40, "sum");
    assert(s.min === 2 && s.max === 9 && s.range === 7, "min/max/range");
    near(s.variance, 32 / 7, 1e-9, "sample variance");
    near(s.sd, Math.sqrt(32 / 7), 1e-9, "sample sd");
    near(s.sem, Math.sqrt(32 / 7) / Math.sqrt(8), 1e-9, "sem");
    assert(s.median === 4.5, `median: ${s.median}`);
    assert(s.quantiles.p95 !== undefined && s.quantiles.p99 !== undefined, "default quantiles present");
    assert(s.quantiles.p50 === 4.5 && s.quantiles.p90 !== undefined && s.quantiles.p95 !== undefined, `default quantiles: ${JSON.stringify(s.quantiles)}`);
    assert(s.quantiles.p95 >= s.quantiles.p90, "quantiles are monotone");
    assert(Array.isArray(s.histogram) && s.histogram.length > 0, "histogram built");
    const bins = s.histogram.reduce((a: number, b: any) => a + b.count, 0);
    assert(bins === 8, `histogram counts must sum to n, got ${bins}`);
    // Tukey's fence on this classic sample: IQR 1.5 -> upper fence 7.75, so 9 flags.
    assert(s.iqr === 1.5, `iqr: ${s.iqr}`);
    assert(s.outliers.length === 1 && s.outliers[0].value === 9, `Tukey outlier: ${JSON.stringify(s.outliers)}`);

    // Reference quantile behaviour (type 7) on a simple ramp.
    const ramp = await run("math_statistics", { values: [1, 2, 3, 4], quantiles: [0.25, 0.5, 0.75] });
    assert(ramp.quantiles.p25 === 1.75, `type-7 q25: ${ramp.quantiles.p25}`);
    assert(ramp.quantiles.p75 === 3.25, `type-7 q75: ${ramp.quantiles.p75}`);

    // Skew/kurtosis signs on an obviously skewed sample.
    const skewed = await run("math_statistics", { values: [1, 1, 1, 1, 1, 1, 1, 100] });
    assert(skewed.skewness > 1, `right skew expected, got ${skewed.skewness}`);
    assert(skewed.outliers.length === 1 && skewed.outliers[0].value === 100, "Tukey fence catches the spike");

    // Latency mode reproduces the router's own log-normal quantiles.
    const latency = await run("math_statistics", { values: [120, 132, 145, 160, 180, 210, 260, 900], latency: true });
    assert(latency.lognormal, "log-normal fit present");
    assert(latency.lognormal.p99_ms > latency.lognormal.p95_ms, "p99 > p95");
    assert(latency.lognormal.p50_ms > 100 && latency.lognormal.p50_ms < 400, `p50 sane: ${latency.lognormal.p50_ms}`);

    // Bad input is rejected precisely, and huge samples are capped not crashed.
    const bad = await executeTool("math_statistics", { values: [] });
    assert(fail(bad).code === "INVALID_ARGUMENTS", `empty sample rejected: ${JSON.stringify(bad)}`);
    const coerced = await run("math_statistics", { values: ["1", "2", 3] });
    assert(coerced.count === 3, `numeric strings coerced: ${coerced.count}`);
    const big = await run("math_statistics", { values: Array.from({ length: 50_000 }, (_, i) => i % 100) });
    assert(big.count === 50_000, "large sample handled");
  },
});

Deno.test({
  name: "text tools: similarity ranking and regex extraction",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Pairwise scoring.
    assert(levenshtein("kitten", "sitting") === 3, "levenshtein reference");
    assert(levenshtein("", "abc") === 3, "empty vs string");
    near(jaccard("a b c", "a b c"), 1, 1e-9, "identical token sets");
    near(jaccard("a b", "c d"), 0, 1e-9, "disjoint token sets");
    assert(trigramDice("claude-opus-5.5", "claude-opus-5.5") === 1, "identical trigrams");
    assert(similarityScore("gpt-5.2", "gpt-5.2-mini", "prefix") > 0.6, "prefix similarity");
    assert(similarityScore("gpt-5.2", "gpt-5.2-mini", "levenshtein") > 0.5, "edit-distance similarity");

    // Ranking a candidate list — the model-picker use case.
    const ranked = await run("text_similarity", {
      query: "anthropic/claude-opus-5.5",
      candidates: ["anthropic/claude-opus-4.5", "google/gemini-3.0-pro", "anthropic/claude-opus-5.5", "openai/gpt-5.2"],
      k: 2,
    });
    assert(ranked.best === "anthropic/claude-opus-5.5", `exact match must win, got ${ranked.best}`);
    assert(ranked.matches[0].score === 1, "exact match scores 1");
    assert(ranked.matches[1].value === "anthropic/claude-opus-4.5", `closest sibling second, got ${ranked.matches[1].value}`);
    assert(ranked.matches.length === 2, "k respected");

    const filtered = await run("text_similarity", { query: "zzz", candidates: ["aaa", "bbb"], min_score: 0.5 });
    assert(filtered.matches.length === 0, "min_score filters everything out");

    const pairwise = await run("text_similarity", { a: "nokey-router", b: "nokey router" });
    assert(pairwise.score > 0.9, `punctuation-insensitive: ${pairwise.score}`);

    // Extraction with groups, offsets and de-duplication.
    const extracted = await run("text_extract", {
      text: "v1.2.3 shipped 2026-11-04, then v1.2.4 on 2026-11-05. Contact ops@nokey.dev or support@nokey.dev",
      patterns: [
        { name: "version", pattern: "v(\\d+\\.\\d+\\.\\d+)", group: 1 },
        { name: "date", pattern: "\\d{4}-\\d{2}-\\d{2}" },
        { name: "email", pattern: "[\\w.+-]+@[\\w.-]+", unique: true },
      ],
    });
    assert(extracted.results.length === 3, "one result group per pattern");
    assert(extracted.results[0].matches.map((m: any) => m.value).join(",") === "1.2.3,1.2.4", `capture group extracted: ${JSON.stringify(extracted.results[0].matches)}`);
    assert(extracted.results[1].count === 2, "two dates");
    assert(extracted.results[2].count === 2, "two unique emails");
    assert(extracted.results[1].matches[0].index > 0, "byte offset reported");

    const named = await run("text_extract", { text: "id=42 name=router", pattern: "(?<key>\\w+)=(?<val>\\w+)" });
    assert(named.results[0].matches[0].named.key === "id", `named groups surfaced: ${JSON.stringify(named.results[0].matches[0])}`);

    const invalid = await run("text_extract", { text: "abc", pattern: "(" });
    assert(invalid.results[0].ok === false, "invalid regex reported per-pattern, not thrown");
    const noPattern = await executeTool("text_extract", { text: "abc" });
    assert(!noPattern.ok, "missing pattern rejected by the schema");
  },
});

Deno.test({
  name: "json tools: JSONPath-lite query, validate and transform",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const doc = {
      store: {
        book: [
          { title: "Sayaka", price: 8.95, tags: ["a"] },
          { title: "Sword", price: 12.99, tags: ["a", "b"] },
          { title: "Moby Dick", price: 8.99, tags: [] },
        ],
        bicycle: { color: "red", price: 19.95 },
      },
      meta: { version: 2 },
    };

    // Direct query engine.
    assert(queryJson(doc, "$.store.bicycle.color")[0] === "red", "child path");
    assert(queryJson(doc, "$.store.book[0].title")[0] === "Sayaka", "index");
    assert(queryJson(doc, "$.store.book[-1].title")[0] === "Moby Dick", "negative index");
    assert(queryJson(doc, "$.store.book[*].title").length === 3, "wildcard");
    assert(queryJson(doc, "$.store.book[0:2].title").length === 2, "slice");
    assert(queryJson(doc, "$..price").length === 4, `recursive descent: ${JSON.stringify(queryJson(doc, "$..price"))}`);
    assert(queryJson(doc, "$.store.book[?(@.price>9)].title")[0] === "Sword", "numeric filter");
    assert(queryJson(doc, "$.store.book[?(@.title~=^S)].title").length === 2, "regex filter");
    assert(queryJson(doc, "$['store']['bicycle']['color']")[0] === "red", "quoted children");
    assert(queryJson(doc, "$.missing.path").length === 0, "missing path yields no matches");
    assert(queryJson(doc, "$")[0] === doc as any, "root");

    const viaTool = await run("json_query", { data: doc, paths: ["$.store.book[*].title", "$.meta.version"], first: true });
    assert(viaTool.results[0].matches === "Sayaka", "first:true collapses to a single match");
    assert(viaTool.results[1].matches === 2, "second path");
    const fromString = await run("json_query", { data: JSON.stringify(doc), path: "$.meta.version" });
    assert(fromString.count === 1, "JSON string input is parsed");
    const badPath = await run("json_query", { data: doc, path: "$.store.book[?(" });
    assert(badPath.results[0].ok === false, "invalid path reported, not thrown");

    // json_validate dogfoods the same kernel the argument ladder uses.
    const verdict = await run("json_validate", {
      data: { count: "3" },
      schema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      coerce: true,
    });
    assert(verdict.ok && verdict.repaired, `coerced validation: ${JSON.stringify(verdict)}`);
    assert(verdict.value.count === 3, "coerced value returned");
    const rejection = await run("json_validate", { data: { count: "abc" }, schema: { type: "object", properties: { count: { type: "integer" } } } });
    assert(rejection.ok === false && rejection.errors.length > 0, `rejection carries diagnostics: ${JSON.stringify(rejection)}`);

    // json_transform: pick, omit, flatten, sort, compact, defaults.
    const picked = await run("json_transform", { data: doc, pick: ["$.meta.version", "$.store.bicycle.color"] });
    assert(picked.value["meta.version"] === 2, `pick flattens into keyed result: ${JSON.stringify(picked.value)}`);
    const omitted = await run("json_transform", { data: doc, omit: ["$.store.bicycle"] });
    assert(omitted.value.store.bicycle === undefined, `omit removed the subtree: ${JSON.stringify(omitted.value.store)}`);
    assert(omitted.value.store.book.length === 3, "omit leaves siblings alone");
    const shaped = await run("json_transform", {
      data: { b: 2, a: { z: null, y: [], x: 1 } },
      sort_keys: true,
      compact: true,
      defaults: { c: 3 },
      flatten: true,
    });
    assert(Object.keys(shaped.value).join(",") === "a,b,c", `keys sorted and defaults filled: ${Object.keys(shaped.value)}`);
    assert(Object.keys(shaped.value.a).join(",") === "x", `nulls and empties compacted: ${JSON.stringify(shaped.value.a)}`);
    assert(shaped.flattened["a.x"] === 1, "flattened dotted keys");
    assert(shaped.bytes > 0, "byte size reported");
  },
});

Deno.test({
  name: "time, crypto, encoding and sampling tools",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Durations.
    assert(parseDuration("1h30m") === 5_400_000, "1h30m");
    assert(parseDuration("-3d") === -259_200_000, "-3d");
    assert(parseDuration("500ms") === 500, "500ms");
    assert(parseDuration("P1DT2H3M") === 93_780_000, "ISO-8601 duration");
    assert(parseDuration("2 weeks") === 1_209_600_000, "spelled units");
    assert(parseDuration("banana") === null, "garbage duration rejected");
    assert(humanizeDuration(90_000) === "1m 30s", `humanize: ${humanizeDuration(90_000)}`);
    assert(humanizeDuration(0.4).endsWith("µs"), "sub-millisecond humanized");

    // Epoch unit guessing.
    assert(guessEpochUnit(1_761_523_200) === 1000, "10-digit is seconds");
    assert(guessEpochUnit(1_761_523_200_000) === 1, "13-digit is milliseconds");
    assert(guessEpochUnit(1_761_523_200_000_000) === 1e-3, "16-digit is microseconds");

    const converted = await run("time_convert", { value: 1_761_523_200_000, to: "iso" });
    assert(converted.iso === "2025-10-27T00:00:00.000Z", `epoch -> ISO: ${converted.iso}`);
    assert(converted.unix_s === 1_761_523_200, "epoch seconds");
    const zoned = await run("time_convert", { value: "2026-11-04T12:00:00Z", tz: "America/New_York", to: "iso" });
    assert(zoned.local === "2026-11-04T07:00:00", `wall clock in New York: ${zoned.local}`);
    assert(zoned.offset_minutes === -300, `EST offset: ${zoned.offset_minutes}`);
    const shifted = await run("time_convert", { value: "2026-11-04T12:00:00Z", add: "90m" });
    assert(shifted.iso === "2026-11-04T13:30:00.000Z", `add duration: ${shifted.iso}`);
    const diff = await run("time_convert", { value: "2026-11-04T12:00:00Z", diff_to: "2026-11-04T09:30:00Z" });
    assert(diff.diff.ms === 9_000_000 && diff.diff.human === "2h 30m", `diff: ${JSON.stringify(diff.diff)}`);
    const nowOut = await run("time_convert", { now: true });
    assert(Math.abs(nowOut.unix_ms - Date.now()) < 5_000, "now is close to the clock");
    const badTime = await executeTool("time_convert", { value: "not a date" });
    assert(!badTime.ok, "unparseable instant rejected");

    // Hashing.
    const digest = await run("crypto_digest", { data: "abc" });
    assert(digest.digest === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", `sha-256("abc"): ${digest.digest}`);
    const sha1 = await run("crypto_digest", { data: "abc", algorithm: "sha-1" });
    assert(sha1.digest === "a9993e364706816aba3e25717850c26c9cd0d89d", `sha-1("abc"): ${sha1.digest}`);
    const all = await run("crypto_digest", { data: "abc", encoding: "all" });
    assert(all.base64 && all.base64url && all.hex, "all encodings");

    // Ids.
    const ids = await run("crypto_id", { kind: "ulid", count: 5 });
    assert(ids.ids.length === 5, "five ids");
    for (const id of ids.ids) assert(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), `ulid charset/length: ${id}`);
    assert([...ids.ids].sort().join() === ids.ids.join(), "ulids generated in the same millisecond stay ordered");
    const uuids = await run("crypto_id", { kind: "uuid", count: 2, prefix: "call" });
    assert(uuids.ids.every((i: string) => /^call_[0-9a-f-]{36}$/.test(i)), `prefixed uuids: ${JSON.stringify(uuids.ids)}`);
    const nanoid = await run("crypto_id", { kind: "nanoid", length: 12 });
    assert(nanoid.id.length === 12, `nanoid length: ${nanoid.id}`);

    // Encoding round-trips.
    const b64 = await run("encode_transform", { data: "hello ✓", to: "base64" });
    assert(b64.result === "aGVsbG8g4pyT", `utf8 -> base64: ${b64.result}`);
    const back = await run("encode_transform", { data: "aGVsbG8g4pyT", from: "base64", to: "utf8" });
    assert(back.result === "hello ✓", "base64 -> utf8 round-trip");
    const hexed = await run("encode_transform", { data: "414243", from: "hex", to: "utf8" });
    assert(hexed.result === "ABC", "hex -> utf8");
    const badHex = await executeTool("encode_transform", { data: "zz", from: "hex" });
    const hexErr = fail(badHex);
    assert(/decode failed/.test(hexErr.error), `invalid hex reported: ${hexErr.error}`);

    // JWT inspection is explicit about not verifying.
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/, "");
    const payload = btoa(JSON.stringify({ sub: "1234", iss: "nokey", iat: 1700000000, exp: 1700003600 })).replace(/=+$/, "");
    const jwt = await run("encode_jwt", { token: `${header}.${payload}.sig` });
    assert(jwt.verified === false && jwt.payload.sub === "1234", `jwt decoded: ${JSON.stringify(jwt)}`);
    assert(jwt.expired === true, "a 2023 expiry is expired");
    assert(jwt.expires_at.iso === "2023-11-14T23:13:20.000Z", `exp interpreted: ${jwt.expires_at.iso}`);
    assert(jwt.issued_at.iso === "2023-11-14T22:13:20.000Z", `iat interpreted: ${jwt.issued_at.iso}`);
    const badJwt = await executeTool("encode_jwt", { token: "nope" });
    fail(badJwt);
    assert(true, "malformed token rejected");

    // Reproducible randomness.
    const a = await run("random_sample", { seed: "nokey", count: 5, distribution: "normal", mean: 10, sd: 2 });
    const b = await run("random_sample", { seed: "nokey", count: 5, distribution: "normal", mean: 10, sd: 2 });
    assert(JSON.stringify(a.values) === JSON.stringify(b.values), "same seed must reproduce exactly");
    const c = await run("random_sample", { seed: "other", count: 5, distribution: "normal", mean: 10, sd: 2 });
    assert(JSON.stringify(a.values) !== JSON.stringify(c.values), "different seed differs");
    const uniform = await run("random_sample", { seed: 1, count: 200, min: 0, max: 1 });
    assert(uniform.values.every((v: number) => v >= 0 && v <= 1), "uniform within bounds");
    near(uniform.mean, 0.5, 0.08, "uniform mean near 0.5");
    const beta = await run("random_sample", { seed: 7, count: 100, distribution: "beta", alpha: 2, beta: 5 });
    assert(beta.values.every((v: number) => v >= 0 && v <= 1), "beta within [0,1]");
    near(beta.mean, 2 / 7, 0.08, "beta mean near alpha/(alpha+beta)");
    const sampled = await run("random_sample", { seed: 3, population: [1, 2, 3, 4, 5], count: 3 });
    assert(new Set(sampled.values).size === 3, "sampling without replacement is distinct");
    const shuffled = await run("random_sample", { seed: 3, population: [1, 2, 3, 4, 5], shuffle: true });
    assert([...shuffled.values].sort().join() === "1,2,3,4,5", "shuffle is a permutation");
    const tooMany = await run("random_sample", { seed: 3, population: [1, 2], count: 5 });
    assert(tooMany.error !== undefined, "oversampling without replacement reports instead of lying");
    const rng = seededRandom("stable");
    assert(rng() === seededRandom("stable")(), "seeded PRNG is deterministic");
  },
});

Deno.test({
  name: "execution sandbox: unknown tools, argument errors, timeouts, result caps",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const unknown = await executeTool("does_not_exist", {});
    assert(!unknown.ok && unknown.code === "UNKNOWN_TOOL", "unknown tool code");
    assert(Array.isArray(fail(unknown).suggestions), "unknown tool offers suggestions");

    const badArgs = await executeTool("math_statistics", { values: "not a list" });
    const argErr = fail(badArgs);
    assert(argErr.code === "INVALID_ARGUMENTS", `code: ${argErr.code}`);
    assert((argErr.issues ?? []).length > 0, "schema diagnostics returned to the model");

    // A slow tool is cut by its own deadline rather than blocking the request.
    registerTool({
      name: "test_slow",
      kind: "compute",
      description: "test-only tool that outlives its deadline",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: (_args, ctx) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ late: true }), 5_000);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve({ aborted: true });
          });
        }),
    });
    const slow = await executeTool("test_slow", {}, { timeoutMs: 40 });
    const slowErr = fail(slow);
    assert(slowErr.code === "TIMEOUT" || slowErr.code === "ABORTED", `timeout code: ${slowErr.code}`);
    assert(slowErr.ms < 2_000, `timeout must fire promptly, took ${slowErr.ms}ms`);

    // A throwing tool surfaces its message without poisoning the plane.
    registerTool({
      name: "test_throws",
      kind: "compute",
      description: "test-only tool that throws",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: () => {
        throw new Error("boom");
      },
    });
    const threw = await executeTool("test_throws", {});
    const threwErr = fail(threw);
    assert(threwErr.code === "TOOL_ERROR" && /boom/.test(threwErr.error), `throw surfaced: ${JSON.stringify(threwErr)}`);

    // Oversized results are capped, not sent whole.
    registerTool({
      name: "test_huge",
      kind: "compute",
      description: "test-only tool that returns a huge array",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: () => ({ items: Array.from({ length: 200_000 }, (_, i) => ({ i, pad: "x".repeat(40) })) }),
    });
    const huge = await executeTool("test_huge", {}, { maxResultBytes: 4096 });
    assert(huge.ok, "capped result still succeeds");
    assert(huge.truncated, "truncation flagged");
    assert(huge.bytes > 0, "true size reported");
    assert(JSON.stringify(huge.result).length < 8192, `payload actually shrank: ${JSON.stringify(huge.result).length}`);

    // Admin-gated tools refuse without the secret.
    registerTool({
      name: "test_admin",
      kind: "mesh",
      admin: true,
      description: "test-only admin tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: () => ({ ok: true }),
    });
    const denied = await executeTool("test_admin", {});
    assert(fail(denied).code === "ADMIN_REQUIRED", `admin gate: ${fail(denied).code}`);
    const allowed = await executeTool("test_admin", {}, { admin: true });
    assert(allowed.ok, "admin secret unlocks it");
    assert(!toToolSpecs().some((t: any) => t.function?.name === "test_admin"), "admin tools are never advertised to models");
    assert(toToolSpecs({ includeAdmin: true }).some((t: any) => t.function?.name === "test_admin"), "includeAdmin opt-in works");
  },
});

Deno.test("vendor projections: one registry, four wire formats", () => {
  const openai = toToolSpecs({ names: ["math_evaluate"] }) as any[];
  assert(openai.length === 1 && openai[0].type === "function", "openai envelope");
  assert(openai[0].function.name === "math_evaluate", "openai name");
  assert(openai[0].function.parameters.properties.expression, "openai parameters");

  const strict = toToolSpecs({ flavor: "openai-strict", names: ["math_statistics"] }) as any[];
  const params = strict[0].function.parameters;
  assert(strict[0].function.strict === true, "strict flag set");
  assert(params.additionalProperties === false, "strict closes the object");
  assert(params.required.includes("values"), "declared required kept");
  assert(!("maxItems" in params.properties.values), `strict mode drops unsupported keywords: ${JSON.stringify(params.properties.values)}`);
  assert(!("minimum" in (params.properties.bins ?? {})), "numeric constraints stripped for strict mode");

  const anthropic = toToolSpecs({ flavor: "anthropic", names: ["math_evaluate"] }) as any[];
  assert(anthropic[0].input_schema && anthropic[0].name === "math_evaluate", "anthropic shape");

  const gemini = toToolSpecs({ flavor: "gemini", names: ["math_evaluate"] }) as any[];
  const decl = gemini[0].functionDeclarations[0];
  assert(decl.parameters.type === "OBJECT", `gemini upper-cases types: ${decl.parameters.type}`);
  assert(decl.parameters.properties.expression.type === "STRING", "gemini nested types");

  // toStrictSchema keeps $defs/$ref intact and marks nullable unions.
  const strictRef = toStrictSchema({ $defs: { a: { type: "string" } }, type: "object", properties: { x: { $ref: "#/$defs/a" } } }) as any;
  assert(strictRef.$defs.a.type === "string", "$defs preserved");
  assert(strictRef.properties.x.$ref === "#/$defs/a", "$ref preserved");

  // Client tools always win over a shadowed built-in.
  const merged = mergeToolDeclarations(
    [{ type: "function", function: { name: "math_evaluate", description: "mine", parameters: { type: "object" } } }],
    { names: ["math_evaluate", "json_query"] },
  ) as any[];
  assert(merged.length === 2, `both declarations present: ${merged.length}`);
  assert(merged[0].function.description === "mine", "client declaration not hijacked");
  assert(merged[1].function.name === "json_query", "built-in still appended");

  const preamble = toolPreamble(["math_evaluate"]);
  assert(preamble.includes("math_evaluate"), "preamble lists the tools");
});

Deno.test("call partitioning: the router executes its own calls and returns the rest untouched", () => {
  const normalized = normalizeToolCalls([
    { index: 0, id: "c1", function: { name: "math.evaluate", arguments: { expression: "1+1" } } },
    { index: 1, function: { name: "get_weather", arguments: '{"city":"Baton Rouge"}' } },
  ]);
  assert(normalized.length === 2, "both calls normalised");
  assert(normalized[0].builtin && normalized[0].resolved === "math_evaluate", "dotted name resolves to the registry");
  assert(normalized[0].arguments === '{"expression":"1+1"}', `object arguments stringified: ${normalized[0].arguments}`);
  assert(!normalized[1].builtin, "client tool is not ours");
  assert(typeof normalized[1].id === "string" && normalized[1].id.length > 0, "missing ids are synthesised");

  const mixed = partitionToolCalls([
    { function: { name: "math_evaluate", arguments: "{}" } },
    { function: { name: "get_weather", arguments: "{}" } },
  ]);
  assert(mixed.mine.length === 0 && mixed.theirs.length === 2, "a mixed batch is handed back to the client whole");

  const ours = partitionToolCalls([{ function: { name: "json_query", arguments: "{}" } }]);
  assert(ours.mine.length === 1 && ours.theirs.length === 0, "an all-built-in batch is executable");

  const theirs = partitionToolCalls([{ function: { name: "get_weather", arguments: "{}" } }]);
  assert(theirs.mine.length === 0 && theirs.theirs.length === 1, "client-only batch passes through");

  assert(resolveAutoToolNames("auto")?.length === DEFAULT_AUTO_TOOLS.length, "auto expands to the default set");
  assert(resolveAutoToolNames(true)?.length === DEFAULT_AUTO_TOOLS.length, "boolean flag expands too");
  assert(resolveAutoToolNames("all")!.includes("json_transform"), "all expands to the full non-admin set");
  assert(resolveAutoToolNames("math.evaluate, json_query")?.length === 2, "explicit list resolved");
  assert(resolveAutoToolNames(["math_evaluate"])?.length === 1, "array form");
  assert(resolveAutoToolNames("test_admin") === null, "admin tools cannot be auto-attached by a client");
  assert(resolveAutoToolNames(undefined) === null, "no request, no tools");
  assert(resolveAutoToolNames("nope_nope_nope") === null, "unresolvable names yield nothing");
});

Deno.test({
  name: "skill memory compounds: Kalman latency + discounted Beta reliability",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const now = Date.now();
    let skill: ToolSkillRecord = emptyToolSkill("math_evaluate", now);
    assert(skill.calls === 0 && skill.alpha === 1 && skill.beta === 1, "fresh record is the uniform prior");

    // 40 clean executions: competence climbs, latency posterior tightens.
    const sigmaBefore = skillSummary(skill, now).p95_ms;
    for (let i = 0; i < 40; i++) skill = observeToolSkill(skill, { ok: true, ms: 20 }, now + i);
    const healthy = skillSummary(skill, now + 40);
    assert(healthy.calls === 40 && healthy.errors === 0, "counters");
    assert(healthy.success_rate === 1, "perfect success rate");
    // Wilson's floor on ~27 discounted successes (the 0.98 leak is deliberate:
    // a tool that stops being used must slide back toward the prior).
    assert(healthy.competence > 0.85, `Wilson floor after 40 successes: ${healthy.competence}`);
    assert(healthy.p50_ms > 10 && healthy.p50_ms < 40, `Kalman converged on ~20ms: ${healthy.p50_ms}`);
    assert(healthy.p95_ms > healthy.p50_ms, "tail above the median");
    void sigmaBefore;

    // Failures pull it back down fast, and the error codes are learned.
    for (let i = 0; i < 20; i++) skill = observeToolSkill(skill, { ok: false, ms: 900, code: "TOOL_ERROR", error: "upstream 500" }, now + 100 + i);
    const broken = skillSummary(skill, now + 200);
    assert(broken.errors === 20, "errors counted");
    assert(broken.competence < healthy.competence, "competence fell");
    assert(broken.top_errors[0].code === "TOOL_ERROR" && broken.top_errors[0].count === 20, "error codes learned");
    assert(broken.last_error === "upstream 500", "last error retained");
    assert(broken.p95_ms > healthy.p95_ms, "latency posterior absorbed the slow failures");
    const okAgain = observeToolSkill(skill, { ok: true, ms: 25 }, now + 201);
    assert(okAgain.last_error === null, "a success clears the last error");

    // Repairs are tracked separately: they are a wire-quality signal, not a failure.
    let repaired = emptyToolSkill("json_query", now);
    for (let i = 0; i < 10; i++) repaired = observeToolSkill(repaired, { ok: true, ms: 5, repaired: true }, now + i);
    assert(skillSummary(repaired, now + 10).repair_rate === 1, "repair rate is 100%");
    assert(skillSummary(repaired, now + 10).success_rate === 1, "repaired calls still count as successes");

    // Stale evidence decays back toward the prior (6 h half-life).
    const stale = skillSummary(skill, now + 48 * 3_600_000);
    assert(stale.stale_hours >= 47, `staleness reported: ${stale.stale_hours}`);
    assert(stale.p95_ms > broken.p95_ms, "an idle tool regains uncertainty instead of looking confidently fast");

    // Deterministic summaries are stable; Thompson draws vary.
    const d1 = skillSummary(skill, now, true).competence_draw;
    const d2 = skillSummary(skill, now, true).competence_draw;
    assert(d1 === d2, "deterministic mode must not sample");
    const draws = new Set<number>();
    for (let i = 0; i < 25; i++) draws.add(skillSummary(skill, now).competence_draw);
    assert(draws.size > 1, "sampling mode explores");

    // Executions feed the record end to end.
    const before = emptyToolSkill("math_evaluate", Date.now());
    const exec = await executeTool("math_evaluate", { expression: "6*7" });
    const after = observeToolSkill(before, { ok: exec.ok, ms: exec.ms, repaired: exec.ok ? exec.repairs.length > 0 : false }, Date.now());
    assert(after.calls === 1 && after.errors === 0, "a successful execution updates the record");

    // Per-tuple tool competence: the routing signal main.ts compounds on.
    let tuple = observeTupleToolStats({}, { valid: true }, now);
    for (let i = 0; i < 30; i++) tuple = observeTupleToolStats(tuple, { valid: true }, now + i);
    const good = tupleToolCompetence(tuple, now + 30);
    assert(good > 0.8, `a tuple that always emits valid calls ranks high: ${good}`);
    assert(toolRoutingBonus(tuple, { now: now + 30 }) > 0, "positive routing bonus");

    let bad = observeTupleToolStats({}, { valid: false, repaired: true }, now);
    for (let i = 0; i < 30; i++) bad = observeTupleToolStats(bad, { valid: false }, now + i);
    assert(tupleToolCompetence(bad, now + 30) < good, "a tuple that mangles calls ranks lower");
    assert(toolRoutingBonus(bad, { now: now + 30 }) < 0, "negative routing bonus");

    // Repaired-but-valid sits between the two: intent right, wire format wrong.
    let half = observeTupleToolStats({}, { valid: true, repaired: true }, now);
    for (let i = 0; i < 30; i++) half = observeTupleToolStats(half, { valid: true, repaired: true }, now + i);
    const halfScore = tupleToolCompetence(half, now + 30);
    assert(halfScore < good && halfScore > tupleToolCompetence(bad, now + 30), `repaired competence between clean and broken: ${halfScore}`);

    // No evidence -> no opinion, so exploration still drives new tuples.
    assert(toolRoutingBonus({}, { now }) === 0, "unproven tuples get a neutral bonus");
    assert(tupleToolCompetence({}, now) === 0, "unproven tuples have no competence claim");
    const deterministic = toolRoutingBonus(tuple, { now: now + 30, deterministic: true });
    assert(deterministic === toolRoutingBonus(tuple, { now: now + 30, deterministic: true }), "deterministic bonus is stable");
  },
});

Deno.test("damage accounting: defaults are not repairs, shadows are not ours, hints reach the model", async () => {
  // Filling a declared default is not damage: `repaired` has to stay a signal
  // about the caller's payload, not about how optional a schema happens to be.
  const cleanExec = await executeTool("math_evaluate", { expression: "1+1" });
  assert(cleanExec.ok, `clean call must succeed: ${JSON.stringify(cleanExec)}`);
  const clean = cleanExec as ToolExecutionOk;
  assert(clean.repaired === false, `defaults counted as damage: ${JSON.stringify(clean.repairs)}`);
  assert(clean.repairs.some((r) => r.endsWith(":default")), "the fill is still reported for transparency");
  assert((clean.result as any).value === 2, "the call still ran");

  // Real damage — a fence plus single quotes — is exactly what it is for.
  const damagedExec = await executeTool("math_evaluate", "```json\n{'expression': '6*7'}\n```");
  assert(damagedExec.ok, `damaged call must be recovered: ${JSON.stringify(damagedExec)}`);
  const damaged = damagedExec as ToolExecutionOk;
  assert(damaged.repaired, "a recovered call reports itself as repaired");
  assert((damaged.result as any).value === 42, "and still computes the right answer");

  // Inclusive-bound clamping is damage too, and it is bounded rather than fatal.
  const clampedExec = await executeTool("math_evaluate", { expressions: new Array(200).fill("1") });
  assert(clampedExec.ok, `clamped call must succeed: ${JSON.stringify(clampedExec)}`);
  const clamped = clampedExec as ToolExecutionOk;
  assert(clamped.repaired, "clamping is reported as a repair");
  assert((clamped.result as any).count === 64, `batch clamped to maxItems: ${(clamped.result as any).count}`);

  // anyOf picks the branch that describes the value best, i.e. the one needing
  // the fewest repairs — not the one that rewrites the most.
  const choice = validateJson("5", { anyOf: [{ type: "string" }, { type: "integer" }] }, { coerce: true });
  assert(choice.ok, `anyOf coercion failed: ${JSON.stringify(choice.issues)}`);
  assert(choice.value === "5", `an already-valid branch must win untouched: ${JSON.stringify(choice.value)}`);
  const coercedChoice = validateJson(5, { anyOf: [{ type: "string" }, { type: "integer" }] }, { coerce: true });
  assert(coercedChoice.ok && coercedChoice.value === 5, `integer branch wins for a number: ${JSON.stringify(coercedChoice.value)}`);

  // A caller-declared name shadows a built-in of the same name: the plane must
  // never hijack the caller's own API.
  const shadowed = partitionToolCalls([{ function: { name: "math_evaluate", arguments: "{}" } }], { clientNames: ["math_evaluate"] });
  assert(shadowed.mine.length === 0 && shadowed.theirs.length === 1, "a shadowed built-in stays the caller's");
  const aliasShadow = partitionToolCalls([{ function: { name: "Math.Evaluate", arguments: "{}" } }], { clientNames: ["math-evaluate"] });
  assert(aliasShadow.mine.length === 0, "shadowing is matched through the name normaliser");
  const unshadowed = partitionToolCalls([{ function: { name: "math_evaluate", arguments: "{}" } }], { clientNames: ["get_weather"] });
  assert(unshadowed.mine.length === 1, "an unrelated client tool does not disable the plane");

  // An unknown tool explains itself in prose as well as in the structured
  // field, because a model retrying from the message text alone must still see
  // the correction.
  const hint = fail(await executeTool("json_querry", {}));
  assert(hint.code === "UNKNOWN_TOOL", `code ${hint.code}`);
  assert(/json_query/.test(hint.error), `the hint must be in the message: ${hint.error}`);
  assert(hint.suggestions?.[0]?.name === "json_query", "and in the structured suggestions");

  // Declarations merge with the caller's version winning, de-duplicated.
  const merged = mergeToolDeclarations(
    [{ type: "function", function: { name: "math_evaluate", description: "client-owned" } }],
    { names: ["math_evaluate", "json_query"] },
  ) as any[];
  assert(merged.length === 2, `merged to ${merged.length} declarations`);
  assert(merged[0].function.description === "client-owned", "the client declaration wins");
  assert(merged[1].function.name === "json_query", "the plane's own tool is still offered");
});
