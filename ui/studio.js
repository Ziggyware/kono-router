// =====================================================================
// CHAT TOOLS INTEGRATION & DRAWER
// =====================================================================
const chatToolsDrawer = $("#chat-tools-drawer");
async function openChatToolsDrawer(preselectedTool = null) {
  // Await the registry load: building the select from a still-empty
  // toolList was why the drawer could open with no tools in it.
  if (!toolList.length) await loadTools();
  const sel = $("#chat-tool-select");
  sel.innerHTML = toolList.map((t) => `<option value="${esc(t.name)}">${esc(t.name)} (${esc(t.kind)})</option>`).join("");
  if (preselectedTool && toolList.some((t) => t.name === preselectedTool)) {
    sel.value = preselectedTool;
  }
  updateChatToolDrawerFields();
  openSheet(chatToolsDrawer);
}
function updateChatToolDrawerFields() {
  const name = $("#chat-tool-select").value;
  const tool = toolList.find((t) => t.name === name);
  $("#chat-tool-desc").textContent = tool?.description || "";
  const ex = TOOL_EXAMPLES[name]?.request ?? exampleArgs(name);
  $("#chat-tool-args").value = JSON.stringify(ex, null, 2);
  $("#chat-tool-res-preview").hidden = true;
}
$("#chat-tool-select")?.addEventListener("change", updateChatToolDrawerFields);
$("#chat-tool-load-ex")?.addEventListener("click", updateChatToolDrawerFields);

// Proper tool calling for the chat drawer: the tool runs on the router's
// tool plane, and the call + result enter the conversation as a real
// tool exchange (assistant tool_calls -> tool message) that the model
// sees in context — never as text pasted into the composer, and never
// as a prose "please use this tool" directive. In normal chat the model
// calls tools itself via tools:"auto"; this drawer is for running one
// specific tool yourself.
async function runChatTool(continueAfter) {
  const name = $("#chat-tool-select").value;
  if (!name) { toast("pick a tool first", true); return; }
  let args;
  try { args = JSON.parse($("#chat-tool-args").value); }
  catch { toast("parameters must be valid JSON", true); return; }
  toast(`Running ${name}…`);
  try {
    const d = await req("/v1/tools/execute", { method: "POST", admin: true, body: { name, arguments: args } });
    const r = d.results?.[0] ?? {};
    const payload = r.ok ? r.result : { error: r.error || r.code || "tool failed" };
    const code = $("#chat-tool-preview-code");
    code.textContent = JSON.stringify(payload, null, 2);
    code.style.color = r.ok ? "" : "#e06c5f";
    $("#chat-tool-res-preview").hidden = false;
    const callId = "call_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    conv.messages.push({ role: "assistant", content: "", tool_calls: [{ id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    conv.messages.push({ role: "tool", tool_call_id: callId, name, content: JSON.stringify(payload) });
    saveConv(); renderThread();
    closeSheets();
    toast(r.ok ? `${name} ran — its result is in the conversation` : `${name} failed — the error is in the conversation`, !r.ok);
    if (continueAfter && !chatCtl) complete();
  } catch (err) {
    toast(`Tool execute error: ${err.message}`, true);
  }
}
$("#chat-tool-run-insert")?.addEventListener("click", () => runChatTool(false));
$("#chat-tool-run-continue")?.addEventListener("click", () => runChatTool(true));

// =====================================================================
// APP BUILDER STUDIO & LIVE SANDBOX RUNNER
// =====================================================================
const DEFAULT_TECHNIQUES = [
  { id: "spa-single", name: "Single-File Standalone SPA", cat: "Architecture", desc: "Complete HTML5 + CSS + ES2024 single-file app with zero build step.", rules: "Produce a single self-contained HTML file with embedded CSS and modern JavaScript. All styling and logic must be inline or via reliable ESM imports. Never leave placeholder code." },
  { id: "reactive-comp", name: "Component-Driven Reactive", cat: "Architecture", desc: "Modular state-driven UI components with clean unidirectional data flow.", rules: "Structure the app into reusable components with declarative state bindings and reactive re-rendering." },
  { id: "micro-widget", name: "Micro-App Embed Widget", cat: "Embed", desc: "Self-contained sandboxed widget with postMessage event bus.", rules: "Create an isolated widget that fits into dashboards or iframes with responsive boundaries." },
  { id: "api-runner", name: "API-Driven Tool Runner", cat: "Dashboard", desc: "Client-first control surface communicating with REST APIs & tools.", rules: "Include interactive controls, live parameter testing, network latency monitoring, and response viewing." },
  { id: "tdd-spec", name: "Step-by-Step TDD Architecture", cat: "Testing", desc: "Specification-driven build with embedded test runner and verified assertions.", rules: "Write test cases and an embedded test assertion suite that proves functionality and shows all green tests." },
  { id: "offline-pwa", name: "Offline-First Local Storage", cat: "Persistence", desc: "Client-side application using localStorage / IndexedDB with export/import.", rules: "Persist all user data and state to localStorage with automatic schema migration, import, and export." },
  { id: "compound-intel", name: "Compounding Intelligence", cat: "Architecture", desc: "Every build records its decisions and recalls prior ones — the architecture improves with use.", rules: "Work the pipeline: understand intent, decide the architecture explicitly, generate, then validate. Honor the ARCHITECTURAL MEMORY section when one is provided. Prefer patterns prior builds proved; call out any deliberate deviation and why." },
];

const DEFAULT_TECHNOLOGIES = [
  { id: "preact-tailwind", name: "Preact + Tailwind CSS", cat: "UI Framework", desc: "Reactive component UI with Tailwind styling via ESM.", tags: '<script src="https://cdn.tailwindcss.com"><\/script>\n<script type="module" src="https://esm.sh/htm/preact/standalone"><\/script>', template: '<div id="app"></div>\n<script type="module">\nimport { html, render, useState } from "https://esm.sh/htm/preact/standalone";\nfunction App() {\n  const [count, setCount] = useState(0);\n  return html`<div class="p-6 max-w-sm mx-auto bg-slate-900 text-white rounded-xl shadow-lg flex flex-col items-center gap-4">\n    <h1 class="text-xl font-bold">Preact + Tailwind</h1>\n    <button class="px-4 py-2 bg-emerald-500 rounded font-semibold" onClick=${() => setCount(count + 1)}>Count: ${count}</button>\n  </div>`;\n}\nrender(html`<${App} />`, document.getElementById("app"));\n<\/script>' },
  { id: "alpine-pico", name: "Alpine.js + PicoCSS", cat: "Minimalist UI", desc: "Minimal declarative reactivity with semantic responsive styling.", tags: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">\n<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"><\/script>', template: '<main class="container" x-data="{ count: 0 }">\n  <h2>Alpine + PicoCSS</h2>\n  <button @click="count++" x-text="`Clicked: ${count}`"></button>\n</main>' },
  { id: "vanilla-modules", name: "Vanilla ES2024 + CSS Modules", cat: "Native Web", desc: "Modern native web components, CSS Grid/Flexbox, zero dependencies.", tags: '', template: '<div class="app-container">\n  <h1>Vanilla Modern App</h1>\n  <button id="btn">Click me</button>\n</div>' },
  { id: "petite-vue", name: "Vue 3 Petite + UnoCSS", cat: "Progressive UI", desc: "Progressive minimal reactive framework with instant inline templates.", tags: '<script src="https://unpkg.com/petite-vue" defer init><\/script>', template: '<div v-scope="{ count: 0 }">\n  <button @click="count++">{{ count }}</button>\n</div>' },
  { id: "canvas-2d", name: "HTML5 Canvas 2D / WebGL", cat: "Graphics & Games", desc: "High performance double-buffered 2D canvas with animation loop.", tags: '', template: '<canvas id="c" width="600" height="400" style="background:#111;border-radius:8px"></canvas>' },
  { id: "chart-viz", name: "Chart.js / Visual Analytics", cat: "Data Viz", desc: "Interactive telemetry and data visualization charts.", tags: '<script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>', template: '<canvas id="myChart"></canvas>' },
  { id: "nov2026-baseline", name: "Nov 2026 Baseline — SolidJS + Hono + Bun", cat: "Full-stack", desc: "State-of-the-art project baseline (SolidJS 2 + Vinxi, UnoCSS, Ark UI, TanStack Store/Query, Hono 4.6, Turso + Drizzle, Better Auth, PartyKit). For multi-file project modes written into the workspace — not the single-file sandbox.", tags: "", template: "" },
];

let selTechnique = DEFAULT_TECHNIQUES[0].id;
let selTech = DEFAULT_TECHNOLOGIES[0].id;

const appBuilderDrawer = $("#app-builder-drawer");
function openAppBuilder() {
  renderAppBuilderLists();
  openSheet(appBuilderDrawer);
}

function getSavedTechniques() {
  return store.get("user_techniques", []);
}
function getSavedTechnologies() {
  return store.get("user_tech", []);
}

function renderAppBuilderLists() {
  const techniques = [...DEFAULT_TECHNIQUES, ...getSavedTechniques()];
  const techList = [...DEFAULT_TECHNOLOGIES, ...getSavedTechnologies()];

  const tecContainer = $("#builder-techniques-list");
  if (tecContainer) {
    tecContainer.innerHTML = techniques.map((t) => `
      <div class="tech-card ${t.id === selTechnique ? "selected" : ""}" data-technique="${esc(t.id)}">
        <div class="tech-card-h">
          <b>${esc(t.name)}</b>
          <span class="badge ${t.custom ? "adm" : ""}" style="font-size:9.5px">${t.custom ? "custom" : esc(t.cat)}</span>
        </div>
        <div class="tech-card-desc">${esc(t.desc)}</div>
      </div>
    `).join("");
  }

  const techContainer = $("#builder-tech-list");
  if (techContainer) {
    techContainer.innerHTML = techList.map((t) => `
      <div class="tech-card ${t.id === selTech ? "selected" : ""}" data-tech="${esc(t.id)}">
        <div class="tech-card-h">
          <b>${esc(t.name)}</b>
          <span class="badge ${t.custom ? "adm" : ""}" style="font-size:9.5px">${t.custom ? "custom" : esc(t.cat)}</span>
        </div>
        <div class="tech-card-desc">${esc(t.desc)}</div>
      </div>
    `).join("");
  }
}

$("#builder-techniques-list")?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-technique]");
  if (card) {
    selTechnique = card.dataset.technique;
    renderAppBuilderLists();
  }
});
$("#builder-tech-list")?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-tech]");
  if (card) {
    selTech = card.dataset.tech;
    renderAppBuilderLists();
  }
});

$("#builder-presets")?.addEventListener("change", (e) => {
  if (e.target.value) $("#builder-prompt").value = e.target.value;
});

$("#btn-generate-app")?.addEventListener("click", async () => {
  if (chatCtl) { toast("wait for the current reply to finish first", true); return; }
  const pmax = $("#pmax").value.trim();
  if (pmax && (!Number.isSafeInteger(Number(pmax)) || Number(pmax) < 1)) { toast("max tokens must be a positive whole number", true); return; }
  const allTechniques = [...DEFAULT_TECHNIQUES, ...getSavedTechniques()];
  const allTech = [...DEFAULT_TECHNOLOGIES, ...getSavedTechnologies()];
  const technique = allTechniques.find((t) => t.id === selTechnique) || DEFAULT_TECHNIQUES[0];
  const tech = allTech.find((t) => t.id === selTech) || DEFAULT_TECHNOLOGIES[0];
  const goal = $("#builder-prompt").value.trim() || "Interactive Kanban Board application with local storage persistence and responsive design";
  const mode = BUILD_MODES.find((mm) => mm.id === selMode) || BUILD_MODES[0];
  // Architectural memory: decisions and lessons from prior builds ride
  // into this generation (the compounding loop's read side). Best-effort.
  let memoryBlock = "";
  try {
    const rec = await wsExec("memory_recall", { query: goal, tags: ["app-builder"], k: 5 });
    const rows = rec.memories ?? rec.results ?? rec.rows ?? [];
    const texts = rows.map((r) => r.text).filter(Boolean).slice(0, 5);
    if (texts.length) memoryBlock = "ARCHITECTURAL MEMORY (decisions and lessons from prior builds — honor them unless the goal overrides them):\n" + texts.map((t) => "- " + t).join("\n");
  } catch { /* best-effort */ }

  // The build runs on the tool plane: without it there is no workspace,
  // no fs_write and no server build gate — turn it on, don't degrade.
  if (!$("#pauto").checked) {
    $("#pauto").checked = true; saveParams();
    toast("builder needs the tool plane — router tools turned on");
  }

  // Phased work, in order. Synthesis is planning-only, so it keeps its
  // directive as-is; every build mode specifies, implements into the
  // durable workspace, and only then answers — the old one-shot prompt
  // asked for the whole app as a chat code block, which bypassed the
  // workspace and the build gate entirely.
  const phases = mode.id === "synthesis" ? [] : [
    ``,
    `WORK IN PHASES, IN THIS ORDER:`,
    `PHASE 1 — SPEC: before writing any code, use fs_write to save .appbuilder/spec.md containing the feature list, the data/state model, the file plan, and an acceptance checklist for this build.`,
    mode.multi
      ? `PHASE 2 — IMPLEMENT: build the application into the durable workspace with fs_write and fs_patch, following the spec's file plan. Only after every file is written, finish with a short build summary: the files created or changed and the verification results.`
      : `PHASE 2 — IMPLEMENT: write the complete application as the workspace file index.html with fs_write; if it is too large for one call, write the first part with fs_write and append the rest with fs_patch. Only after the file is written, finish with a final reply that contains the complete app in a single html code block (so it can be previewed) plus a short build summary.`,
    `PHASE 3 — VERIFY: call app_debug with wait_ms 6000 and fix every static and runtime error it reports; if the project has tests, run app_test {all: true} and fix until they pass, re-running after each fix. The build is done only when it runs clean. If the verification tools are unavailable, say so plainly in the summary — never claim the build is verified when it is not.`,
    mode.multi ? `Work in parallel where the job splits: use agent_team (builders on independent areas, a tester writing tests, a reviewer at the end) — the verify phase above still decides when the build is done.` : ``,
  ];

  const appPrompt = [
    `Please build a complete, production-grade interactive application based on the following specifications:`,
    ``,
    `BUILD TECHNIQUE: ${technique.name}`,
    `Technique Guidelines: ${technique.rules}`,
    ``,
    `TECHNOLOGY STACK: ${tech.name}`,
    tech.tags ? `Includes tags / imports: ${tech.tags}` : ``,
    tech.template ? `Starter template — build from this structure:\n${tech.template}` : ``,
    ``,
    `APPLICATION REQUIREMENTS:`,
    goal,
    ``,
    `GENERATION MODE: ${mode.name}`,
    mode.directive,
    ...phases,
    memoryBlock,
  ].filter(Boolean).join("\n");
  recordBuildDecision(mode, technique, tech, goal);

  $("#pmodel").value = "free:code";
  // Builder request: complete() sends the phased prompt as a fresh wire
  // context with an explicit budget and kono_builder set; the thread
  // itself records only the goal, in short display form.
  builderReq = { prompt: appPrompt, continuations: 0 };
  $("#cinput").value = `[App Builder · ${mode.name}] ${goal}`;
  autosize($("#cinput"));
  closeSheets();
  go("chat");
  sendChat();
});

// ---- generation modes -------------------------------------------------------
// The spec's abstraction levels. A mode is a directive: single-file modes
// answer in chat; workspace modes send the agent into the durable
// workspace with its fs tools to read, write and patch real files.
const BUILD_MODES = [
  { id: "app", icon: "⚡", name: "Single-file App", multi: false, desc: "A complete app in one HTML file, ready for the sandbox.", directive: "CRITICAL INSTRUCTIONS:\n- Output the entire complete single-file HTML application inside a single html code block.\n- Zero placeholders, zero TODOs. Must run directly in the browser immediately.\n- Ensure beautiful modern UI with styling, responsive layout, and robust state management." },
  { id: "synthesis", icon: "🧠", name: "Architectural Synthesis", multi: false, desc: "Architecture first — decisions, trade-offs, data model, API contracts, as ADRs.", directive: "Do NOT write the application yet. Produce the architecture in ADR form: for each major choice (structure, state management, data model, API contracts, deployment) give context, the decision, alternatives considered, trade-offs and consequences. End with the ordered build plan you would execute next." },
  { id: "scaffold", icon: "🏗️", name: "Scaffold Project", multi: true, desc: "A multi-file project written into the durable workspace.", directive: "Scaffold a complete multi-file project. Use your fs_write tool to create every file in the durable workspace — project layout, configs, entry points, base modules, README — instead of pasting one giant code block. Keep files small and coherent. Finish with a summary of the tree you created." },
  { id: "feature", icon: "🧩", name: "Feature Implementation", multi: true, desc: "Build a feature into the existing workspace project.", directive: "Implement the feature in the existing workspace project: first read the relevant files with fs_list, fs_grep and fs_read, match the project's existing patterns, then write or patch files with fs_write and fs_patch. Add tests for the new behavior in the project's own test style. Finish with a summary of the files changed." },
  { id: "refactor", icon: "🔧", name: "Refactor & Modernize", multi: true, desc: "Migrate the workspace code toward a target state.", directive: "Refactor the workspace code toward the stated target state. Read before you write (fs_list, fs_grep, fs_read), make the smallest coherent set of patches with fs_patch, keep behavior identical unless the goal says otherwise, and list every file changed with the reason." },
  { id: "security", icon: "🛡️", name: "Security Hardening", multi: true, desc: "Audit the workspace code and patch the findings.", directive: "Audit the workspace code for security issues — injection, XSS, unsafe HTML sinks, secrets committed in code, missing input validation, unsafe dependencies. Read the code with your fs tools, rank findings by severity, patch the critical and high ones with fs_patch, and report what you fixed and what remains." },
  { id: "performance", icon: "📈", name: "Performance Optimization", multi: true, desc: "Find the bottlenecks in the workspace code and fix them.", directive: "Profile the workspace code by reading it with your fs tools: find the real bottlenecks — bundle weight, render churn, repeated computation, unoptimized assets, chatty network calls. Patch the highest-impact ones and explain each change with the expected gain and how to verify it." },
  { id: "tests", icon: "🧪", name: "Test Generation", multi: true, desc: "Tests for the workspace code, in its own style.", directive: "Generate tests for the workspace code. Read the code first with your fs tools, match the project's existing test framework and style, cover the critical paths and the edge cases you find, and write the test files with fs_write. List what each test proves." },
  { id: "docs", icon: "📚", name: "Documentation Sync", multi: true, desc: "Docs and ADR entries generated from the workspace code.", directive: "Generate documentation from the actual workspace code — read it with your fs tools and never invent APIs: README sections, an API / endpoint reference, and an ADR log entry for the current architecture. Write the docs as Markdown files into the workspace (docs/ or README.md) with fs_write." },
];
let selMode = store.get("builder_mode", "app");
if (!BUILD_MODES.some((mm) => mm.id === selMode)) selMode = "app";

function renderBuildModes() {
  const box = $("#builder-modes");
  if (!box) return;
  box.innerHTML = BUILD_MODES.map((mm) => `
      <div class="tech-card ${mm.id === selMode ? "selected" : ""}" data-mode="${esc(mm.id)}">
        <div class="tech-card-h">
          <b>${mm.icon} ${esc(mm.name)}</b>
          <span class="badge" style="font-size:9.5px">${mm.multi ? "workspace" : "chat"}</span>
        </div>
        <div class="tech-card-desc">${esc(mm.desc)}</div>
      </div>`).join("");
}
renderBuildModes();
$("#builder-modes")?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-mode]");
  if (card) { selMode = card.dataset.mode; store.set("builder_mode", selMode); renderBuildModes(); }
});

// The compounding loop's write side: every generation records what was
// decided — a project config and an ADR in the workspace, plus a memory
// the next build recalls. All best-effort; a write failure never blocks
// the generation itself.
async function recordBuildDecision(mode, technique, tech, goal) {
  const stamp = new Date().toISOString();
  try {
    let adrN = 1;
    try { const l = await wsExec("fs_list", { path: "docs/adr" }); adrN = (l.files ?? []).length + 1; } catch { /* first ADR */ }
    const slug = (goal || mode.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || mode.id;
    const adr = [
      `# ADR-${String(adrN).padStart(3, "0")} — ${goal.slice(0, 80) || mode.name}`,
      ``,
      `- Date: ${stamp}`,
      `- Mode: ${mode.name}`,
      `- Technique: ${technique.name}`,
      `- Technology: ${tech.name}`,
      ``,
      `## Goal`,
      goal,
      ``,
      `## Decision`,
      `Generated in ${mode.name} mode with the ${technique.name} technique on ${tech.name}. Machine-readable configuration lives in .appbuilder/config.json; prior decisions are recalled into every new generation prompt.`,
      ``,
    ].join("\n");
    await wsExec("fs_write", { path: `docs/adr/ADR-${String(adrN).padStart(3, "0")}-${slug}.md`, content: adr });
    await wsExec("fs_write", { path: ".appbuilder/config.json", content: JSON.stringify({ updated: stamp, mode: mode.id, technique: technique.id, technology: tech.id, last_goal: goal }, null, 2) });
  } catch { /* workspace writes are best-effort */ }
  try {
    await wsExec("memory_write", { text: `App build decision (${stamp.slice(0, 10)}): mode=${mode.name}; technique=${technique.name}; technology=${tech.name}; goal: ${goal.slice(0, 240)}`, tags: ["app-builder", "mode:" + mode.id], kind: "decision", importance: 0.6 });
  } catch { /* memory is best-effort */ }
}

// Form modals (New Technique / New Technology / New Channel) are REAL
// dialogs. They used to carry the .sheet class, whose CSS parks the element
// off-screen (translateY(102%), visibility:hidden) until an .open class
// lands — so showModal() produced an invisible modal whose backdrop blocked
// every click: the whole page froze. Keep them sheet-free, guard re-entry,
// and wire their close buttons to dialog.close().
function openFormModal(sel) { const d = $(sel); if (d && !d.open) d.showModal(); }
for (const sel of ["#custom-technique-modal", "#custom-technology-modal", "#comm-channel-modal"]) {
  const d = $(sel);
  d?.querySelector("[data-close]")?.addEventListener("click", () => d.close());
}

// Custom Technique modal
$("#btn-add-technique")?.addEventListener("click", () => {
  openFormModal("#custom-technique-modal");
});
$("#btn-save-technique")?.addEventListener("click", (e) => {
  e.preventDefault();
  const name = $("#tech-name-in").value.trim();
  const cat = $("#tech-cat-in").value.trim() || "Custom";
  const desc = $("#tech-desc-in").value.trim();
  const rules = $("#tech-rules-in").value.trim();
  if (!name || !desc) { toast("Name and description required", true); return; }
  const id = "custom-" + name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now().toString(36);
  const list = getSavedTechniques();
  list.push({ id, name, cat, desc, rules, custom: true });
  store.set("user_techniques", list);
  selTechnique = id;
  $("#custom-technique-modal").close();
  renderAppBuilderLists();
  toast(`Saved custom technique "${name}" locally`);
});

// Custom Technology modal
$("#btn-add-tech")?.addEventListener("click", () => {
  openFormModal("#custom-technology-modal");
});
$("#btn-save-tech")?.addEventListener("click", (e) => {
  e.preventDefault();
  const name = $("#t-name-in").value.trim();
  const cat = $("#t-cat-in").value.trim() || "Custom";
  const desc = $("#t-desc-in").value.trim();
  const tags = $("#t-tags-in").value.trim();
  const template = $("#t-template-in").value.trim();
  if (!name || !desc) { toast("Name and description required", true); return; }
  const id = "custom-tech-" + name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now().toString(36);
  const list = getSavedTechnologies();
  list.push({ id, name, cat, desc, tags, template, custom: true });
  store.set("user_tech", list);
  selTech = id;
  $("#custom-technology-modal").close();
  renderAppBuilderLists();
  toast(`Saved custom technology "${name}" locally`);
});

// Export / Import Tech Pack
$("#btn-export-techpack")?.addEventListener("click", () => {
  const pack = { techniques: getSavedTechniques(), technologies: getSavedTechnologies() };
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "kono-techpack.json";
  a.click();
  toast("Exported custom tech pack");
});

$("#btn-import-techpack")?.addEventListener("click", () => {
  $("#techpack-file-in").click();
});
$("#techpack-file-in")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (Array.isArray(data.techniques)) store.set("user_techniques", data.techniques);
      if (Array.isArray(data.technologies)) store.set("user_tech", data.technologies);
      renderAppBuilderLists();
      toast("Imported custom tech pack successfully");
    } catch (err) { toast("Invalid pack JSON: " + err.message, true); }
  };
  reader.readAsText(file);
});

// Live App Sandbox Runner
let currentSandboxCode = "";   // app source as assembled from the message
let currentSandboxDoc = "";    // full document actually loaded (wrapped + console bridge)

// Injected into every preview document: forwards console output and page
// errors to the parent, where they land in the Sandbox Console panel. The
// iframe is sandboxed without allow-same-origin, so postMessage is the
// only channel; the parent checks e.source against the frame.
const SBX_BRIDGE = `<scr${"ipt"}>(function(){
  function fmt(a){ if (typeof a === "string") return a; if (a instanceof Error) return a.message; try { return JSON.stringify(a); } catch { try { return String(a); } catch { return "[object]"; } } }
  function send(level, args, extra){ try { parent.postMessage(Object.assign({ __sbx: 1, level, text: [...args].map(fmt).join(" ") }, extra || {}), "*"); } catch {} }
  function errExtra(e, line, col, file){ const o = {}; if (e && e.stack) o.stack = String(e.stack); if (line) o.line = line; if (col) o.col = col; if (file) o.file = String(file).slice(0, 300); return o; }
  for (const k of ["log","info","warn","error","debug"]) { const orig = console[k] ? console[k].bind(console) : () => {}; console[k] = (...a) => { const bad = a.find((x) => x instanceof Error); send(k === "debug" ? "log" : k, a, bad ? errExtra(bad) : (k === "error" || k === "warn") ? { site: String(new Error().stack || "") } : null); orig(...a); }; }
  // Capture phase: element load failures (scripts, styles, images) do not bubble.
  addEventListener("error", (e) => {
    const t = e.target;
    if (e instanceof ErrorEvent || !t || t === window || !t.getAttribute) { send("error", [e.message || "Script error"], Object.assign({ kind: "exception" }, errExtra(e.error, e.lineno, e.colno, e.filename))); return; }
    const tag = (t.tagName || "resource").toLowerCase(), ref = t.getAttribute("data-sbx") || t.getAttribute("src") || t.getAttribute("href") || "";
    send("error", ["Failed to load <" + tag + "> " + (ref || "(inline module: one of its imports failed)")], { kind: "resource", ref: ref.slice(0, 300) });
  }, true);
  addEventListener("unhandledrejection", (e) => send("error", ["Unhandled rejection: " + fmt(e.reason)], Object.assign({ kind: "rejection" }, e.reason instanceof Error ? errExtra(e.reason) : null)));
})();<\/script>`;

// ---- transpiling -------------------------------------------------------------
// Generated apps increasingly arrive as TypeScript / JSX. Sucrase (loaded
// on demand from esm.sh) transpiles them in the browser — syntax-level
// only (types stripped, JSX compiled); it does not type-check. If the
// CDN is unreachable the block is left untouched and the failure is
// reported in the debug panel, never hidden.
let sbxTranspilerPromise = null;
function loadTranspiler() {
  if (typeof globalThis.__SBX_TRANSPILER__ === "function") return Promise.resolve(globalThis.__SBX_TRANSPILER__);
  if (!sbxTranspilerPromise) {
    sbxTranspilerPromise = import("https://esm.sh/sucrase@3.35.0").then((mod) => (code, opts) => {
      const transforms = [];
      if (opts.ts) transforms.push("typescript");
      if (opts.jsx) transforms.push("jsx");
      return mod.transform(code, { transforms, production: true, filePath: opts.name || "block", ...(opts.automatic ? { jsxRuntime: "automatic" } : {}) }).code;
    }).catch(() => null);
  }
  return sbxTranspilerPromise;
}
async function sbxTranspile(code, name, automatic = false) {
  const lower = (name || "").toLowerCase();
  const ts = /\.(ts|mts|tsx)$/.test(lower) || ["typescript", "ts", "tsx"].includes(lower);
  const jsx = /\.(tsx|jsx)$/.test(lower) || ["tsx", "jsx"].includes(lower);
  if (!ts && !jsx) return { code, error: null, skipped: true };
  const t = await loadTranspiler();
  if (!t) return { code, error: "transpiler unavailable (esm.sh unreachable)", skipped: false };
  try { return { code: t(code, { ts, jsx, name, automatic: jsx && automatic }), error: null, skipped: false }; }
  catch (e) { return { code, error: String((e && e.message) || e), skipped: false }; }
}
const SBX_TS_TYPE = /type\s*=\s*["']text\/(?:tsx|typescript|jsx)["']/i;
async function sbxTranspileDoc(doc) {
  const errors = [];
  const tags = [];
  const re = /<[s]cript([^>]*)>([\s\S]*?)<\/[s]cript>/gi;
  let m;
  while ((m = re.exec(doc))) tags.push({ full: m[0], attrs: m[1], body: m[2], at: m.index });
  for (let i = tags.length - 1; i >= 0; i--) {
    const t = tags[i];
    const nameM = t.attrs.match(/data-sbx="([^"]+)"/);
    const marked = /data-sbx-ts/.test(t.attrs) || SBX_TS_TYPE.test(t.attrs);
    if (!marked) continue;
    const r = await sbxTranspile(t.body, nameM ? nameM[1] : "tsx");
    if (r.error) { errors.push({ name: nameM ? nameM[1] : "inline block", error: r.error }); continue; }
    if (r.skipped) continue;
    const attrs = t.attrs.replace(SBX_TS_TYPE, "").replace(/\s*data-sbx-ts="1"/, "");
    const body = r.code.replace(/<\/script/gi, "<\\/script");
    doc = doc.slice(0, t.at) + "<" + "script" + attrs + ">" + body + "<" + "/script>" + doc.slice(t.at + t.full.length);
  }
  return { doc, errors };
}

function sbxWrap(code) {
  let doc = (code.includes("<!DOCTYPE") || /<html[\s>]/i.test(code))
    ? code
    : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${code}</body></html>`;
  if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head[^>]*>/i, (h) => h + SBX_BRIDGE);
  else if (/<html[^>]*>/i.test(doc)) doc = doc.replace(/<html[^>]*>/i, (h) => h + "<head>" + SBX_BRIDGE + "</head>");
  else doc = SBX_BRIDGE + doc;
  return doc;
}

// ---- multi-file assembly: a generated app often arrives as several code
// blocks in one chat message (index.html + style.css + app.js). Running
// only the clicked block leaves its <link>/<script src> pointing nowhere,
// so the other files never load. Assemble all of the message's blocks
// into a single document, inlining the CSS/JS.
function sbxBlockInfo(block) {
  if (!block) return null;
  const btn = block.querySelector(".btn-run-app");
  const pre = block.querySelector("pre");
  const code = block._sbxRaw ?? btn?.dataset.appCode ?? pre?.innerText ?? "";
  const lang = (block._sbxLang ?? block.querySelector(".lang")?.textContent ?? "").toLowerCase();
  if (!code.trim()) return null;
  let kind = "other";
  if (lang === "css") kind = "css";
  else if (lang === "js" || lang === "javascript" || lang === "mjs" || lang === "ts" || lang === "tsx" || lang === "typescript" || lang === "jsx") kind = "js";
  else if (lang === "html" || /<!doctype html|<html[\s>]/i.test(code) || (/<(div|section|main|canvas|button|input|form|svg)[\s>]/i.test(code) && lang !== "css")) kind = "html";
  const fm = code.split("\n", 3).join("\n").match(/(?:\/\/|<!-{2}|\/\*)\s*([A-Za-z0-9._-]+\.(?:html?|css|m?js))\b/i);
  return { code, lang, kind, name: fm ? fm[1].toLowerCase() : null, el: block, ts: ["ts", "tsx", "typescript", "jsx"].includes(lang) };
}

function sbxAssemble(clicked) {
  const clickedInfo = sbxBlockInfo(clicked);
  if (!clickedInfo) return "";
  const root = clicked?.closest(".md") || clicked?.parentElement;
  const infos = root ? $$(".code-block", root).map(sbxBlockInfo).filter(Boolean) : [];
  if (infos.length <= 1) return clickedInfo.code;
  const base = clickedInfo.kind === "html" ? clickedInfo : infos.find((i) => i.kind === "html");
  if (!base) return clickedInfo.code;
  const css = infos.filter((i) => i.kind === "css");
  const js = infos.filter((i) => i.kind === "js");
  if (!css.length && !js.length) return base.code;
  const styleTag = (c) => `<style data-sbx="${c.name || "style.css"}">\n${c.code}\n</style>`;
  const scriptTag = (j) => `<scr${"ipt"} data-sbx="${j.name || "app.js"}"${j.ts ? ' data-sbx-ts="1"' : ""}>\n${j.code.replace(/<\/script/gi, "<\\/script")}\n<\/script>`;
  let doc = base.code;
  if (!/<!doctype html|<html[\s>]/i.test(doc)) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${css.map(styleTag).join("\n")}</head><body>${doc}\n${js.map(scriptTag).join("\n")}</body></html>`;
  }
  const usedCss = new Set(), usedJs = new Set();
  doc = doc.replace(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi, (tag, href) => {
    const f = css.find((c) => c.name && href.toLowerCase().endsWith(c.name));
    if (!f) return tag;
    usedCss.add(f);
    return styleTag(f);
  });
  doc = doc.replace(/<[s]cript[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, srcAttr) => {
    const f = js.find((j) => j.name && srcAttr.toLowerCase().endsWith(j.name));
    if (!f) return tag;
    usedJs.add(f);
    return scriptTag(f);
  });
  const extraCss = css.filter((c) => !usedCss.has(c)).map(styleTag).join("\n");
  if (extraCss) doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, extraCss + "\n</head>") : extraCss + doc;
  const extraJs = js.filter((j) => !usedJs.has(j)).map(scriptTag).join("\n");
  if (extraJs) doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, extraJs + "\n</body>") : doc + extraJs;
  return doc;
}

function sbxResetPlacement(modal) {
  modal.classList.remove("fullscreen");
  for (const p of ["left", "top", "right", "bottom", "width", "height"]) modal.style.removeProperty(p);
  delete modal.dataset.pinned;
}

async function launchAppSandbox(code, title = "Application Preview") {
  currentSandboxCode = code;
  const modal = $("#app-sandbox-modal");
  $("#sandbox-app-title").textContent = title;
  let doc = sbxWrap(code);
  let errors = [];
  try { const t = await sbxTranspileDoc(doc); doc = t.doc; errors = t.errors; } catch { /* keep the untranspiled doc */ }
  currentSandboxDoc = doc;
  $("#sandbox-iframe").srcdoc = currentSandboxDoc;
  $("#sandbox-logs").innerHTML = `<div class="dim">App mounted in sandbox. Console + debug output stream here — errors show the call stack, the source line with its surroundings, and the containing function.</div>`;
  sbxResetPlacement(modal);
  if (!modal.open) modal.showModal();
  for (const e of errors) sbxRenderLog({ level: "error", text: `Transpile failed in ${e.name}: ${e.error} (syntax-level transpile only — types are not checked)` });
}

// ---- save the running app back to the workspace --------------------------
// The assembled document carries its origins in data-sbx markers, so it
// can be split back into the files it came from: marked style/script
// blocks become their own files again, and what remains becomes the
// page (index.html, or the sandbox title when that names an .html
// file). A single unmarked block saves as one file. The console bridge
// is never saved — this works from currentSandboxCode, the source from
// before wrapping and transpiling, so TypeScript saves as TypeScript.
async function sbxSaveToWorkspace() {
  const src = currentSandboxCode || "";
  if (!src.trim()) { toast("Nothing to save yet", true); return; }
  const files = [];
  let doc = src;
  const take = (re) => {
    doc = doc.replace(re, (full, name, body) => { files.push({ path: name, content: body.replace(/^\n+/, "").replace(/\s+$/, "") + "\n" }); return ""; });
  };
  take(/<style data-sbx="([^"]+)"[^>]*>([\s\S]*?)<\/style>/gi);
  take(/<[s]cript data-sbx="([^"]+)"[^>]*>([\s\S]*?)<\/[s]cript>/gi);
  const rest = doc.trim();
  if (rest) {
    const title = $("#sandbox-app-title").textContent || "";
    const mainName = /\.html?$/i.test(title) ? title : (files.length ? "index.html" : (/\.[\w]+$/.test(title) ? title : "sandbox-app.html"));
    files.unshift({ path: mainName, content: rest + "\n" });
  }
  if (!files.length) { toast("Nothing to save", true); return; }
  try {
    for (const f of files) await wsExec("fs_write", { path: f.path, content: f.content });
    toast(`Saved ${files.length} file${files.length === 1 ? "" : "s"} to the workspace: ${files.map((f) => f.path).join(", ")}`);
    wsRefresh(true);
  } catch (e) { toast("Save to workspace failed: " + e.message, true); }
}
$("#sb-save-ws")?.addEventListener("click", sbxSaveToWorkspace);

// ---- sandbox debug rendering ----------------------------------------------
// Console lines stay one-liners, but errors render as debug cards: the
// message, the parsed call stack, the containing function, and the
// source line with its surrounding lines — resolved against the exact
// document loaded in the frame (currentSandboxDoc), so line numbers
// line up with what actually ran.
function sbxParseStack(stack) {
  if (!stack) return [];
  const frames = [];
  for (const raw of String(stack).split("\n").slice(0, 12)) {
    const m = raw.match(/at\s+(?:(.+?)\s+\()?[^()\s]*:(\d+):(\d+)\)?\s*$/) || raw.match(/^\s*(?:(.+?)@)?[^@\s]*:(\d+):(\d+)\s*$/);
    if (m) frames.push({ fn: (m[1] || "(anonymous)").trim(), line: Number(m[2]), col: Number(m[3]) });
  }
  return frames;
}
function sbxOriginAt(lines, lineNo) {
  for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
    const m = lines[i].match(/data-sbx="([^"]+)"/);
    if (m) return m[1];
  }
  return "assembled document";
}
function sbxContainingFn(lines, lineNo) {
  const pats = [/function\s+([A-Za-z_$][\w$]*)\s*\(/, /([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\()/, /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, /class\s+([A-Za-z_$][\w$]*)/];
  for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
    for (const re of pats) { const m = lines[i].match(re); if (m) return m[1]; }
  }
  return "(top level)";
}
function sbxRenderLog(d) {
  const logs = $("#sandbox-logs");
  if (!logs) return;
  const frames = d.level === "error" ? sbxParseStack(d.stack) : [];
  const lineNo = d.line || frames[0]?.line || 0;
  if (d.level !== "error" || !lineNo) {
    const line = document.createElement("div");
    if (d.level === "warn") line.style.color = "#d29922";
    if (d.level === "error") line.style.color = "#f47067";
    line.style.whiteSpace = "pre-wrap";
    line.textContent = (d.level === "log" || d.level === "info" ? "" : d.level.toUpperCase() + "  ") + d.text + (d.level === "error" && frames.length ? "\n" + frames.map((f) => `  at ${f.fn} (line ${f.line}:${f.col})`).join("\n") : "");
    logs.appendChild(line);
  } else {
    const lines = currentSandboxDoc ? currentSandboxDoc.split("\n") : [];
    const origin = sbxOriginAt(lines, lineNo);
    const fn = sbxContainingFn(lines, lineNo);
    const from = Math.max(1, lineNo - 3), to = Math.min(lines.length, lineNo + 3);
    const ctx = [];
    for (let n = from; n <= to; n++) ctx.push({ n, text: lines[n - 1] ?? "", hot: n === lineNo });
    const card = document.createElement("div");
    card.className = "dbg-card";
    card.innerHTML = `<div style="color:#f47067"><b>⛔ ${esc(d.text)}</b></div>
      <div class="dbg-frame">at line ${lineNo}${(d.col || frames[0]?.col) ? ":" + (d.col || frames[0].col) : ""} · in ${esc(origin)} · inside <b>${esc(fn)}</b>()</div>
      ${frames.length ? `<div>${frames.slice(0, 6).map((f) => `<div class="dbg-frame">↳ ${esc(f.fn)} — line ${f.line}:${f.col}</div>`).join("")}</div>` : ""}
      <pre class="dbg-ctx">${ctx.map((c) => `<span style="display:block" class="${c.hot ? "dbg-hot" : ""}">${c.hot ? "▶" : " "} ${String(c.n).padStart(4)} │ ${esc(c.text)}</span>`).join("")}</pre>`;
    logs.appendChild(card);
    const panel = $("#sandbox-console");
    if (panel) panel.hidden = false;
  }
  const panel = $("#sandbox-console");
  if (panel) panel.scrollTop = panel.scrollHeight;
}

// Console stream from the preview frame
window.addEventListener("message", (e) => {
  const frame = $("#sandbox-iframe");
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data;
  if (!d || d.__sbx !== 1) return;
  sbxRenderLog(d);
});

// ---- move & resize ------------------------------------------------------
const sbxModal = $("#app-sandbox-modal");
function sbxPin(modal) {
  if (modal.dataset.pinned) return;
  const r = modal.getBoundingClientRect();
  modal.style.left = r.left + "px";
  modal.style.top = r.top + "px";
  modal.style.width = r.width + "px";
  modal.style.height = r.height + "px";
  modal.style.right = "auto";
  modal.style.bottom = "auto";
  modal.dataset.pinned = "1";
}
function sbxDrag(handle, onMove) {
  handle.addEventListener("pointerdown", (e) => {
    if (sbxModal.classList.contains("fullscreen")) return;
    if (e.target.closest("button")) return;
    e.preventDefault();
    sbxPin(sbxModal);
    const sx = e.clientX, sy = e.clientY;
    const r = sbxModal.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    sbxModal.classList.add("sbx-live");
    const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, r);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      sbxModal.classList.remove("sbx-live");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
if (sbxModal) {
  const header = $(".sandbox-header", sbxModal);
  if (header) sbxDrag(header, (dx, dy, r) => {
    const nx = Math.min(Math.max(r.left + dx, 60 - r.width), innerWidth - 60);
    const ny = Math.min(Math.max(r.top + dy, 0), innerHeight - 40);
    sbxModal.style.left = nx + "px";
    sbxModal.style.top = ny + "px";
  });
  const grip = $("#sb-resize", sbxModal);
  if (grip) sbxDrag(grip, (dx, dy, r) => {
    const nw = Math.min(Math.max(r.width + dx, 360), innerWidth - r.left);
    const nh = Math.min(Math.max(r.height + dy, 280), innerHeight - r.top);
    sbxModal.style.width = nw + "px";
    sbxModal.style.height = nh + "px";
  });
  // Click on the backdrop dismisses, like the other dialogs
  sbxModal.addEventListener("click", (e) => { if (e.target === sbxModal) sbxModal.close(); });
}

$("#sb-close")?.addEventListener("click", () => $("#app-sandbox-modal").close());
$("#sb-fullscreen")?.addEventListener("click", () => $("#app-sandbox-modal").classList.toggle("fullscreen"));
$("#sb-reload")?.addEventListener("click", () => {
  const frame = $("#sandbox-iframe");
  frame.srcdoc = currentSandboxDoc || sbxWrap(currentSandboxCode);
  toast("Reloaded sandbox");
});
$("#sb-copy-code")?.addEventListener("click", () => {
  navigator.clipboard.writeText(currentSandboxCode).then(() => toast("Copied application code"));
});
$("#sb-toggle-console")?.addEventListener("click", () => {
  const c = $("#sandbox-console");
  c.hidden = !c.hidden;
});
$("#sb-clear-console")?.addEventListener("click", () => {
  $("#sandbox-logs").innerHTML = "";
});

