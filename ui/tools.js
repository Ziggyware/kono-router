// =====================================================================
// TOOLS — the ASCK-T tool plane: registry, learned skill, live runner
// =====================================================================
let toolList = [], toolSkills = {}, toolTotals = {}, toolAgent = {}, toolWire = { flavor: "openai", tools: [] };
let toolPlane = "asck-t-v2", toolEnabled = true, toolOpen = null, tsort = { k: "name", d: 1 };
let activeTool = null, currentToolCat = "all", toolMode = "form";

const TOOL_SEEDS = {
  calculate: { expression: "(23*19)+14" },
  data: { op: "query", data: { a: { b: [10, 20, 30] } }, path: "$.a.b[1]" },
  text: { op: "similarity", text: "gpt-4o-mini", candidates: ["gpt-4o", "claude-3-5-sonnet", "gpt-4o-mini-2024"] },
  time: { op: "now" },
  crypto: { op: "digest", algorithm: "sha-256", data: "kono-router" },
  web_search: { query: "deno kv", limit: 3 },
  web_fetch: { url: "https://example.com" },
  http_request: { method: "GET", url: "https://api.github.com/zen" },
  fs_write: { path: "notes.md", content: "# Notes\nwritten by the tool plane\n" },
  fs_read: { path: "notes.md" },
  fs_list: { path: "" },
  fs_grep: { pattern: "tool" },
  fs_patch: { path: "notes.md", edits: [{ old: "plane", new: "plane v2" }] },
  fs_delete: { path: "notes.md" },
  clipboard: { op: "set", slot: "draft", text: "hello clipboard" },
  task: { op: "add", title: "ship ASCK-T v2", priority: 1 },
  memory_write: { text: "The user prefers TypeScript.", tags: ["user"], importance: 0.8 },
  memory_recall: { query: "what does the user prefer?", k: 3 },
  memory_forget: { query: "typescript" },
  memory_graph: { limit: 10 },
  rag_index: { collection: "docs", docs: [{ id: "n", source: "notes", text: "The router fuses BM25 with dense vectors." }] },
  rag_search: { collection: "docs", query: "how are vectors fused?", k: 3 },
  rag_collections: { collection: "docs" },
  embed: { text: "retrieval augmented generation" },
  router_capabilities: {},
  router_catalog: { mode: "tools", limit: 5 },
  router_health: { section: "tool_plane" },
  router_models: { filter: "free:", limit: 10 },
  router_endpoints: { limit: 5 },
  router_lane: { prompt: "write a python function", with_tools: true },
  router_trace: { limit: 5 },
};

const TOOL_EXAMPLES = {
  calculate: {
    title: "Exact arithmetic & functions",
    request: { expression: "(23 * 19) + 14 / (2.5 - 0.5)" },
    response: { ok: true, result: 444, expression: "(23 * 19) + 14 / (2.5 - 0.5)", ms: 0.8 }
  },
  data: {
    title: "JSONPath Query & Projection",
    request: {
      op: "query",
      data: { users: [{ id: 1, name: "Ada", role: "admin" }, { id: 2, name: "Alan", role: "developer" }] },
      path: "$.users[?(@.role == 'admin')].name"
    },
    response: { ok: true, matches: ["Ada"], count: 1 }
  },
  text: {
    title: "Semantic & string similarity ranking",
    request: {
      op: "similarity",
      text: "fast inference router",
      candidates: ["high speed llm gateway", "database migration script", "realtime text router"]
    },
    response: { ok: true, best: "high speed llm gateway", score: 0.84, ranked: [{ candidate: "high speed llm gateway", score: 0.84 }] }
  },
  time: {
    title: "Current timestamp with IANA timezone",
    request: { op: "now", zone: "America/New_York" },
    response: { ok: true, iso: "2026-11-04T12:00:00-05:00", epoch_ms: 1793800800000, zone: "America/New_York" }
  },
  crypto: {
    title: "Cryptographic hash digest",
    request: { op: "digest", algorithm: "sha-256", data: "kono-router-asck" },
    response: { ok: true, algorithm: "sha-256", digest: "b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78", bytes: 32 }
  },
  web_search: {
    title: "Search the web with rank fusion",
    request: { query: "modern web components 2026", limit: 3 },
    response: { ok: true, query: "modern web components 2026", count: 3, results: [{ title: "Web Components in 2026", url: "https://developer.mozilla.org", snippet: "Modern declarative custom elements with shadow DOM..." }] }
  },
  web_fetch: {
    title: "Fetch readable content as clean Markdown",
    request: { url: "https://example.com" },
    response: { ok: true, status: 200, markdown: "# Example Domain\nThis domain is for use in illustrative examples.", bytes: 1256 }
  },
  http_request: {
    title: "Execute arbitrary HTTP request",
    request: { method: "GET", url: "https://api.github.com/zen" },
    response: { ok: true, status: 200, data: "Design for failure." }
  },
  fs_write: {
    title: "Write sandboxed file to virtual filesystem",
    request: { path: "app.config.json", content: '{\n  "theme": "ocean",\n  "telemetry": true\n}' },
    response: { ok: true, path: "app.config.json", bytes: 49, created: true }
  },
  fs_read: {
    title: "Read sandboxed file from virtual filesystem",
    request: { path: "app.config.json" },
    response: { ok: true, path: "app.config.json", content: '{\n  "theme": "ocean",\n  "telemetry": true\n}', bytes: 49 }
  },
  fs_list: {
    title: "List sandboxed files",
    request: { path: "" },
    response: { ok: true, files: [{ path: "app.config.json", bytes: 49, updated: "2026-11-04T12:00:00Z" }] }
  },
  fs_grep: {
    title: "Search inside virtual filesystem files",
    request: { pattern: "telemetry" },
    response: { ok: true, matches: [{ file: "app.config.json", line: 3, text: '  "telemetry": true' }] }
  },
  fs_patch: {
    title: "Atomic find-and-replace patch",
    request: { path: "app.config.json", edits: [{ old: '"ocean"', new: '"violet"' }] },
    response: { ok: true, path: "app.config.json", applied: 1, bytes: 50 }
  },
  fs_delete: {
    title: "Delete file from virtual filesystem",
    request: { path: "app.config.json" },
    response: { ok: true, deleted: "app.config.json" }
  },
  clipboard: {
    title: "Store text in named clipboard slot",
    request: { op: "set", slot: "prompt_draft", content: "Build a responsive Kanban board app" },
    response: { ok: true, slot: "prompt_draft", bytes: 34, revision: 1 }
  },
  task: {
    title: "Add a task to the durable task board",
    request: { op: "add", title: "Revamp Tools Tab and add People Chat", priority: 1 },
    response: { ok: true, task_id: "tsk-001", status: "todo", priority: 1 }
  },
  memory_write: {
    title: "Record durable semantic memory fact",
    request: { text: "User prefers Preact components with Tailwind CSS.", tags: ["preferences", "frontend"], importance: 0.9 },
    response: { ok: true, id: "mem-01", importance: 0.9, indexed: true }
  },
  memory_recall: {
    title: "Recall relevant semantic memories",
    request: { query: "What frontend stack does the user prefer?", k: 3 },
    response: { ok: true, memories: [{ text: "User prefers Preact components with Tailwind CSS.", score: 0.94 }], count: 1 }
  },
  memory_forget: {
    title: "Forget memories by query match",
    request: { query: "outdated stack" },
    response: { ok: true, forgotten: 0 }
  },
  memory_graph: {
    title: "Inspect memory entity knowledge graph",
    request: { limit: 10 },
    response: { ok: true, nodes: 4, edges: 6, entities: ["User", "Preact", "Tailwind CSS"] }
  },
  rag_index: {
    title: "Index document into RAG collection",
    request: { collection: "docs", docs: [{ id: "guide", source: "readme.md", text: "The ASCK tool plane executes built-ins with self-repair ladders." }] },
    response: { ok: true, collection: "docs", indexed: 1, total_chunks: 1 }
  },
  rag_search: {
    title: "Hybrid vector and BM25 RAG search",
    request: { collection: "docs", query: "repair ladders in tool plane", k: 3 },
    response: { ok: true, hits: [{ id: "guide", score: 0.91, text: "The ASCK tool plane executes built-ins with self-repair ladders." }] }
  },
  rag_collections: {
    title: "List available RAG collections",
    request: { collection: "docs" },
    response: { ok: true, collections: ["docs"], stats: { docs: { chunks: 1 } } }
  },
  embed: {
    title: "Generate dense semantic embedding vector",
    request: { text: "Bayesian optimal stopping and lane scoring" },
    response: { ok: true, dimensions: 128, vector: [0.038, -0.092, 0.141, -0.021] }
  },
  router_capabilities: {
    title: "Inspect router engine capabilities",
    request: {},
    response: { ok: true, engine: "kono-router v6", kernel: "asck-t-v2", models: 140, endpoints: 102 }
  },
  router_catalog: {
    title: "Inspect model catalog by mode",
    request: { mode: "tools", limit: 5 },
    response: { ok: true, mode: "tools", lane: "free:tools", count: 5, candidates: ["qwen-2.5-coder-32b", "llama-3.3-70b"] }
  },
  router_health: {
    title: "Router health and subsystem telemetry",
    request: { section: "tool_plane" },
    response: { ok: true, status: "healthy", tool_plane: "asck-t-v2", agent_loop: true }
  },
  router_models: {
    title: "Filter registered model catalog",
    request: { filter: "free:", limit: 5 },
    response: { ok: true, returned: 5, total: 140, data: [{ id: "free:fast" }, { id: "free:smart" }, { id: "free:code" }] }
  },
  router_endpoints: {
    title: "List configured upstream endpoints",
    request: { limit: 5 },
    response: { ok: true, count: 5, endpoints: [{ name: "Pollinations", status: "ok" }] }
  },
  router_lane: {
    title: "Predict optimal lane for prompt",
    request: { prompt: "write a python function to compute fibonacci", with_tools: false },
    response: { ok: true, lane: "free:code", confidence: 0.92, suggested_model: "qwen-2.5-coder-32b" }
  },
  router_trace: {
    title: "Inspect recent routing traces",
    request: { limit: 5 },
    response: { ok: true, returned: 5, traces: [{ id: "tr-01", model: "free:fast", outcome: "won", ms: 420 }] }
  }
};

const pct = (v) => (v === null || v === undefined ? "\u2014" : `${(v * 100).toFixed(1)}%`);

// Several loadable examples per tool, each exercising a different capability.
// Ordered so stateful sequences (fs, clipboard, memory, rag, task) run top to bottom.
const TOOL_EXAMPLE_SETS = {
  calculate: [
    { title: "Precedence", args: { expression: "(23*19)+14" } },
    { title: "Functions in degrees", args: { expression: "sin(30) + sqrt(2)^2 + log(1000)", angle: "deg" } },
    { title: "Batch with variables", args: { expressions: ["a*b", "a/b", "gcd(a,b)"], variables: { a: 84, b: 36 } } },
    { title: "Statistics & quantiles", args: { values: [12, 15, 11, 19, 42, 14, 13], quantiles: [0.25, 0.5, 0.9] } },
  ],
  clipboard: [
    { title: "Set a slot", args: { op: "set", slot: "draft", text: "hello clipboard" } },
    { title: "Append", args: { op: "append", slot: "draft", text: " — appended" } },
    { title: "Get", args: { op: "get", slot: "draft" } },
    { title: "List slots", args: { op: "list" } },
    { title: "Undo last change", args: { op: "undo", slot: "draft" } },
  ],
  crypto: [
    { title: "SHA-256 digest", args: { op: "digest", algorithm: "sha-256", data: "kono-router" } },
    { title: "HMAC", args: { op: "hmac", algorithm: "sha-256", key: "secret", data: "message" } },
    { title: "UUIDv7 ×3", args: { op: "id", id_kind: "uuid7", count: 3 } },
    { title: "base64url encode", args: { op: "encode", encoding: "base64url", data: "hello world?" } },
    { title: "Sign a JWT", args: { op: "jwt_sign", payload: { sub: "42", role: "admin" }, secret: "s3cret" } },
  ],
  data: [
    { title: "JSONPath filter", args: { op: "query", data: { users: [{ name: "Ada", role: "admin" }, { name: "Bo", role: "user" }] }, path: "$.users[?(@.role == 'admin')].name" } },
    { title: "CSV → JSON", args: { op: "convert", data: "name,age\nAda,36\nBo,29", from: "csv", to: "json" } },
    { title: "Sort, pick, limit", args: { op: "transform", data: [{ n: "b", v: 2 }, { n: "a", v: 5 }, { n: "c", v: 1 }], sort_by: "v", sort_desc: true, pick: ["n", "v"], limit: 2 } },
    { title: "Validate + coerce", args: { op: "validate", data: { age: "36" }, schema: { type: "object", properties: { age: { type: "integer" } }, required: ["age"] }, coerce: true } },
  ],
  embed: [
    { title: "Semantic comparison", args: { text: "fast inference router", compare_to: ["low latency llm gateway", "banana bread recipe"] } },
    { title: "Embedding summary", args: { text: "vector embeddings for retrieval", format: "summary" } },
  ],
  fs_write: [
    { title: "Create a file", args: { path: "notes/todo.md", content: "# Todo\n- ship tool tabs\n- test fs_move\n" } },
    { title: "Append mode", args: { path: "notes/todo.md", content: "- append a line\n", mode: "append" } },
    { title: "Scratch file", args: { path: "scratch.txt", content: "temporary" } },
  ],
  fs_read: [
    { title: "Read whole file", args: { path: "notes/todo.md" } },
    { title: "Line range", args: { path: "notes/todo.md", offset: 2, limit: 2 } },
  ],
  fs_list: [
    { title: "Workspace root", args: {} },
    { title: "Glob *.md", args: { glob: "**/*.md" } },
  ],
  fs_grep: [
    { title: "Regex with context", args: { pattern: "ship|test", flags: "i", context: 1 } },
    { title: "Scoped to a folder", args: { pattern: "todo", path: "notes", flags: "i" } },
  ],
  fs_patch: [
    { title: "Dry-run an edit", args: { path: "notes/todo.md", edits: [{ old: "ship tool tabs", new: "shipped tool tabs" }], dry_run: true } },
    { title: "Apply an edit", args: { path: "notes/todo.md", edits: [{ old: "ship tool tabs", new: "shipped tool tabs" }] } },
  ],
  ws_check: [
    { title: "Check the whole project", args: {} },
    { title: "Only files under src/", args: { path: "src" } },
  ],
  app_debug: [
    { title: "Static + last preview run", args: {} },
    { title: "Wait for the current files to run", args: { wait_ms: 6000 } },
  ],
  fs_move: [
    { title: "Rename a file", args: { from: "notes/todo.md", to: "notes/done.md" } },
    { title: "Move a folder", args: { from: "notes", to: "archive/notes" } },
  ],
  fs_delete: [
    { title: "Delete a file", args: { path: "scratch.txt" } },
    { title: "Delete a folder", args: { path: "archive", recursive: true } },
  ],
  http_request: [
    { title: "GET text", args: { method: "GET", url: "https://api.github.com/zen" } },
    { title: "POST JSON", args: { method: "POST", url: "https://httpbin.org/post", json: { hello: "world" } } },
    { title: "HEAD only", args: { method: "HEAD", url: "https://example.com" } },
  ],
  memory_write: [
    { title: "Store a preference", args: { text: "Prefers brutalist, minimal interfaces", tags: ["prefs"], kind: "preference", importance: 0.8 } },
    { title: "Store a decision", args: { text: "Lanes rank by credibility-shrunk IQ", tags: ["router"], kind: "decision" } },
  ],
  memory_recall: [
    { title: "Semantic recall", args: { query: "interface preferences", k: 5 } },
    { title: "Filter by tag & kind", args: { query: "router ranking", tags: ["router"], kind: "decision" } },
  ],
  memory_graph: [
    { title: "Graph stats", args: { op: "stats" } },
  ],
  memory_forget: [
    { title: "Forget by query", args: { query: "brutalist", limit: 1 } },
    { title: "Forget by tag", args: { tag: "router" } },
  ],
  rag_index: [
    { title: "Index two documents", args: { collection: "docs", docs: [{ id: "hedge", text: "The router hedges requests across endpoints using survival-quantile optimal stopping." }, { id: "iq", text: "Effective IQ is the model-name prior shrunk toward the population mean by earned trust." }] } },
  ],
  rag_search: [
    { title: "Hybrid search", args: { query: "how does hedging work", collection: "docs", k: 3 } },
    { title: "BM25 only", args: { query: "population mean", collection: "docs", mode: "bm25", k: 2 } },
  ],
  rag_collections: [
    { title: "List collections", args: {} },
  ],
  task: [
    { title: "Add a task", args: { op: "add", title: "Ship tool tabs", priority: 1 } },
    { title: "List with done", args: { op: "list", include_done: true } },
  ],
  text: [
    { title: "Extract emails", args: { op: "extract", kind: "emails", text: "Mail ada@x.io or bo@y.dev for access." } },
    { title: "Similarity ranking", args: { op: "similarity", text: "fast inference router", candidates: ["high speed llm gateway", "database migration script", "realtime text router"] } },
    { title: "Line diff", args: { op: "diff", text: "alpha\nbeta\ngamma", other: "alpha\nBETA\ngamma\ndelta" } },
    { title: "Regex replace", args: { op: "replace", text: "2026-11-05", pattern: "(\\d+)-(\\d+)-(\\d+)", replacement: "$3/$2/$1" } },
    { title: "Template", args: { op: "template", text: "Hi {{user.name}}, you have {{count}} alerts", vars: { user: { name: "Ada" }, count: 3 } } },
    { title: "Corpus stats", args: { op: "stats", text: "The quick brown fox jumps over the lazy dog. The dog sleeps." } },
  ],
  time: [
    { title: "Now in a zone", args: { op: "now", zone: "America/Chicago" } },
    { title: "Parse ISO", args: { op: "parse", value: "2026-11-05T06:26:00-06:00" } },
    { title: "Add a duration", args: { op: "add", value: "2026-11-05", duration: "P1DT2H" } },
    { title: "Difference in days", args: { op: "diff", value: "2026-01-01", other: "2026-11-05", unit: "d" } },
    { title: "Convert zone", args: { op: "convert", value: "2026-11-05T12:00:00Z", zone: "Asia/Tokyo" } },
  ],
  web_fetch: [
    { title: "Page as markdown", args: { url: "https://example.com", format: "markdown" } },
    { title: "JSON API", args: { url: "https://api.github.com/repos/denoland/deno", format: "json" } },
  ],
  web_search: [
    { title: "Quick search", args: { query: "deno kv", limit: 3 } },
    { title: "Wikipedia engine", args: { query: "Kalman filter", engine: "wikipedia", limit: 3 } },
    { title: "Search + read pages", args: { query: "openai images api", limit: 3, fetch_pages: 1 } },
  ],
  router_health: [{ title: "Best tuples", args: { section: "best" } }, { title: "Coverage", args: { section: "coverage" } }],
  router_catalog: [{ title: "Code lane top 5", args: { mode: "code", limit: 5 } }, { title: "Min IQ filter", args: { mode: "smart", min_iq: 0.7, limit: 5 } }],
  router_lane: [{ title: "Route a prompt", args: { prompt: "write a quicksort in rust", limit: 5 } }],
  router_models: [{ title: "Filter models", args: { filter: "qwen", limit: 10 } }],
  router_endpoints: [{ title: "Endpoints", args: { limit: 10 } }],
  router_capabilities: [{ title: "File tools", args: { kind: "files" } }],
  router_trace: [{ title: "Recent traces", args: { limit: 5 } }],
  forge_tool: [{ title: "Forge word_count", args: { name: "word_count", description: "Counts words and characters in a text.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, code: "const t = String(args.text ?? \"\");\nreturn { words: t.split(/\\s+/).filter(Boolean).length, chars: t.length };" } }],
  retire_tool: [{ title: "Retire word_count", args: { name: "word_count" } }],
};

let exIdx = 0, exTool = "";
const exRuns = new Map(); // "tool#idx" -> last response, shown in the response pane
function exampleArgs(name) {
  if (TOOL_EXAMPLE_SETS[name]?.length) return TOOL_EXAMPLE_SETS[name][Math.min(exIdx, TOOL_EXAMPLE_SETS[name].length - 1)].args;
  if (TOOL_EXAMPLES[name]?.request) return TOOL_EXAMPLES[name].request;
  if (TOOL_SEEDS[name]) return TOOL_SEEDS[name];
  const props = toolList.find((t) => t.name === name)?.parameters?.properties ?? {};
  const required = toolList.find((t) => t.name === name)?.parameters?.required ?? [];
  const keys = required.length ? required : Object.keys(props).slice(0, 1);
  const out = {};
  for (const k of keys) {
    const sch = props[k] ?? {};
    const type = Array.isArray(sch.type) ? sch.type[0] : sch.type;
    out[k] = sch.default !== undefined ? sch.default
      : sch.enum ? sch.enum[0]
      : type === "integer" || type === "number" ? 1
      : type === "boolean" ? false
      : type === "array" ? []
      : type === "object" ? {} : "";
  }
  return out;
}

const CAT_COLOR = { compute: "--blue", data: "--vio", system: "--warn", web: "--ok", memory: "--vio", router: "--acc" };
function toolCategoryOf(t) {
  const n = t.name, k = t.kind || "";
  if (["calculate", "crypto", "time"].includes(n) || k.includes("compute")) return "compute";
  if (["data", "text", "embed"].includes(n)) return "data";
  if (n.startsWith("fs_") || ["clipboard", "task"].includes(n)) return "system";
  if (n.startsWith("web_") || n.startsWith("http_")) return "web";
  if (n.startsWith("memory_") || n.startsWith("rag_")) return "memory";
  if (n.startsWith("router_")) return "router";
  return "compute";
}

async function loadTools() {
  try {
    const flavor = $("#tflavor").value;
    const d = await req(`/v1/tools?flavor=${encodeURIComponent(flavor)}`, { admin: true });
    toolList = d.data ?? [];
    toolSkills = d.skills ?? {};
    toolTotals = d.totals ?? {};
    toolAgent = d.agent ?? {};
    toolWire = d.wire ?? { flavor, tools: [] };
    toolPlane = d.plane ?? toolPlane;
    toolEnabled = d.enabled !== false;
    if (!activeTool && toolList.length) activeTool = toolList[0];
    renderTools();
  } catch (e) { toast("tools: " + e.message, true); }
}

function renderActiveTool(t) {
  if (!t) return;
  activeTool = t;
  $("#trname").value = t.name;
  $("#wb-tool-name").textContent = t.name;
  $("#wb-tool-kind").textContent = t.kind || "tool";
  $("#wb-tool-admin").hidden = !t.admin;
  $("#wb-tool-pure").hidden = !t.deterministic;
  $("#wb-tool-desc").textContent = t.description || "";
  
  const aliasesEl = $("#wb-tool-aliases");
  if (t.aliases?.length) {
    aliasesEl.hidden = false;
    aliasesEl.textContent = `Also answers to: ${t.aliases.join(", ")}`;
  } else {
    aliasesEl.hidden = true;
  }

  const s = toolSkills[t.name];
  $("#wb-skill-chips").innerHTML = [
    s ? `<span class="wb-kpi-chip">${s.calls} calls</span>` : '<span class="wb-kpi-chip">no calls yet</span>',
    s ? `<span class="wb-kpi-chip ${s.competence >= 0.8 ? "ok" : s.competence < 0.5 ? "no" : "warn"}">competence ${pct(s.competence)}</span>` : "",
    s?.p50_ms ? `<span class="wb-kpi-chip">p50 ${ms(s.p50_ms)}</span>` : "",
    s?.repair_rate !== undefined ? `<span class="wb-kpi-chip">repair ${pct(s.repair_rate)}</span>` : "",
  ].filter(Boolean).join("");

  // A registry reload re-creates tool objects; the selection is keyed by name.
  if (exTool !== t.name) exIdx = 0;
  exTool = t.name;
  renderExamples(t);

  // Schema code
  $("#wb-schema-code").innerHTML = `<code>${highlightCode(JSON.stringify(t.parameters ?? {}, null, 2), "json")}</code>`;

  // Build Dynamic Form Controls
  buildToolFormControls(t);
}

// The examples card: one chip per curated example; the response pane shows
// this example's last live run, else the curated expected response.
function renderExamples(t) {
  const set = TOOL_EXAMPLE_SETS[t.name] ?? [{ title: TOOL_EXAMPLES[t.name]?.title ?? "Example", args: exampleArgs(t.name) }];
  exIdx = Math.min(exIdx, set.length - 1);
  $("#ex-chips").innerHTML = set.map((e, i) => `<button class="ex-chip" role="option" data-ex="${i}" aria-selected="${i === exIdx}">${esc(e.title)}</button>`).join("");
  $("#ex-req-code").innerHTML = `<code>${highlightCode(JSON.stringify(set[exIdx].args, null, 2), "json")}</code>`;
  const run = exRuns.get(t.name + "#" + exIdx);
  const curated = exIdx === 0 ? TOOL_EXAMPLES[t.name]?.response : undefined;
  $("#ex-res-hint").textContent = run ? "last run" : curated ? "expected" : "";
  $("#ex-res-code").innerHTML = run || curated ? `<code>${highlightCode(JSON.stringify(run ?? curated, null, 2), "json")}</code>` : `<code class="dim">run it to see the response</code>`;
}
function loadExample(i) {
  if (!activeTool) return;
  exIdx = i;
  $("#trargs").value = JSON.stringify(exampleArgs(activeTool.name), null, 2);
  buildToolFormControls(activeTool);
  renderExamples(activeTool);
}
$("#ex-chips").addEventListener("click", (e) => { const b = e.target.closest("[data-ex]"); if (b) loadExample(Number(b.dataset.ex)); });

function buildToolFormControls(t) {
  const container = $("#tool-form-controls");
  container.innerHTML = "";
  const props = t.parameters?.properties ?? {};
  const required = new Set(t.parameters?.required ?? []);

  // Parse current values
  let curVals = {};
  try {
    const raw = $("#trargs").value.trim();
    if (raw && raw !== "{}") curVals = JSON.parse(raw);
    else curVals = exampleArgs(t.name);
  } catch {
    curVals = exampleArgs(t.name);
  }

  const propKeys = Object.keys(props);
  // The JSON view's AI tab gets this tool's real context (name, purpose,
  // parameter list) so answers are about THIS tool, not tools in general.
  const trargsEl = $("#trargs");
  trargsEl.dataset.notchLabel = `Tool arguments (JSON) — ${t.name}`;
  trargsEl.dataset.notchContext = `The raw JSON arguments for the router tool "${t.name}" — ${t.description || "a router tool"}. Parameters: ${propKeys.map((k2) => { const p2 = props[k2]; const ty = Array.isArray(p2.type) ? p2.type[0] : (p2.type || "string"); return k2 + " (" + ty + (required.has(k2) ? ", required" : "") + ")"; }).join(", ") || "none — an empty object {} is correct"}. The JSON must parse and match that schema. The form controls above and this JSON stay in sync. Ask the AI to build arguments from a plain-words goal, explain a parameter, or fix a JSON syntax error.`;
  if (!propKeys.length) {
    container.innerHTML = `<div class="dim" style="font-size:12px;padding:8px">This tool requires no input parameters. Click <b>Execute Tool</b> to run.</div>`;
    $("#trargs").value = "{}";
    return;
  }

  propKeys.forEach((k) => {
    const p = props[k];
    const isReq = required.has(k);
    // Untyped or union types that admit structure, holding a non-string value,
    // edit as JSON so the value survives the round trip unchanged.
    const types = Array.isArray(p.type) ? p.type : p.type ? [p.type] : [];
    const structural = !types.length || types.some((x) => x === "object" || x === "array");
    const type = structural && curVals[k] !== undefined && typeof curVals[k] !== "string" && !types.includes("number") && !types.includes("integer") && !types.includes("boolean")
      ? "json" : (types[0] || "string");
    const group = document.createElement("div");
    group.className = "tool-form-group";

    const labelRow = document.createElement("div");
    labelRow.className = "tool-form-label";
    labelRow.innerHTML = `<div><b>${esc(k)}</b>${isReq ? `<span class="req">* required</span>` : ""}</div><span class="type-badge">${esc(type)}${p.enum ? " enum" : ""}</span>`;
    group.appendChild(labelRow);

    if (p.description) {
      const desc = document.createElement("div");
      desc.className = "tool-form-desc";
      desc.textContent = p.description;
      group.appendChild(desc);
    }

    let inputEl;
    // Only fields present in the arguments (or required) are emitted; the
    // schema default is a placeholder, not a value the form invents.
    const present = curVals[k] !== undefined;
    const curVal = present ? curVals[k] : "";

    if (p.enum && Array.isArray(p.enum)) {
      inputEl = document.createElement("select");
      inputEl.className = "tool-form-in";
      if (!isReq) {
        const none = document.createElement("option");
        none.value = ""; none.textContent = p.default !== undefined ? `— default: ${p.default}` : "— unset";
        inputEl.appendChild(none);
      }
      p.enum.forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        if (opt === curVal) o.selected = true;
        inputEl.appendChild(o);
      });
    } else if (type === "boolean") {
      const row = document.createElement("div");
      row.className = "row";
      inputEl = document.createElement("input");
      inputEl.type = "checkbox";
      inputEl.checked = present ? Boolean(curVal) : Boolean(p.default);
      const span = document.createElement("span");
      span.textContent = "Enable";
      span.className = "mid";
      span.style.fontSize = "12px";
      row.append(inputEl, span);
      group.appendChild(row);
    } else if (type === "number" || type === "integer") {
      inputEl = document.createElement("input");
      inputEl.type = "number";
      inputEl.className = "tool-form-in";
      inputEl.value = present ? curVal : "";
      if (p.default !== undefined) inputEl.placeholder = `default ${p.default}`;
      if (p.minimum !== undefined) inputEl.min = p.minimum;
      if (p.maximum !== undefined) inputEl.max = p.maximum;
      if (type === "number") inputEl.step = "any";
    } else if (type === "string") {
      const isMulti = (typeof curVal === "string" && curVal.includes("\n")) || /^(text|other|content|body|code|expression|query|prompt|template|patch|notes|replacement)$/.test(k) || (p.description && /expression|content|script|body|code/i.test(p.description));
      if (isMulti) {
        inputEl = document.createElement("textarea");
        inputEl.rows = 3;
        inputEl.className = "tool-form-in";
        inputEl.style.fontFamily = "var(--mono)";
        inputEl.value = typeof curVal === "string" ? curVal : JSON.stringify(curVal);
      } else {
        inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.className = "tool-form-in";
        inputEl.value = typeof curVal === "string" ? curVal : (curVal !== undefined ? String(curVal) : "");
      }
    } else {
      // array, object, or a structural union (JSON)
      inputEl = document.createElement("textarea");
      inputEl.rows = 3;
      inputEl.className = "tool-form-in";
      inputEl.style.fontFamily = "var(--mono)";
      inputEl.value = present ? (typeof curVal === "string" ? curVal : JSON.stringify(curVal, null, 2)) : "";
      inputEl.placeholder = type === "array" ? "[ … ]  (JSON)" : type === "object" ? "{ … }  (JSON)" : "JSON value";
    }
    if (inputEl && (present || isReq)) inputEl.dataset.set = "1";

    if (inputEl && inputEl.type !== "checkbox") group.appendChild(inputEl);

    // Two-way sync to #trargs
    const syncToArgs = () => {
      const obj = collectFormValues(t);
      $("#trargs").value = JSON.stringify(obj, null, 2);
      $("#json-valid-stat").textContent = "Valid JSON";
      $("#json-valid-stat").className = "dim";
    };

    if (inputEl) {
      inputEl.dataset.field = k;
      inputEl.dataset.type = type;
      // AI tab on every generated control, with the tool + parameter
      // context baked in. Applying an answer fires input/change, which
      // syncs the JSON view too. (Checkboxes carry no editable content.)
      if (inputEl.type !== "checkbox") {
        inputEl.dataset.notch = "";
        inputEl.dataset.notchLabel = `${t.name} — ${k}`;
        inputEl.dataset.notchContext = `Argument "${k}" of the router tool "${t.name}" — ${t.description || "a router tool"}. Type: ${type}${isReq ? " (required)" : " (optional)"}.${p.description ? " " + p.description : ""}${Array.isArray(p.enum) ? " Must be one of: " + p.enum.join(", ") + "." : ""} This control and the Arguments JSON view stay in sync — applying an AI answer here updates both, and the workbench validates the call against the tool schema when it runs.`;
      }
      const touch = () => { inputEl.dataset.set = "1"; syncToArgs(); };
      inputEl.addEventListener("input", touch);
      inputEl.addEventListener("change", touch);
    }

    container.appendChild(group);
  });

  // initial sync
  syncToArgsFromForm(t);
  mountNotches();
}

function syncToArgsFromForm(t) {
  const obj = collectFormValues(t);
  $("#trargs").value = JSON.stringify(obj, null, 2);
}

// Emits exactly the fields that carry a value: set by the arguments, required,
// or touched. Clearing an optional field removes it; required fields are
// always sent so the server reports what is missing.
function collectFormValues(t) {
  const container = $("#tool-form-controls");
  const required = new Set(t.parameters?.required ?? []);
  const obj = {};
  for (const el of container.querySelectorAll("[data-field]")) {
    const k = el.dataset.field;
    const type = el.dataset.type;
    if (!el.dataset.set) continue;
    if (el.type === "checkbox") { obj[k] = el.checked; continue; }
    const raw = el.value;
    if (raw === "" && !required.has(k)) continue;
    if (type === "number" || type === "integer") {
      const n = Number(raw);
      obj[k] = raw !== "" && Number.isFinite(n) ? n : raw;
    } else if (type === "object" || type === "array" || type === "json") {
      try { obj[k] = JSON.parse(raw); } catch { obj[k] = raw; }
    } else {
      obj[k] = raw;
    }
  }
  return obj;
}

function renderTools() {
  const q = $("#tfilter").value.trim().toLowerCase();
  let rows = toolList.filter((t) => {
    if (currentToolCat !== "all" && toolCategoryOf(t) !== currentToolCat) return false;
    if (q && ![t.name, t.kind, t.description, ...(t.aliases ?? [])].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });

  const key = (t) => {
    const s = toolSkills[t.name];
    if (tsort.k === "calls") return s?.calls ?? -1;
    if (tsort.k === "competence") return s?.competence ?? -1;
    if (tsort.k === "p50") return s?.p50_ms ?? -1;
    if (tsort.k === "p95") return s?.p95_ms ?? -1;
    if (tsort.k === "repair") return s?.repair_rate ?? -1;
    return t[tsort.k] ?? t.name;
  };
  rows.sort((a, b) => { const x = key(a), y = key(b); return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * tsort.d; });

  const t = toolTotals;
  $("#tkpis").innerHTML = [
    ["tools", t.tools], ["instrumented", t.instrumented], ["calls", t.calls],
    ["errors", t.errors], ["repairs", t.repairs], ["agent rounds", toolAgent.max_rounds]
  ].map(([k, v]) => `<div class="kpi"><b>${esc(v ?? "\u2014")}</b><span>${k}</span></div>`).join("")
    + `<div class="kpi"><b class="${toolEnabled ? "ok" : "no"}">${toolEnabled ? "on" : "off"}</b><span>${esc(toolPlane)}</span></div>`
    + `<div class="kpi"><b>${esc(toolAgent.auto_tools?.length ?? 0)}</b><span>auto tools</span></div>`;
  $("#tstat").textContent = `${rows.length}/${toolList.length} tools \u00b7 wire ${toolWire.flavor} \u00b7 ${toolEnabled ? "agent loop on" : "plane disabled"}`;
  if (ttabCur === "dashboard") renderToolDashboard();

  // Render Left Tool Items List
  const listEl = $("#tool-list-items");
  if (listEl) {
    listEl.innerHTML = rows.map((x) => {
      const s = toolSkills[x.name];
      const comp = s?.competence;
      const compClass = comp >= 0.8 ? "good" : comp < 0.5 ? "bad" : "mid";
      const isSel = activeTool && activeTool.name === x.name;
      return `<div class="tool-item-card ${isSel ? "active" : ""}" data-tool="${esc(x.name)}" style="--cat:var(${CAT_COLOR[toolCategoryOf(x)] ?? "--line"})">
        <div class="tool-item-header">
          <span class="tool-item-name">${esc(x.name)}</span>
          <div class="tool-item-badges">
            ${x.admin ? '<span class="badge adm" style="font-size:9px;padding:1px 4px">adm</span>' : ""}
            ${x.deterministic ? '<span class="badge" style="border-color:var(--ok);color:var(--ok);font-size:9px;padding:1px 4px">pure</span>' : ""}
            <span class="badge" style="font-size:9px;padding:1px 4px">${esc(x.kind)}</span>
          </div>
        </div>
        <div class="tool-item-desc">${esc(x.description || "")}</div>
        <div class="tool-item-meta">
          <span class="tool-comp-dot ${compClass}"></span>
          <span>${s ? pct(s.competence) : "untested"}</span>
          <span>·</span>
          <span>${s?.calls ?? 0} calls</span>
          ${s?.p50_ms ? `<span>·</span><span>${ms(s.p50_ms)}</span>` : ""}
        </div>
      </div>`;
    }).join("");
  }

  // Render complete registry table
  $("#ttb").innerHTML = rows.map((x) => {
    const s = toolSkills[x.name];
    const flags = [x.admin ? "admin" : "", x.deterministic ? "pure" : ""].filter(Boolean).join(" \u00b7 ");
    return `<tr class="click" data-tool="${esc(x.name)}">
      <td class="l t">${esc(x.name)}</td><td class="l">${esc(x.kind)}</td>
      <td class="${s?.calls ? "" : "no"}">${s?.calls ?? 0}</td>
      <td class="${s && s.competence < 0.5 ? "no" : ""}">${s ? pct(s.competence) : "\u2014"}</td>
      <td>${s ? ms(s.p50_ms) : "\u2014"}</td><td>${s ? ms(s.p95_ms) : "\u2014"}</td>
      <td class="${s && s.repair_rate > 0.25 ? "no" : ""}">${s ? pct(s.repair_rate) : "\u2014"}</td>
      <td class="l dim">${flags || "\u2014"}</td></tr>`;
  }).join("");

  if (!activeTool && rows.length) {
    renderActiveTool(rows[0]);
  } else if (activeTool) {
    const fresh = toolList.find((t) => t.name === activeTool.name);
    if (fresh) renderActiveTool(fresh);
  }
}

let lastToolRun = null;
async function runToolCall() {
  lastToolRun = null;
  const name = $("#trname").value.trim() || activeTool?.name;
  if (!name) { toast("name a tool first", true); return; }
  const raw = $("#trargs").value.trim();
  let args;
  try { args = raw ? JSON.parse(raw) : {}; } catch { args = raw; }
  const statEl = $("#trstat");
  statEl.innerHTML = `<span class="dim">running…</span>`;
  try {
    const d = await req("/v1/tools/execute", { method: "POST", admin: true, body: { name, arguments: args } });
    const r = d.results?.[0] ?? {};
    statEl.innerHTML = r.ok
      ? `<span class="badge" style="background:var(--acc-soft);color:var(--acc);border-color:var(--acc-line)">200 OK</span>
         <span class="wb-kpi-chip">${ms(r.ms)}</span>
         <span class="wb-kpi-chip">${esc(r.strategy)}</span>
         ${r.repairs?.length ? `<span class="wb-kpi-chip warn">${r.repairs.length} repair(s)</span>` : ""}
         <span class="wb-kpi-chip">${r.bytes ?? 0}B</span>`
      : `<span class="badge" style="background:rgba(255,111,125,.15);color:var(--bad);border-color:var(--bad)">${esc(r.code ?? "error")}</span>
         <span class="wb-kpi-chip">${ms(r.ms)}</span>`;
    
    const out = $("#trout");
    out.hidden = false;
    lastToolRun = r.ok ? r.result : { error: r.error, code: r.code, issues: r.issues ?? [] };
    const formatted = JSON.stringify(lastToolRun, null, 2);
    out.innerHTML = `<code>${highlightCode(formatted.slice(0, 40000), "json")}</code>`;
    loadTools();
  } catch (e) {
    statEl.innerHTML = `<span class="no">Error: ${esc(e.message)}</span>`;
    toast("execute: " + e.message, true);
  }
}

// Category tabs
$("#tool-cats")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  for (const b of $$("#tool-cats button")) b.classList.toggle("active", b === btn);
  currentToolCat = btn.dataset.cat;
  renderTools();
});

// Sidebar selection
$("#tool-list-items")?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-tool]");
  if (!card) return;
  const tool = toolList.find((t) => t.name === card.dataset.tool);
  if (tool) {
    for (const c of $$("#tool-list-items .tool-item-card")) c.classList.toggle("active", c === card);
    renderActiveTool(tool);
  }
});

// Mode switch
$("#btn-mode-form")?.addEventListener("click", () => {
  toolMode = "form";
  $("#btn-mode-form").classList.add("active");
  $("#btn-mode-raw").classList.remove("active");
  $("#tool-form-view").hidden = false;
  $("#tool-raw-view").hidden = true;
  if (activeTool) buildToolFormControls(activeTool);
});
$("#btn-mode-raw")?.addEventListener("click", () => {
  toolMode = "raw";
  $("#btn-mode-raw").classList.add("active");
  $("#btn-mode-form").classList.remove("active");
  $("#tool-form-view").hidden = true;
  $("#tool-raw-view").hidden = false;
});

$("#wb-btn-example")?.addEventListener("click", () => loadExample(exIdx));
$("#btn-run-example")?.addEventListener("click", async () => {
  if (!activeTool) return;
  loadExample(exIdx);
  await runToolCall();
  if (lastToolRun) { exRuns.set(activeTool.name + "#" + exIdx, lastToolRun); renderExamples(activeTool); }
});

$("#wb-btn-reset")?.addEventListener("click", () => {
  if (!activeTool) return;
  $("#trargs").value = "{}";
  buildToolFormControls(activeTool);
});

$("#wb-btn-copyargs")?.addEventListener("click", () => {
  navigator.clipboard.writeText($("#trargs").value).then(() => toast("Arguments JSON copied"));
});

$("#btn-copy-out")?.addEventListener("click", () => {
  navigator.clipboard.writeText($("#trout").innerText).then(() => toast("Output copied"));
});

$("#btn-clear-out")?.addEventListener("click", () => {
  $("#trout").textContent = "(Output cleared)";
  $("#trstat").innerHTML = "";
});

$("#trargs").addEventListener("input", (e) => {
  try {
    JSON.parse(e.target.value);
    $("#json-valid-stat").textContent = "Valid JSON";
    $("#json-valid-stat").className = "dim";
  } catch (err) {
    $("#json-valid-stat").textContent = "Invalid JSON: " + err.message;
    $("#json-valid-stat").className = "no";
  }
});

$("#tfilter").oninput = renderTools;
$("#tflavor").onchange = loadTools;
$("#treload").onclick = loadTools;
$("#trgo").onclick = runToolCall;
$("#trargs").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runToolCall(); } });
$("#twire").onclick = () => {
  const n = toolWire.tools[0]?.functionDeclarations?.length ?? toolWire.tools.length;
  navigator.clipboard.writeText(JSON.stringify(toolWire.tools, null, 2)).then(() => toast(`${n} ${toolWire.flavor} declarations copied`));
};
$$("#v-tools th[data-k]").forEach((th) => th.onclick = () => { tsort = { k: th.dataset.k, d: tsort.k === th.dataset.k ? -tsort.d : 1 }; renderTools(); });
$("#ttb").onclick = (ev) => {
  const tr = ev.target.closest("tr[data-tool]");
  if (tr) {
    const tool = toolList.find((t) => t.name === tr.dataset.tool);
    if (tool) { renderActiveTool(tool); $("#tool-workbench")?.scrollIntoView({ block: "nearest" }); }
  }
};
// ---- tabs ----
let ttabCur = store.get("tools.tab", "tools");
function showToolsTab(name) {
  ttabCur = name;
  store.set("tools.tab", name);
  for (const b of $$("#v-tools [data-ttab]")) b.setAttribute("aria-selected", String(b.dataset.ttab === name));
  for (const p of $$("#v-tools [data-tpage]")) p.hidden = p.dataset.tpage !== name;
  if (name === "dashboard") renderToolDashboard();
}
$("#v-tools .ttabs").addEventListener("click", (e) => { const b = e.target.closest("[data-ttab]"); if (b) showToolsTab(b.dataset.ttab); });

// ---- dashboard: statistics from the plane's learned skill memory ----
function renderToolDashboard() {
  const box = $("#tdash");
  if (!box) return;
  const rows = toolList.map((t) => ({ t, s: toolSkills[t.name], cat: toolCategoryOf(t) }));
  const used = rows.filter((r) => r.s?.calls);
  const calls = used.reduce((a, r) => a + r.s.calls, 0);
  const errs = used.reduce((a, r) => a + r.s.errors, 0);
  const comp = calls ? used.reduce((a, r) => a + r.s.competence * r.s.calls, 0) / calls : 0;
  const bars = (title, list, val, fmt, color) => {
    const max = Math.max(1e-9, ...list.map(val));
    return `<div class="td-card"><h4>${title}</h4>${list.length ? list.map((r) => `<div class="td-bar"><span class="td-n">${esc(r.t?.name ?? r.name)}</span><span class="td-track"><i style="width:${(val(r) / max * 100).toFixed(1)}%;background:var(${typeof color === "function" ? color(r) : color})"></i></span><span class="td-v">${fmt(r)}</span></div>`).join("") : `<div class="dim">no data yet</div>`}</div>`;
  };
  const byCat = Object.entries(rows.reduce((m, r) => { m[r.cat] = (m[r.cat] ?? 0) + (r.s?.calls ?? 0); return m; }, {})).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  const errAgg = {};
  for (const r of used) for (const e of r.s.top_errors ?? []) errAgg[e.code] = (errAgg[e.code] ?? 0) + e.count;
  const errList = Object.entries(errAgg).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  const top = [...used].sort((a, b) => b.s.calls - a.s.calls).slice(0, 10);
  const failing = used.filter((r) => r.s.success_rate < 0.9).sort((a, b) => a.s.success_rate - b.s.success_rate).slice(0, 10);
  const slow = [...used].sort((a, b) => (b.s.p95_ms ?? 0) - (a.s.p95_ms ?? 0)).slice(0, 10);
  const untested = rows.filter((r) => !r.s?.calls).map((r) => r.t.name);
  box.innerHTML = `<div class="td-sum"><span><b>${calls}</b> calls</span><span><b class="${errs / Math.max(1, calls) > 0.1 ? "no" : "ok"}">${(errs / Math.max(1, calls) * 100).toFixed(1)}%</b> error rate</span><span><b>${(comp * 100).toFixed(1)}%</b> call-weighted competence</span><span><b>${used.length}/${rows.length}</b> tools exercised</span></div>
    <div class="td-grid">
      ${bars("Most used", top, (r) => r.s.calls, (r) => r.s.calls, (r) => CAT_COLOR[r.cat])}
      ${bars("Competence", top, (r) => r.s.competence, (r) => pct(r.s.competence), (r) => r.s.competence >= 0.8 ? "--ok" : r.s.competence < 0.5 ? "--bad" : "--warn")}
      ${bars("Slowest (p95)", slow, (r) => r.s.p95_ms ?? 0, (r) => ms(r.s.p95_ms ?? 0), "--blue")}
      ${bars("Lowest success", failing, (r) => 1 - r.s.success_rate, (r) => pct(r.s.success_rate) + (r.s.last_error ? " · " + r.s.last_error.slice(0, 40) : ""), "--bad")}
      ${bars("Calls by category", byCat, (r) => r.n, (r) => r.n, (r) => CAT_COLOR[r.name] ?? "--mid")}
      ${bars("Error codes", errList, (r) => r.n, (r) => r.n, "--bad")}
    </div>
    <div class="td-card"><h4>Not exercised yet (${untested.length})</h4><div class="td-tags">${untested.map((n) => `<button class="ex-chip" data-goto-tool="${esc(n)}">${esc(n)}</button>`).join("") || '<span class="dim">every tool has been called</span>'}</div></div>`;
}
$("#tdash")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-goto-tool]");
  if (!b) return;
  const t = toolList.find((x) => x.name === b.dataset.gotoTool);
  if (t) { showToolsTab("tools"); renderActiveTool(t); renderTools(); }
});
enter.tools = () => { showToolsTab(ttabCur); if (!toolList.length) loadTools(); else renderTools(); };

