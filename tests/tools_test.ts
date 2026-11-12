// deno-lint-ignore-file no-explicit-any
/**
 * Toolbox tests — kernel + capabilities, no network.
 *
 *   1. registry, schema validation, the argument repair ladder;
 *   2. every capability: web (stubbed fetch), files, memory, RAG, embeddings,
 *      clipboard, tasks, compute/data/text/time/crypto;
 *   3. the learning machinery that makes tool knowledge compound.
 *
 * Run: deno test --unstable-kv -A tests/
 */
import {
  DEFAULT_AUTO_TOOLS,
  emptyToolSkill,
  executeTool,
  parseTextToolCalls,
  executeToolCalls,
  extractJsonCandidate,
  getTool,
  listTools,
  mergeToolDeclarations,
  normalizeToolCalls,
  normalizeToolName,
  observeToolSkill,
  observeTupleToolStats,
  parseToolArguments,
  partitionToolCalls,
  registerTool,
  repairJsonText,
  autoToolsForClass,
  resolveAutoToolNames,
  resolveTool,
  skillSummary,
  toStrictSchema,
  toToolSpecs,
  toolPreamble,
  toolRoutingBonus,
  tupleToolCompetence,
  unregisterTool,
  validateJson,
  type ToolExecution,
  type ToolExecutionErr,
  type ToolExecutionOk,
  type ToolSkillRecord,
} from "../tools.ts";
import { bm25, chunkText, cosineI8, dequantize, embed, quantize, rankOf, rrf } from "../toolbox/vec.ts";
import { isPrivateProbe } from "../toolbox/web.ts";
import { stubFetch } from "./web_stub.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function fail(exec: ToolExecution): ToolExecutionErr {
  assert(!exec.ok, `expected a failure, got ${JSON.stringify(exec).slice(0, 300)}`);
  return exec as ToolExecutionErr;
}
const near = (a: number, b: number, tol = 1e-6, msg = "") => assert(Math.abs(a - b) <= tol, `${msg} expected ~${b}, got ${a}`);

async function run(name: string, args: unknown, opts: { namespace?: string; fetch?: typeof fetch } = {}): Promise<any> {
  const exec = await executeTool(name, args, opts.namespace || opts.fetch ? { caps: { namespace: opts.namespace, fetch: opts.fetch } } : {});
  if (!exec.ok) throw new Error(`${name} failed: ${exec.code} ${exec.error} ${JSON.stringify(exec.issues ?? []).slice(0, 300)}`);
  return (exec as ToolExecutionOk).result;
}

// ---------------------------------------------------------------------------
// 1. Registry & name resolution
// ---------------------------------------------------------------------------

Deno.test("registry: a coherent, wire-safe, agent-grade tool set", () => {
  const tools = listTools();
  assert(tools.length >= 20, `expected a broad toolbox, got ${tools.length}`);
  for (const t of tools) {
    assert(/^[a-z0-9_]{1,64}$/.test(t.name), `tool name "${t.name}" is not wire-safe`);
    assert(t.description.length > 60, `${t.name} needs a description a model can act on`);
    assert((t.parameters as any).type === "object", `${t.name} parameters must be an object schema`);
    assert(new Set(t.aliases ?? []).size === (t.aliases ?? []).length, `${t.name} has duplicate aliases`);
  }
  for (const name of DEFAULT_AUTO_TOOLS) assert(getTool(name), `DEFAULT_AUTO_TOOLS advertises missing tool ${name}`);

  // The old toy set is gone; the new one is real I/O plus real computation.
  const names = new Set(tools.map((t) => t.name));
  for (const retired of ["math_evaluate", "math_statistics", "json_query", "json_validate", "json_transform", "text_extract", "text_similarity", "time_convert", "crypto_digest", "crypto_id", "encode_transform", "encode_jwt", "random_sample"]) {
    assert(!names.has(retired), `retired tool ${retired} is still registered`);
  }
  for (const needed of ["web_search", "web_fetch", "http_request", "fs_read", "fs_write", "fs_patch", "fs_grep", "clipboard", "memory_write", "memory_recall", "rag_index", "rag_search", "embed", "task", "calculate", "data", "text", "time", "crypto"]) {
    assert(names.has(needed), `missing capability ${needed}`);
  }
  const kinds = new Set(tools.map((t) => t.kind));
  for (const kind of ["web", "files", "memory", "rag", "vector", "clipboard", "task", "compute", "data", "text", "time", "crypto"]) {
    assert(kinds.has(kind as any), `kind ${kind} unused`);
  }

  // Every spelling a model might emit resolves to one canonical name.
  assert(resolveTool("math.evaluate").tool?.name === "calculate", "dotted alias");
  assert(resolveTool("math-evaluate").tool?.name === "calculate", "kebab spelling");
  assert(resolveTool("MathEvaluate").tool?.name === "calculate", "camel spelling");
  assert(resolveTool("calculator").tool?.name === "calculate", "declared alias");
  assert(resolveTool("read_file").tool?.name === "fs_read", "fs alias");
  assert(resolveTool("mem_recall").tool?.name === "memory_recall", "near miss resolves");
  assert(normalizeToolName("  Router.Health!! ") === "router_health", "normaliser strips punctuation/case");
  const unknown = resolveTool("weather_lookup");
  assert(unknown.tool === undefined && Array.isArray(unknown.suggestions), "unknown names still return suggestions");
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
  const strict = validateJson({ count: "5", ratio: 0, mode: "FAST", tags: "a,b,c,d", nested: { deep: "yes", extra: 1 } }, schema);
  assert(!strict.ok, "uncoerced payload must fail");
  assert(strict.issues.some((i) => i.path === "/count" && i.keyword === "type"), "count type issue at /count");
  assert(strict.issues.some((i) => i.path === "/ratio" && i.keyword === "exclusiveMinimum"), "exclusiveMinimum reported");
  assert(strict.issues.some((i) => i.path === "/tags" && i.keyword === "type"), "comma string is not an array without coercion");

  const fixed = validateJson({ count: "5", ratio: "0.25", mode: "FAST", tags: "a,b,c,d", nested: { deep: "yes", extra: 1 } }, schema, { coerce: true });
  assert(fixed.ok, `coerced payload must validate: ${JSON.stringify(fixed.issues)}`);
  assert(fixed.repairs > 0, "repairs must be recorded");
  const value: any = fixed.value;
  assert(value.count === 5, `"5" -> 5, got ${value.count}`);
  near(value.ratio, 0.25);
  assert(value.mode === "fast", "enum casing repaired");
  assert(Array.isArray(value.tags) && value.tags.length === 3, `maxItems clamp: ${JSON.stringify(value.tags)}`);
  assert(value.nested.deep === true, "boolean coerced");
  assert(!("extra" in value.nested), "undeclared key dropped");
});

Deno.test("repair ladder: fences, prose, single quotes, bare keys, Python literals, truncation", () => {
  const schema = { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } }, required: ["query"], additionalProperties: false };
  const cases: Array<[string, string]> = [
    ["markdown fence", '```json\n{"query": "hello", "limit": 5}\n```'],
    ["prose wrapper", 'Sure! Here you go: {"query": "hello", "limit": 5} — hope that helps.'],
    ["single quotes", "{'query': 'hello', 'limit': 5}"],
    ["bare keys", '{query: "hello", limit: 5}'],
    ["python literals", '{"query": "hello", "limit": 5, "flag": None}'],
    ["trailing commas", '{"query": "hello", "limit": 5,}'],
    ["comments", '{\n// the query\n"query": "hello",\n"limit": 5\n}'],
  ];
  for (const [label, raw] of cases) {
    const parsed = parseToolArguments(raw, schema);
    assert(parsed.repaired, `${label}: expected a repair`);
    assert(parsed.ok, `${label}: ladder must satisfy the schema (${parsed.error ?? ""})`);
    assert((parsed.value as any).query === "hello", `${label}: query lost`);
  }
  const double = parseToolArguments('"{\\"query\\": \\"hello\\", \\"limit\\": 5}"', schema);
  assert(double.strategy === "double-decode" && double.ok, `double-decode: ${double.strategy}`);

  const truncated = parseToolArguments('{"query": "hello", "lim', schema);
  assert(truncated.ok, `truncated args must survive (${truncated.error})`);
  assert(truncated.repairs.includes("truncated"), `repairs should mention truncation: ${truncated.repairs}`);
  assert((truncated.value as any).query === "hello" && (truncated.value as any).lim === undefined, "half-written key dropped");

  const salvage = parseToolArguments('query = "hello"; limit: 5   <<<not json>>>', schema);
  assert(salvage.strategy === "salvage" && (salvage.value as any).query === "hello", `salvage: ${salvage.strategy}`);
  assert(parseToolArguments('{"query":"hi"}', schema).strategy === "strict", "valid JSON is never rewritten");
  assert(parseToolArguments({ query: "hi" }, schema).strategy === "native", "objects skip parsing");
  assert(parseToolArguments("", schema).strategy === "empty", "empty arguments are distinct");
  assert(!parseToolArguments('{"limit": 5}', schema).ok, "missing required key still fails");
  assert(extractJsonCandidate('```json\n{"a":1}\n```') === '{"a":1}', "fence extraction");
  assert(repairJsonText("{a: 'b',}").text === '{"a": "b"}', `repairJsonText: ${repairJsonText("{a: 'b',}").text}`);
});

// ---------------------------------------------------------------------------
// 2. Deterministic compute
// ---------------------------------------------------------------------------

Deno.test("calculate: exact arithmetic, functions, batching and statistics", async () => {
  assert((await run("calculate", { expression: "(23 * 19) + 14" })).value === 451, "precedence");
  assert((await run("calculate", { expression: "2^10 + 1" })).value === 1025, "power");
  assert((await run("calculate", { expression: "-3^2" })).value === -9, "unary binds looser than ^");
  assert((await run("calculate", { expression: "0.1 + 0.2" })).value === 0.3, "float dust is not shown");
  assert((await run("calculate", { expression: "sin(30)", angle: "deg" })).value === 0.5, "degree mode");
  assert((await run("calculate", { expression: "gcd(84, 30)" })).value === 6, "gcd");
  assert((await run("calculate", { expression: "fact(6) + norm_cdf(0)" })).value === 720.5, "factorial + erf");
  assert((await run("calculate", { expression: "2*x + y", variables: { x: 3, y: 4 } })).value === 10, "variables");
  const batch = await run("calculate", { expressions: ["1+1", "2+"] });
  assert(batch.count === 2 && batch.results[0].value === 2, "batch evaluates independently");
  assert(typeof batch.results[1].error === "string", "per-expression errors are values, not failures");
  const nan = await run("calculate", { expression: "sqrt(-1)" });
  assert(Number.isNaN(nan.value) && String(nan.note).includes("non-finite"), `NaN is reported, not thrown: ${JSON.stringify(nan)}`);

  const stats = await run("calculate", { values: [3, 5, 7, 9, 100], quantiles: [0.5, 0.95] });
  assert(stats.median === 7 && stats.mean === 24.8, `stats ${JSON.stringify(stats)}`);
  assert(stats.outliers.values.includes(100), "Tukey outlier");
  assert(stats.quantiles.p50 === 7, "type-7 quantile");
  assert((await run("calculate", { expression: "nope(1)" })).error.includes("unknown function"), "grammar is closed");
});

Deno.test("data: JSONPath, conversion, reshaping and validation", async () => {
  const doc = { store: { books: [{ title: "A", price: 5 }, { title: "B", price: 25 }] } };
  assert((await run("data", { op: "query", data: doc, path: "$.store.books[1].title" })).value === "B", "index path");
  assert((await run("data", { op: "query", data: doc, path: "$.store.books[*].price" })).count === 2, "wildcard");
  const filter = await run("data", { op: "query", data: doc, path: "$.store.books[?(@.price>10)].title" });
  assert(JSON.stringify(filter.value) === '"B"' || filter.value === "B", `filter ${JSON.stringify(filter)}`);
  assert((await run("data", { op: "query", data: { a: { id: 1 }, b: { id: 2 } }, path: "$..id" })).count === 2, "recursive descent");

  const csv = await run("data", { op: "convert", data: [{ a: 1, b: 2 }, { a: 3, b: 4 }], to: "csv" });
  assert(csv.value === "a,b\n1,2\n3,4", `csv ${csv.value}`);
  const back = await run("data", { op: "convert", data: "a,b\n1,2", from: "csv", to: "json" });
  assert(Array.isArray(back.value) && back.value[0].a === "1", `csv->json ${JSON.stringify(back.value)}`);

  const grouped = await run("data", { op: "transform", data: [{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "a", v: 3 }], group_by: "k" });
  assert(grouped.groups === 2 && grouped.value.a.length === 2, `group ${JSON.stringify(grouped).slice(0, 200)}`);
  const sorted = await run("data", { op: "transform", data: [{ n: 3 }, { n: 1 }, { n: 2 }], sort_by: "n", limit: 2 });
  assert(sorted.value[0].n === 1 && sorted.value.length === 2, "sort + limit");
  const picked = await run("data", { op: "transform", data: { a: 1, b: 2, c: { d: 3 } }, pick: ["a", "c.d"] });
  assert(picked.value["a"] === 1 && picked.value["c.d"] === 3, `pick ${JSON.stringify(picked.value)}`);

  const valid = await run("data", { op: "validate", data: { n: "5" }, schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } });
  assert(valid.valid === true && valid.value.n === 5, `validate ${JSON.stringify(valid)}`);
  const invalid = await run("data", { op: "validate", data: { n: "x" }, schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } });
  assert(invalid.valid === false && invalid.issues.length > 0, "invalid payload reports issues, not a crash");
});

Deno.test("text: extraction, similarity, diff, replace, template, summary, stats", async () => {
  const emails = await run("text", { op: "extract", text: "mail a@b.co and c@d.io", kind: "emails" });
  assert(emails.count === 2 && emails.matches[0].value === "a@b.co", "email preset");
  const grouped = await run("text", { op: "extract", text: "id=42 name=bob", pattern: "id=(\\d+)", flags: "g" });
  assert(grouped.matches[0].groups[0] === "42", "capture groups");

  const sim = await run("text", { op: "similarity", text: "gpt-4o-mini", candidates: ["gpt-4o", "claude-3-5-sonnet", "gpt-4o-mini-2024"] });
  assert(sim.best.candidate === "gpt-4o-mini-2024", `similarity ${JSON.stringify(sim.best)}`);
  assert(sim.ranked[2].candidate === "claude-3-5-sonnet", "ranking is complete");

  const diff = await run("text", { op: "diff", text: "a\nb\nc", other: "a\nB\nc" });
  assert(diff.added === 1 && diff.removed === 1 && diff.identical === false, `diff ${JSON.stringify(diff)}`);

  const replaced = await run("text", { op: "replace", text: "a1 b2", pattern: "([a-z])(\\d)", replacement: "$2$1" });
  assert(replaced.text === "1a 2b", `replace ${replaced.text}`);

  const tpl = await run("text", { op: "template", text: "hi {{ user.name }} / {{ missing }}", vars: { user: { name: "ada" } } });
  assert(tpl.text === "hi ada / " && tpl.missing.includes("missing"), `template ${JSON.stringify(tpl)}`);

  const summary = await run("text", { op: "summarize", text: ("Alpha beta gamma. ".repeat(40)) + "The thesis is that retrieval beats context stuffing. " + ("Delta epsilon. ".repeat(40)), max_chars: 200 });
  assert(summary.summary_chars <= 200 && summary.compression < 0.5, "summary respects the budget");

  const stats = await run("text", { op: "stats", text: "One two. Three four five." });
  assert(stats.words === 5 && stats.sentences === 2 && stats.estimated_tokens > 0, `stats ${JSON.stringify(stats)}`);
});

Deno.test("time: now, parse, add, diff and IANA zones", async () => {
  const now = await run("time", { op: "now", zone: "UTC" });
  assert(now.iso.endsWith("Z") && now.epoch_ms > 1_700_000_000_000, "now");
  const ny = await run("time", { op: "convert", value: "2026-07-01T12:00:00Z", zone: "America/New_York" });
  assert(ny.utc_offset === "-04:00" && ny.local === "2026-07-01T08:00:00", `zone ${JSON.stringify(ny)}`);
  const added = await run("time", { op: "add", value: "2026-11-04T12:00:00Z", duration: "2h30m" });
  assert(added.iso === "2026-11-04T14:30:00.000Z", `add ${added.iso}`);
  assert((await run("time", { op: "add", value: "2026-11-04T00:00:00Z", duration: "P1DT2H" })).iso === "2026-11-05T02:00:00.000Z", "ISO duration");
  const diff = await run("time", { op: "diff", value: "2026-11-04T00:00:00Z", other: "2026-11-05T06:30:00Z", unit: "h" });
  assert(diff.value === 30.5 && diff.human === "1d 6h", `diff ${JSON.stringify(diff)}`);
  assert((await run("time", { op: "parse", value: "1793793600" })).epoch_s === 1793793600, "epoch seconds guessed");
  const bad = await executeTool("time", { op: "parse", value: "sometime last tuesday" });
  assert(!bad.ok && /cannot parse instant/.test(bad.error), "unparseable instants fail loudly");
});

Deno.test("crypto: digests, HMAC, ids, encodings and JWTs", async () => {
  const sha = await run("crypto", { op: "digest", data: "abc", algorithm: "sha-256" });
  assert(sha.hex === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", `sha256 ${sha.hex}`);
  assert(sha.base64 === "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=", "base64 output");
  const mac = await run("crypto", { op: "hmac", data: "The quick brown fox jumps over the lazy dog", key: "key", algorithm: "sha-256" });
  assert(mac.hex === "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8", `hmac ${mac.hex}`);

  const ids = await run("crypto", { op: "id", id_kind: "uuid7", count: 3 });
  assert(ids.ids.length === 3 && ids.ids.every((id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)), "uuidv7 shape");
  const ul = await run("crypto", { op: "id", id_kind: "ulid" });
  assert(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ul.id), `ulid ${ul.id}`);

  assert((await run("crypto", { op: "encode", data: "hello ✓", encoding: "base64" })).result === "aGVsbG8g4pyT", "base64 encode");
  assert((await run("crypto", { op: "decode", data: "aGVsbG8g4pyT", encoding: "base64" })).result === "hello ✓", "base64 decode");
  assert((await run("crypto", { op: "encode", data: "a b", encoding: "url" })).result === "a%20b", "url encode");
  assert((await run("crypto", { op: "decode", data: "a%20b", encoding: "url" })).result === "a b", "url decode");

  const signed = await run("crypto", { op: "jwt_sign", payload: { sub: "42", name: "ada" }, secret: "s3cret" });
  const decoded = await run("crypto", { op: "jwt_decode", data: signed.token });
  assert(decoded.payload.sub === "42" && decoded.header.alg === "HS256", `jwt ${JSON.stringify(decoded)}`);
});

// ---------------------------------------------------------------------------
// 3. The virtual workspace
// ---------------------------------------------------------------------------

Deno.test("files: write/read/list/grep/patch/delete inside a sandboxed namespace", async () => {
  const ns = "fs-test";
  const w = await run("fs_write", { path: "notes/a.md", content: "alpha\nbeta\ngamma\n" }, { namespace: ns });
  assert(w.created === true && w.bytes === 17 && w.lines === 4, `write ${JSON.stringify(w)}`);
  const appended = await run("fs_write", { path: "notes/a.md", content: "delta\n", mode: "append" }, { namespace: ns });
  assert(appended.bytes === 23 && appended.created === false, "append");

  const read = await run("fs_read", { path: "notes/a.md", offset: 2, limit: 2 }, { namespace: ns });
  assert(read.content === "beta\ngamma" && read.lines === 5 && read.truncated === true, `read ${JSON.stringify(read)}`);

  const list = await run("fs_list", { glob: "**/*.md" }, { namespace: ns });
  assert(list.count === 1 && list.dirs.includes("notes"), "list + glob");

  const grep = await run("fs_grep", { pattern: "a$", context: 1 }, { namespace: ns });
  assert(grep.count >= 2 && grep.matches[0].path === "notes/a.md" && Array.isArray(grep.matches[0].after), `grep ${JSON.stringify(grep).slice(0, 200)}`);

  // Exact replacement.
  const patched = await run("fs_patch", { path: "notes/a.md", edits: [{ old: "beta", new: "BETA" }] }, { namespace: ns });
  assert(patched.changed === true && patched.sha256, "edit applied");
  // Dry run never writes.
  const dry = await run("fs_patch", { path: "notes/a.md", edits: [{ old: "gamma", new: "GAMMA" }], dry_run: true }, { namespace: ns });
  assert(dry.dry_run === true, "dry run");
  // Unified diff with a shifted hunk: content anchoring still lands it.
  const unified = await run("fs_patch", {
    path: "notes/a.md",
    patch: "@@ -2,2 +2,2 @@\n-BETA\n+beta\n gamma\n",
  }, { namespace: ns });
  assert(unified.applied[0].match === "diff" && unified.applied[0].hunks === 1, `unified ${JSON.stringify(unified)}`);
  assert((await run("fs_read", { path: "notes/a.md" }, { namespace: ns })).content.includes("beta"), "patch content");

  const ambiguous = await run("fs_patch", { path: "notes/a.md", edits: [{ old: "a", new: "z", replace_all: true }] }, { namespace: ns });
  assert(ambiguous.changed, "replace_all allowed");

  // Path traversal is refused before any storage access.
  const escape = await executeTool("fs_read", { path: "../../etc/passwd" }, { caps: { namespace: ns } });
  assert(!escape.ok && /escapes the workspace/.test(escape.error), `traversal ${escape.ok ? "allowed" : escape.error}`);

  // Binary round-trip.
  const bytes = new Uint8Array([0, 255, 10, 128]);
  const b64 = btoa(String.fromCharCode(...bytes));
  await run("fs_write", { path: "bin/x.dat", content: b64, encoding: "base64" }, { namespace: ns });
  const bin = await run("fs_read", { path: "bin/x.dat" }, { namespace: ns });
  assert(bin.binary === true && bin.encoding === "base64", `binary ${JSON.stringify(bin)}`);

  const del = await run("fs_delete", { path: "notes", recursive: true }, { namespace: ns });
  assert(del.deleted === 1, `delete ${JSON.stringify(del)}`);
  const missing = await executeTool("fs_read", { path: "notes/a.md" }, { caps: { namespace: ns } });
  assert(!missing.ok && /no such file/.test(missing.error), "deleted file is gone");
});

Deno.test("batches keep stateful calls in order and parallelise pure ones", async () => {
  const opts = { caps: { namespace: "batch-order-test" } };
  const out = await executeToolCalls([
    { id: "1", name: "fs_write", arguments: { path: "order.txt", content: "first\n" } },
    { id: "2", name: "calculate", arguments: { expression: "6*7" } },
    { id: "3", name: "fs_read", arguments: { path: "order.txt" } },
    { id: "4", name: "memory_write", arguments: { text: "batched memory", importance: 0.5 } },
    { id: "5", name: "memory_recall", arguments: { query: "batched memory" } },
  ], opts);
  assert(out.every((r) => r.execution.ok), `all ok: ${JSON.stringify(out.map((r) => r.execution.ok))}`);
  assert(((out[2].execution as any).result?.content ?? "").startsWith("first"), "read sees the earlier write");
  assert((out[1].execution as any).result?.value === 42, "pure call still computes");
  assert((out[4].execution as any).result?.returned === 1, `recall sees the earlier write: ${JSON.stringify(out[4].execution)}`);
});

Deno.test("clipboard: named slots, revisions and undo", async () => {
  const ns = "clip-test";
  await run("clipboard", { op: "set", slot: "draft", text: "one" }, { namespace: ns });
  const appended = await run("clipboard", { op: "append", slot: "draft", text: " two" }, { namespace: ns });
  assert(appended.rev === 2, "revision increments");
  assert((await run("clipboard", { op: "get", slot: "draft" }, { namespace: ns })).text === "one two", "append");
  const undone = await run("clipboard", { op: "undo", slot: "draft" }, { namespace: ns });
  assert(undone.text === "one", `undo ${JSON.stringify(undone)}`);
  await run("clipboard", { op: "set", slot: "payload", text: "x" }, { namespace: ns });
  const list = await run("clipboard", { op: "list" }, { namespace: ns });
  assert(list.count === 2, `list ${JSON.stringify(list)}`);
  assert((await run("clipboard", { op: "clear", slot: "draft" }, { namespace: ns })).cleared === true, "clear");
});

Deno.test("task: a durable, deterministic plan board", async () => {
  const ns = "task-test";
  const a = await run("task", { op: "add", title: "read the repo", priority: 1 }, { namespace: ns });
  await run("task", { op: "add", title: "ship the toolbox" }, { namespace: ns });
  await run("task", { op: "update", id: a.added.id, status: "active" }, { namespace: ns });
  const board = await run("task", { op: "list" }, { namespace: ns });
  assert(board.total === 2 && board.counts.active === 1, `board ${JSON.stringify(board)}`);
  assert(board.next.title === "read the repo", "next action is the active task");
  await run("task", { op: "update", id: a.added.id, status: "done" }, { namespace: ns });
  assert((await run("task", { op: "list" }, { namespace: ns })).next.title === "ship the toolbox", "done tasks sink");
  const cleared = await run("task", { op: "clear" }, { namespace: ns });
  assert(cleared.cleared === 1 && cleared.remaining === 1, "clear removes finished tasks");
});

// ---------------------------------------------------------------------------
// 4. Memory and retrieval
// ---------------------------------------------------------------------------

Deno.test("memory: consolidation, hybrid recall, graph and forgetting", async () => {
  const ns = "mem-test";
  const first = await run("memory_write", { text: "The user prefers TypeScript and brutalist minimalism.", tags: ["user"], importance: 0.8 }, { namespace: ns });
  const merged = await run("memory_write", { text: "The user prefers TypeScript and brutalist minimal design.", tags: ["preference"] }, { namespace: ns });
  assert(merged.consolidated === true && merged.id === first.id, `near-duplicate must consolidate: ${JSON.stringify(merged)}`);
  const other = await run("memory_write", { text: "Deploys happen on Fridays at 16:00 UTC.", tags: ["ops"], importance: 0.6 }, { namespace: ns });
  assert(other.consolidated === false, "a different fact is not merged");

  const recalled = await run("memory_recall", { query: "when do we deploy?", k: 5 }, { namespace: ns });
  assert(recalled.returned >= 1 && recalled.memories.some((m: any) => m.text.includes("Fridays")), `recall ${JSON.stringify(recalled).slice(0, 300)}`);
  const reinforced = recalled.memories.find((m: any) => m.text.includes("Fridays"));
  assert(reinforced.uses >= 1, "recall reinforces usage");

  const linked = await run("memory_graph", { op: "link", from: first.id, to: other.id, rel: "context" }, { namespace: ns });
  assert(linked.links === 1, "link");
  const neighbors = await run("memory_graph", { op: "neighbors", from: first.id }, { namespace: ns });
  assert(neighbors.nodes.length === 2 && neighbors.edges.length === 1, `neighbors ${JSON.stringify(neighbors)}`);
  assert((await run("memory_graph", { op: "path", from: first.id, to: other.id }, { namespace: ns })).found === true, "path");

  const stats = await run("memory_graph", { op: "stats" }, { namespace: ns });
  assert(stats.memories === 2 && stats.edges === 1, `stats ${JSON.stringify(stats)}`);
  assert((await run("memory_forget", { tag: "ops" }, { namespace: ns })).deleted === 1, "forget by tag");
  assert((await run("memory_recall", { query: "deploy" }, { namespace: ns })).total === 1, "forgotten memory is gone");

  const isolated = await run("memory_recall", { query: "TypeScript" }, { namespace: "mem-other" });
  assert(isolated.total === 0, "tenants cannot see each other's memory");
});

Deno.test("rag: chunking, content-addressed indexing, hybrid retrieval and citations", async () => {
  const ns = "rag-test";
  const handbook = "The router caches embeddings by content hash. Retrieval fuses BM25 and dense vectors with reciprocal rank fusion. " .repeat(6);
  const notes = "Clipboard slots are versioned and support undo. Tasks are a small state machine with priorities. " .repeat(6);
  const indexing = await run("rag_index", { collection: "docs", docs: [{ id: "h", source: "handbook", text: handbook }, { id: "n", source: "notes", text: notes }] }, { namespace: ns });
  assert(indexing.chunks_added >= 2 && indexing.documents.length === 2, `index ${JSON.stringify(indexing)}`);

  // Identical text is free the second time.
  const again = await run("rag_index", { collection: "docs", docs: [{ id: "h", source: "handbook", text: handbook }] }, { namespace: ns });
  assert(again.chunks_added === 0 && again.duplicates_skipped >= 1, `dedupe ${JSON.stringify(again)}`);

  const hits = await run("rag_search", { collection: "docs", query: "rank fusion of vectors", k: 4 }, { namespace: ns });
  assert(hits.returned >= 1 && hits.hits[0].source === "handbook", `search ${JSON.stringify(hits).slice(0, 400)}`);
  assert(hits.citations[0].startsWith("handbook#"), "citation shape");
  assert(typeof hits.hits[0].text === "string" && hits.hits[0].text.length > 0, "passages are returned");

  const bm25Only = await run("rag_search", { collection: "docs", query: "clipboard", mode: "bm25" }, { namespace: ns });
  assert(bm25Only.hits[0].source === "notes", `bm25 ${JSON.stringify(bm25Only.hits[0])}`);

  const collections = await run("rag_collections", {}, { namespace: ns });
  assert(collections.count === 1 && collections.collections[0].name === "docs", "collections");
  const detail = await run("rag_collections", { collection: "docs" }, { namespace: ns });
  assert(detail.documents.length === 2, `detail ${JSON.stringify(detail.documents)}`);

  const replaced = await run("rag_index", { collection: "docs", replace: true, docs: [{ id: "one", source: "solo", text: "only this document exists now. " .repeat(10) }] }, { namespace: ns });
  assert(replaced.collection_chunks === 1, `replace ${JSON.stringify(replaced)}`);

  const chunks = chunkText("para one\n\npara two\n\npara three", 20, 5);
  assert(chunks.length >= 2 && chunks.every((c) => c.length <= 40), `chunker ${JSON.stringify(chunks)}`);
});

Deno.test("vector: deterministic embeddings, int8 compression and hybrid primitives", async () => {
  const a = embed("The user prefers TypeScript.");
  const b = embed("The user prefers TypeScript.");
  const c = embed("Invoice 42 was paid.");
  assert(a.length === 384 && a.every((v, i) => v === b[i]), "deterministic, 384-d");
  assert(cosineI8(dequantize(quantize(a)), dequantize(quantize(a))) > 0.999, "quantisation preserves self-similarity");
  const approx = cosineI8(dequantize(quantize(a)), dequantize(quantize(embed("The user prefers TypeScript and tests."))));
  assert(approx > 0.5 && approx < 1, `near-duplicate cosine ${approx}`);
  assert(cosineI8(dequantize(quantize(a)), dequantize(quantize(c))) < approx, "unrelated text scores lower");

  // BM25 ranks the matching doc first and RRF fuses two rankings.
  const docs = [{ text: "alpha beta gamma" }, { text: "delta epsilon" }, { text: "alpha alpha" }];
  const scores = bm25("alpha", docs);
  assert(rankOf(scores)[0] === 2, `bm25 ${JSON.stringify(scores)}`);
  const fused = rrf([[0, 1], [1, 0]]);
  assert(fused[0] === fused[1], "symmetric fusion");

  const tool = await run("embed", { text: "retrieval augmented generation", compare_to: ["RAG retrieval augmented generation", "banana"] });
  assert(tool.dims === 384 && tool.similarities.length === 2, `embed tool ${JSON.stringify(tool).slice(0, 300)}`);
  assert(tool.similarities[0].cosine > tool.similarities[1].cosine, "similarity ordering");
  const int8 = await run("embed", { text: "abc", format: "int8" });
  assert(typeof int8.vectors[0] === "string" && int8.vectors[0].length > 100, "int8 output is compact");
});

// ---------------------------------------------------------------------------
// 5. Web (stubbed transport — never the real network)
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html><html><head><title>Router Docs</title>
<meta name="description" content="How the router works">
<meta property="og:url" content="https://example.test/page">
</head><body>
<nav><a href="/home">Home</a></nav>
<article><h1>Toolbox</h1>
<p>Hello <strong>world</strong>. This page explains the <em>tool plane</em>.</p>
<pre><code>const x = 1;</code></pre>
<ul><li>one</li><li>two</li></ul>
<p><a href="/next">Next page</a></p>
</article>
<script>alert("do not ship me")</script>
</body></html>`;

Deno.test("web_fetch: readable markdown, no chrome, cached and SSRF-guarded", async () => {
  let calls = 0;
  const fetchStub = stubFetch((url) => {
    calls++;
    assert(url.startsWith("https://example.test/page"), `unexpected fetch ${url}`);
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  const page = await run("web_fetch", { url: "https://example.test/page" }, { fetch: fetchStub });
  assert(page.title === "Router Docs" && page.description === "How the router works", `meta ${JSON.stringify(page).slice(0, 300)}`);
  assert(page.content.includes("# Toolbox"), "headings survive");
  assert(page.content.includes("**world**") && page.content.includes("_tool plane_"), "inline formatting");
  assert(page.content.includes("```\nconst x = 1;\n```"), "code block preserved");
  assert(page.content.includes("- one") && page.content.includes("- two"), "lists preserved");
  assert(page.content.includes("[Next page](https://example.test/next)"), "links absolutised");
  assert(!page.content.includes("do not ship me"), "scripts stripped");
  assert(!page.content.includes("Home"), "navigation stripped");

  const cached = await run("web_fetch", { url: "https://example.test/page" }, { fetch: fetchStub });
  assert(cached.cached === true && calls === 1, `cache miss ${calls}`);

  const guarded = await executeTool("web_fetch", { url: "http://127.0.0.1:8080/secret" }, { caps: { fetch: fetchStub } });
  assert(!guarded.ok && /refusing private/.test(guarded.error), "private address refused");
  const metadata = await executeTool("web_fetch", { url: "http://169.254.169.254/latest/meta-data/" }, { caps: { fetch: fetchStub } });
  assert(!metadata.ok && /refusing private/.test(metadata.error), "metadata service refused");
  const scheme = await executeTool("web_fetch", { url: "file:///etc/passwd" }, { caps: { fetch: fetchStub } });
  assert(!scheme.ok && /non-HTTP/.test(scheme.error), "non-http refused");
});

Deno.test("http_request: methods, JSON bodies and parsed responses", async () => {
  const seen: Array<{ method: string; body: string }> = [];
  const fetchStub = stubFetch((_url, init) => {
    seen.push({ method: String(init?.method), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: true, echoed: JSON.parse(String(init?.body ?? "{}")) }), { headers: { "content-type": "application/json" } });
  });
  const res = await run("http_request", { url: "https://api.example.test/v1/things", method: "POST", json: { a: 1 }, headers: { "x-token": "t" } }, { fetch: fetchStub });
  assert(res.ok === true && res.body.echoed.a === 1, `json body ${JSON.stringify(res).slice(0, 300)}`);
  assert(seen[0].method === "POST" && seen[0].body === '{"a":1}', "request shape");
  assert(res.status === 200 && res.body.ok === true, "response parsed");
});

Deno.test("web_search: parallel engines, RRF fusion and de-duplication", async () => {
  const DDG = `<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa&amp;rut=x">Alpha result</a></h2>
  <a class="result__snippet" href="#">Alpha snippet</a></div>
  <div class="result"><h2><a rel="nofollow" class="result__a" href="https://example.test/b">Beta result</a></h2>
  <a class="result__snippet" href="#">Beta snippet</a></div>`;
  const fetchStub = stubFetch((url) => {
    if (url.includes("duckduckgo.com/html")) return new Response(DDG, { headers: { "content-type": "text/html" } });
    if (url.includes("wikipedia.org")) {
      return new Response(JSON.stringify({ query: { search: [{ title: "Alpha", snippet: "<span>alpha</span> from wikipedia" }] } }), { headers: { "content-type": "application/json" } });
    }
    return new Response("nope", { status: 500 });
  });
  const found = await run("web_search", { query: "alpha thing", limit: 5 }, { fetch: fetchStub });
  assert(found.engines_answered.includes("duckduckgo") && found.engines_answered.includes("wikipedia"), `engines ${JSON.stringify(found.engines_answered)}`);
  assert(!found.engines_answered.includes("mojeek"), "a failing engine is omitted, not fatal");
  assert(found.results.length === 3, `fusion ${JSON.stringify(found.results)}`);
  assert(found.results.some((r: any) => r.url === "https://example.test/a"), `decoded url: ${JSON.stringify(found.results.map((r: any) => r.url))}`);
  assert(found.results[0].score >= found.results[1].score, "ranked by fused score");
});

// ---------------------------------------------------------------------------
// 6. Projections, partitioning and compounding
// ---------------------------------------------------------------------------

Deno.test("vendor projections: one registry, four wire formats", () => {
  const openai = toToolSpecs({ names: ["calculate"] }) as any[];
  assert(openai.length === 1 && openai[0].function.name === "calculate", "openai envelope");
  assert(openai[0].function.parameters.properties.expression, "openai parameters");

  const strict = toToolSpecs({ flavor: "openai-strict", names: ["data"] }) as any[];
  const params = strict[0].function.parameters;
  assert(strict[0].function.strict === true && params.additionalProperties === false, "strict closes the object");
  assert(params.required.includes("op"), "declared keys required");
  assert(!("maxItems" in (params.properties.expressions ?? {})), "strict drops unsupported keywords");

  const anthropic = toToolSpecs({ flavor: "anthropic", names: ["web_fetch"] }) as any[];
  assert(anthropic[0].input_schema.properties.url && anthropic[0].name === "web_fetch", "anthropic shape");

  const gemini = toToolSpecs({ flavor: "gemini", names: ["fs_read"] }) as any[];
  const decl = gemini[0].functionDeclarations[0];
  assert(decl.parameters.type === "OBJECT" && decl.parameters.properties.path.type === "STRING", `gemini ${JSON.stringify(decl).slice(0, 200)}`);

  const strictRef = toStrictSchema({ $defs: { a: { type: "string" } }, type: "object", properties: { x: { $ref: "#/$defs/a" } } }) as any;
  assert(strictRef.$defs.a.type === "string" && strictRef.properties.x.$ref === "#/$defs/a", "$ref/$defs preserved");

  const merged = mergeToolDeclarations(
    [{ type: "function", function: { name: "calculate", description: "mine", parameters: { type: "object" } } }],
    { names: ["calculate", "data"] },
  ) as any[];
  assert(merged.length === 2 && merged[0].function.description === "mine" && merged[1].function.name === "data", "client declaration wins");
  assert(toolPreamble(["web_search"]).includes("web_search"), "preamble lists tools");
});

Deno.test("partitioning and auto-resolution", () => {
  const normalized = normalizeToolCalls([
    { index: 0, id: "c1", function: { name: "math.evaluate", arguments: { expression: "1+1" } } },
    { index: 1, function: { name: "get_weather", arguments: '{"city":"Baton Rouge"}' } },
  ]);
  assert(normalized[0].builtin && normalized[0].resolved === "calculate", "alias resolves");
  assert(normalized[0].arguments === '{"expression":"1+1"}', "object arguments stringified");
  assert(!normalized[1].builtin && normalized[1].id.length > 0, "client tool + synthesised id");

  const batch = [
    { function: { name: "calculate", arguments: "{}" } },
    { function: { name: "get_weather", arguments: "{}" } },
  ];
  const mixed = partitionToolCalls(batch, { clientNames: ["get_weather"] });
  assert(mixed.mine.length === 0 && mixed.theirs.length === 2, "mixed batch goes back whole");
  const hallucinated = partitionToolCalls(batch);
  assert(hallucinated.mine.length === 2 && hallucinated.theirs.length === 0, "undeclared names execute, never reach the user");
  assert(partitionToolCalls([{ function: { name: "data", arguments: "{}" } }]).mine.length === 1, "our batch executes");
  const shadowed = partitionToolCalls([{ function: { name: "Calculate", arguments: "{}" } }], { clientNames: ["calculate"] });
  assert(shadowed.mine.length === 0, "shadowing matched through the normaliser");

  assert(resolveAutoToolNames("auto")?.length === DEFAULT_AUTO_TOOLS.length, "auto expands");
  assert(resolveAutoToolNames(true)?.length === DEFAULT_AUTO_TOOLS.length, "boolean expands");
  assert(resolveAutoToolNames("all")!.includes("rag_collections"), "all includes the long tail");
  assert(resolveAutoToolNames("calculate, read_file")?.length === 2, "explicit list resolved");
  assert(resolveAutoToolNames(["calculate"])?.length === 1, "array form");
  assert(resolveAutoToolNames("router_trace") === null, "admin tools cannot be auto-attached");
  assert(resolveAutoToolNames(undefined) === null, "no request, no tools");
  assert(resolveAutoToolNames("nope_nope_nope") === null, "unresolvable names yield nothing");
});

Deno.test({
  name: "skill memory compounds: Kalman latency + discounted Beta reliability",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const now = Date.now();
    let skill: ToolSkillRecord = emptyToolSkill("calculate", now);
    assert(skill.calls === 0 && skill.alpha === 1 && skill.beta === 1, "fresh record is the uniform prior");
    for (let i = 0; i < 40; i++) skill = observeToolSkill(skill, { ok: true, ms: 20 }, now + i);
    const healthy = skillSummary(skill, now + 40);
    assert(healthy.calls === 40 && healthy.errors === 0 && healthy.success_rate === 1, "counters");
    assert(healthy.competence > 0.85, `Wilson floor: ${healthy.competence}`);
    assert(healthy.p50_ms > 10 && healthy.p50_ms < 40, `Kalman converged: ${healthy.p50_ms}`);
    assert(healthy.p95_ms > healthy.p50_ms, "tail above median");

    for (let i = 0; i < 20; i++) skill = observeToolSkill(skill, { ok: false, ms: 900, code: "TOOL_ERROR", error: "upstream 500" }, now + 100 + i);
    const broken = skillSummary(skill, now + 200);
    assert(broken.errors === 20 && broken.competence < healthy.competence, "failures pull it down");
    assert(broken.top_errors[0].code === "TOOL_ERROR", "error codes learned");
    assert(observeToolSkill(skill, { ok: true, ms: 25 }, now + 201).last_error === null, "success clears last error");

    let repaired = emptyToolSkill("data", now);
    for (let i = 0; i < 10; i++) repaired = observeToolSkill(repaired, { ok: true, ms: 5, repaired: true }, now + i);
    assert(skillSummary(repaired, now + 10).repair_rate === 1, "repair rate tracked separately");

    const stale = skillSummary(skill, now + 48 * 3_600_000);
    assert(stale.stale_hours >= 47 && stale.p95_ms > broken.p95_ms, "idle tools regain uncertainty");

    const d1 = skillSummary(skill, now, true).competence_draw;
    const d2 = skillSummary(skill, now, true).competence_draw;
    assert(d1 === d2, "deterministic mode does not sample");
    const draws = new Set<number>();
    for (let i = 0; i < 25; i++) draws.add(skillSummary(skill, now).competence_draw);
    assert(draws.size > 1, "sampling mode explores");

    let tuple = observeTupleToolStats({}, { valid: true }, now);
    for (let i = 0; i < 30; i++) tuple = observeTupleToolStats(tuple, { valid: true }, now + i);
    const good = tupleToolCompetence(tuple, now + 30);
    assert(good > 0.8 && toolRoutingBonus(tuple, { now: now + 30 }) > 0, "valid calls rank high");
    let bad = observeTupleToolStats({}, { valid: false, repaired: true }, now);
    for (let i = 0; i < 30; i++) bad = observeTupleToolStats(bad, { valid: false }, now + i);
    assert(tupleToolCompetence(bad, now + 30) < good && toolRoutingBonus(bad, { now: now + 30 }) < 0, "mangled calls rank low");
    assert(toolRoutingBonus({}, { now }) === 0 && tupleToolCompetence({}, now) === 0, "no evidence, no opinion");
  },
});

Deno.test("damage accounting: defaults are not repairs, hints reach the model, caps are reported", async () => {
  const clean = (await executeTool("calculate", { expression: "1+1" })) as ToolExecutionOk;
  assert(clean.ok && clean.repaired === false && clean.repairs.some((r) => r.endsWith(":default")), "defaults are transparent, not damage");
  assert((clean.result as any).value === 2, "the call ran");

  const damaged = (await executeTool("calculate", "```json\n{'expression': '6*7'}\n```")) as ToolExecutionOk;
  assert(damaged.ok && damaged.repaired && (damaged.result as any).value === 42, "fenced payload recovered");

  const clampedExec = (await executeTool("calculate", { expressions: new Array(200).fill("1") })) as ToolExecutionOk;
  assert(clampedExec.ok && clampedExec.repaired, "clamping is a repair");
  assert((clampedExec.result as any).count === 64, `batch clamped: ${(clampedExec.result as any).count}`);

  const hint = fail(await executeTool("json_querry", {}));
  assert(hint.code === "UNKNOWN_TOOL" && hint.suggestions?.[0]?.name === "data", `suggestions ${JSON.stringify(hint.suggestions)}`);
  assert(/data/.test(hint.error), `hint in prose: ${hint.error}`);

  const huge = await executeTool("web_fetch", { url: "https://example.test/" }, { caps: { fetch: stubFetch(() => new Response("x".repeat(3_000_000), { headers: { "content-type": "text/plain" } })) }, maxResultBytes: 2048 });
  assert(huge.ok && huge.truncated, "results are capped, not failed");
});

Deno.test("execution sandbox: deadlines, admin tier and argument caps", async () => {
  registerTool({
    name: "plane_test_slow",
    kind: "compute",
    description: "test-only tool that resolves long after its deadline has passed",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: (_args, ctx) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ late: true }), 3_000);
      ctx.signal.addEventListener("abort", () => { clearTimeout(timer); resolve({ aborted: true }); });
    }),
  });
  try {
    const slow = await executeTool("plane_test_slow", {}, { timeoutMs: 60 });
    assert(!slow.ok && slow.code === "TIMEOUT" && slow.ms >= 50, `deadline ${JSON.stringify(slow)}`);
    registerTool({
      name: "plane_test_admin",
      kind: "mesh",
      admin: true,
      description: "test-only admin tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: () => ({ secret: true }),
    });
    const denied = await executeTool("plane_test_admin", {});
    assert(!denied.ok && denied.code === "ADMIN_REQUIRED", `admin tier ${JSON.stringify(denied)}`);
    const allowed = await executeTool("plane_test_admin", {}, { admin: true });
    assert(allowed.ok, "admin tier admits the secret");
    unregisterTool("plane_test_admin");
  } finally {
    unregisterTool("plane_test_slow");
  }
});

Deno.test("isPrivateProbe matches the guard's address classes", () => {
  for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "localhost", "foo.internal", "[::1]"]) {
    assert(isPrivateProbe(host), `${host} should be private`);
  }
  for (const host of ["example.com", "8.8.8.8", "router.test"]) assert(!isPrivateProbe(host), `${host} should be public`);
});

Deno.test("text-format tool calls: Qwen3-Coder XML, Hermes JSON, bare <function=>", () => {
  const q = parseTextToolCalls("Renaming now.\n<tool_call> <function=fs_rename> <parameter=newpath> myapp/src/styles.module.css <parameter=oldpath> myapp/src/main.module.css </tool_call>");
  assert(q?.calls.length === 1 && q.calls[0].name === "fs_rename", JSON.stringify(q));
  assert(q.calls[0].arguments.newpath === "myapp/src/styles.module.css" && q.calls[0].arguments.oldpath === "myapp/src/main.module.css", "params trimmed");
  assert(q.rest === "Renaming now.", "prose kept");
  const typed = parseTextToolCalls("<tool_call>\n<function=fs_read>\n<parameter=path>\na.md\n</parameter>\n<parameter=limit>\n20\n</parameter>\n</function>\n</tool_call>");
  assert(typed?.calls[0].arguments.limit === 20 && typed.calls[0].arguments.path === "a.md", "closed tags + number typing");
  const h = parseTextToolCalls('<tool_call>{"name": "calculate", "arguments": {"expression": "1+1"}}</tool_call>\n<tool_call>{"name":"time","arguments":"{\\"op\\":\\"now\\"}"}</tool_call>');
  assert(h?.calls.length === 2 && h.calls[1].arguments.op === "now", "hermes, string arguments");
  const bare = parseTextToolCalls('<function=calculate>{"expression":"2*3"}</function>');
  assert(bare?.calls[0].arguments.expression === "2*3", "bare function JSON");
  assert(parseTextToolCalls("no calls here <b>x</b>") === null, "plain text is not a call");
});

Deno.test("text-format tool calls: <Function> element + <function_calls>/<invoke> forms", () => {
  const el = parseTextToolCalls('Working.\n<Function name="calculate">{"expression":"3*7"}</Function>');
  assert(el?.calls.length === 1 && el.calls[0].name === "calculate" && el.calls[0].arguments.expression === "3*7", "element form, JSON body: " + JSON.stringify(el));
  assert(el.rest === "Working.", "prose kept around element form");
  const elp = parseTextToolCalls('<Function name="fs_read"><parameter name="path">a.md</parameter><parameter name="limit">20</parameter></Function>');
  assert(elp?.calls[0].arguments.path === "a.md" && elp.calls[0].arguments.limit === 20, "element form, named parameters typed: " + JSON.stringify(elp));
  const ela = parseTextToolCalls(`<Function name="time" arguments='{"op":"now"}'></Function>`);
  assert(ela?.calls[0].arguments.op === "now", "element form, arguments attribute: " + JSON.stringify(ela));
  const inv = parseTextToolCalls('<function_calls><invoke name="calculate"><parameter name="expression">1+2</parameter></invoke><invoke name="time"><parameter name="op">now</parameter></invoke></function_calls>');
  assert(inv?.calls.length === 2 && inv.calls[0].arguments.expression === "1+2" && inv.calls[1].name === "time", "invoke list: " + JSON.stringify(inv));
  const caps = parseTextToolCalls('<TOOL_CALL><FUNCTION=calculate>{"expression":"5*5"}</FUNCTION></TOOL_CALL>');
  assert(caps?.calls[0].arguments.expression === "5*5", "tags are case-insensitive: " + JSON.stringify(caps));
  assert(parseTextToolCalls("the <function> element is prose") === null, "bare <function> prose is not a call");
});

Deno.test("text-format tool calls: <|tool_call> dialect with <|\"|> string delimiters", () => {
  // The exact shape that leaked into chat prose on 2026-11-12: an fs_patch
  // whose strings are delimited by <|"|> instead of quotes.
  const leaked = '<|tool_call>call:fs_patch{edits:[{new:<|"|>NEW BODY<|"|>,old:<|"|>OLD BODY<|"|>}],path:<|"|>index.html<|"|>}';
  const p = parseTextToolCalls(leaked);
  assert(p?.calls.length === 1 && p.calls[0].name === "fs_patch", "bar dialect lifts: " + JSON.stringify(p));
  assert(p.calls[0].arguments.path === "index.html", "path lifted");
  const edits = p.calls[0].arguments.edits as Array<{ new: string; old: string }>;
  assert(Array.isArray(edits) && edits[0].new === "NEW BODY" && edits[0].old === "OLD BODY", "edits lifted");
  assert(p.rest === "", "no prose left behind");

  // Multiline string content with braces inside it must not break the match.
  const multi = 'Patching now.\n<|tool_call>call:fs_patch{edits:[{new:<|"|>\nStar Count: \n2000\nif (x) { y(); }\n<|"|>,old:<|"|>legacy<|"|>}],path:<|"|>index.html<|"|>}';
  const m = parseTextToolCalls(multi);
  assert(m?.calls.length === 1 && m.rest === "Patching now.", "multiline dialect lifts, prose kept: " + JSON.stringify(m?.rest));
  const mEdits = m.calls[0].arguments.edits as Array<{ new: string }>;
  assert(mEdits[0].new.includes("if (x) { y(); }"), "braces inside string content survive");

  // No call: prefix, a truncated blob (stream cut), and non-call prose.
  const bare = parseTextToolCalls('<|tool_call>calculate{expression:<|"|>2*3<|"|>}');
  assert(bare?.calls[0].arguments.expression === "2*3", "no-prefix form lifts");
  const cut = parseTextToolCalls('<|tool_call>call:fs_patch{edits:[{new:<|"|>partial');
  assert(cut?.calls.length === 1 && cut.calls[0].name === "fs_patch", "truncated blob still lifts");
  assert(parseTextToolCalls("the <|tool_call> token is prose") === null, "opener without a call shape is prose");
});

Deno.test("fs_move: renames files and directories, honours aliases and overwrite", async () => {
  const ns = "move-" + crypto.randomUUID();
  await run("fs_write", { path: "src/main.module.css", content: "a{}" }, { namespace: ns });
  await run("fs_write", { path: "src/lib/x.ts", content: "export {}" }, { namespace: ns });
  const r = await run("fs_rename", { oldpath: "src/main.module.css", newpath: "src/styles.module.css" }, { namespace: ns });
  assert(r.moved === 1, JSON.stringify(r));
  assert((await run("fs_read", { path: "src/styles.module.css" }, { namespace: ns })).content === "a{}", "content moved");
  fail(await executeTool("fs_read", { path: "src/main.module.css" }, { caps: { namespace: ns } }));
  const d = await run("fs_move", { from: "src/lib", to: "lib" }, { namespace: ns });
  assert(d.moved === 1 && (await run("fs_read", { path: "lib/x.ts" }, { namespace: ns })).content === "export {}", "directory moved");
  await run("fs_write", { path: "b.txt", content: "b" }, { namespace: ns });
  fail(await executeTool("fs_move", { from: "lib/x.ts", to: "b.txt" }, { caps: { namespace: ns } }));
  assert((await run("fs_move", { from: "lib/x.ts", to: "b.txt", overwrite: true }, { namespace: ns })).moved === 1, "overwrite");
});

Deno.test("autoToolsForClass: intent-shaped exposure keeps focus + forged tools", () => {
  const full = [...DEFAULT_AUTO_TOOLS];
  const chat = autoToolsForClass("chat", full);
  assert(chat.includes("calculate") && chat.includes("web_search"), `chat keeps its focus ${chat.join(",")}`);
  assert(chat.includes("fs_patch") && chat.includes("agent_team") && chat.includes("app_debug"), `the plane core always rides ${chat.join(",")}`);
  assert(!chat.includes("embed") && !chat.includes("clipboard") && !chat.includes("rag_index") && !chat.includes("crypto"), `chat sheds the long tail ${chat.join(",")}`);
  assert(chat.length < full.length, `chat subset is smaller (${chat.length}/${full.length})`);
  const math = autoToolsForClass("math", full);
  assert(math.includes("calculate") && math.includes("crypto") && math.includes("fs_read"), `math focus ${math.join(",")}`);
  assert(autoToolsForClass("code", full).length === full.length, "code keeps the full set");
  assert(autoToolsForClass("nonsense-class", full).length === full.length, "unknown class keeps the full set");
  // Forged (dynamic) tools ride along in every subset.
  registerTool({
    name: "shape_probe_dynamic",
    kind: "compute",
    dynamic: true,
    deterministic: true,
    description: "test-only dynamic tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ ok: true }),
  });
  try {
    const withDyn = autoToolsForClass("chat", [...full, "shape_probe_dynamic"]);
    assert(withDyn.includes("shape_probe_dynamic"), "dynamic tools ride along in subsets");
  } finally {
    unregisterTool("shape_probe_dynamic");
  }
});
