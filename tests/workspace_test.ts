// Workspace editing accuracy, the static project checker, and the runtime
// debug loop (app_report → app_debug).

import { executeTool, type ToolExecutionOk } from "../tools.ts";
import { applyEdits, explainMiss } from "../toolbox/edit.ts";
import { checkProject, exportsOf, importsOf } from "../toolbox/check.ts";
import { workspaceBrief } from "../toolbox/project.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
// deno-lint-ignore no-explicit-any
async function run(name: string, args: unknown, ns: string, admin = false): Promise<any> {
  const exec = await executeTool(name, args, { caps: { namespace: ns }, admin });
  if (!exec.ok) throw new Error(`${name} failed: ${exec.code} ${exec.error}`);
  return (exec as ToolExecutionOk).result;
}
async function err(name: string, args: unknown, ns: string): Promise<string> {
  const exec = await executeTool(name, args, { caps: { namespace: ns } });
  assert(!exec.ok, `${name} should fail, got ${JSON.stringify(exec).slice(0, 300)}`);
  return exec.error;
}

Deno.test("edit: replacement text is literal ($ patterns are not expanded)", () => {
  const { text } = applyEdits("price = 1;\n", [{ old: "1", new: "$&$1$$ `${x}`" }]);
  assert(text === "price = $&$1$$ `${x}`;\n", text);
  const all = applyEdits("a a a", [{ old: "a", new: "$'", replace_all: true }]);
  assert(all.text === "$' $' $'" && all.reports[0].replacements === 3, all.text);
});

Deno.test("edit: CRLF files accept LF anchors and stay CRLF", () => {
  const src = "line one\r\nline two\r\nline three\r\n";
  const { text, reports } = applyEdits(src, [{ old: "line one\nline two", new: "first\nsecond" }]);
  assert(text === "first\r\nsecond\r\nline three\r\n" && reports[0].match === "crlf", JSON.stringify(text));
});

Deno.test("edit: whitespace-insensitive match is unique, reported, and re-indented", () => {
  const src = "function f() {\n    if (x) {\n        go();\n    }\n}\n";
  // Anchor written with 2-space indentation; the file uses 4.
  const { text, reports } = applyEdits(src, [{ old: "  if (x) {\n    go();\n  }", new: "  if (x) {\n    go();\n    again();\n  }" }]);
  assert(reports[0].match === "whitespace" && reports[0].line === 2, JSON.stringify(reports));
  assert(text === "function f() {\n    if (x) {\n        go();\n        again();\n    }\n}\n", JSON.stringify(text));
  // Word boundaries still need whitespace: `returnx` is not `return x`.
  let threw = "";
  try { applyEdits("returnx;\n", [{ old: "return x", new: "y" }]); } catch (e) { threw = (e as Error).message; }
  assert(/anchor not found/.test(threw), threw);
});

Deno.test("edit: misses explain where the anchor diverged", () => {
  const src = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
  const why = explainMiss(src, "const a = 1;\nconst b = 9;");
  assert(/line 1/.test(why) && /anchor line 2/.test(why) && /const b = 2/.test(why), why);
  const near = explainMiss(src, "const bb = 2;");
  assert(/closest is line 2/.test(near), near);
  let threw = "";
  try { applyEdits("x\nx\n", [{ old: "x", new: "y" }]); } catch (e) { threw = (e as Error).message; }
  assert(/matches 2 places \(lines 1, 2\)/.test(threw), threw);
});

Deno.test("edit: line-range edits use original numbering and reject overlap", () => {
  const src = "a\nb\nc\nd\n";
  const { text } = applyEdits(src, [{ start_line: 2, end_line: 2, new: "B" }, { start_line: 4, end_line: 3, new: "c2" }]);
  assert(text === "a\nB\nc\nc2\nd\n", JSON.stringify(text));
  let threw = "";
  try { applyEdits(src, [{ start_line: 1, end_line: 2, new: "" }, { start_line: 2, end_line: 3, new: "" }]); } catch (e) { threw = (e as Error).message; }
  assert(/overlap/.test(threw), threw);
});

Deno.test("fs_patch: sha precondition, syntax guard, diagnostics", async () => {
  const ns = "ws_edit_" + crypto.randomUUID().slice(0, 8);
  const w = await run("fs_write", { path: "app.js", content: "export function add(a, b) {\n  return a + b;\n}\n" }, ns);
  assert(w.check === "ok" && w.sha256, JSON.stringify(w));

  const stale = await err("fs_patch", { path: "app.js", expect_sha256: "AAAAAAAAAAAA", edits: [{ old: "a + b", new: "b + a" }] }, ns);
  assert(/changed since you read it/.test(stale) && stale.includes(w.sha256), stale);

  const ok = await run("fs_patch", { path: "app.js", expect_sha256: w.sha256.slice(0, 10), edits: [{ old: "a + b", new: "b + a" }] }, ns);
  assert(ok.changed && ok.applied[0].match === "exact" && ok.check === "ok", JSON.stringify(ok));

  const broken = await err("fs_patch", { path: "app.js", edits: [{ old: "return b + a;", new: "return (b + a;" }] }, ns);
  assert(/would break app\.js/.test(broken) && /line 2/.test(broken) && /nothing written/.test(broken), broken);
  const still = await run("fs_read", { path: "app.js" }, ns);
  assert(still.sha256 === ok.sha256, "refused edit must not write");

  const forced = await run("fs_patch", { path: "app.js", force: true, edits: [{ old: "return b + a;", new: "return (b + a;" }] }, ns);
  assert(forced.check === "errors" && forced.diagnostics[0].line === 2 && forced.diagnostics[0].excerpt.includes("return (b + a;"), JSON.stringify(forced));

  const lines = await err("fs_patch", { path: "app.js", edits: [{ start_line: 1, end_line: 1, new: "x" }] }, ns);
  assert(/need expect_sha256/.test(lines), lines);

  const created = await err("fs_write", { path: "app.js", content: "x", expect_sha256: "new" }, ns);
  assert(/already exists/.test(created), created);

  const json = await run("fs_write", { path: "data.json", content: '{"a": 1,}' }, ns);
  assert(json.check === "errors" && json.diagnostics[0].line === 1, JSON.stringify(json));

  const list = await run("fs_list", {}, ns);
  assert(typeof list.sig === "string" && list.sig.length > 10, "fs_list sig");
});

Deno.test("checker: imports, exports, html refs, inline scripts, css", async () => {
  const files = new Map<string, string | null>([
    ["index.html", `<!doctype html>\n<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="missing.css">\n<script type="module" src="src/main.js"></script>\n<script>\n  let x = ;\n</script>\n<a href="about.html">about</a>\n`],
    ["style.css", "body { color: red;\n"],
    ["src/main.js", `import { add, sub } from "./math";\nimport Widget from "./widget.jsx";\nimport "./theme.css";\nimport fs from "fs";\nimport { h } from "preact";\nimport { gone } from "./nope.js";\nexport * from "./math.ts";\n`],
    ["src/math.ts", "export const add = (a: number, b: number) => a + b;\nexport type T = number;\n"],
    ["src/widget.jsx", "export function Widget() { return <div>ok</div>; }\n"],
    ["src/theme.css", ":root{}\n"],
    ["logo.png", null],
  ]);
  const r = await checkProject(files);
  const msgs = r.diagnostics.map((d) => `${d.path}:${d.line} ${d.severity} ${d.message}`);
  const has = (re: RegExp) => assert(msgs.some((m) => re.test(m)), `expected ${re} in\n${msgs.join("\n")}`);
  has(/index\.html:3 error <link href="missing\.css">/);
  has(/index\.html:6 error .*Unexpected token/);
  has(/index\.html:8 warning <a href="about\.html">/);
  has(/style\.css:1 error block opened here is never closed/);
  has(/src\/main\.js:1 error src\/math\.ts does not export 'sub' \(it exports: add, T\)/);
  has(/src\/main\.js:2 error src\/widget\.jsx has no default export/);
  has(/src\/main\.js:3 error .*not a JS\/TS module/);
  has(/src\/main\.js:4 error 'fs' is a Node built-in/);
  has(/src\/main\.js:6 error cannot resolve '\.\/nope\.js'/);
  assert(!msgs.some((m) => /'add'/.test(m)), "add is exported");
  assert(r.entry === "index.html" && r.packages.includes("preact"), JSON.stringify(r));
});

Deno.test("checker: export shapes and import clauses", () => {
  const ex = exportsOf("// export const ghost = 1\nexport default function () {}\nexport { a as b, c };\nexport async function go() {}\nexport class K {}\nexport * as ns from './x';\n");
  assert(ex.hasDefault && ["b", "c", "go", "K", "ns"].every((n) => ex.names.has(n)) && !ex.names.has("ghost"), JSON.stringify([...ex.names]));
  const im = importsOf("import D, { a, b as c, type T } from './m';\nimport * as all from './n';\nconst lazy = import('./o');\nimport type { X } from './t';\n");
  assert(im.length === 3 && im[0].default && im[0].names!.join() === "a,b" && im[1].namespace && im[2].names === null, JSON.stringify(im));
});

Deno.test("app_debug: runtime reports are located, current-aware, and briefed", async () => {
  const ns = "ws_dbg_" + crypto.randomUUID().slice(0, 8);
  await run("fs_write", { path: "index.html", content: '<script type="module" src="main.js"></script>\n' }, ns);
  await run("fs_write", { path: "main.js", content: "const el = document.querySelector('#x');\nel.textContent = 'hi';\n" }, ns);
  const none = await run("app_debug", {}, ns);
  assert(none.runtime.status === "none" && none.static.errors === 0 && none.ok, JSON.stringify(none));

  const { sig } = await run("fs_list", {}, ns);
  const denied = await executeTool("app_report", { sig, page: "index.html", errors: [] }, { caps: { namespace: ns } });
  assert(!denied.ok, "app_report is admin-only");
  await run("app_report", { sig, page: "index.html", errors: [{ message: "TypeError: Cannot set properties of null (setting 'textContent')", path: "main.js", line: 2, col: 16 }], logs: 3 }, ns, true);

  const cur = await run("app_debug", {}, ns);
  assert(cur.runtime.status === "current" && !cur.ok && cur.runtime.errors[0].excerpt.includes(">2| el.textContent"), JSON.stringify(cur));

  const brief = await workspaceBrief({ namespace: ns });
  assert(brief && /2 files; preview entry: index\.html/.test(brief) && /main\.js:2:16 TypeError/.test(brief), String(brief));

  await run("fs_patch", { path: "main.js", edits: [{ old: "el.textContent", new: "if (el) el.textContent" }] }, ns);
  const stale = await run("app_debug", { wait_ms: 400 }, ns);
  assert(stale.runtime.status === "stale" && stale.ok, JSON.stringify(stale));
});

Deno.test("semantic pass: const assignment, typos, undeclared names, inline scripts; DOM lookups stay quiet in JS", async () => {
  const { checkProject } = await import("../toolbox/check.ts");
  const files = new Map<string, string | null>([
    ["index.html", "<!doctype html>\n<input id=a>\n<script>\n  const n = 1;\n  n = 2;\n</script>\n<script type=\"module\" src=\"app.js\"></script>\n"],
    ["app.js", "const total = 0;\nconst el = document.getElementById('a');\nel.value = '3';\nel.addEventListner('input', () => console.log(totl));\n"],
    ["src/t.ts", "export const s: string = 5;\n"],
  ]);
  const r = await checkProject(files, { semantic: true });
  if (r.semantic?.skipped) { console.warn("semantic skipped:", r.semantic.skipped); return; } // offline CI
  const m = r.diagnostics.filter((d) => d.source === "semantic").map((d) => `${d.path}:${d.line} ${d.severity} ${d.message}`);
  const has = (re: RegExp) => assert(m.some((x) => re.test(x)), `expected ${re} in\n${m.join("\n")}`);
  has(/index\.html:5 error Cannot assign to 'n' because it is a constant/);
  has(/app\.js:4 error Property 'addEventListner' .*Did you mean 'addEventListener'/);
  has(/app\.js:4 error Cannot find name 'totl'\. Did you mean 'total'/);
  has(/src\/t\.ts:1 warning Type 'number' is not assignable to type 'string'/);
  assert(!m.some((x) => /'value' does not exist/.test(x)), "untyped DOM lookups are not reported in JS");
});

Deno.test("a batch that writes then checks sees the write", async () => {
  const { executeToolCalls } = await import("../tools.ts");
  const ns = "ws_order_" + crypto.randomUUID().slice(0, 8);
  const out = await executeToolCalls([
    { id: "w", name: "fs_write", arguments: { path: "a.js", content: "export const x = (;\n" } },
    { id: "c", name: "ws_check", arguments: {} },
  ], { caps: { namespace: ns } });
  const check = out[1].execution;
  assert(check.ok && (check.result as { errors: number }).errors === 1, JSON.stringify(check).slice(0, 300));
});
