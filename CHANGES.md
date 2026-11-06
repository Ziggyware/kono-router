# Fix: chat leaked raw `<Function ...>` markup instead of calling tools — 2026-11-06

The text-format tool-call lifter only recognized the Hermes/Qwen
shapes (`<tool_call>`, `<function=NAME>`) and matched them
case-sensitively. Models answering in the element form
(`<Function name="x">{...}</Function>`, parameters as
`<parameter name="k">` children or an `arguments` attribute) or the
Anthropic XML form (`<function_calls><invoke name="x">...</invoke>`)
matched nothing: the markup streamed into the chat as prose and no
tool ever executed.

- TEXT_CALL_OPENERS gains `<function_calls>`, `<function ` and
  `<invoke `; the stream lifter now searches a lowercased copy
  (partial-tag holding was already case-insensitive).
- parseTextToolCalls: case-insensitive throughout; new element,
  wrapper and bare-invoke forms; `<parameter name="k">` spelling
  accepted alongside `<parameter=k>`.
- New parser test covers all new forms plus the regression that bare
  `<function>` prose is not a call. Suite: 140 passed, 0 failed.

# Fix: workspace would not open — wspLayout name collision — 2026-11-06

Two different functions were both named `wspLayout`: the editor/preview
pane-mode getter (returns the #wsp-layout select value) and the
workspace layout applier (sets the chat CSS vars, then calls
wspPanes()). The later declaration wins in JS, so wspPanes() called
the applier expecting a mode string, and the applier calls wspPanes()
— unbounded mutual recursion (RangeError: Maximum call stack size
exceeded) the moment the workspace opened.

Fix: the getter is renamed `wspPaneMode` (definition + its three call
sites in wspPanes and the layout change handler). The applier keeps
the name `wspLayout`; every other caller (splitters, live/viewport
handlers, wspShow) already wanted the applier. Verified in the jsdom
harness: boot clean, workspace opens, tab/vertical/horizontal modes
apply and persist, zero errors.

# Semantic checks and ordered workspace batches — 2026-11-05

- **Semantic pass.** `ws_check`, `app_debug` and the build gate now run the TypeScript 5.9 checker over the project's JS and TS, including HTML inline scripts mapped back to page lines. It checks against the DOM and ES2022 libraries and reports only codes that are bugs in any program: assignment to a const, misspelled names and properties (with did-you-mean), undeclared identifiers, redeclarations, use before declaration, calling a non-function, wrong argument counts, impossible comparisons, and an always-true Promise condition.
  - In `.ts`/`.tsx`, type errors are reported as warnings.
  - Untyped DOM lookups in plain JS (`el.value`) stay quiet.
  - Bare imports type as `any`, and the app_test unit-test globals are declared.
  - An undeclared name is downgraded to a warning when the page loads external scripts.
  - Type libraries load once per isolate from jsDelivr; if they can't be fetched, the pass is skipped and reported as skipped.
  - Found on production: a free model's tip calculator passed every earlier check while reassigning two consts.
- **Ordered batches.** `ws_*`, `app_*` and `agent_team` now keep call order with `fs_*` in one batch, so `fs_write` followed by `ws_check` sees the write. The check used to run concurrently and could report an empty workspace.

# Build loop: keep building until clean and tested, browser tests, agent teams — 2026-11-05

- **Build gate.** An agent turn that changed the workspace is not finished when the model says it is. The router checks, in order:
  1. Static errors (`ws_check`).
  2. Runtime errors the live preview saw in the current files.
  3. Failing tests.
  4. With a browser test runner present, whether any test run has passed against the current files.

  The first unmet condition goes back to the agent as a `[build gate]` user turn with located findings, and the round budget is extended. This happens up to `nokey_gate_rounds` times (default 6). Streams emit a `build_gate` status frame, which the chat shows as "build gate N: … — continuing". Sub-agents are held to static and runtime cleanliness only. `nokey_gate: false` opts out; `"always"` (used by **fix errors →**) checks even when nothing changed.
- **`app_test`: open the app and test it.** Tests run in the user's browser, in a fresh hidden sandboxed copy of the preview per case, so the visible preview is untouched. The router queues a job; the dashboard takes it while a reply streams (or every ~4 s with the workspace open) and posts the results back.
  - **UI cases** live in `*.test.json` files. Their steps are `click`, `dblclick`, `type` (works with React-controlled inputs), `press` (Enter submits forms), `select`, `check`, `wait`, `wait_for` and `expect` (text, equals, count, visible, value, exists; retried for up to 2 s), plus `eval`.
  - **Unit tests** live in `*.test.js|ts|jsx|tsx` files and use `test`/`it`/`describe`, `expect` (toBe, toEqual, toContain, toThrow, …) and `assert`.
  - **Failure reports** give the step, the message and the page text and HTML at that moment. Any uncaught error fails the case.

  The last result is part of the workspace brief. Requests declare a runner with `nokey_runner`; without one, `app_test` answers `no_runner` within seconds rather than hanging.
- **`agent_team`: multi-agent work.** Up to 4 sub-agents run concurrently, each a full tool-using agent loop through the router, in the caller's session (shared workspace, sha-guarded edits) and with the caller's credentials. Roles are builder, tester, reviewer, debugger and researcher, and each comes with its own instructions. Each agent's report returns with its tool log. Teams are one level deep: sub-agents never see `agent_team`.
- **Everywhere.** `app_test` and `agent_team` are in the default tool set. The tool preamble asks for tests of the requested behaviour and for parallel work through teams. App Builder workspace modes plan builders, a tester and a reviewer and end in debug → test → fix. The editing discipline ends with "a build is finished only when it is clean and its tests pass".

# Keepalives: no response goes silent — 2026-11-05

- **Streams.** Streams send `: keepalive` comments whenever nothing has been sent for `NOKEY_IDLE_MS` (default 15 s). That covers quiet upstreams and long server-side tool rounds.
- **Buffered completions.** A buffered completion still running after that window commits its 200 and sends whitespace (valid before JSON) until the body is ready.
- **Fix.** `GET /v1/community/posts?voter=…` failed once there were more than 10 posts, because Deno KV's `getMany` reads at most 10 keys. It now batches.

# Chat panel: fold the chat, resizable input, controls panel, tinted tabs — 2026-11-05

- **Chat folds, not the workspace.** With the workspace open, the notch now belongs to the chat. It sits inside the chat's edge, clear of the thread's scrollbar, and folds the chat to a rail so the workspace takes the full width. Closing the workspace unfolds the chat. The workspace no longer folds; ✕ closes it.
- **Thread | input split.** A drag handle between the thread and the composer sets the message input's height (content still grows it). Arrow keys step, double-click resets, and the height persists.
- **Chat controls panel.** Menu, model, parallel run, expand and settings sit in one panel above the input, which folds with its notch. The input row keeps only send/stop.
- **Tabs.** Top tabs are smaller (11.5px, tighter padding), and each group carries one hue: build in the accent, routing in blue, observe in violet. Each tab gets a dot, and the selected tab is tinted in its group's hue.

# Workspace: exact edits, project checks, live debugging loop — 2026-11-05

- **Edits land exactly or explain why not** (`fs_patch`, new `toolbox/edit.ts`). Replacement text is inserted literally (a `$&` or `$1` in new code was previously expanded by `String.replace`). `expect_sha256` (any 8+ character prefix of the hash from `fs_read`/the last write) refuses edits to a file that changed underneath the caller, naming the current hash; `fs_write` takes it too, plus `"new"` for create-only. Anchors that miss exactly are retried, and each recovery is reported in `applied[].match`: LF anchors in CRLF files (`crlf`), then a unique whitespace-insensitive match whose replacement is re-indented to the file's scheme, so a 2-space anchor edits a 4-space file correctly (`whitespace`). A real miss says where the anchor's first line matched and which anchor line diverged from which file line, or the closest line; an ambiguous anchor lists its line numbers. Line-range edits (`start_line`/`end_line`) are available but require `expect_sha256`. An edit that would introduce a syntax error into a file that parsed before is refused with the location and surrounding lines (`force` overrides).
- **Syntax feedback on every write.** `fs_write` and `fs_patch` return `check: ok|errors|warnings` with located diagnostics for JS/TS/JSX (parsed by Sucrase exactly as the preview transpiles), JSON, CSS and HTML (inline scripts, missing referenced files). `fs_list` returns `sig`, one hash of the whole workspace.
- **`ws_check`** checks the project the way the preview loads it: syntax, unresolvable imports (with the preview's extension and `/index.*` rules and a "did you mean"), imports of non-module files, named imports a file does not export (following `export *`), missing default exports, Node built-ins, HTML `src`/`href` to missing files, inline `<script>`/`<style>`, JSON, CSS braces. Each diagnostic carries the surrounding lines.
- **`app_debug`** combines static diagnostics with what the browser preview observed running the app — uncaught exceptions, rejections, `console.error`/`warn` (with call site), failed script/style/image loads — each located at workspace `file:line:col` with an excerpt, and `runtime.status` `current`/`stale`/`none` by comparing the run's sig with the workspace's. `wait_ms` waits for the preview to run the current files. The preview posts its runs with the admin-only `app_report`.
- **The chat uses the workspace.** On agent turns the router adds a workspace brief to the system prompt: the file tree with line counts, the preview's entry point, and the preview's last errors (marked current or stale). The tool preamble adds the editing discipline (read, patch with copied anchors and `expect_sha256`, check, fix every error, confirm). `ws_check` and `app_debug` are in the default tool set; App Builder workspace modes end in the debug loop.
- **Preview runs for the agent.** After a tool round that touched files, the dashboard refreshes and runs the app even if the workspace panel is closed or showing the editor, so `app_debug` has a current runtime report seconds later. Saving in the editor re-runs it too.
- **Debugging in the workspace.** Console entries link to `file:line:col` (module stacks via `sourceURL`; inline page scripts are named after their starting line, so their errors map back to the page; missing resources point at the referencing line; `console.error` records its call site); a click opens the file with the line selected. Stack frames show workspace locations. `ws_check` results are listed under each run as `[check]` rows. The console sits below both tabs, so errors stay listed while their files are edited. "fix errors →" sends the chat every runtime and static error, located, with instructions to fix and confirm with `app_debug`.
- **Projects that just work.** Module JSX that never imports React compiles with the automatic runtime (`react/jsx-runtime` via esm.sh), so `return <App />` without `import React` renders. Editor saves carry `expect_sha256`; if the agent changed the file meanwhile the save is refused and the tab is flagged instead of silently overwriting.

# Panel notches: fold any control panel to a rail — 2026-11-05

- **Model.** A panel declares the side it sits on (`data-fold="left|right|top|bottom"`), its name (`data-fold-label`) and optionally the splitter beside it (`data-fold-split="prev|next"`). Folded, it shrinks in place to a 12px rail with a seam and keeps only its notch. The splitter hides, and the neighbouring content takes the space. The notch sits on the edge facing the content. It is faint until the panel is hovered, solid when folded, and its chevron points the way it will move. Hovering or focusing the notch shows the panel's name in a top-layer popover (never clipped, works inside sheets). A click or Enter/Space toggles. `aria-expanded`/`aria-controls` and a "Show/Hide <name>" label track state. Fold state persists per panel, and each panel gets a "toggle <name>" command in Ctrl+K.
- **Panels.** Workspace (beside chat; folding it stops its preview, unfolding rebuilds), Files and Inspector inside it, Trace list, Lane metrics, Tool metrics, Tool list, Community channels, the four detail panes (Request, Endpoint, Model, Search results; selecting a row unfolds its pane, and the notch replaces their ✕), Image controls, Harvester input, the App Builder's Generation mode / Build technique / Technology stack sections, and the Project drawer's Workspace intelligence / Conversations.
- **Not to collide with** the ✦ AI field notches (`data-notch`): this system is `data-fold` / `.pnotch`.

# Split panes: tabbed editor/preview panel, list | detail views — 2026-11-05

- **Workspace.** The panel is files/inspector | one tabbed panel: the open file and the live preview are tabs in the same place. A single click on a file opens it in its tab (images open in a viewer); arrow keys in the tree select without closing it. The file tab carries the name, an unsaved dot, a changed-on-disk note and a close ×; ←/→ switch tabs. Save (Ctrl+S) and revert sit above the editor; the inspector keeps metadata and actions. Renaming a file or its folder keeps it open under the new path with its current text. The drawer opens files in the docked panel on desktop; phones keep the drawer editor.
- **Preview tab.** The preview only builds, and its app only runs, while its tab is showing; its reload/live/viewport controls appear with it. Closing the file returns to the preview and rebuilds. The pop-out (⧉) works from either tab: it assembles the current page on demand.
- **Splits.** Every boundary drags, steps with the arrow keys (Shift = coarse), jumps with Home/End and resets on double-click; widths persist.
- **List | detail panes.** One `pane2` primitive (on the existing `splitter`) replaces inline row expansion. Inspector shows the request/response tree beside the request list, refreshed in place as calls finish. Endpoints shows the endpoint with its model hints (click → use in chat). Catalog shows the model detail; double-click or "use in chat" switches to chat. Source puts all-files search hits beside the code; a hit opens the whole file scrolled to the flagged line. Phones stack list over detail.

# Agent compiler: `POST /v1/agent/compile` — 2026-11-05

The server-side loop runs ReAct: one sequential LLM round trip per tool step. The compiler emits the whole plan as a DAG in a single planner round trip and runs it in parallel (LLMCompiler, Kim et al. 2023). A DAG of depth *d* costs one plan plus one join instead of *d* + 1 sequential calls.
- **Retrieval.** Okapi BM25 over each tool's name, aliases, description and parameter text picks the *k* (default 12) relevant tools. The planner sees compact TypeScript-style signatures, not raw JSON Schema. `tools: [...]` skips retrieval.
- **Plan grammar.** `{"nodes":[{"id":"n1","tool":…,"args":…}]}`. `"$n1.path"` substitutes the typed value and `"${n1.path}"` interpolates text. Parsing is Kahn's algorithm, so a cycle, a dangling `$nK`, an unknown tool (reported with the registry's nearest names), a duplicate id or a self-reference is a reported error, not a crash. Reasoning models leak deliberation into `content`, so the reply is the *last* balanced JSON block with the plan shape, read through the plan's own repair ladder. Prose alone is not an empty plan.
- **Selection.** `samples` (default 3) plans are drawn concurrently at spread temperatures, rotating across the free lanes. The executed plan is the minimum-Bayes-risk choice (Kumar & Byrne 2004): it maximises expected utility against the other samples. The utility is half multiset Jaccard over id-free call signatures and half over tool choice. It is weighted by the share of nodes whose literal arguments pass their schemas. Self-consistency is the exact-match special case. Pairwise agreement is reported as `consensus`.
- **Execution.** List scheduling by upward rank (HEFT, Topcuoglu et al. 2002). Each node is weighted by its learned p50 from tool skill memory. Concurrency is bounded (default 6). Stateful tools (fs/memory/rag/task/clipboard) are chained in plan order by ordering-only edges. A failed node skips only its data dependents. Each node reports rank, start/end, result or error. Each round reports makespan, work, critical path, parallelism and depth.
- **Join / replan.** A joiner answers or requests a replan with a reason, up to `rounds` (default 2, max 3). Later rounds see every result and may reference earlier ids. A verdict-less joiner reply is retried once on another lane.
- **Plumbing.** Planner and joiner calls go in-process through `/v1/chat/completions` as the caller, with the caller's key, session, IP and quota. Tool nodes go through the same traced, skill-recording path as `/v1/tools/execute` (factored into `runTracedTool`). Everything nests in one `agent.compile` trace. `startTrace` no longer wipes the spans of a trace it joins.
- Measured on the live free mesh: four independent tool calls ran in 14.8 ms of makespan against 52.4 ms of work (parallelism 3.54). A bad reference in round 1 was repaired by a joiner-requested replan in round 2.

# Images honour the selected model — 2026-11-05

A named backend fell through silently to Pollinations on any failure, and
picking AI Horde still put Pollinations ahead of it. A specifically chosen
backend now runs alone. If it fails, the response is the honest placeholder
with the backend's error, and the Media view shows that error. `nokey-image`
(the default), an unknown id, or `fallback: true` still walk the whole chain.
Discovered backends that answer 401/402/403 are marked as needing a key for
24 h (shared through KV) and drop out of the list and the chain. The new
`POST /v1/images/probe` (admin; "probe images" in Ops) classifies them all in
one pass. Measured locally: 474 discovered backends, 0 work without a key
(370 need payment or a key, 64 are rate-limited, the rest error).
gen.pollinations.ai also requires a key, so it was removed. The working
keyless generators are Pollinations and AI Horde.

# Eighteen-item pass: tool calls, IQ/lanes, images, traces, tools, community, chat — 2026-11-05

**Router.**
- Tool timeout cap 120 s → 10,000 s, and an explicit `timeout_ms` now overrides the per-tool deadline (it was clamped to it, so the cap did nothing).
- Text-format tool calls (Qwen3-Coder `<tool_call><function=…><parameter=…>`, Hermes `<tool_call>{json}</tool_call>`, bare `<function=…>`) are lifted into real `tool_calls` when the request declared tools, in every path (buffered, streaming head, late tail), so they run instead of showing as text.
- New `fs_move` tool (aliases `fs_rename`, `mv`, `rename_file`…; `oldpath`/`newpath` accepted) moves files or folders byte-exact. Tool argument synonyms are a generic `argAliases` hook.
- **IQ** was prior × trust starting at 0.55, so an unverified frontier model read ≈0.54. It is now the prior shrunk toward the population mean (0.56) by earned trust: unverified keeps 40% of its distance, full trust keeps all of it.
- **Lanes:** coding specialists are code-tuned models only (generalists had been flagged and the code lane collapsed into smart). Image, video and audio models are excluded from chat (Bria and friends were in the fast lane) and evicted on sync. Lanes show 8 rows. /health reports ranked vs configured providers.
- **Images:** discovered image models on configured providers (481 locally: Cloudflare Workers AI, DeepInfra, BlockRun, Gemini image…) are tried through the OpenAI-standard `POST {v1}/images/generations`, ordered by learned success. `gen.pollinations.ai` is added as a backend. Responses name the winning backend, and /v1/models lists them.
- Traces keep capped request/response bodies (chat, images, tool executions), in memory only and never exported to OTel.
- Community posts (KV): create, one vote per voter applied atomically (flip and clear), comments, stats.

**Dashboard.**
- Source: one search box with "this file" / "all files" buttons; matches highlighted.
- Traces: list above, draggable split, request / response / spans tabs below, both panes scroll, highlighted JSON. Live tail no longer resets your scroll.
- JSON highlighting was broken everywhere (it matched `&quot;`, which the escaper never produces); keys and strings now colour.
- Tools: Dashboard (usage, competence, latency, failures, categories, error codes, untested) · Tools (78 loadable examples across 34 tools, each verified against the live plane) · Forge. The form ↔ JSON round trip is exact: it used to emit every field (`""` for arrays and objects, enum defaults), flatten multi-line strings and stringify untyped fields, which caused the `text` tool's INVALID_ARGUMENTS. Seeds for text, fs_patch, task and clipboard used wrong argument names. Lighter type, category colours.
- Community: renamed; Dashboard / Posts (hot/new/top, votes, comments, markdown) / Chat.
- Chat composer: one menu (App builder, Workspace, Upload image, Upload file, New chat) replaces the chips and four buttons. Uploads go byte-exact into the chat's workspace.
- The durable workspace is per chat: a new chat starts empty, saved conversations carry theirs, and existing files stay with the current chat.
- App Builder is full-page; Project Files and the created/updated feed are removed.
- A quick-search browser extension's injected `dse-quicksearch` box is hidden.

# Tool calls never land on the user — 2026-11-04

With `tools: "auto"` the dashboard declares no client tools, yet two
paths handed tool calls back to it, where they surfaced as a
"result" box + "send results" button. **Undeclared names**: a call
that was neither built-in nor caller-declared made the whole batch
"the client's"; ownership is now strictly caller-declared, so a
hallucinated name executes in-plane, returns `UNKNOWN_TOOL` with
suggestions, and the model self-corrects. **Spent budget**: when the
last allowed round executes and the caller declared no tools, the
next turn runs with `tool_choice: "none"`, so it answers instead of
emitting calls nobody will run. Callers that declare their own tools
keep the OpenAI contract unchanged. Tests: partition unit cases,
both client-handoff tests now declare their client tool, new e2e
test for the auto path.

# Tool calls never land on the user — 2026-11-04

With `tools: "auto"` the dashboard declares no client tools, yet two
paths handed tool calls back to it, where they surfaced as a
"result" box + "send results" button. **Undeclared names**: a call
that was neither built-in nor caller-declared made the whole batch
"the client's"; ownership is now strictly caller-declared, so a
hallucinated name executes in-plane, returns `UNKNOWN_TOOL` with
suggestions, and the model self-corrects. **Spent budget**: when the
last allowed round executes and the caller declared no tools, the
next turn runs with `tool_choice: "none"`, so it answers instead of
emitting calls nobody will run. Callers that declare their own tools
keep the OpenAI contract unchanged. **Dashboard backstop**: if calls still reach the
chat page (a model ignoring `"none"`), it runs them through
`/v1/tools/execute` and continues automatically (≤4 turns per send);
the manual "send results" box remains only as the failure fallback. **Late streamed calls**: a streaming model that emits more than
`COMMIT_CHARS` of text before its tool call committed the head as plain
text, and the call was passed straight through to the page. Calls that
arrive in the tail are now held, executed in-plane, and the loop
re-dispatches; only client-declared calls are handed over. Tests: partition unit cases,
both client-handoff tests now declare their client tool, new e2e
test for the auto path.

# Backlog knock-off: Save to Workspace from the sandbox — 2026-11-04

An app running in the sandbox used to live only in the chat message
it came from. The sandbox header now has **💾 Save to workspace**:
the assembled document carries its origins in `data-sbx` markers, so
it splits back into the files it came from — marked style/script
blocks become their own files again and the remainder becomes the
page (`index.html`, or the sandbox title when that names an .html
file; a single unmarked block saves as one file). Saving works from
the pre-wrap, pre-transpile source, so the console bridge is never
saved and TypeScript saves as TypeScript. Verified with the jsdom
harness (new run10: split correctness, bridge exclusion, single-file
naming; run8/run9 still pass).

# Backlog knock-off: rename/move and folders in the workspace — 2026-11-04

The file tree was display-only for structure: folders existed only as
path prefixes and a file could not be renamed. The workspace editor
now has **Rename / Move** (an inline path row — write-new + delete-old
through the fs tools, using the editor buffer so unsaved edits move
with the file; the activity feed reports the create + delete pair),
and **+ Folder** creates a folder explicitly via the `.gitkeep`
convention. Verified with the jsdom harness (new run9: rename moves
content and repoints the editor, folder appears in the tree).

# Backlog knock-offs: /v1/probe honors its mode; workspace Run assembles the project — 2026-11-04

**Probe.** The dashboard has been sending `{ mode }` to POST /v1/probe
all along (command palette + api helper) and the server silently
probed the smart lane's top 4 regardless. The endpoint now accepts
`{ mode: "fast" | "smart" | "code" | "reasoning", limit: 1..12 }`,
probes that lane, and echoes the lane actually probed (unknown modes
fall back to smart). Verified against a local server: a code-lane
probe returned code-lane tuples, a bogus mode fell back to smart.

**Workspace Run.** Running a file used to run only the editor buffer,
so a generated multi-file project's `<link>`/`<script src>` pointed
nowhere. Run now assembles the project: relative stylesheet and
script references are inlined from the workspace (marked with the
real file name for debug origins; TypeScript siblings are transpiled
on the way in), missing references are reported rather than silently
dropped, and a standalone JS/TS file runs wrapped as its own app
under its own name.

Verified: harness run8 (project run inlines + transpiles siblings,
standalone TS run) plus run4–run7, deno check + test 103/0, and the
local probe calls above.

# App Builder: file tree, live updates, transpiling, real debug output — 2026-11-04

The builder could generate, but it couldn't *show* a project. Now it
can, end to end:

**Files & folders.** The workspace renders as a real tree — folders
as collapsible groups, files nested under them — in both the
Workspace drawer and a new **Project Files** section in App Builder
Studio (clicking a file there opens it in the workspace editor).

**Generate / update visibility.** Every refresh diffs the new file
snapshot against the previous one and reports **✚ created /
✎ updated / ✖ deleted** in an activity feed in both panels. While a
panel is open the tree re-lists itself every few seconds, so files
the agent writes during a generation appear — and announce
themselves — without a manual refresh.

**Transpiling.** TypeScript/JSX is now transpiled before it runs:
code blocks in `ts`/`tsx`/`jsx` and inline blocks typed
`text/tsx`/`text/typescript`/`text/jsx` are transpiled with Sucrase
(loaded on demand) during sandbox assembly, and the workspace editor
gained a **⚙ Transpile → .js** action that writes the compiled
sibling file. Transpiling is syntax-level (types stripped, JSX
compiled) — it does not type-check, and a failed transpile is
reported in the debug panel instead of being hidden.

**Debug output.** The sandbox bridge now forwards structured errors
(message, stack, line, column). Errors render as debug cards with
the **parsed call stack**, the **origin file** (from the assembled
block markers), the **containing function**, and the **source line
with three lines of context on each side**, resolved against the
exact document loaded in the frame so line numbers line up. The
console panel opens itself when an error arrives.

Verified with the jsdom harness (new run7, 19/19: tree in both
panels, created/updated activity, editor transpile writes a stripped
.js, sandbox transpiles a tsx block, debug card shows stack +
containing function + origin + surrounding lines; run4/run5/run6
still pass; deno 103/0).

# Chat tools: real tool calling, no more text insertion — 2026-11-04

The chat Tools drawer was not set up as tool calling at all: **Run &
Insert** executed the tool and then pasted a code-block of the
request/response into the composer, and **Insert Directive** pasted a
prose "Use the X tool with arguments…" line into the composer for the
model to read. Both are gone.

Now **⚡ Run Tool** executes on the tool plane and appends a real tool
exchange to the conversation — an assistant `tool_calls` message
followed by the `tool` result message — so the result is in the
model's context as a tool result, renders as a completed tool card,
and the composer is never touched. **⚡ Run & Continue in Chat** does
the same and then lets the model answer using the result. The result
also previews inside the drawer, and invalid parameter JSON is
rejected instead of being sent as a raw string.

Also fixed: the drawer could open with an empty tool list because it
built its select before the registry finished loading — it now awaits
the load. (In normal chat, tools still run entirely behind the scenes
via `tools: "auto"`, as before.)

Verified with the jsdom harness (new run6: drawer opens with the
composer untouched, execute carries the real args, the exchange lands
in the thread with no hand-feed textareas, Run & Continue produces an
answer from the result — 16/16; run4/run5 still pass; deno 103/0).

# Parallel runs with a judge pass — 2026-11-04

Chat can now run one prompt on several models at once (the
**parallel ×2/×3/×4** control next to the model selector). A panel
above the composer shows every request live — model, running/done/
failed, elapsed time — so concurrent work is visible instead of
hidden behind one spinner.

When all requests settle, a **judge pass** (a separate model call)
scores the answers and returns a winner, a confidence and per-answer
scores. The bar is the user's: only a **100%-confident** judge adopts
its pick into the thread automatically (with the pick, confidence and
reason noted on the message). Anything less — or a judge that fails —
returns the candidates to the user in a chooser that fits the answer
kind: apps get a sandbox **preview** button, code renders as a code
block, prose as a readable card, each with the judge's score and a
**Use this answer** button. If only one request finishes, it is
adopted with a note that there was nothing to judge.

Verified with the jsdom harness (new run5: confident-judge auto-adopt
and unsure-judge chooser + preview + user pick, 16/16; spec run4
19/19; deno task check + test 103/0).

# App Builder: generation modes, compounding memory, workspace intelligence — 2026-11-04

Implements the November 2026 app-builder specification on top of the
existing Studio, workspace and tool plane:

- **Generation modes** are now the first choice in App Builder Studio:
  Single-file App, Architectural Synthesis, Scaffold Project, Feature
  Implementation, Refactor & Modernize, Security Hardening, Performance
  Optimization, Test Generation and Documentation Sync. The selected
  mode is persisted and its directive is injected into the generation
  prompt; workspace modes direct the agent to use its fs tools behind
  the scenes to read, write and patch real project files.
- **Compounding loop:** before generating, the builder recalls prior
  app-builder decisions from memory and adds them to the prompt as an
  ARCHITECTURAL MEMORY section. After Generate is pressed, it records
  the decision three ways: `.appbuilder/config.json` in the durable
  workspace, a numbered ADR under `docs/adr/`, and a memory entry for
  the next build to recall.
- **Presets:** a Compounding Intelligence technique and a Nov 2026
  Baseline technology (SolidJS 2 + Vinxi, UnoCSS, Ark UI, TanStack,
  Hono, Turso/Drizzle, Better Auth, PartyKit) are available for project
  modes. The baseline guides generated project files; this dashboard
  does not itself provision Bun/Turso/PartyKit/Grafana infrastructure.
- **Workspace Intelligence:** the Workspace drawer gained an Analyze
  pass computed from the actual workspace files — file/folder counts,
  endpoints found in code, dependencies from `package.json` (or import
  scan), test-file count, TODO/FIXME count, and a plain checklist
  (README, manifest, tests, builder config, ADRs). No invented scores.

Verified with the jsdom harness (new run4: modes, prompt composition,
memory recall, config/ADR writes, intelligence render — 19/19; existing
suites still pass) and `deno task check` / `deno task test` (103/0).

# AI tabs in the builder modals — 2026-11-04

All nine fields of the New Build Technique and New Technology dialogs
(name, category, description, rules / tags / template) now carry the ✦
AI tab, each with context describing what the field feeds — the
generation prompt, the card list, or the generated page itself.

One subtlety: a modal <dialog> renders in the top layer, above the
shared AI panel, so a notch inside a dialog could never be answered.
`openNotch` now moves the panel inside the field's dialog when the
field lives in one (and back to body level for regular fields).

# Dashboard views: source search, visual inspector, harvester hints, plain-English lanes — 2026-11-04

- **Source** can now search every readable file at once: new admin route
  `GET /v1/source/search?q=` scans the same allowlist as `/v1/source`
  (which now shares one `SOURCE_FILES` set) and returns line-anchored
  matches; the view gained a "search every file's contents…" box whose
  results jump straight to the file + line filter. The per-file line
  filter is case-insensitive now, and `learning.ts` joined the file menu.
- **Inspector** details render as a visual, collapsible JSON tree —
  typed, coloured values with object/array summaries — instead of a raw
  text dump. The raw JSON is still there, collapsed, when you need it.
- **Harvester** inputs say what they expect: example base URLs in the
  URLs box, an "optional — keyless is fine" placeholder on the <redacted>, and
  a one-line explanation of the probe flow.
- **Lanes** rewritten in plain English: what a lane is, what each lane is
  for, who's winning right now, reliability as a percentage, typical vs
  slow-case first-token times, strengths in words ("reasoning, vision").
  The log-normal density chart is gone; the first-token history chart
  stays. The raw Bayesian statistics (iq, σ, ewma, score) live on in each
  row's hover tooltip.

# Dashboard: builder freeze fix, workspace, tools behind the scenes — 2026-11-04

- **Freeze fix.** The New Technique / New Technology / New Channel modals
  were `<dialog class="sheet">` elements opened with `showModal()`. Sheet
  CSS parks an element off-screen (translateY(102%), visibility:hidden)
  until an `.open` class lands, so the modal opened invisible while its
  backdrop blocked every click — the page froze. The three modals are now
  real dialogs (`.form-modal`), with guarded openers and close buttons
  wired to `dialog.close()`.
- **Tools behind the scenes.** Chat no longer forwards client tool
  definitions and no longer asks the user to hand-feed tool results: the
  Tools (JSON) field, the demo preset and the parallel-tools toggle are
  gone from Settings, and chat requests carry `tools: "auto"` so the
  router's tool plane runs server-side in the agent loop.
- **Workspace drawer in chat.** Durable workspace files (fs tools) with an
  editor and sandbox Run, a conversation library (named snapshots of the
  live chat), GitHub push/pull via the Contents API (token stays in the
  browser), and zip download / file import for local development.
- **Model selector in the chat tab** (two-way synced with Settings), plus
  one in the Architect composer.
- **AI tabs on the Tools workbench**: every generated argument control
  carries a notch whose context names the tool, the parameter, its type
  and description; the JSON view's notch context is rebuilt per tool.

# Learning loop (ASCK-L) — 2026-11-04

The router already learned "did this tuple answer, and how fast". ASCK-L
extends the same mechanisms — the discounted Beta posterior, Thompson
sampling, the Wilson floor, the tool-skill records — so it also learns
"which choice produces the best verified result for this kind of task".
New pure core in `learning.ts`; `main.ts` wires it into dispatch. No
parallel learning system was built.

## What shipped

- **Task context.** Every chat request is classified deterministically
  into one of 12 classes (chat, qa, code, math, tool, vision, json,
  reasoning, multilingual, longform, summarize, creative) from tool
  presence, code fences, math/code tokens, image parts, length, language
  and an embed feature-hash nearest centroid. The class is on the trace.
- **Contextual posterior.** A Beta cell per (tuple, task class), shrunk
  toward the tuple's global posterior with empirical-Bayes pseudo-counts
  (method of moments over the pooled cells, clamped 2..64), discounted at
  the same 6 h half-life as the existing posteriors. Ranking adds a
  bounded contextual term (±0.05) from the Thompson draw, or from the
  Wilson lower bound in deterministic mode. Cells are capped (4,000) and
  compacted by evidence × recency.
- **Graded reward r ∈ [0,1] with provenance.** Signals: completion,
  schema-valid tool verdicts, independent verifiers (the calculate
  evaluator for math, JSON/JSON-schema validation, A2A task completion),
  explicit thumbs, and implicit negatives (regenerate). Delayed rewards
  join through the trace id (`POST /v1/feedback`, 24 h window, applied
  exactly once per decision). The grader rejects self-evaluations,
  signals sourced from the tuple/arm being graded, and verifier-kind
  signals without verifier provenance — the generator never grades
  itself.
- **Strategy arms.** System-prompt variant, temperature delta and compute
  mode are chosen per task class by the same Thompson bandit with a 5%
  exploration floor. Arms are data in KV: `POST /v1/learning/arms`
  (admin) adds one with no deploy. Five ship built in (baseline, verify,
  concise, explore_temp, best_of).
- **Compute by value of information.** Escalation to verify-and-retry
  (or a verifier-selected second sample for best-of-n arms) fires only
  when the head candidate's contextual posterior variance is high AND an
  independent verifier exists for the class. Streams and pure-passthrough
  modes (tool plane off) never escalate and are never mutated — no
  variant, lesson, temperature shift or retry is applied to them.
- **Lesson memory.** A verified failure writes a structured lesson
  {task class, failure signature, correction} to the ledger and to
  `memory_write` under the `router_lessons` namespace. Top-2 lessons per
  class are injected into the prompt. Each lesson is itself an arm:
  injections are scored by the rewards of the decisions they touched,
  and a lesson is pruned after ≥10 injections when its decisions still
  score below the midpoint (Wilson floor < 0.45).
- **Off-policy logging.** Every decision logs the chosen arm and tuple
  with Thompson propensities estimated by resampling (7-day TTL in KV).
  `GET /v1/learning` (admin) reports per-class posteriors, arm shares,
  the regret curve with its fitted exponent, calibration buckets,
  reward per extra token, IPS and doubly-robust estimates for "always
  pick arm X" policies, and the lesson ledger — as data.
- **Dashboard.** Assistant messages carry 👍/👎 buttons that post to
  `/v1/feedback`; retrying an answer posts the implicit `regenerate`
  signal for the decision behind it.

## Measured results (tests/learning_test.ts, seeded, deterministic)

- Thompson choice over two arms (true means 0.8 / 0.5), 3,000 pulls:
  expected regret 60.0, fitted regret exponent **0.842** (< 1,
  sublinear). A non-learning alternating policy fits 1.0 on the same
  fitter. Most of the 60 is the 5% exploration floor's known cost.
- Shrinkage on sparse cells (10 cells, 4 trials each, 400 replications,
  known truth): MSE **0.0171** shrunk vs **0.0278** unpooled.
- Abrupt drift (arm means swap 0.85↔0.15 at pull 1,000 of 1,600, 6 h
  half-life discounting): the new best arm takes **0.97** of pulls
  1,450–1,600.
- Off-policy estimators on a known logging policy (20,000 decisions,
  0.7/0.3 propensities, true value 0.6): IPS **0.605** (ESS 14,022),
  doubly-robust **0.604**.
- Lesson pruning: a zero-effect lesson (30 injections, decision rewards
  ~0.3) reaches mean 0.31 and is pruned; an effective one (~0.85)
  reaches 0.88 and is kept.
- Integration: a mocked math chat logs a decision with class, arm and
  tuple propensities and an immediate graded reward; a thumbs-up joins
  it exactly once (reward 1.0) and moves the (tuple, math) posterior.
- Gates: `deno task check` passes; `deno task test` is **103 passed,
  0 failed** (baseline before this work: 86 passed, 4 failed).

## Also fixed on the way through

- `openapi.json` now documents `/pricing`, `/forge-docs`,
  `/v1/tools/forge`, `/v1/tools/forge/{name}` (shipped earlier without
  spec entries; the route/spec lockstep test failed on them).
- Two stale tool-round expectations (clamp is 32, default is 8 since the
  ultra-agentic change) and the health check's `agent_rounds` (now 8).
- `forge_tool` left `DEFAULT_AUTO_TOOLS` in tools.ts (it is registered
  by main.ts and joins the auto set as a dynamic tool), which failed
  the registry coherence test.
- tool_plane_test.ts authenticates with the key it configures. Since
  the free tier shipped, its unauthenticated requests rode the 50/day
  anonymous quota in shared KV plus the edge rate bucket, and the
  file's tail failed with 429s depending on run order and history (the
  pristine tree fails the same way run standalone). Production behavior
  is unchanged.

## Stated limits

- Best-of-n escalation currently spends one verifier-selected second
  sample (n=2), not parallel samples.
- Calibration and reward-per-extra-token are computed from live
  decisions; both are empty/null until real traffic accrues.
- Learning is pooled globally; a tenant's own cells override the pooled
  posterior only after 30 tenant pulls for that tuple and class.


# Workspace quality of life — 2026-11-04

- The chat model picker accepts arbitrary IDs and offers searchable, keyboard-navigable catalog suggestions, with capability and minimum-context filters. Catalog capabilities and context sizes are estimates, not guarantees of upstream support.
- A blank max-token field uses a conservative output budget from the smallest advertised context for an exact model ID, after an approximate text/tool-input estimate and safety margin. For lanes or unknown IDs it leaves the provider default untouched. Manual limits are preserved; output limits, images and automatic router tools are not known to the estimator.
- Mobile chat starts with parameters closed even if the desktop preference was open. The closed scrim cannot blur the page, and opening chat no longer automatically raises the mobile keyboard.
- Added ocean and violet themes and local draft recovery.
- Video generation is not implemented or advertised: this environment cannot reach provider APIs to verify keyless video support, and a model name in a catalog is not proof that a usable generation API exists.

# Tool Plane (ASCK-T v2) — 2026-11-04

v1 made the plane *executable*: a schema validator, a repair ladder, a registry
and a skill posterior. What it could execute was mostly arithmetic. v2 splits
the code along the seam that actually matters — a vendor-neutral **kernel** and
a **capability toolbox** — and gives the plane state.

## Split
- `tools.ts` is now the kernel only (~1.9k lines): validation, repair, resolve,
  projections, sandbox, skill memory, agent partitioning. It knows nothing about
  files, SQL or HTTP.
- `toolbox/` owns capabilities behind one `ToolCaps` contract (`{ kv?, fetch? }`),
  so nothing below it touches a global, and every module is unit-testable with a
  memory store and a stub fetcher. `registerToolbox(register, api)` is the only
  join point; `main.ts` passes Deno KV and the guard-wrapped fetch.
- Stateful tools are namespaced per tenant: `x-nokey-session` / `x-session-id`,
  falling back to `shared`. `/v1/tools` now publishes that contract under
  `session`.

## New capabilities (24 built-ins, 13 kinds)
- **Durable VFS** (`fs_write`/`read`/`list`/`grep`/`patch`/`delete`): 2 MiB per
  file, 32 MiB + 2000-file quota checked *before* writing, chunked KV blobs,
  glob listing, regex grep with context, unified diff and fuzzy hunk anchoring.
- **Memory** (`memory_write`/`recall`/`forget`/`graph`): conjunctive duplicate
  consolidation (cosine *and* token containment, so TypeScript and Python notes
  stop collapsing into each other), hybrid retrieval, MMR, one-hop expansion,
  reinforcement on read, decay/importance scoring.
- **RAG** (`rag_index`/`search`/`collections`): content-addressed chunks with
  duplicate skipping, BM25 + dense fusion, char budget, citations.
- **Embeddings** (`embed`): deterministic 384-d feature hash, int8 compression,
  optional neural upgrade via `NOKEY_EMBED_URL` (no key required by default).
- **Web** (`web_search`/`web_fetch`/`http_request`): keyless multi-engine search
  fused with RRF, readability extraction to Markdown, SSRF guard, response cache.
- **Clipboard** (versioned slots with undo/TTL), **task** (durable plan board),
  and consolidated **`calculate` / `data` / `text` / `time` / `crypto`** replacing
  the thirteen narrow v1 tools (`math_evaluate`, `json_query`, `encode_*`, …).
  Every old name still resolves: aliases, dotted spellings and fuzzy matches are
  folded into the five verbs.

## Bugs the new tests found (all fixed)
- `rrf()` sized its score array by the longest *ranking* instead of the largest
  *document index*; two short rankings pointing at different documents produced
  `NaN` scores and empty recall. Hybrid RAG and memory recall both hit it.
- Unary minus bound tighter than `^` (`-3^2` evaluated to 9). It now parses its
  operand at the power precedence, matching Python/Excel.
- The unified-diff parser turned the patch's trailing newline into a phantom
  context line, so every anchored hunk failed against the last line of a file.
- Memory recall dropped every memory when a query had no positive lexical or
  dense signal (score became `NaN`). Recall now degrades to importance+recency.
- A batch ran every call in parallel, so `fs_write` then `fs_read` (or
  `memory_write` then `memory_recall`) raced: the read could not see the write.
  Stateful calls now execute in call order while pure calls stay parallel, and
  the KV store reads/lists with strong consistency so the write is visible
  immediately.
- Tokenisation ignored inflection (`deploy` never matched `Deploys`). A
  conservative stemmer folds plurals and `-ing`/`-ed` without Porter's reach.

## Tests
`tests/tools_test.ts` (23 suites) covers the kernel and every capability with a
stubbed transport; `tests/tool_plane_test.ts` (25 tests) now pins ASCK-T v2:
plane string, engine `nokey-sovereign-v6-asck2-toolbox`, the 24-tool roster, the
new verbs in the agent-loop scripts, and `session.namespace`.

# Tool Plane (ASCK-T v1) — 2026-11-04

First-class tool support. Until now the router only *forwarded* `tools` /
`tool_choice` / `parallel_tool_calls` and forced the `code` lane when they were
present; nothing on the mesh could actually be called, and nothing was learned
from the calls that went past. `tools.ts` adds an executable tool plane with its
own control kernel, and `main.ts` wires it into dispatch so tool knowledge
compounds across requests instead of being rebuilt per call.

## `tools.ts` — the kernel (pure module, no I/O, no `eval`)
- **Schema subset validator** (`validateJson`): type/enum/const, required,
  properties, patternProperties, `additionalProperties`, items/prefixItems,
  min/max Items, uniqueItems, minimum/maximum (+ exclusive), multipleOf,
  min/maxLength, pattern, format, `default`, allOf/anyOf/oneOf/not, `$ref`/`$defs`.
  Bounded (depth 24, 250k nodes) so a hostile schema cannot hang an isolate.
  Coercion is lossless-only (`"5"`→5, `"true"`→true, scalar→[scalar], enum case,
  inclusive-bound clamp) and every mutation is reported at its JSON pointer.
- **Argument repair ladder** (`parseToolArguments`): native → strict parse →
  fence/prose extraction → string-aware repair (single quotes, bare keys,
  Python literals, trailing commas, truncation, raw newlines, comments) →
  double-decode → scalar salvage. Each rung records what it did, so a repaired
  call is still a *graded* call rather than a silent guess.
- **Registry**: wire-safe canonical ids (`^[a-zA-Z0-9_-]{1,64}$`) with dotted,
  kebab and camelCase aliases folded by one normaliser; a fuzzy resolver that
  either auto-corrects a near miss (≥0.82) or returns ranked suggestions
  (≥0.62), and now puts the suggestion in the error *text* too, because a model
  retrying from the message alone must still see the correction.
- **Sandboxed execution** (`executeTool` / `executeToolCalls`): deadline armed
  *before* the work starts (a polite tool cannot win the race on abort), 128KB
  argument cap, 64KB result cap with truncation flagged, structured error codes
  (`UNKNOWN_TOOL`, `ADMIN_REQUIRED`, `INVALID_ARGUMENTS`, `TOOL_ERROR`,
  `TIMEOUT`, `ABORTED`, `RESULT_TOO_LARGE`).
- **Vendor projections**: one registry → `openai`, `openai-strict` (closed
  schema, everything required), `anthropic` (`input_schema`) and `gemini`
  (`functionDeclarations`, upper-cased types), plus a system-prompt preamble.
- **Skill memory** (`observeToolSkill` / `skillSummary`): per-tool discounted
  Beta posterior and a Kalman filter over ln(latency) with *tool-scale* bounds
  (the kernel's TTFT-shaped filter would clamp a 40µs computation to 50ms),
  reported as Wilson competence floor, Thompson draw, p50/p95/p99, repair rate,
  top error codes and staleness.
- **14 built-ins**: `math_evaluate` (precedence-climbing evaluator, no `eval`,
  AST-cached, 30+ functions incl. `erf`, `norm_quantile`, `lognorm_sf`),
  `math_statistics` (one-pass moments, type-7 quantiles, Freedman–Diaconis
  histogram, Tukey outliers, log-normal fit), `text_similarity`, `text_extract`,
  `json_query` (JSONPath-lite), `json_validate`, `json_transform`,
  `time_convert` (IANA zones, durations, epoch-unit guessing), `crypto_digest`,
  `crypto_id`, `encode_transform`, `encode_jwt`, `random_sample`,
  `router_capabilities`.

## HTTP surface
- **`GET /v1/tools`** — registry with schemas, aliases and learned skill, plane
  totals, the agent configuration, and `wire.tools` projected onto any of the
  four vendor formats. `?schemas=0` slims it; admin-only tools appear only with
  a valid `x-admin-secret` (mirroring `requireAdmin`: no secret configured means
  no admin tier at all).
- **`POST /v1/tools/execute`** — one call (`{name, arguments}`) or a batch
  (`{calls:[…]}`, ≤16), accepting OpenAI nesting or flat keys. Always 200: a
  failing tool is reported per-call with its code, issues and suggestions,
  because that is what a model needs to retry. Skill writes are awaited so the
  response's own `totals` already include the call, and the route is traced
  (`traceparent` honoured inbound and returned).
- **Mesh tools** (`router_catalog`, `router_health`, `router_models`,
  `router_endpoints`, `router_lane`, and admin `router_trace`) expose live router
  state to any model, so "which lane should I use?" is answered with evidence
  instead of a guess.
- `/health` gains a `tool_plane` block and `current_best_tools`; `/v1/models`
  gains the `free:tools` lane. Engine id → `nokey-sovereign-v6-asck1-toolplane`.

## Chat integration: an opt-in agent loop
- `"tools": "auto"` (or `nokey_tools`, or `x-nokey-tools`) attaches the plane's
  built-ins; `nokey_tools: "all"` attaches every non-admin tool, and an explicit
  list attaches exactly those. Client declarations are merged first and **shadow
  same-named built-ins** — the plane never hijacks a caller's own API.
- When the router supplied the tools it also runs the loop: execute the calls,
  append the protocol-correct `assistant` + `tool` turns, keep the winning tuple
  selectable, and re-dispatch — up to `NOKEY_TOOL_ROUNDS` (default 3, clamped
  0–8; 0 is pure passthrough). A round is executed only when *every* call in it
  is a built-in, so a mixed parallel batch is handed back whole.
- Streaming drains a tool round quietly (`collectUpstream`), emits a status
  frame with `choices: []` and `nokey.type: "tool_round"`, then streams the real
  answer. Assistant content is never fabricated, and with the loop off the byte
  stream is exactly what it was before.
- A one-line preamble (`toolPreamble`, opt out with `nokey_preamble: false`)
  tells small free models the router will execute their calls — measurably the
  difference between a tool call and a guess.

## Compounding intelligence
- Every completion with declared tools is **graded**: each call must name a
  declared tool (the caller's schema wins over the registry's) and its arguments
  must survive the ladder and validate. The verdict feeds the tuple's tool
  posterior (`observeTupleToolStats`: valid → α, repaired-but-valid → half
  credit, invalid → β), stored with the same CAS + optimistic-L1 discipline as
  the model catalog.
- Ranking picks it up: `scoreRecord` adds `toolRoutingBonus = (draw − 0.5) × 0.14`
  when a request is tool-aware, and **exactly 0 with no evidence**, so unproven
  tuples keep being explored rather than being punished for youth. Tool-aware
  requests skip the fast-lane latency sort, because the cheapest tuple is rarely
  the one that emits valid calls.
- Tool-level skill (latency, reliability, repair rate) compounds separately and
  is published on `/v1/tools`, `/health` and through `router_capabilities`.

## Workspace UI
- New **Tools** view: plane KPIs, a sortable registry table (calls, Wilson
  competence, p50/p95, repair rate, admin/pure flags), an expandable row with
  the description, aliases, top error codes and the JSON Schema, a live runner
  that posts to `/v1/tools/execute` (unparsable argument text is sent as-is so
  the repair ladder can be watched working), and a copy button for the wire
  declarations in any of the four vendor formats.
- Chat gains a **router tools** toggle (sends `"tools": "auto"`, or
  `nokey_tools: true` alongside client tools) and shows tool rounds: live
  "tool round N · name" while streaming, and "N tool rounds · tools" in the
  message footer. Status frames with empty `choices` are handled explicitly.

## Tests
- `tests/tools_test.ts` (13 tests): validator paths and lossless coercion, the
  full repair ladder, exact reference values for every built-in (SHA-256 of
  `"abc"`, base64 of `"hello ✓"`, Levenshtein, type-7 quantiles, ISO-8601
  durations, `-3^2 = -9`), the execution sandbox, all four vendor projections,
  call partitioning, skill compounding, and the damage-accounting rules
  (declared defaults are *not* repairs, `anyOf` prefers the branch needing the
  fewest repairs, shadows stay the caller's).
- `tests/tool_plane_test.ts` (25 tests, end-to-end through `app.fetch` with a
  mocked registry): both new routes, admin gating, per-call failure reporting,
  bounded execution (deadline enforced, maxItems/maximum clamped, 413 at the
  body limit), skill compounding over HTTP, mesh tools answering from live
  state, the buffered agent loop and its round cap, repaired arguments, failed
  calls returned as tool messages, client passthrough, mixed rounds, shadowing,
  both kill switches, three streaming cases, `free:tools`, and tuple-level
  learning becoming visible to later requests.
- Suite: 36 → 74 passing. `deno task check` now covers `tools.ts` too.

# Workspace UI v2 — 2026-11-04

Front-end only: `index.html` (the operator workspace) and `docs.html` (Scalar
reference). No route, schema or routing-math changes; every existing view, id
and keyboard shortcut still works.

## Mobile-first shell
- Phones get a real app shell: compact glass header (logo, active-view title,
  search, theme, docs, connection chip) plus a bottom tab bar for Chat,
  Architect, Media, Traces and a "More" sheet listing all twelve views with
  icons and one-line descriptions.
- Safe-area aware: `viewport-fit=cover`, `env(safe-area-inset-*)` padding on the
  header, tab bar, sheets and composer, `100dvh` panels, 16px inputs so iOS
  never zooms on focus, 42–44px touch targets under `(hover: none)`.
- Wide data tables become stacked cards below 860px: cells are labelled from
  their `<thead>` at runtime (`annotate()`), so Catalog, Endpoints, Lanes,
  Inspector and Ops stay readable instead of scrolling sideways.
- The chat parameter panel becomes a dismissable bottom sheet on phones
  (scrim, grabber, close button); the command palette goes full-screen; dialogs
  dock to the bottom edge.

## Look and feel
- New design system: Inter + JetBrains Mono, rounded surfaces, hairline borders,
  soft elevation, lime accent with an aurora wash behind the workspace.
- Light / dark / auto theme with a header toggle, persisted in localStorage and
  applied before first paint (no flash). Canvas plots and the trace waterfall
  read their colours from the same CSS tokens, so they repaint with the theme.
- Chat gets a real empty state (logo, tagline, four prompt chips), right-aligned
  user bubbles, a floating "jump to latest" button and a rounded composer that
  glows on focus.
- Reasoning, tool calls and traces restyled; markdown, code blocks and copy
  buttons keep their behaviour.

## Modern-platform plumbing
- View Transitions API between views (desktop, skipped under reduced motion).
- A thin request-progress bar driven by the instrumented `req()` wrapper.
- `?` opens a keyboard-shortcut sheet; `Esc` closes overlays; the palette gains
  theme, shortcuts and new-chat commands.
- Overflow-aware header nav (fades only when it actually scrolls) and the
  active tab is scrolled into view.
- `prefers-reduced-motion`, `(hover: none)` and DPR-aware canvas drawing.

## Dependencies
- hono 4.6.14 -> 4.13.16, @opentelemetry/api 1.9.0 -> 1.10.0 (`deno.json`).
- Scalar reference restyled to the new palette (still 1.76.4, unchanged API).

# Nokey Router update — 2026-10-27

Base: GitHub main @ 9aa0877 (the services.json build). Deploy = redeploy the
Deno project with this main.ts; a push alone does not deploy.

## Why text generation was 502ing on production
POST /v1/chat/completions existed and the keyless providers are alive (Kilo
and Pollinations both answered direct test calls), but every lane returned
502 "All promises were rejected". Two dispatch defects:

1. The dispatch race and the canary probe resolved providers with
   PROVIDERS.find ONLY, ignoring the services.json registry providers that
   the ranking admits. Registry candidates (ids services_json_*) instantly
   threw "Provider missing or unconfigured". Since providers moved into
   services.json — and the native Pollinations spec was removed in 9aa0877 —
   most of the catalog could rank but never execute.
2. Waves draw 3-at-a-time from the head of the ranking (9 attempts max) with
   no provider diversity, so one failing provider's tuples (production's
   head was all OpenRouter) burn every attempt while healthy providers are
   never tried.

## Fixes in main.ts
- resolveProviderById(): merged lookup across native PROVIDERS and the
  services.json registry; used by the dispatch race and the canary probe.
  This also makes the 9aa0877 Pollinations removal safe: Pollinations lives
  on in services.json (5 endpoints) and is dispatchable again.
- interleaveByProvider(): ranked lists are round-robined across providers
  before racing, per-provider order preserved.
- Provider circuit breaker: 6 consecutive tuple failures exclude a provider
  from ranking for 5 minutes; its next success clears it.

## New: image generation (OpenAI-standard path)
POST /v1/images/generations  { model, prompt, size, n, response_format }
-> { created, data: [{ url }] } or [{ b64_json }] with response_format=b64_json.
Models (also listed by GET /v1/models):
- nokey-image       Pollinations turbo (fast) — primary
- nokey-image-flux  Pollinations flux (quality, slower)
- nokey-image-horde AI Horde stable_diffusion (anonymous key)
Pollinations failures fall back to the Horde automatically.
NOTE: the image endpoint calls the Pollinations image API directly; it does
not depend on the removed native text spec.

## Page (index.html, new in repo)
Dashboard media tab POSTs {router}/v1/images/generations with the header-bar
API key, shows a spinner, renders data[0].url, sets the download link, logs
to the Inspector tab. Video option marked unavailable (no keyless provider).

## Verified locally against this exact build (with services.json present)
- deno check clean
- GET /v1/models lists nokey-image, nokey-image-flux, nokey-image-horde
- POST /v1/chat/completions with a realistic request -> 200 in ~3s (Kilo);
  canary probe passes; registry loads (334 catalog entries) and registry
  tuples appear in rankings again
- POST /v1/images/generations returns real images via both backends
  (Pollinations 503s are absorbed by the Horde fallback)

## Known wart (pre-existing, not fixed here)
Tiny max_tokens probes (e.g. 16) against reasoning-heavy models return
502 after long wave-burning: the model spends the whole budget on
reasoning, content arrives empty, and verifyCleanText throws POISON_EMPTY.
Realistic budgets (the dashboard/Forge defaults) are unaffected. Worth a
follow-up: treat POISON_EMPTY as a soft failure that returns the truncated
completion instead of failing the candidate.

## Production note
The live deployment failed even a realistic request in ~5.6s (every
candidate rejected almost immediately) while this build answers the same
request locally in ~3s — the deployed code itself is the broken layer.
Redeploying this build is the fix; if it still 502s after redeploy, check
the deployment's OPENROUTER_API_KEY next.

## Addendum — 2026-10-27 (status moved to /health)
2822769 made the router serve this dashboard at GET / itself and moved the
JSON gateway status to GET /health. Every consumer still parsing / as JSON
(the dashboard Sync check, the connector status helper) died with an
"HTML is not valid JSON" parse error.
- index.html: connection test now probes GET /health; a fetchJson helper in
  the Architect/media paths and an HTML guard on the chat stream turn the
  raw parse error into a plain-English message.
- Connector helper (router.py status): falls back to /health when / does
  not return JSON, instead of crashing with a decode traceback.
- main.ts: unchanged by this addendum (the /health route already exists).

## Addendum 2 — 2026-10-27 (unverified tuples no longer top the IQ lanes)
After the redeploy, free:fast and image generation worked on production,
but free:smart / free:code / free:reasoning still 502ed: their rankings are
IQ-sorted, and newly discovered tuples entered the catalog with
iq_verified = 1.0 (full trust) plus an optimistic 900 ms latency prior.
Registry gateways advertising frontier names ("claude-opus-5",
"gemini-4-argon") therefore monopolized the IQ lanes despite never having
served a completion, and every wave burned on them.
- Fresh tuples now start unverified: iq_verified 0.55 (the canary's fail
  value) and a neutral 2500 ms latency prior.
- Sync clamps iq_verified to 0.55 for any tuple that has never succeeded,
  so existing catalogs self-heal without a KV wipe.
- Each real dispatch success raises iq_verified by 0.15 (cap 1.0); the
  canary still sets 1.0 / 0.55 outright on probe results.
Verified locally: after a sync, Kilo natives head the smart/code rankings
and both lanes complete in seconds (previously 502).

## Addendum 3 — 2026-10-27 (rank-time trust clamp)
Addendum 2's demotion ran during catalog sync, but sync skips providers
whose model discovery fails -- the exact population that needed demoting --
so production's IQ lanes stayed clogged after the redeploy (fast and code
recovered; smart/auto/reasoning still 502). The clamp now also applies at
rank time in getRankedCandidates: any tuple with success_count == 0 is
scored with iq_verified capped at 0.55 on every request, regardless of the
stored value or sync state.

## Addendum 4 — 2026-10-27 (rolling hedged race + dashboard overhaul)
Server: the wave race (3 candidates per wave behind 0/250/1300-3000 ms
staggers and a wave barrier) is replaced by a rolling hedged race: first
candidate starts immediately, hedges join at +150/+400 ms, and EVERY
failure instantly launches the next candidate (up to 12 attempts, max 5
in flight) -- a fast 4XX no longer leaves the next attempt unstarted for
~1 s. Catalog sync no longer blocks the request path: with a warm cache
a due sync refreshes in the background (cold start / admin force still
await). Local proof: fast 1.9 s, smart 2.2 s, and an explicit request for
a dead registry model fell through its broken tuples to a working
provider in 2.7 s (previously 7-10 s of waves, usually a 502).
Dashboard: the header and tab nav are merged into one unified top bar
inside a fixed-height app shell (h-screen flex column) -- the bar never
scrolls, and the chat composer is pinned: only the message list scrolls.
Self-hiding panels: the connection bar and the chat Routing Parameters
panel collapse via toggles (state persists; params auto-hide on small
screens). New Plugins tab: a real registry (NokeyPlugins.register) with
four working built-ins (Lane Probe, Catalog Sync, Model Ping, Image
QuickGen) plus an Install panel that mounts Architect-generated plugin
code live. New Admin tab: locked until the existing Admin Secret is
verified against the router with a live probe; then status cards, lane
rankings, probe runner, and catalog force-sync.

## Addendum 5 — 2026-10-27 (frontier resilience: escalate, resurrect, salvage)
Three changes so the router expands its choices instead of giving up:
1. Second-wind escalation. When the tier-1 race (12 attempts) exhausts,
   dispatch escalates instead of returning 502: tier 2 widens to the next
   candidates INCLUDING providers in circuit-breaker cooldown (mercy
   attempts; breaker state is a stale snapshot), and tier 3 rescues
   cross-lane to any tuple that has ever completed a request (this lane,
   then the fast lane). getRankedCandidates gained includeCoolingDown /
   verifiedOnly options; every attempt is tracked so tiers never retry a
   tuple. Tier-1 size is env-tunable (MESH_RACE_TIER1_ATTEMPTS). Proven
   locally with tier-1 forced to 1 attempt on a proven-dead tuple: the
   log shows tier 2 engaging (273 candidates) and rescuing the request
   in ~2.2 s.
2. Long-tail resurrection. Of ~1,300 catalog tuples most sit unproven
   (success_count == 0) and the canary only re-tests the top 4. A new
   prober (cron every 10 min, POST /v1/resurrect, Admin tab button)
   walks the least-recently-probed tail with the canary question and
   promotes whatever answers -- verified IQ written back exactly like
   the canary. First local run: probed 4, promoted 1
   (kilo::cohere/north-mini-code:free), correctly buried 3 dead tuples.
3. Salvage, don't discard. A reasoning-only completion (empty visible
   content, full reasoning_content) used to die as POISON_EMPTY. The
   parser now promotes the reasoning into content -- the same promotion
   splitThinkBlock already did for <think> blocks -- and counts it as a
   win. Tool-call responses were already exempt; truly empty responses
   still throw. (Branch is type-checked and mirrors the existing think-
   block behavior; no live reasoning-only response occurred during
   local testing despite several tiny-token attempts.)

## Addendum 6 — 2026-10-27 (the Architect gets hands: tool-use agent)
The Vajra Core Architect was a chat box: one lane call, no abilities. It
is now a real tool-use agent in the page. Protocol: the model replies
with a fenced ```action {"tool": ...}``` block; the page executes the
tool, feeds the result back, and loops up to 6 rounds, rendering each
tool call in the chat. Tools: read_file (the system's real source —
main.ts, index.html, CHANGES.md, services.json, deno.json — paged 300
lines per call), router_health, list_models, list_plugins,
install_plugin (mounts live into the Plugins registry), ping_model,
run_probe and force_sync (admin). New server endpoint GET /v1/source
(admin-guarded, strict allowlist, path traversal rejected) serves the
source files; without the Admin Secret the Architect can still read
index.html (its own page) and use the non-admin tools, and the tab shows
whether admin tools are armed. The system prompt grounds it honestly:
deployments are immutable, plugins are its writable surface, and server
changes must be handed over as patch text, never faked. Verified three
ways: the page's own tool code ran in a Node harness against the live
local server (12/12 checks: parsing, health, source reads, allowlist,
install/list plugins, ping, unknown-tool handling); a live model
followed the action format, consumed a real list_models result and
answered with the true catalog count (277); and it produced a
well-formed install_plugin action for a clock plugin on request.

## Addendum 7 — 2026-10-27 (Architect v2: byte budgets, code navigation, plugin SDK v2)
Fixes from live use. (1) /v1/probe returned raw Promise.allSettled
entries while every consumer (Admin tab, Lane Probe plugin, Architect)
expected {tupleId, ok, passed, ms} — probes misreported as failures.
The endpoint now normalizes results and probe failures carry their
tupleId; all three consumers render PASS / ANSWERED (wrong canary
answer) / FAIL distinctly. (2) read_file was line-capped (300 lines,
14k chars). Reads are now BYTE-budgeted: default 120,000 chars per call
(up to 200,000), whole lines from start_line, with the next start_line
reported — the whole 83 KB / 2,216-line main.ts returns in ONE call.
Source fetches are cached per session. (3) Two navigation tools join
read_file: search_code (regex over a file, line-numbered matches) and
file_map (structural outline — top-level functions/consts, routes,
crons, sections, headings; local-variable noise filtered after testing
showed it drowning the map). (4) The action parser now accepts ```json
fences, bare JSON objects, and trailing commas, and if a reply looks
like an action but does not parse, the loop feeds back a correction and
lets the model resend instead of ending the turn; rounds raised 6 -> 8.
(5) Plugin SDK v2: ctx gains chat, chatStream (SSE), image, models,
health, probe, sync, resurrect, source, and storeFor (persistent
per-plugin storage). Model Ping and Image QuickGen were rebuilt on it,
and a new built-in, Prompt Lab, is a streaming chat app with a model
picker and persisted history that exists purely on SDK calls.
Verified: harness v2 against the live local server — parser variants
4/4, byte-budgeted whole-file read, search, file map, ctx.chat /
ctx.models / ctx.storeFor / ctx.probe all passing; a live model asked
to locate the resurrection probe chose file_map unprompted.

## Addendum 8 — 2026-11-03 (first-token streaming race)
The rolling race awaited FULL completions (`stream:false`) and the client
"stream" was one buffered chunk, so client TTFT == total generation time;
an attempt with no response held an in-flight slot until the 20-30 min
global timeout, and tier escalation could not fire while it did.
- Upstreams are opened with `stream:true` (openUpstream). An attempt wins
  at its first validated tokens (64 chars through the poison guard, or a
  tool call), losers are aborted at that instant, and the winner's
  remainder is piped token-by-token to SSE clients. Bodies that ignore
  stream:true and return one JSON document are sniffed and handled.
- Hedging is model-driven: TTFT per tuple is modelled log-normal (EW
  mean/variance of ln TTFT, new optional record fields; old records derive
  from ewma_ttft_ms). The next attempt launches at the p80/p90/p95
  (fast/smart+code/reasoning) TTFT quantile of the newest attempt, capped by
  the best pending alternative's median, or instantly on a failure.
- First-token deadline: an attempt silent past its p99.9 TTFT (floors
  4 s / 25 s / 90 s) is aborted and penalised, so tiers always progress.
- One in-flight attempt per provider (diversity, no self-inflicted 429s);
  interleaveByProvider, tiers 1-3, breaker and trust clamp unchanged.
- Tool-call stream deltas are merged by index (previously overwritten).
  Upstream finish_reason (e.g. "length") is passed through.
- Salvage preserved on both paths: a reasoning-only completion is
  promoted to content (buffered) / emitted as a content frame (SSE).
- Non-stream: a generation that dies after its first token re-dispatches
  once over the untried pool.
- Hot path: L1 cache is stale-while-revalidate, a cold isolate hydrates
  from KV before deciding a provider sweep is needed, telemetry writes are
  fire-and-forget, and failures update L1 optimistically. Client
  disconnect aborts every upstream attempt.
Verified locally against mock upstreams (fast SSE, slow, JSON-only,
poison 200, hung) plus live Kilo: SSE first frame 315 ms of a 1.1 s
generation in 20 frames; poison-first and hang-first requests answered in
1.2-1.3 s (hang-first was 5.9 s before the median cap); tool-call
fragments merged; stream cancel clean. deno check clean; lint unchanged.

## Addendum 9 — 2026-11-03 (ASCK v1: exhaustive endpoints, never-error requests)

Goal: requests always work, and the router tries **every available endpoint**
before giving up, for **any** requested model id. Two hard bugs stood in the
way, plus a decade-old control heuristic.

### Root causes of "it errored instead of trying everything"
1. `parseServiceJsonRegistry` rejected `authHeader: null` (only string or
   undefined were accepted). 47 of the 100 registry endpoints carry exactly
   that shape, so **nearly half the registry was silently deleted before it
   could ever be ranked or dispatched**. Optional string fields now accept
   null. Coverage went 55 -> 102 configured endpoints (100 registry + Kilo +
   OpenCode).
2. Rankings only contain tuples with a KV record. Endpoints whose `/models`
   discovery fails, returns an empty/foreign schema, or was never synced had
   **no dispatchable candidate at all**. `providerModelHints()` now builds a
   static per-endpoint model ladder from the registry's own `defaultModel` +
   `telemetry.discoveredModels` (plus a universally accepted alias), so every
   configured endpoint always has a candidate with or without KV.
3. Dispatch was capped (12 + 18 + 10 attempts) and could return 502/503.
   `free:fast` also filtered out `iqEffective < 0.50`, and vision lanes
   discarded non-vision tuples.

### New: ASCK v1 — Adaptive Stochastic Control Kernel (`math.ts`)
A pure, dependency-free, O(1)-per-candidate mathematical kernel replacing
the fixed-EWMA + static-Beta heuristics:
- **Scalar Kalman filter over ln(TTFT)** with process noise Q and observation
  noise R. The Kalman gain is the optimal learning rate; posterior variance
  tightens on evidence and re-inflates with staleness (6 h cap), so an idle
  endpoint is never deceptively "confidently fast".
- **Posterior-predictive log-normal quantiles** for first-token deadlines,
  computed with an incomplete-gamma (series + Lentz continued fraction)
  normal CDF/quantile that keeps ~1e-300 tail resolution instead of the old
  A&S 1.5e-7 approximation.
- **Survival-driven optimal hedging**: with k spare arms, P(all pending at t)
  = S(t)^k; solving S(t)^k = theta0 gives the effective tail
  theta = theta0^(1/(1+eta*ln(1+k))), and the hedge delay is the (1-theta)
  quantile. More alternatives hedge no later; kills use the p99.9 predictive
  quantile.
- **Discounted Thompson sampling** (Beta posterior decayed toward uniform
  with a 6 h half-life) + **UCB exploration bonus** + **Wilson lower bound**
  for deterministic rankings + **Gumbel / Plackett-Luce** rank sampling.
  Records gain `log_ttft_updated_at` and `last_success_at` (optional, so old
  KV rows self-heal without a migration).
- **Trigram-Dice + token-Jaccard model similarity** for model-agnostic
  ordering of arbitrary requested model ids.
- **Decorrelated jitter** on cooldown backoff.

### New: four-tier anytime dispatch
1. `mode-ranked` — the ASCK-ranked lane (env `MESH_RACE_TIER1_ATTEMPTS`).
2. `cross-lane-proven` — proven tuples from all four lanes, including cooling
   down providers; `ESCALATION_POLICY`.
3. `full-catalog` — every catalog tuple with breaker/cooldown/vision/IQ gates
   lifted; `WIDE_POLICY` burst.
4. `exhaustive-endpoint-sweep` — every configured endpoint (and up to
   `MESH_SWEEP_MODELS_PER_ENDPOINT`=3 model variants each), round-robined so
   each provider is tried before any provider's second model; burst launch
   (128 slots, one in-flight per provider) with 6-15 s first-token kills.
   This tier intentionally re-attempts earlier tuples with fresh protocol
   negotiation. `tried` is shared across tiers so nothing is double-counted.
Every tier has a hard anytime budget (15-60 / 25 / 25 / 25 s); expiry cuts
only that tier via a portable `combineSignals`, never the request, so
escalation always progresses.

### New: adaptive wire-protocol negotiation
`openUpstreamAdaptive` retries a relay up to 5 rungs — full payload + SSE,
minimal payload + SSE, universal model alias + SSE, minimal + JSON, alias +
JSON — on 400/404/405/415/422/501, `UPSTREAM_ERR`, poison-empty, or JSON
parse failures. `parseDeltas` now self-sniffs SSE, single JSON documents,
JSON arrays and **plain text**, and `extractJsonDelta` normalises the eight
response shapes used across the keyless registry. Poison guard extended to
HTML/error-page bodies; tool-call delta indexing is preserved for SSE.

### New: requests always work
- Malformed/empty bodies are normalised (including `prompt`-only payloads)
  instead of 400ing; no more 502/503 from `/v1/chat/completions`.
- After the full sweep, a **valid 200 OpenAI-shaped completion is returned**
  (JSON or SSE) with `nokey.degraded: true`, `X-Nokey-Degraded: 1` and an
  honest explanation that no model output was fabricated. Set
  `NOKEY_STRICT_ERRORS=1` to restore legacy 502 while debugging.
- `/v1/images/generations` tries all three image backends for ANY model id,
  validates that the returned body is really an image, and falls back to a
  locally generated labelled SVG placeholder (also for `b64_json`) instead
  of 502. Missing prompt uses a benign default.
- Rate limiter is now generous and tunable (`NOKEY_RATE_BURST`=120,
  `NOKEY_RATE_REFILL`=8/s), so normal clients never get a 429.

### New: observability
- `GET /v1/endpoints` — every configured endpoint, its URL, catalog tuple
  count and model ladder, plus sweep size.
- `GET /health` — coverage, the active control kernel, guaranteed-response
  policy, and the registry load diagnostic.
- `GET /v1/models` — `accepts_any_model: true`.
- Successful responses carry `nokey` metadata and `X-Nokey-Attempts` /
  `X-Nokey-Endpoints` headers.
- Dashboard: connection toast shows endpoint coverage; degraded chat replies
  get an explicit amber banner; Architect prompt/tool docs updated (and
  `math.ts` added to the `/v1/source` allowlist).

### Cleanup
Removed dead resolver/admissibility helpers, `toDelta` (superseded by
`extractJsonDelta`), unused params, and `async`-without-`await` handlers.
`deno check` and `deno lint main.ts math.ts tests/` are both **clean**.

### Verification (fresh KV, fully mocked upstreams — no external network)
`deno task check` clean; `deno lint` clean; `deno task test` -> **20 passed,
0 failed** (8 math-kernel unit tests + 12 end-to-end dispatch tests):
- all 102 configured endpoints POSTed at least once when every upstream is
  dead, with 240 dispatch attempts, and the client still receives HTTP 200
- unknown requested model id answered by a healthy endpoint; streaming
  success emits chunks + `[DONE]`
- streamed degradation remains a valid 200 SSE stream
- 400-on-stream relays rescued by protocol negotiation; plain-text and
  JSON-only bodies accepted; malformed bodies normalised
- image endpoint degrades to a valid placeholder for `url` and `b64_json`
- `/health`, `/v1/models`, `/v1/endpoints` report 102 endpoints / 211 sweep
  candidates

### Deployment note
As before, a push alone does not deploy — redeploy the Deno project with this
`main.ts` + the new `math.ts` + `services.json` present. New optional env:
`NOKEY_STRICT_ERRORS`, `NOKEY_RATE_BURST`, `NOKEY_RATE_REFILL`,
`MESH_SWEEP_MODELS_PER_ENDPOINT` (existing `MESH_RACE_TIER1_ATTEMPTS` kept).

## Addendum 10 — 2026-11-04 (model picker grouped by provider)

`GET /v1/models` returns one row per routable tuple, so the chat model field
listed the same slug once per endpoint ("anthropic/claude-opus-5.5" x3)
interleaved with bare leaf names, and two different code paths rendered the
datalist (boot used raw ids, the Catalog view stripped the provider prefix),
so the picker mixed both styles.

- `groupedModels()` in `index.html` is now the single source for every model
  datalist: one option per routable id, grouped by vendor, lanes then image
  models first, providers alphabetical, names alphabetical inside a group.
- Vendor comes from the id prefix when the slug is provider-qualified, else
  from `owned_by`; registry ids (`services_json_<endpoint>`) are collapsed
  onto their readable vendor so they group with native providers.
- A provider-qualified slug wins over a bare leaf name for the same model,
  and options are rendered with `label="vendor · model"` so the dropdown
  shows the grouping instead of repeated strings.
- `tests/model_list_test.ts` pulls the renderer out of `index.html` and pins
  the collapse/ordering behaviour (5 cases).

## Addendum 11 — 2026-11-04 (grouping understands `provider/subprovider/model:modifier`)

Addendum 10 derived a model's group name from the last `/` segment only, so a
three-part or modifier-pinned slug grouped under its unmodified name and each
routing variant became its own option: `community/MarcosFRG/qwen3.8-flash:paid`
and `community/chigwell/qwen3.8-flash` were listed as two models with the same
label. Real ids arrive in both shapes (`community/<owner>/<model>`,
`<provider>/<model>:free|:paid|:batch|:stable`, …) via `discoveredModels`.

- `leafModelName()` now takes the last `/` segment and then the part before the
  first `:`, so every variant of a model collapses onto one entry — matching on
  the bare model name, exactly as the router's own alias matching does.
- The virtual lanes are excluded from that colon strip: `free:smart`/`free:auto`
  are names, not slugs, so their colon is not a modifier and they must not
  collapse into one "free" option.
- When variants collide, the id kept for the option is ranked rather than taken
  first: provider-qualified beats bare (as before) and an unmodified id beats one
  pinned to a modifier, so the picker offers the slug that keeps every provider
  and routing class in the race.
- `tests/model_list_test.ts` pins the three-part + modifier collapse, the bare
  `model:modifier` case, the unmodified-id-wins rule, and the lane regression
  (8 cases). Note: no Deno in the sandbox, so the suite was run under node with
  a `Deno.test` shim against the same `index.html` slice — 8/8; the new cases
  fail against the pre-change renderer.
