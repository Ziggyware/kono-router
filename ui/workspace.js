// ---- durable workspace ------------------------------------------------------
// One panel for application building: the router-side durable files (the fs
// tools' namespace for this browser session), a conversation library (the
// dashboard otherwise keeps exactly one live chat), GitHub sync through the
// Contents API (the token lives only in this browser's local storage and is
// only ever sent to api.github.com), and local development via zip export /
// file import.
const wsDrawer = $("#workspace-drawer");
let wsFiles = [], wsCur = null;

async function wsExec(name, args) {
  const d = await req("/v1/tools/execute", { method: "POST", admin: true, body: { name, arguments: args } });
  const r = d.results?.[0] ?? {};
  if (!r.ok) throw new Error(r.error || r.code || (name + " failed"));
  return r.result;
}

// ---- file & folder tree -----------------------------------------------------
// The workspace is a project, not a bag of paths: render it as a tree
// (folders as collapsible <details>, files as open buttons) in the
// Workspace drawer.
function buildFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return root;
}
function fileTreeHTML(node) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, child]) => `<details class="ft-dir" open><summary>📁 ${esc(name)}/</summary><div class="ft-files">${fileTreeHTML(child)}</div></details>`).join("");
  const files = node.files.slice().sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `<button class="btn q" data-ws-open="${esc(file.path)}" style="justify-content:flex-start;font-size:11.5px;${file.path === wsCur ? "border-color:var(--acc-line);color:var(--acc)" : ""}"><span style="font-family:var(--mono)">${esc(file.path.split("/").pop())}</span><span class="dim" style="margin-left:auto">${file.bytes} B</span></button>`).join("");
  return dirs + files;
}
function renderFileTrees() {
  const html = wsFiles.length ? fileTreeHTML(buildFileTree(wsFiles)) : `<div class="dim" style="font-size:12px">No files yet — ask the chat to build something (the agent writes here with its fs tools), create a file below, pull from GitHub, or import.</div>`;
  const box = $("#ws-files");
  if (box) box.innerHTML = html;
}
function renderWsFiles() { renderFileTrees(); }

// ---- create / update activity ----------------------------------------------
// Each refresh diffs the new snapshot against the previous one, so file
// generation and edits (the agent's, GitHub pulls, your own saves) show
// up as an activity feed instead of silently changing the list.
let wsPrev = null;
const wsActivity = [];
function noteWsActivity(kind, path) {
  wsActivity.unshift({ kind, path, t: Date.now() });
  if (wsActivity.length > 12) wsActivity.length = 12;
  const html = wsActivity.map((a) => `<div class="ws-act">${a.kind === "created" ? "✚ created" : a.kind === "updated" ? "✎ updated" : "✖ deleted"} ${esc(a.path)} <span class="dim">${new Date(a.t).toLocaleTimeString()}</span></div>`).join("");
  const box = $("#ws-activity");
  if (box) box.innerHTML = html;
}
function diffWsFiles(next) {
  if (!wsPrev) { wsPrev = new Map(next.map((f) => [f.path, f.bytes + ":" + (f.mtime || "")])); return; }
  const seen = new Set();
  for (const f of next) {
    seen.add(f.path);
    const sig = f.bytes + ":" + (f.mtime || "");
    if (!wsPrev.has(f.path)) noteWsActivity("created", f.path);
    else if (wsPrev.get(f.path) !== sig) noteWsActivity("updated", f.path);
    wsPrev.set(f.path, sig);
  }
  for (const path of [...wsPrev.keys()]) if (!seen.has(path)) { noteWsActivity("deleted", path); wsPrev.delete(path); }
}

// While a panel is open, quietly re-list every few seconds so files the
// agent generates appear (and announce themselves) without a manual
// refresh. Stops when all sheets close.
// Split-pane state; layout and preferences persist, selection and build state do not.
const wsp = Object.assign({ open: false, entry: "", live: true, vp: "auto", chat: 0.44, tree: 260, treeH: 0.58, con: 160 }, store.get("wsp", {}),
  { tab: "preview", sel: null, editing: null, dirty: false, buffer: null, stale: null, ask: null, page: "", doc: "", cache: new Map(), sig: "", sigs: null, flash: new Set(), rows: [], logs: 0, errs: 0, warns: 0, timer: 0, building: false, queued: false, reloadEditor: false, autofix: false, fixArmed: 0 });
wsp.collapsed = new Set(Array.isArray(wsp.collapsed) ? wsp.collapsed : []);
wsp.autofix = Boolean(store.get("wsp.autofix"));
let wsWatchTimer = null;
function wsWatch(on) {
  if (on && !wsWatchTimer) wsWatchTimer = setInterval(() => { if (document.querySelector(".sheet.open") || (wsp.open && !document.hidden && current === "chat")) wsRefresh(true); }, 2500);
  if (!on && wsWatchTimer && !wsp.open) { clearInterval(wsWatchTimer); wsWatchTimer = null; }
}

async function wsRefresh(quiet = false) {
  const box = $("#ws-files");
  if (!quiet) box.innerHTML = `<div class="dim" style="font-size:12px">loading…</div>`;
  try {
    const r = await wsExec("fs_list", { limit: 1000 });
    wsFiles = r.files ?? [];
    wsp.ssig = r.sig || "";
    diffWsFiles(wsFiles);
    renderWsFiles();
    wspOnFiles();
  } catch (e) {
    if (!quiet) {
      wsFiles = [];
      box.innerHTML = `<div class="dim" style="font-size:12px">Could not list the workspace: ${esc(e.message)}</div>`;
    }
  }
}

// ---- workspace split pane ---------------------------------------------------
// chat | workspace, where the workspace is (tree / inspector) | live view.
// The live view assembles the project from its entry point in the browser:
// every file is read whole (paged past fs_read's line cap, batched 16 per
// request, cached by bytes+mtime), CSS and classic scripts inline, ES
// modules resolve through one import map of data: URLs, and a prelude
// supplies the hooks an opaque sandbox lacks (fetch of workspace files,
// storage, history, page links).
const WSP_HOST = "https://ws.local/";
const WSP_RUN = /\.(html?|m?js|jsx|tsx?|mts)$/i;
const WSP_JS = /\.(m?js|jsx|tsx?|mts)$/i;
const WSP_SPEC = /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:[\w$*{}\s,]+?\s*)?from\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g;
const wspDir = (p) => p.slice(0, p.lastIndexOf("/") + 1);
const wspSig = (f) => `${f.bytes}:${f.mtime || ""}`;
function b64utf8(text) {
  const b = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(out);
}
function wspDataUrl(f, mime) { return `data:${mime || f.mime || "text/plain"};base64,${f.binary ? f.content : b64utf8(f.content)}`; }

async function wsReadFull(path) {
  let r = await wsExec("fs_read", { path, limit: 5000 });
  if (r.binary) return r;
  let content = r.content ?? "";
  while (r.truncated) {
    r = await wsExec("fs_read", { path, offset: r.end_line + 1, limit: 5000 });
    content += "\n" + (r.content ?? "");
  }
  return { ...r, content, truncated: false };
}
// Stale files only, 16 calls per request; a truncated read is finished by paging.
async function wspFetch(files) {
  for (let i = 0; i < files.length; i += 16) {
    const batch = files.slice(i, i + 16);
    const d = await req("/v1/tools/execute", { method: "POST", admin: true, body: { calls: batch.map((f) => ({ name: "fs_read", arguments: { path: f.path, limit: 5000 } })) } });
    await Promise.all(batch.map(async (f, j) => {
      const res = d.results?.[j];
      if (!res?.ok) { wsp.cache.delete(f.path); return; }
      const r = res.result.truncated ? await wsReadFull(f.path) : res.result;
      wsp.cache.set(f.path, { sig: wspSig(f), sha: r.sha256, content: r.content ?? "", binary: Boolean(r.binary), mime: r.mime || f.mime || "" });
    }));
  }
}

function wspEntry() {
  const run = wsFiles.map((f) => f.path).filter((p) => WSP_RUN.test(p));
  if (wsp.entry && run.includes(wsp.entry)) return wsp.entry;
  const by = (re) => run.filter((p) => re.test(p)).sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
  return by(/(^|\/)index\.html?$/i) ?? by(/\.html?$/i) ?? by(/(^|\/)(main|index|app)\.(m?js|jsx|tsx?)$/i) ?? "";
}
function wspRenderEntry() {
  const sel = $("#wsp-entry");
  const auto = wsp.entry && wsFiles.some((f) => f.path === wsp.entry) ? "" : wspEntry();
  const run = wsFiles.map((f) => f.path).filter((p) => WSP_RUN.test(p)).sort();
  sel.innerHTML = `<option value="">auto${auto ? " · " + esc(auto) : ""}</option>` + run.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  sel.value = wsp.entry && run.includes(wsp.entry) ? wsp.entry : "";
}

async function wspCompiled(path, f) {
  if (!/\.(tsx?|jsx|mts)$/i.test(path)) return f.content;
  if (f.out === undefined) {
    // Module JSX that never brings React into scope gets the automatic runtime
    // (react/jsx-runtime), so `return <div/>` works without `import React`.
    const automatic = !/\bimport\s+(?:\*\s+as\s+)?React\b|\bimport\s+React\s*,|@jsx(?:ImportSource)?\s|\bReact\s*=/.test(f.content);
    const r = await sbxTranspile(f.content, path, automatic);
    f.out = r.code;
    f.err = r.error;
  }
  if (f.err) { const m = /\((\d+):(\d+)\)\s*$/.exec(f.err); wspLog({ level: "error", kind: "transpile", text: `transpile failed: ${f.err.replace(/^Error transforming [^:]*:\s*/, "")}`, loc: { path, line: m ? Number(m[1]) : 0, col: m ? Number(m[2]) + 1 : 0 } }); }
  return f.out;
}

async function wspAssemble(page) {
  const F = wsp.cache;
  const resolve = (spec, from) => {
    if (!spec || /^[a-z][\w+.-]*:|^\/\/|^#/i.test(spec)) return null;
    try { return decodeURIComponent(new URL(spec, WSP_HOST + wspDir(from)).pathname.slice(1)); } catch { return null; }
  };
  const find = (p) => {
    if (p == null) return null;
    const base = p.replace(/\/$/, "");
    for (const c of [p, ...[".js", ".ts", ".tsx", ".jsx", ".mjs"].map((x) => base + x), ...["js", "ts", "tsx", "jsx"].map((x) => `${base}/index.${x}`)]) if (F.has(c)) return c;
    return null;
  };
  const bare = new Set();
  const rewrite = (code, from) => code.replace(WSP_SPEC, (all, pre, q, spec) => {
    if (/^\.{0,2}\//.test(spec)) { const hit = find(resolve(spec, from)); return hit ? pre + q + WSP_HOST + hit + q : all; }
    if (!/^[a-z][\w+.-]*:/i.test(spec)) bare.add(spec);
    return all;
  });
  const imports = {};
  for (const [p, f] of F) {
    if (!WSP_JS.test(p) || f.binary) continue;
    const code = rewrite(await wspCompiled(p, f), p);
    imports[WSP_HOST + p] = `data:text/javascript;base64,${b64utf8(code + `\n//# sourceURL=${WSP_HOST}${p}`)}`;
  }
  const asset = (ref, from) => { const hit = find(resolve(ref, from)); const f = hit && F.get(hit); return f ? wspDataUrl(f) : null; };
  const css = (path, seen = new Set()) => {
    if (seen.has(path)) return "";
    seen.add(path);
    const f = F.get(path);
    if (!f || f.binary) return "";
    return f.content
      .replace(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?\s*;/gi, (all, ref) => { const hit = find(resolve(ref, path)); return hit ? css(hit, seen) : all; })
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, ref) => { const u = asset(ref, path); return u ? `url("${u}")` : all; });
  };

  let html;
  if (/\.html?$/i.test(page)) html = F.get(page)?.content ?? "";
  else html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(page)}</title></head><body><div id="root"></div><div id="app"></div><script type="module" data-sbx="${esc(page)}">import "${WSP_HOST}${page}";<\/script></body></html>`;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const userMap = { imports: {}, scopes: {} };
  for (const s of [...doc.querySelectorAll('script[type="importmap"]')]) {
    try { const j = JSON.parse(s.textContent || "{}"); Object.assign(userMap.imports, j.imports); Object.assign(userMap.scopes, j.scopes); } catch { wspLog({ level: "warn", text: "ignored an invalid importmap in " + page }); }
    s.remove();
  }
  for (const l of [...doc.querySelectorAll("link[href]")]) {
    const rel = (l.getAttribute("rel") || "").toLowerCase();
    const href = l.getAttribute("href");
    if (rel.includes("stylesheet")) {
      const hit = find(resolve(href, page));
      if (!hit) continue;
      const st = doc.createElement("style");
      st.setAttribute("data-sbx", hit);
      st.textContent = css(hit);
      l.replaceWith(st);
    } else if (rel.includes("modulepreload")) l.remove();
    else { const u = asset(href, page); if (u) l.setAttribute("href", u); }
  }
  // Inline scripts are named after the page and the line they start on, so a
  // stack frame maps back to page:line (see wspLocate).
  let scan = 0;
  const startLine = (body) => {
    const at = body.trim() ? html.indexOf(body, scan) : -1;
    if (at < 0) return 0;
    scan = at + body.length;
    let n = 1;
    for (let i = html.indexOf("\n"); i !== -1 && i < at; i = html.indexOf("\n", i + 1)) n++;
    return n;
  };
  for (const sc of [...doc.querySelectorAll("script")]) {
    const type = (sc.getAttribute("type") || "").toLowerCase();
    const src = sc.getAttribute("src");
    const named = !src && (!type || type === "module" || /javascript|ecmascript/.test(type));
    const line = src ? 0 : startLine(sc.textContent);
    if (src) {
      const hit = find(resolve(src, page));
      if (!hit) continue;
      const n = doc.createElement("script");
      for (const a of sc.attributes) if (a.name !== "src") n.setAttribute(a.name, a.value);
      n.setAttribute("data-sbx", hit);
      if (type === "module") n.textContent = `import "${WSP_HOST}${hit}";`;
      else {
        const f = F.get(hit);
        const code = type === "text/babel" || !WSP_JS.test(hit) ? f.content : await wspCompiled(hit, f);
        n.textContent = code.replace(/<\/script/gi, "<\\/script") + (type === "text/babel" ? "" : `\n//# sourceURL=${WSP_HOST}${hit}`);
      }
      sc.replaceWith(n);
    } else {
      if (type === "module") sc.textContent = rewrite(sc.textContent, page);
      if (named && line) sc.textContent += `\n//# sourceURL=${WSP_HOST}__inline/${line}/${page}`;
    }
  }
  for (const el of doc.querySelectorAll("img[src],source[src],video[src],audio[src],track[src],embed[src],input[src]")) { const u = asset(el.getAttribute("src"), page); if (u) el.setAttribute("src", u); }
  for (const el of doc.querySelectorAll("video[poster]")) { const u = asset(el.getAttribute("poster"), page); if (u) el.setAttribute("poster", u); }
  for (const el of doc.querySelectorAll("[style*='url(']")) el.setAttribute("style", el.getAttribute("style").replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, ref) => { const u = asset(ref, page); return u ? `url("${u}")` : all; }));
  for (const st of doc.querySelectorAll("style:not([data-sbx])")) st.textContent = st.textContent.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, ref) => { const u = asset(ref, page); return u ? `url("${u}")` : all; });

  // Bare package imports resolve on esm.sh with shared packages externalized,
  // so react and react-dom (say) load one instance between them.
  const rootOf = (spec) => spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  const roots = new Set([...bare].map(rootOf));
  for (const r of roots) bare.add(r);
  for (const spec of bare) {
    const ext = [...roots].filter((r) => r !== rootOf(spec));
    imports[spec] = `https://esm.sh/${spec}${ext.length ? "?external=" + ext.join(",") : ""}`;
  }
  Object.assign(imports, userMap.imports);
  const fs = {};
  for (const [p, f] of F) fs[p] = [f.mime || "text/plain", f.content, f.binary ? 1 : 0];
  const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const head = doc.head;
  const map = doc.createElement("script");
  map.type = "importmap";
  map.textContent = json({ imports, ...(Object.keys(userMap.scopes).length ? { scopes: userMap.scopes } : {}) });
  head.prepend(map);
  const pre = doc.createElement("script");
  pre.textContent = WSP_PRELUDE.replace("__ARGS__", () => [json(fs), json(wspDir(page)), json(WSP_HOST), json(store.get("wsp.ls", {}))].join(","));
  head.prepend(pre);
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

// Hooks an opaque-origin sandbox lacks. fetch() of a workspace path is served
// from the snapshot; storage falls back to an in-memory Storage persisted to
// the parent; pushState keeps its state when the URL part is refused; links
// to workspace pages navigate the live view instead of a dead frame URL.
const WSP_PRELUDE = `(function(FS, DIR, HOST, LS){
  function rel(u){ try { var s = typeof u === "string" ? u : (u && u.url) || String(u); if (/^[a-z][\\w+.-]*:/i.test(s) && s.indexOf(HOST) !== 0) return null; var p = decodeURIComponent(new URL(s, HOST + DIR).pathname.slice(1)); return FS[p] ? p : null; } catch (e) { return null; } }
  function bytes(b64){ var s = atob(b64), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  var of = window.fetch && window.fetch.bind(window);
  window.fetch = function(input, init){ var p = rel(input); if (p === null) return of(input, init); var e = FS[p]; return Promise.resolve(new Response(e[2] ? bytes(e[1]) : e[1], { status: 200, headers: { "content-type": e[0] } })); };
  function store(name, seed){
    var d = Object.assign({}, seed || {});
    function sync(){ if (name === "localStorage") try { parent.postMessage({ __wsp: "ls", data: d }, "*"); } catch (e) {} }
    var api = { getItem: function(k){ k = String(k); return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; }, setItem: function(k, v){ d[String(k)] = String(v); sync(); }, removeItem: function(k){ delete d[String(k)]; sync(); }, clear: function(){ d = {}; sync(); }, key: function(i){ var k = Object.keys(d)[i]; return k === undefined ? null : k; } };
    Object.defineProperty(api, "length", { get: function(){ return Object.keys(d).length; } });
    return new Proxy(api, { get: function(t, k){ return k in t ? t[k] : (typeof k === "string" && Object.prototype.hasOwnProperty.call(d, k) ? d[k] : undefined); }, set: function(t, k, v){ t.setItem(k, v); return true; }, deleteProperty: function(t, k){ t.removeItem(k); return true; }, ownKeys: function(){ return Object.keys(d); }, getOwnPropertyDescriptor: function(t, k){ return Object.prototype.hasOwnProperty.call(d, k) ? { value: d[k], enumerable: true, configurable: true, writable: true } : undefined; } });
  }
  ["localStorage", "sessionStorage"].forEach(function(n){ var ok = true; try { window[n].length; } catch (e) { ok = false; } if (!ok) Object.defineProperty(window, n, { value: store(n, n === "localStorage" ? LS : null), configurable: true }); });
  ["pushState", "replaceState"].forEach(function(k){ var o = history[k].bind(history); history[k] = function(s, t, u){ try { return o(s, t, u); } catch (e) { return o(s, t); } }; });
  addEventListener("click", function(e){ var a = e.target && e.target.closest && e.target.closest("a[href]"); if (!a || e.defaultPrevented || a.target === "_blank") return; var h = a.getAttribute("href"); if (!h || h.charAt(0) === "#") return; var p = rel(h.split("#")[0]); if (p && /\\.html?$/i.test(p)) { e.preventDefault(); parent.postMessage({ __wsp: "nav", path: p }, "*"); } });
})(__ARGS__);`;

async function wspBuild() {
  // A probe runs the app even while the live view is hidden, so the agent can
  // see runtime errors of the files it just wrote.
  if (!wsp.probe && (!wsp.open || wsp.tab !== "preview" || $("#wsp").classList.contains("folded"))) return;
  if (wsp.building) { wsp.queued = true; return; }
  wsp.building = true;
  try { do { wsp.queued = false; await wspBuildOnce(); } while (wsp.queued); }
  finally { wsp.building = false; }
}
async function wspBuildOnce() {
  const stat = $("#wsp-stat"), empty = $("#wsp-empty"), frame = $("#wsp-frame");
  wspRenderEntry();
  const entry = wspEntry();
  if (wsp.page && !wsFiles.some((f) => f.path === wsp.page)) wsp.page = "";
  const page = wsp.page || entry;
  if (!page) {
    frame.srcdoc = "";
    empty.hidden = false;
    empty.innerHTML = `<b>NO ENTRY POINT</b><span>Add an index.html (or main.js / main.tsx), or ask the chat to build an app — it writes here.</span>`;
    stat.textContent = `${wsFiles.length} files`; stat.classList.remove("err");
    return;
  }
  const t0 = performance.now();
  stat.textContent = "building…"; stat.classList.remove("err");
  try {
    const live = wsFiles.filter((f) => !/(^|\/)\.gitkeep$/.test(f.path));
    const keep = new Set(live.map((f) => f.path));
    for (const p of [...wsp.cache.keys()]) if (!keep.has(p)) wsp.cache.delete(p);
    await wspFetch(live.filter((f) => wsp.cache.get(f.path)?.sig !== wspSig(f)));
    wspConClear();
    wsp.run = { id: (wsp.run?.id ?? 0) + 1, sig: wsp.ssig, page, entry, t0: performance.now(), errors: new Map(), warnings: new Map(), logs: 0, static: [] };
    wsp.builtSig = wsp.ssig;
    wspReportSoon();
    wspCheckSoon();
    const doc = await wspAssemble(page);
    wsp.doc = doc;
    let out = sbxWrap(doc);
    try { const t = await sbxTranspileDoc(out); out = t.doc; for (const e of t.errors) wspLog({ level: "error", text: `transpile failed in ${e.name}: ${e.error}` }); } catch { /* keep the untranspiled doc */ }
    empty.hidden = true;
    frame.srcdoc = out;
    stat.textContent = `${page}${wsp.page && wsp.page !== entry ? " (page)" : ""} · ${live.length} files · ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    stat.textContent = "build failed: " + e.message;
    stat.classList.add("err");
  }
}
const wspSchedule = () => { clearTimeout(wsp.timer); wsp.timer = setTimeout(wspBuild, 350); };
// The current page assembled without rendering it (pop-out while the preview is hidden).
async function wspDocNow() {
  const page = wsp.page || wspEntry();
  if (!page) return null;
  const live = wsFiles.filter((f) => !/(^|\/)\.gitkeep$/.test(f.path));
  await wspFetch(live.filter((f) => wsp.cache.get(f.path)?.sig !== wspSig(f)));
  return { doc: await wspAssemble(page), page };
}

// ---- console ---------------------------------------------------------------
function wspConClear() {
  wsp.logs = 0; wsp.errs = 0; wsp.warns = 0;
  $("#wsp-con-b").replaceChildren();
  wspConBadge();
}
function wspConBadge() {
  const n = $("#wsp-con-n");
  n.className = wsp.errs ? "err" : wsp.warns ? "warn" : "";
  n.textContent = wsp.errs ? `${wsp.errs} error${wsp.errs > 1 ? "s" : ""}` : wsp.warns ? `${wsp.warns} warning${wsp.warns > 1 ? "s" : ""}` : wsp.logs ? String(wsp.logs) : "";
  $("#wsp-con-fix").hidden = !wsp.errs;
  // Automatic code fixes: when enabled, any new build-time or run-time error
  // is sent to the fixer once per error count (re-arms when errors clear).
  if (!wsp.errs) wsp.fixArmed = 0;
  else if (wsp.autofix && wsp.errs !== wsp.fixArmed && !chatCtl) { wsp.fixArmed = wsp.errs; wspFix(); }
}
function wspConOpen(on) {
  $("#wsp-con-b").hidden = !on;
  $("#wsp-con-h").setAttribute("aria-expanded", String(on));
}
// Where a console entry came from, as workspace path:line:col. Module frames
// carry their sourceURL (ws.local/<path>); inline page scripts are named
// ws.local/__inline/<first line>/<page>, so their lines are offset back.
const WSP_LOC = /https:\/\/ws\.local\/(?:__inline\/(\d+)\/)?([^\s:()?#]+)[^\s:()]*:(\d+)(?::(\d+))?/;
function wspLocate(d) {
  if (d.loc) return d.loc;
  for (const src of [d.file && d.line ? `${d.file}:${d.line}:${d.col || 0}` : "", d.stack || "", d.site || "", d.text || ""]) {
    const m = WSP_LOC.exec(src);
    if (m) return { path: decodeURIComponent(m[2]), line: Number(m[3]) + (m[1] ? Number(m[1]) - 1 : 0), col: Number(m[4]) || 0 };
  }
  if (d.kind === "resource" && d.ref) {
    if (wsp.cache.has(d.ref)) return { path: d.ref, line: 0, col: 0 };
    // A missing file: point at the page line that references it.
    const page = wsp.run?.page, html = page && wsp.cache.get(page)?.content;
    const at = html ? html.indexOf(d.ref) : -1;
    if (at >= 0) { const before = html.slice(0, at); return { path: page, line: before.split("\n").length, col: at - before.lastIndexOf("\n") }; }
  }
  return null;
}
const wspLocText = (l) => l ? `${l.path}${l.line ? ":" + l.line + (l.col ? ":" + l.col : "") : ""}` : "";
function wspRecord(d, loc) {
  const run = wsp.run;
  if (!run || d.static) return;
  if (d.level !== "error" && d.level !== "warn") { run.logs++; return; }
  const bag = d.level === "error" ? run.errors : run.warnings;
  const key = d.text + "|" + wspLocText(loc);
  const prev = bag.get(key);
  if (prev) { prev.count++; return; }
  if (bag.size >= 40) return;
  bag.set(key, { message: String(d.text).slice(0, 600), ...(loc ? { path: loc.path, line: loc.line || undefined, col: loc.col || undefined } : {}), kind: d.kind || (d.level === "error" ? "console" : "warn"), ...(d.stack ? { stack: String(d.stack).replace(/data:text\/javascript;base64,[\w+/=]+/g, "module").slice(0, 1200) } : {}), count: 1 });
  wspReportSoon();
}
// The run's outcome goes to the router once the app settles, stamped with the
// workspace sig it was built from; app_debug compares it against the current one.
function wspReportSoon() { clearTimeout(wsp.repTimer); wsp.repTimer = setTimeout(wspReport, 1500); }
async function wspReport() {
  const run = wsp.run;
  if (!run || !run.sig) return;
  const body = { sig: run.sig, page: run.page, entry: run.entry || run.page, errors: [...run.errors.values()], warnings: [...run.warnings.values()], logs: run.logs, ms: Math.round(performance.now() - run.t0) };
  const key = JSON.stringify([body.sig, body.page, body.errors, body.warnings]);
  if (key === wsp.repKey) return;
  wsp.repKey = key;
  try { await wsExec("app_report", body); } catch { wsp.repKey = ""; }
}
// Static diagnostics for the files just built, listed under the runtime output.
function wspCheckSoon() { clearTimeout(wsp.chkTimer); wsp.chkTimer = setTimeout(wspCheck, 600); }
async function wspCheck() {
  const run = wsp.run;
  if (!run) return;
  let r;
  try { r = await wsExec("ws_check", { limit: 40 }); } catch { return; }
  if (wsp.run !== run) return;
  run.static = (r.diagnostics ?? []).filter((d) => d.severity === "error" || d.severity === "warning");
  for (const d of run.static) wspLog({ level: d.severity === "error" ? "error" : "warn", text: `[check] ${d.message}`, static: true, loc: { path: d.path, line: d.line, col: d.col } });
}
function wspGoto(loc) {
  if (!loc?.path || !wsFiles.some((f) => f.path === loc.path)) { toast(`${loc?.path || "that file"} is not in the workspace`, true); return; }
  wspEdit(loc.path, false, loc.line ? { line: loc.line, col: loc.col } : null);
}
function wspFixPrompt() {
  const run = wsp.run;
  const rt = run ? [...run.errors.values()] : [];
  const st = run ? run.static.filter((d) => d.severity === "error") : [];
  const line = (e) => `- ${e.path ? `${e.path}${e.line ? ":" + e.line + (e.col ? ":" + e.col : "") : ""} ` : ""}\`${String(e.message).replace(/`/g, "'")}\`${e.count > 1 ? ` (×${e.count})` : ""}`;
  return [
    `Fix every error in the workspace app${run?.page ? ` (${run.page})` : ""}.`,
    ...(rt.length ? ["", "The live preview reported:", ...rt.slice(0, 20).map(line)] : []),
    ...(st.length ? ["", "Static check (ws_check):", ...st.slice(0, 20).map(line)] : []),
    "",
    "Use app_debug to see the code around each error, fix the cause with fs_patch, then call app_debug with wait_ms until it reports no errors.",
  ].join("\n");
}
async function wspFix() {
  if (chatCtl) { toast("wait for the current reply to finish", true); return; }
  if (!wsp.errs) { toast("no errors to fix"); return; }
  $("#pauto").checked = true;
  $("#cinput").value = wspFixPrompt();
  gateAlways = true;
  await sendChat();
}
// After an agent round that touched the workspace: refresh, and run the app
// (even with the live view hidden) so its runtime report is ready for app_debug.
async function wspProbe() {
  await wsRefresh(true);
  if (!wsp.ssig || wsp.ssig === wsp.builtSig) return;
  wsp.probe = true;
  try { await wspBuild(); } finally { wsp.probe = false; }
}
const WSP_TOUCH = /^(fs_write|fs_patch|fs_move|fs_delete|app_debug|ws_check|app_test|agent_team)$/;

// ---- test runner -------------------------------------------------------------------
// app_test queues a job on the router; this page takes it while a reply is
// streaming or the workspace is open, runs every case in its own hidden
// sandboxed frame (the visible preview is untouched) and posts the results.
// The agent below is serialised into each test frame.
function wspTestAgent() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (v) => { try { return typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); } catch { return String(v); } };
  const eq = (a, b) => {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && eq(a[k], b[k]));
  };
  // ---- unit-test API ----
  const tests = [];
  let prefix = "";
  window.test = window.it = (name, fn) => tests.push({ name: prefix + name, fn });
  window.describe = (name, fn) => { const p = prefix; prefix = p + name + " › "; try { fn(); } finally { prefix = p; } };
  window.assert = (c, msg) => { if (!c) throw new Error(msg || "assertion failed"); };
  const matchers = {
    toBe: (v, e) => [Object.is(v, e), `expected ${fmt(v)} to be ${fmt(e)}`],
    toEqual: (v, e) => [eq(v, e), `expected ${fmt(v)} to equal ${fmt(e)}`],
    toBeTruthy: (v) => [Boolean(v), `expected ${fmt(v)} to be truthy`],
    toBeFalsy: (v) => [!v, `expected ${fmt(v)} to be falsy`],
    toBeNull: (v) => [v === null, `expected ${fmt(v)} to be null`],
    toBeDefined: (v) => [v !== undefined, "expected a defined value"],
    toBeUndefined: (v) => [v === undefined, `expected ${fmt(v)} to be undefined`],
    toContain: (v, e) => [v != null && typeof v.includes === "function" && v.includes(e), `expected ${fmt(v)} to contain ${fmt(e)}`],
    toHaveLength: (v, n) => [v != null && v.length === n, `expected length ${n}, got ${v?.length}`],
    toMatch: (v, re) => [new RegExp(re).test(String(v)), `expected ${fmt(v)} to match ${re}`],
    toBeGreaterThan: (v, n) => [v > n, `expected ${fmt(v)} > ${n}`],
    toBeLessThan: (v, n) => [v < n, `expected ${fmt(v)} < ${n}`],
    toBeCloseTo: (v, n, d = 2) => [Math.abs(v - n) < 10 ** -d / 2, `expected ${fmt(v)} ≈ ${n}`],
    toThrow: (fn, m) => { try { fn(); } catch (e) { return [!m || String(e && e.message).includes(m), `expected the error to mention ${fmt(m)}, got ${fmt(e && e.message)}`]; } return [false, "expected the function to throw"]; },
  };
  window.expect = (v) => {
    const build = (neg) => Object.fromEntries(Object.entries(matchers).map(([k, f]) => [k, (...a) => { const [pass, msg] = f(v, ...a); if (pass === neg) throw new Error(neg ? "not: " + msg : msg); }]));
    return Object.assign(build(false), { not: build(true) });
  };
  async function runUnit() {
    const out = [];
    for (const t of tests) {
      const t0 = performance.now();
      try {
        await Promise.race([Promise.resolve().then(t.fn), sleep(5000).then(() => { throw new Error("timed out after 5 s"); })]);
        out.push({ name: t.name, ok: true, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        out.push({ name: t.name, ok: false, ms: Math.round(performance.now() - t0), message: String((e && e.message) || e).slice(0, 600) });
      }
    }
    return { tests: out, ok: out.length > 0 && out.every((t) => t.ok), ...(out.length ? {} : { failure: { message: "no test() registered — did the test file import correctly?" } }) };
  }
  // ---- UI steps ----
  const $ = (sel) => document.querySelector(sel);
  const visible = (el) => Boolean(el && el.isConnected && (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length));
  const textOf = (el) => (el ? (el.innerText ?? el.textContent ?? "") : "").replace(/\s+/g, " ").trim();
  async function until(check, ms) {
    const end = performance.now() + ms;
    let last;
    for (;;) {
      try { last = await check(); if (last === true) return true; } catch (e) { last = String(e.message || e); }
      if (performance.now() >= end) throw new Error(typeof last === "string" ? last : "timed out");
      await sleep(50);
    }
  }
  async function need(sel, ms) {
    await until(() => ($(sel) ? true : `no element matches ${sel}`), ms);
    return $(sel);
  }
  function setValue(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (set) set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const key = (el, type, k) => el.dispatchEvent(new KeyboardEvent(type, { key: k, code: k.length === 1 ? "Key" + k.toUpperCase() : k, bubbles: true, cancelable: true }));
  async function step(s, wait) {
    const ms = Number(s.timeout_ms) || wait;
    if ("click" in s || "dblclick" in s) {
      const el = await need(s.click ?? s.dblclick, ms);
      el.scrollIntoView?.({ block: "center" });
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      el.click();
      if ("dblclick" in s) { el.click(); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); }
    } else if ("type" in s) {
      const el = await need(s.type, ms);
      el.focus?.();
      const text = String(s.text ?? "");
      if (el.isContentEditable) { el.textContent = s.clear === false ? el.textContent + text : text; el.dispatchEvent(new Event("input", { bubbles: true })); }
      else setValue(el, s.clear === false ? el.value + text : text);
    } else if ("press" in s) {
      const el = s.on ? await need(s.on, ms) : document.activeElement || document.body;
      const k = String(s.press);
      const go = key(el, "keydown", k);
      key(el, "keypress", k);
      key(el, "keyup", k);
      // Synthetic keys never submit forms; do what the browser would.
      if (go && k === "Enter" && el.form && el.tagName === "INPUT") el.form.requestSubmit();
    } else if ("select" in s) {
      const el = await need(s.select, ms);
      setValue(el, String(s.value ?? ""));
    } else if ("check" in s) {
      const el = await need(s.check, ms);
      const want = s.value !== false;
      if (el.checked !== want) el.click();
    } else if ("wait" in s) {
      await sleep(Math.min(10000, Number(s.wait) || 0));
    } else if ("wait_for" in s) {
      await until(() => (visible($(s.wait_for)) ? true : `${s.wait_for} did not become visible`), ms);
    } else if ("expect" in s) {
      const sel = s.expect;
      await until(() => {
        const all = document.querySelectorAll(sel);
        const el = all[0];
        if (s.exists === false) return all.length === 0 ? true : `expected no element for ${sel}, found ${all.length}`;
        if (typeof s.count === "number") return all.length === s.count ? true : `expected ${s.count} × ${sel}, found ${all.length}`;
        if (!el) return `no element matches ${sel}`;
        if (s.visible !== undefined && visible(el) !== Boolean(s.visible)) return `${sel} is ${visible(el) ? "visible" : "not visible"}`;
        if (s.text !== undefined && !textOf(el).includes(String(s.text))) return `${sel} text is ${fmt(textOf(el).slice(0, 200))}, expected it to contain ${fmt(s.text)}`;
        if (s.equals !== undefined && textOf(el) !== String(s.equals)) return `${sel} text is ${fmt(textOf(el).slice(0, 200))}, expected exactly ${fmt(s.equals)}`;
        if (s.value !== undefined && String(el.value) !== String(s.value)) return `${sel} value is ${fmt(el.value)}, expected ${fmt(s.value)}`;
        return true;
      }, ms);
    } else if ("eval" in s) {
      const v = await new Function("return (" + s.eval + ")")();
      if ("equals" in s) { if (!eq(v, s.equals)) throw new Error(`eval returned ${fmt(v)}, expected ${fmt(s.equals)}`); }
      else if (v === false) throw new Error("eval returned false");
    } else throw new Error("unknown step " + fmt(s));
  }
  async function runSteps(steps) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      try { await step(s, 2000); }
      catch (e) {
        const sel = s.click ?? s.dblclick ?? s.type ?? s.on ?? s.select ?? s.check ?? s.wait_for ?? s.expect;
        const el = typeof sel === "string" ? $(sel) : null;
        return { ok: false, steps_run: i, failure: { step: i + 1, action: Object.keys(s).find((k) => k !== "timeout_ms") , message: String((e && e.message) || e).slice(0, 600), text: textOf(document.body).slice(0, 800), html: (el || document.body).outerHTML.slice(0, 1500) } };
      }
    }
    return { ok: true, steps_run: steps.length };
  }
  addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || d.__wsp_test !== 1) return;
    let out;
    try { out = d.kind === "unit" ? await runUnit() : await runSteps(d.steps || []); }
    catch (err) { out = { ok: false, failure: { message: String((err && err.message) || err) } }; }
    parent.postMessage(Object.assign({ __wsp_test_result: d.id }, out), "*");
  });
}
const WSP_TEST_AGENT = "<scr" + "ipt>(" + wspTestAgent.toString() + ")();</scr" + "ipt>";

async function wspTestDoc(c) {
  if (c.kind === "unit") {
    // A synthetic entry that imports every test module; it lives in the cache only while assembling.
    const entry = "__nokey_tests__.js";
    wsp.cache.set(entry, { sig: "", content: c.files.map((f) => `import "./${f}";`).join("\n") + "\n", binary: false, mime: "text/javascript" });
    try { return await wspAssemble(entry); } finally { wsp.cache.delete(entry); }
  }
  const page = c.page || wspEntry();
  if (!page || !wsp.cache.has(page)) throw new Error(`page ${page || "(no entry point)"} is not in the workspace`);
  return await wspAssemble(page);
}
async function wspRunCase(c, id) {
  const t0 = performance.now();
  let doc = sbxWrap(await wspTestDoc(c));
  try { doc = (await sbxTranspileDoc(doc)).doc; } catch { /* run untranspiled */ }
  doc = doc.replace(SBX_BRIDGE, () => SBX_BRIDGE + WSP_TEST_AGENT);
  const fr = document.createElement("iframe");
  fr.setAttribute("sandbox", "allow-scripts allow-forms");
  fr.setAttribute("aria-hidden", "true");
  fr.tabIndex = -1;
  fr.style.cssText = "position:fixed;left:-12000px;top:0;width:1024px;height:768px;border:0;opacity:0;pointer-events:none";
  const errors = [], warnings = [];
  let resolveResult;
  const result = new Promise((r) => { resolveResult = r; });
  const onMsg = (e) => {
    if (e.source !== fr.contentWindow || !e.data) return;
    const d = e.data;
    if (d.__wsp_test_result === id) { resolveResult(d); return; }
    if (d.__sbx === 1 && (d.level === "error" || d.level === "warn")) {
      const loc = wspLocate(d);
      const item = { message: String(d.text).slice(0, 500), kind: d.kind || "console", ...(loc ? { path: loc.path, line: loc.line || undefined, col: loc.col || undefined } : {}) };
      (d.level === "error" ? errors : warnings).length < 20 && (d.level === "error" ? errors : warnings).push(item);
    }
  };
  addEventListener("message", onMsg);
  try {
    const loaded = new Promise((r) => fr.addEventListener("load", r, { once: true }));
    fr.srcdoc = doc;
    document.body.appendChild(fr);
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 10000))]);
    await new Promise((r) => setTimeout(r, 400)); // first render and effects settle
    fr.contentWindow.postMessage({ __wsp_test: 1, id, kind: c.kind, steps: c.steps }, "*");
    const out = await Promise.race([result, new Promise((r) => setTimeout(() => r({ ok: false, failure: { message: "the test did not finish within 20 s (a step hung, or the page never loaded the test agent)" } }), 20000))]);
    await new Promise((r) => setTimeout(r, 150)); // let errors raised by the last step arrive
    const fatal = errors.filter((e) => e.kind === "exception" || e.kind === "rejection" || e.kind === "resource" || e.kind === "transpile");
    const ok = Boolean(out.ok) && fatal.length === 0;
    const failure = out.failure ?? (fatal.length ? { message: "uncaught error while testing: " + fatal[0].message } : undefined);
    return { name: c.name, kind: c.kind, ok, ms: Math.round(performance.now() - t0), ...(out.steps_run !== undefined ? { steps_run: out.steps_run, steps: c.steps.length } : {}), ...(failure ? { failure } : {}), ...(out.tests ? { tests: out.tests } : {}), ...(errors.length ? { errors } : {}), ...(warnings.length ? { warnings: warnings.slice(0, 5) } : {}) };
  } finally {
    removeEventListener("message", onMsg);
    fr.remove();
  }
}
async function wspRunJob(job) {
  await wsRefresh(true);
  const live = wsFiles.filter((f) => !/(^|\/)\.gitkeep$/.test(f.path));
  await wspFetch(live.filter((f) => wsp.cache.get(f.path)?.sig !== wspSig(f)));
  const results = [];
  for (const [i, c] of job.cases.entries()) {
    try { results.push(await wspRunCase(c, `${job.id}:${i}`)); }
    catch (e) { results.push({ name: c.name, kind: c.kind, ok: false, failure: { message: e.message } }); }
  }
  const failed = results.filter((r) => !r.ok).length;
  wspLog({ level: failed ? "error" : "info", static: true, text: `[test] ${results.length - failed}/${results.length} case${results.length === 1 ? "" : "s"} passed${failed ? " — " + results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.failure?.message ?? "failed"}`).join(" · ").slice(0, 400) : ""}` });
  return { results };
}
// Poll while someone could be waiting on a test: a streaming reply or an open workspace.
let wspTicks = 0;
// wsp.runnerOk: this page may run test jobs (app_runner is admin-only); it is
// what lets a chat request promise the router a browser test runner.
async function wspRunnerTick(force = false) {
  // Every tick while a reply streams; every ~4 s with only the workspace open (Tools-tab runs).
  wspTicks++;
  if (wsp.jobBusy || (!force && (document.hidden || !(chatCtl || (wsp.open && wspTicks % 4 === 0))))) return;
  wsp.jobBusy = true;
  let job = null;
  try {
    try { job = (await wsExec("app_runner", { op: "take" }))?.job; wsp.runnerOk = true; }
    catch (e) { if (/40[13]|admin/i.test(e.message)) wsp.runnerOk = false; throw e; }
    if (job) {
      let result;
      try { result = await wspRunJob(job); } catch (e) { result = { error: e.message }; }
      await wsExec("app_runner", { op: "done", id: job.id, result });
    }
  } catch { /* router unreachable or not admin: no runner */ }
  finally { wsp.jobBusy = false; }
}
setInterval(wspRunnerTick, 900);
setTimeout(() => wspRunnerTick(true), 1500);

function wspLog(d) {
  const body = $("#wsp-con-b");
  const loc = wspLocate(d);
  wspRecord(d, loc);
  if (wsp.logs >= 500) body.firstChild?.remove();
  wsp.logs++;
  if (d.level === "error") wsp.errs++;
  if (d.level === "warn") wsp.warns++;
  const row = document.createElement("div");
  row.className = "cl " + (d.level || "log");
  row.textContent = d.text;
  if (loc) {
    const a = document.createElement("button");
    a.className = "cl-loc"; a.type = "button";
    a.textContent = wspLocText(loc);
    a.title = "Open in the editor";
    a.addEventListener("click", (e) => { e.stopPropagation(); wspGoto(loc); });
    row.prepend(a);
  } else if (d.line) row.textContent += `  :${d.line}${d.col ? ":" + d.col : ""}`;
  if (d.stack && !d.static) {
    const st = document.createElement("span");
    st.className = "st";
    st.textContent = String(d.stack).split("\n").filter((l) => /\bat\b|@/.test(l)).slice(0, 4).join("\n").replace(/data:text\/javascript;base64,[\w+/=]+/g, "module")
      .replace(new RegExp(WSP_LOC.source, "g"), (all, off, p, l, c) => `${decodeURIComponent(p)}:${Number(l) + (off ? Number(off) - 1 : 0)}${c ? ":" + c : ""}`);
    if (st.textContent) row.appendChild(st);
  }
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  body.appendChild(row);
  if (stick) body.scrollTop = body.scrollHeight;
  if (d.level === "error") wspConOpen(true);
  wspConBadge();
}
$("#wsp-con-h").addEventListener("click", (e) => {
  if (e.target.id === "wsp-con-clr") { wspConClear(); return; }
  if (e.target.id === "wsp-con-fix") { wspFix(); return; }
  wspConOpen($("#wsp-con-b").hidden);
});
window.addEventListener("message", (e) => {
  const fr = $("#wsp-frame");
  if (!fr || e.source !== fr.contentWindow) return;
  const d = e.data;
  if (!d) return;
  if (d.__sbx === 1) wspLog(d);
  else if (d.__wsp === "ls" && d.data && typeof d.data === "object") store.set("wsp.ls", d.data);
  else if (d.__wsp === "nav" && typeof d.path === "string" && wsp.cache.has(d.path)) { wsp.page = d.path; wspBuild(); }
});

// ---- tree --------------------------------------------------------------------
function wspRows() {
  const rows = [];
  const count = (n) => n.files.filter((f) => !/(^|\/)\.gitkeep$/.test(f.path)).length + [...n.dirs.values()].reduce((a, c) => a + count(c), 0);
  const walk = (node, prefix, d) => {
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const path = prefix + name + "/";
      const open = !wsp.collapsed.has(path);
      rows.push({ dir: true, path, name, d, open, n: count(child) });
      if (open) walk(child, path, d + 1);
    }
    for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
      if (/(^|\/)\.gitkeep$/.test(f.path)) continue;
      rows.push({ dir: false, path: f.path, name: f.path.split("/").pop(), d, f });
    }
  };
  walk(buildFileTree(wsFiles), "", 0);
  return rows;
}
const wspSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + "M" : b >= 1024 ? (b / 1024).toFixed(1) + "k" : b + "B";
function wspRenderTree() {
  const tree = $("#wsp-tree");
  const rows = wspRows();
  wsp.rows = rows;
  const entry = wspEntry();
  tree.innerHTML = rows.length ? rows.map((r) => `<button class="tr${r.dir ? " dir" : ""}${wsp.flash.has(r.path) ? " flash" : ""}" role="treeitem" tabindex="-1" style="--d:${r.d}" data-p="${esc(r.path)}" aria-level="${r.d + 1}" aria-selected="${wsp.sel === r.path}"${r.dir ? ` aria-expanded="${r.open}"` : ""}><span class="tw">${r.dir ? (r.open ? "▾" : "▸") : ""}</span><span class="nm">${esc(r.name)}${r.dir ? "/" : ""}</span>${!r.dir && r.path === entry ? `<span class="en" title="entry point">★</span>` : ""}<span class="sz">${r.dir ? r.n : wspSize(r.f.bytes)}</span></button>`).join("")
    : `<div class="wi-hint">empty — create a file below, or ask the chat to build something.</div>`;
  wsp.flash.clear();
}
function wspToggleDir(path, open) {
  if (open ?? wsp.collapsed.has(path)) wsp.collapsed.delete(path); else wsp.collapsed.add(path);
  wspSave(); wspRenderTree();
}
$("#wsp-tree").addEventListener("click", (e) => {
  const b = e.target.closest(".tr");
  if (!b) { wspSelect(null); return; }
  const p = b.dataset.p;
  if (!p.endsWith("/")) { if (wsp.editing !== p) wspEdit(p); else { wspSelect(p); wspTab("edit"); } return; }
  if (wsp.sel === p || e.target.closest(".tw")) wspToggleDir(p);
  wspSelect(p);
});
$("#wsp-tree").addEventListener("keydown", (e) => {
  const rows = wsp.rows ?? [];
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.path === wsp.sel);
  const cur = rows[i];
  let to = null;
  if (e.key === "ArrowDown") to = rows[Math.min(rows.length - 1, i + 1)];
  else if (e.key === "ArrowUp") to = rows[Math.max(0, i - 1)];
  else if (e.key === "ArrowRight" && cur?.dir) { if (!cur.open) wspToggleDir(cur.path, true); else to = rows[i + 1]; }
  else if (e.key === "ArrowLeft" && cur) { if (cur.dir && cur.open) wspToggleDir(cur.path, false); else to = rows.find((r) => r.dir && cur.path.startsWith(r.path) && r.path !== cur.path && r.d === cur.d - 1); }
  else if (e.key === "Enter" && cur) { if (cur.dir) wspToggleDir(cur.path); else wspEdit(cur.path); }
  else if (e.key === "Delete" && cur) wspDelete(cur.path);
  else return;
  e.preventDefault();
  if (to) wspSelect(to.path, { focus: true });
});

// ---- inspector ---------------------------------------------------------------
function wspGuard(next) {
  if (!wsp.dirty) { next(); return; }
  confirmDialog(`Discard unsaved edits to ${wsp.editing}?`, () => { wsp.dirty = false; wsp.editing = null; next(); }, "Discard");
}
function wspSelect(path, { focus = false } = {}) {
  wsp.sel = path;
  wsp.ask = null;
  wspRenderTree();
  wspInspect();
  if (focus) $(`#wsp-tree .tr[aria-selected="true"]`)?.focus();
}
function wspInspect() {
  const box = $("#wsp-insp");
  const sel = wsp.sel;
  const ask = wsp.ask ? `<div class="wi-row"><input id="wi-in" spellcheck="false" aria-label="${esc(wsp.ask.label)}" placeholder="${esc(wsp.ask.label)}" value="${esc(wsp.ask.value ?? "")}"><button id="wi-ok">${esc(wsp.ask.verb)}</button><button id="wi-no">cancel</button></div>` : "";
  if (!sel || (sel.endsWith("/") && !wsFiles.some((f) => f.path.startsWith(sel)))) {
    const bytes = wsFiles.reduce((a, f) => a + f.bytes, 0);
    box.innerHTML = `<div class="wi-h"><span class="p">/</span></div><div class="wi-kv"><span>files</span><b>${wsFiles.filter((f) => !/(^|\/)\.gitkeep$/.test(f.path)).length}</b><span>size</span><b>${wspSize(bytes)}</b><span>entry</span><b>${esc(wspEntry() || "none")}</b></div><div class="wi-acts"><button data-a="newfile">+ file</button><button data-a="newdir">+ folder</button><button data-a="refresh">↻ refresh</button></div>${ask}<div class="wi-hint">select a file or folder · dbl-click / enter edits · ↑↓←→ navigate · del deletes</div>`;
  } else if (sel.endsWith("/")) {
    const inside = wsFiles.filter((f) => f.path.startsWith(sel) && !/(^|\/)\.gitkeep$/.test(f.path));
    box.innerHTML = `<div class="wi-h"><span class="p">${esc(sel)}</span></div><div class="wi-kv"><span>files</span><b>${inside.length}</b><span>size</span><b>${wspSize(inside.reduce((a, f) => a + f.bytes, 0))}</b></div><div class="wi-acts"><button data-a="newfile">+ file here</button><button data-a="newdir">+ folder here</button><button data-a="rename">rename</button><button class="bad" data-a="delete">delete</button></div>${ask}`;
  } else {
    const f = wsFiles.find((x) => x.path === sel);
    if (!f) { wsp.sel = null; wspInspect(); return; }
    const c = wsp.cache.get(sel);
    const runnable = WSP_RUN.test(sel);
    const isEntry = wspEntry() === sel;
    box.innerHTML = `<div class="wi-h"><span class="p">${esc(sel)}</span></div>
      <div class="wi-kv"><span>size</span><b>${f.bytes} B</b><span>lines</span><b>${f.lines ?? "—"}</b><span>type</span><b>${esc(f.mime || "")}</b><span>modified</span><b>${f.mtime ? esc(new Date(f.mtime).toLocaleString()) : "—"}</b></div>
      <div class="wi-acts">${wsp.editing === sel ? "" : `<button data-a="edit">open</button>`}${runnable ? `<button data-a="entry" aria-pressed="${isEntry}" title="Run this file in the live view">${isEntry ? "★ entry" : "set entry"}</button>` : ""}<button data-a="rename">rename</button><button data-a="download">download</button><button class="bad" data-a="delete">delete</button></div>${ask}`;
  }
  wspRenderEditor();
  const input = $("#wi-in");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); wspAskApply(); } else if (e.key === "Escape") { wsp.ask = null; wspInspect(); } });
  }
}
// ---- editor column ----------------------------------------------------------------
// Re-rendered whole only when the open file changes (or on reload); otherwise
// only its header updates, so the caret and scroll survive tree activity.
// The panel right of the tree holds two tabs: the open file and the live
// preview. The preview only builds (and its app only runs) while showing.
// Editor/preview layout: "tab" (one at a time), "vertical" (side by side),
// "horizontal" (stacked) — a configurable split panel.
function wspPaneMode() { return ($("#wsp-layout")?.value || "tab"); }
function wspPanes() {
  const mode = wspPaneMode();
  const main = $("#wsp-panes")?.parentElement;
  if (main) {
    main.classList.toggle("mode-vertical", mode === "vertical");
    main.classList.toggle("mode-horizontal", mode === "horizontal");
  }
  const split = mode !== "tab";
  if (!wsp.editing && wsp.tab !== "preview") { wsp.tab = "preview"; queueMicrotask(wspBuild); }
  const pv = !split && wsp.tab === "preview";
  $("#wsp-ed").hidden = split ? !wsp.editing : pv;
  $("#wsp-view").hidden = split ? false : !pv;
  for (const id of ["wsp-reload", "wsp-live", "wsp-vp"]) $("#" + id).hidden = split ? false : !pv;
  const p = wsp.editing;
  const name = p ? p.split("/").pop() : "";
  $("#wsp-tabs").innerHTML = (p ? `<button role="tab" id="wsp-tab-edit" data-t="edit" aria-selected="${!pv}" aria-controls="wsp-ed" tabindex="${pv ? -1 : 0}" title="${esc(p)}"><span class="nm">${esc(name)}</span>${wsp.dirty ? `<span class="dirty" title="unsaved">●</span>` : ""}${wsp.stale === p ? `<span class="note">changed on disk</span>` : ""}<span class="x" data-t="close" role="button" aria-label="Close ${esc(name)}" title="Close">×</span></button>` : "")
    + `<button role="tab" id="wsp-tab-preview" data-t="preview" aria-selected="${pv}" aria-controls="wsp-view" tabindex="${pv ? 0 : -1}">preview</button>`;
}
function wspTab(t) {
  if (t === "edit" && !wsp.editing) return;
  const was = wsp.tab;
  wsp.tab = t;
  wspPanes();
  if (t === was) return;
  if (t === "preview") wspBuild(); else $("#wsp-frame").srcdoc = "";
}
function wspCloseFile() {
  wspGuard(() => { wsp.editing = null; wsp.dirty = false; wsp.buffer = null; wsp.stale = null; wspTab("preview"); wspInspect(); });
}
$("#wsp-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("[data-t]")?.dataset.t;
  if (t === "close") wspCloseFile();
  else if (t) wspTab(t);
});
$("#wsp-tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  wspTab(wsp.tab === "preview" ? "edit" : "preview");
  $(`#wsp-tabs [aria-selected="true"]`)?.focus();
});
// Configurable split panel: tab / vertical / horizontal, persisted.
$("#wsp-layout").addEventListener("change", () => {
  store.set("wsp.layout", wspPaneMode());
  wspPanes();
  if (wsp.tab === "preview" || wspPaneMode() !== "tab") wspBuild();
});
const savedLayout = store.get("wsp.layout");
if (savedLayout) $("#wsp-layout").value = savedLayout;
function wspRenderEditor(force = false) {
  wspPanes();
  const pane = $("#wsp-ed");
  const path = wsp.editing;
  if (!path) { pane.replaceChildren(); delete pane.dataset.path; return; }
  if (!force && pane.dataset.path === path) return;
  pane.dataset.path = path;
  const c = wsp.cache.get(path);
  const body = c?.binary
    ? (/^image\//.test(c.mime) ? `<img class="wi-img" alt="${esc(path)}" src="${wspDataUrl(c)}">` : `<div class="wi-hint">binary · ${esc(c.mime || "unknown type")}</div>`)
    : `<div class="wi-hl-wrap"><pre class="wi-hl" id="wi-hl" aria-hidden="true"><code></code></pre><textarea class="wi-ed hl" id="wi-ed" spellcheck="false" aria-label="Edit ${esc(path)}"></textarea></div>`;
  pane.innerHTML = `<div class="wi-acts">${c?.binary ? "" : `<button data-e="save">save · ctrl+s</button><button data-e="revert">revert</button><button data-e="find" title="Find in all workspace files">find</button><button data-e="def" title="Go to definition of the symbol at the caret">go to def</button><button data-e="rename" title="Refactor — rename the symbol at the caret across every file">rename</button><button data-e="diag" title="Build-time (ws_check) and run-time diagnostics">diagnostics</button><button data-e="autofix" id="wi-autofix" aria-pressed="${wsp.autofix ? "true" : "false"}" title="Automatically fix errors when they appear">auto-fix ${wsp.autofix ? "on" : "off"}</button>`}<span class="ed-path" title="${esc(path)}">${esc(path)}</span></div>${c?.binary ? "" : `<div class="wi-results" id="wi-results" hidden></div>`}${body}`;
  const ed = $("#wi-ed");
  if (!ed) return;
  ed.value = wsp.buffer ?? c?.content ?? "";
  // Syntax highlighting overlay: a highlighted <pre> sits behind a transparent
  // textarea; both scroll together so the highlight always matches the text.
  const hlSync = () => {
    const pre = $("#wi-hl");
    const code = pre && $("code", pre);
    if (!code) return;
    code.innerHTML = highlightCode(ed.value, langOf(path)) + "\n";
    pre.scrollTop = ed.scrollTop;
    pre.scrollLeft = ed.scrollLeft;
  };
  ed.addEventListener("scroll", hlSync);
  hlSync();
  ed.addEventListener("input", () => { wsp.buffer = ed.value; hlSync(); if (!wsp.dirty) { wsp.dirty = true; wspRenderEditor(); } });
  ed.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); wspSaveFile(); }
    else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); ed.setRangeText("  ", ed.selectionStart, ed.selectionEnd, "end"); ed.dispatchEvent(new Event("input")); }
  });
}
$("#wsp-ed").addEventListener("click", (e) => {
  const a = e.target.closest("[data-e]")?.dataset.e;
  if (a === "save") wspSaveFile();
  else if (a === "revert") { wsp.dirty = false; wsp.buffer = null; wsp.stale = null; wspEdit(wsp.editing, true); }
  else if (a === "find") wiFind();
  else if (a === "def") wiGoDef();
  else if (a === "rename") wiRename();
  else if (a === "diag") wiDiagnostics();
  else if (a === "autofix") {
    wsp.autofix = !wsp.autofix;
    store.set("wsp.autofix", wsp.autofix);
    if (!wsp.autofix) wsp.fixArmed = 0;
    const b = $("#wi-autofix");
    if (b) { b.setAttribute("aria-pressed", String(wsp.autofix)); b.textContent = `auto-fix ${wsp.autofix ? "on" : "off"}`; }
    toast(wsp.autofix ? "auto-fix on — new build/runtime errors are sent to the fixer automatically" : "auto-fix off");
  }
});

// ---- advanced source-code analysis (per file type, cross-file) ------------
// A lightweight language-aware index over every text file in the workspace:
// find-in-files, go-to-definition and rename (refactor) all work across file
// types; build-time diagnostics come from ws_check and run-time ones from the
// live preview report. Heavier checks (full TS checker) run server-side.
function langOf(path) {
  const p = String(path || "").toLowerCase();
  if (/\.(m?js|jsx|tsx?|mts|cjs)$/.test(p)) return "js";
  if (/\.py$/.test(p)) return "python";
  if (/\.html?$/.test(p)) return "html";
  if (/\.css$/.test(p)) return "css";
  if (/\.json$/.test(p)) return "json";
  if (/\.(sh|bash|zsh)$/.test(p)) return "bash";
  if (/\.sql$/.test(p)) return "sql";
  return "";
}
const ANALYZE_RE = /\.(m?js|jsx|tsx?|mts|cjs|py|html?|css|json|sh|sql|ya?ml|md)$/i;
async function wspAllText() {
  const todo = wsFiles.filter((f) => ANALYZE_RE.test(f.path) && (wsp.cache.get(f.path)?.sig !== wspSig(f) || !wsp.cache.has(f.path)));
  if (todo.length) await wspFetch(todo);
  const out = new Map();
  for (const f of wsFiles) {
    if (!ANALYZE_RE.test(f.path)) continue;
    const c = wsp.cache.get(f.path);
    if (c && !c.binary && typeof c.content === "string") out.set(f.path, c.content);
  }
  return out;
}
const DEF_RES = {
  js: /\b(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  python: /\b(?:def|class)\s+([A-Za-z_]\w*)/g,
};
function wspSymbolIndex(files) {
  const idx = new Map();
  for (const [path, content] of files) {
    const lang = langOf(path);
    const re = DEF_RES[lang === "python" ? "python" : "js"];
    if (!/\.(m?js|jsx|tsx?|mts|cjs|py)$/.test(path)) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i]))) {
        const name = m[1];
        if (!idx.has(name)) idx.set(name, []);
        idx.get(name).push({ path, line: i + 1, kind: m[0].trim().split(/\s+/)[0] });
      }
    }
  }
  return idx;
}
function wiShowResults(title, rows) {
  const box = $("#wi-results");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="wi-res-h"><b>${esc(title)}</b><button class="btn q" id="wi-res-x" title="Close">✕</button></div>` +
    (rows.length
      ? rows.map((r, i) => `<button class="wi-res" data-i="${i}" title="${esc(r.loc ? `${r.loc.path}:${r.loc.line || ""}` : r.text)}"><span class="${r.sev === "error" ? "no" : r.sev === "warning" ? "warn" : "dim"}">${r.sev === "error" ? "✖" : r.sev === "warning" ? "⚠" : "•"}</span> ${esc(r.text)}</button>`).join("")
      : `<div class="dim" style="padding:6px 10px;font-size:11.5px">no results</div>`);
  box.querySelectorAll(".wi-res").forEach((b) => b.addEventListener("click", () => {
    const r = rows[Number(b.dataset.i)];
    if (r?.loc) wspGoto(r.loc);
  }));
  $("#wi-res-x").onclick = () => { box.hidden = true; };
}
async function wiFind() {
  const q = window.prompt("Find in all workspace files (case-insensitive):");
  if (!q) return;
  const files = await wspAllText();
  const ql = q.toLowerCase();
  const rows = [];
  for (const [path, content] of files) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(ql)) rows.push({ sev: "log", text: `${path}:${i + 1}  ${lines[i].trim().slice(0, 140)}`, loc: { path, line: i + 1 } });
    }
  }
  wiShowResults(`find “${q}” — ${rows.length} match${rows.length === 1 ? "" : "es"} in ${files.size} file(s)`, rows.slice(0, 300));
}
function wiWordAtCaret() {
  const ed = $("#wi-ed");
  if (!ed) return "";
  const s = ed.selectionStart, v = ed.value;
  const isW = (ch) => /[\w$]/.test(ch);
  let a = s, b = s;
  while (a > 0 && isW(v[a - 1])) a--;
  while (b < v.length && isW(v[b])) b++;
  return v.slice(a, b);
}
async function wiGoDef() {
  const w = wiWordAtCaret();
  if (!w) { toast("put the caret on a symbol first"); return; }
  const files = await wspAllText();
  const idx = wspSymbolIndex(files);
  const defs = idx.get(w) ?? [];
  const rows = defs.map((d) => ({ sev: "log", text: `${d.kind} ${w} — ${d.path}:${d.line}`, loc: { path: d.path, line: d.line } }));
  // fall back to every occurrence when no declaration was indexed
  if (!rows.length) {
    for (const [path, content] of files) {
      const re = new RegExp(`\\b${w.replace(/\$/g, "\\$")}\\b`, "g");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) rows.push({ sev: "log", text: `${w} — ${path}:${i + 1}`, loc: { path, line: i + 1 } });
      }
    }
  }
  wiShowResults(`go to definition of “${w}” — ${rows.length} location${rows.length === 1 ? "" : "s"}`, rows.slice(0, 300));
}
async function wiRename() {
  const w = wiWordAtCaret();
  if (!w) { toast("put the caret on the symbol to rename"); return; }
  const nw = window.prompt(`Refactor: rename “${w}” to (applied across ALL workspace files):`, w);
  if (!nw || nw === w) return;
  if (!/^[A-Za-z_$][\w$]*$/.test(nw)) { toast("not a valid identifier", true); return; }
  const files = await wspAllText();
  const re = new RegExp(`\\b${w.replace(/\$/g, "\\$")}\\b`, "g");
  let changedFiles = 0, occurrences = 0;
  for (const [path, content] of files) {
    re.lastIndex = 0;
    if (!re.test(content)) continue;
    re.lastIndex = 0;
    const matches = content.match(re) ?? [];
    const next = content.replace(re, nw);
    const sha = wsp.cache.get(path)?.sha;
    try {
      const r = await wsExec("fs_write", { path, content: next, ...(sha ? { expect_sha256: sha } : {}) });
      wsp.cache.set(path, { ...(wsp.cache.get(path) ?? { sig: "", sha: "", content: "", binary: false, mime: "" }), content: next, sha: r.sha256 });
      changedFiles++;
      occurrences += matches.length;
    } catch (e) { toast(`rename: ${path} failed: ${e.message}`, true); }
  }
  if (wsp.editing && files.has(wsp.editing)) {
    const ed = $("#wi-ed");
    if (ed) {
      re.lastIndex = 0;
      ed.value = ed.value.replace(re, nw);
      ed.dispatchEvent(new Event("input"));
    }
  }
  await wsRefresh(true);
  toast(`renamed ${w} → ${nw}: ${occurrences} occurrence(s) in ${changedFiles} file(s)`);
}
async function wiDiagnostics() {
  const rows = [];
  try {
    const r = await wsExec("ws_check", { limit: 60 });
    for (const d of r.diagnostics ?? []) rows.push({ sev: d.severity === "error" ? "error" : "warning", text: `[build] ${d.path}:${d.line}:${d.col} — ${d.message}`, loc: { path: d.path, line: d.line, col: d.col } });
  } catch (e) { rows.push({ sev: "warning", text: `[build] ws_check unavailable: ${e.message}` }); }
  const run = wsp.run;
  if (run) {
    for (const e of run.errors.values()) rows.push({ sev: "error", text: `[runtime]${e.path ? ` ${e.path}${e.line ? ":" + e.line : ""}` : ""} — ${e.message}${e.count > 1 ? ` (×${e.count})` : ""}`, loc: e.path ? { path: e.path, line: e.line, col: e.col } : null });
    for (const w of run.warnings.values()) rows.push({ sev: "warning", text: `[runtime]${w.path ? ` ${w.path}${w.line ? ":" + w.line : ""}` : ""} — ${w.message}${w.count > 1 ? ` (×${w.count})` : ""}`, loc: w.path ? { path: w.path, line: w.line, col: w.col } : null });
  }
  wiShowResults(`diagnostics — ${rows.length} item(s) · build-time + run-time`, rows.slice(0, 300));
  if (!rows.length) toast("clean: no build-time or run-time diagnostics");
}
$("#wsp-insp").addEventListener("click", (e) => {
  if (e.target.id === "wi-ok") { wspAskApply(); return; }
  if (e.target.id === "wi-no") { wsp.ask = null; wspInspect(); return; }
  const a = e.target.closest("[data-a]")?.dataset.a;
  if (!a) return;
  const sel = wsp.sel;
  const base = sel ? (sel.endsWith("/") ? sel : wspDir(sel)) : "";
  if (a === "newfile") { wsp.ask = { kind: "newfile", label: "new file path", verb: "create", value: base }; wspInspect(); }
  else if (a === "newdir") { wsp.ask = { kind: "newdir", label: "new folder path", verb: "create", value: base }; wspInspect(); }
  else if (a === "rename") { wsp.ask = { kind: "rename", label: "new path", verb: "move", value: sel }; wspInspect(); }
  else if (a === "refresh") wsRefresh(true);
  else if (a === "delete") wspDelete(sel);
  else if (a === "edit") wspEdit(sel);
  else if (a === "entry") { wsp.entry = wspEntry() === sel && wsp.entry === sel ? "" : sel; wsp.page = ""; wspSave(); wspRenderTree(); wspInspect(); wspBuild(); }
  else if (a === "download") wspDownload(sel);
});
async function wspEdit(path, reload = false, at = null) {
  wspGuard(async () => {
    wsp.sel = path; wsp.editing = path; wsp.dirty = false; wsp.buffer = null; wsp.stale = null; wsp.ask = null;
    const f = wsFiles.find((x) => x.path === path);
    if (reload || !f || wsp.cache.get(path)?.sig !== wspSig(f)) {
      try { const r = await wsReadFull(path); wsp.cache.set(path, { sig: f ? wspSig(f) : "", sha: r.sha256, content: r.content ?? "", binary: Boolean(r.binary), mime: r.mime || "" }); }
      catch (e) { toast("open failed: " + e.message, true); return; }
    }
    wspRenderTree(); wspInspect(); wspRenderEditor(true); wspTab("edit");
    const ed = $("#wi-ed");
    if (!ed) return;
    if (!at?.line) { ed.setSelectionRange(0, 0); ed.focus(); ed.scrollTop = ed.scrollLeft = 0; return; }
    const lines = ed.value.split("\n");
    const n = Math.min(Math.max(1, at.line), lines.length);
    const start = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
    ed.focus();
    ed.setSelectionRange(start + Math.max(0, Math.min((at.col || 1) - 1, lines[n - 1].length)), start + lines[n - 1].length);
    const lh = parseFloat(getComputedStyle(ed).lineHeight) || 18;
    ed.scrollTop = Math.max(0, (n - 4) * lh);
  });
}
async function wspSaveFile() {
  const path = wsp.editing;
  const ed = $("#wi-ed");
  if (!path || !ed) return;
  try {
    const sha = wsp.cache.get(path)?.sha;
    const r = await wsExec("fs_write", { path, content: ed.value, ...(sha && wsp.stale !== path ? { expect_sha256: sha } : {}) });
    wsp.dirty = false; wsp.buffer = null; wsp.stale = null;
    wsp.cache.set(path, { sig: "", sha: r.sha256, content: ed.value, binary: false, mime: wsp.cache.get(path)?.mime || "" });
    const d = r.diagnostics?.[0];
    toast(`saved ${path} · ${r.bytes} B${d ? ` · ${r.diagnostics.length} problem${r.diagnostics.length > 1 ? "s" : ""}: line ${d.line}: ${d.message}` : ""}`, Boolean(d && d.severity === "error"));
    // Re-run the app behind the editor so the console reflects the save.
    await (wsp.live ? wspProbe() : wsRefresh(true));
    wspInspect();
  } catch (e) {
    // Someone (usually the agent) changed the file after it was opened: keep the buffer, flag it stale.
    if (/changed since you read it/.test(e.message)) { wsp.stale = path; wspInspect(); toast(`${path} changed on the server since you opened it — save again to overwrite, or revert to load it`, true); return; }
    toast("save failed: " + e.message, true);
  }
}
async function wspMove(from, to) {
  const r = await wsExec("fs_read", { path: from, encoding: "auto", limit: 5000 });
  const full = !r.binary && r.truncated ? await wsReadFull(from) : r;
  await wsExec("fs_write", { path: to, content: full.content ?? "", ...(full.binary ? { encoding: "base64" } : {}) });
  await wsExec("fs_delete", { path: from });
  if (wsp.entry === from) wsp.entry = to;
}
async function wspAskApply() {
  const ask = wsp.ask;
  const v = ($("#wi-in")?.value ?? "").trim().replace(/^\/+/, "");
  if (!ask) return;
  try {
    if (ask.kind === "newfile") {
      if (!v || v.endsWith("/")) { toast("name the file", true); return; }
      if (wsFiles.some((f) => f.path === v)) { toast(`${v} already exists`, true); return; }
      await wsExec("fs_write", { path: v, content: "" });
      wsp.ask = null;
      await wsRefresh(true);
      wspEdit(v);
    } else if (ask.kind === "newdir") {
      const dir = v.replace(/\/+$/, "");
      if (!dir) { toast("name the folder", true); return; }
      await wsExec("fs_write", { path: dir + "/.gitkeep", content: "" });
      wsp.ask = null; wsp.collapsed.delete(dir + "/"); wsp.sel = dir + "/";
      await wsRefresh(true);
      wspInspect();
    } else if (ask.kind === "rename") {
      const from = ask.value;
      if (!v || v === from) { wsp.ask = null; wspInspect(); return; }
      if (from.endsWith("/")) {
        const to = v.replace(/\/*$/, "/");
        const moving = wsFiles.filter((f) => f.path.startsWith(from));
        if (moving.some((f) => wsFiles.some((g) => g.path === to + f.path.slice(from.length)))) { toast("target folder has clashing files", true); return; }
        $("#wsp-stat").textContent = `moving ${moving.length} files…`;
        if (wsp.editing?.startsWith(from) && wsp.dirty) await wsExec("fs_write", { path: wsp.editing, content: $("#wi-ed").value });
        for (const f of moving) await wspMove(f.path, to + f.path.slice(from.length));
        if (wsp.editing?.startsWith(from)) {
          const moved = to + wsp.editing.slice(from.length);
          wsp.cache.set(moved, { ...wsp.cache.get(wsp.editing), content: $("#wi-ed")?.value ?? wsp.cache.get(wsp.editing)?.content ?? "", sig: "" });
          wsp.editing = moved; wsp.dirty = false; wsp.buffer = null;
        }
        wsp.sel = to;
      } else {
        if (wsFiles.some((f) => f.path === v)) { toast(`${v} already exists`, true); return; }
        const text = wsp.editing === from ? $("#wi-ed")?.value : null;
        if (text != null && wsp.dirty) await wsExec("fs_write", { path: from, content: text });
        await wspMove(from, v);
        if (wsp.editing === from) { wsp.cache.set(v, { ...wsp.cache.get(from), content: text ?? wsp.cache.get(from)?.content ?? "", sig: "" }); wsp.editing = v; }
        wsp.dirty = false; wsp.buffer = null;
        wsp.sel = v;
      }
      wsp.ask = null;
      wspSave();
      await wsRefresh(true);
      wspInspect();
    }
  } catch (e) { toast(`${ask.kind} failed: ${e.message}`, true); }
}
function wspDelete(path) {
  if (!path) return;
  const files = path.endsWith("/") ? wsFiles.filter((f) => f.path.startsWith(path)) : wsFiles.filter((f) => f.path === path);
  if (!files.length) return;
  confirmDialog(`Delete ${path}${files.length > 1 ? ` (${files.length} files)` : ""}? This cannot be undone.`, async () => {
    try {
      for (let i = 0; i < files.length; i += 16) {
        const d = await req("/v1/tools/execute", { method: "POST", admin: true, body: { calls: files.slice(i, i + 16).map((f) => ({ name: "fs_delete", arguments: { path: f.path } })) } });
        const bad = (d.results ?? []).find((r) => !r.ok);
        if (bad) throw new Error(bad.error || bad.code || "fs_delete failed");
      }
      if (wsp.editing && files.some((f) => f.path === wsp.editing)) { wsp.editing = null; wsp.dirty = false; }
      wsp.sel = null;
      await wsRefresh(true);
      wspInspect();
    } catch (e) { toast("delete failed: " + e.message, true); wsRefresh(true); }
  }, "Delete");
}
async function wspDownload(path) {
  try {
    const f = wsp.cache.get(path) ?? await wsReadFull(path);
    const blob = f.binary ? new Blob([Uint8Array.from(atob(f.content), (ch) => ch.charCodeAt(0))], { type: f.mime || "application/octet-stream" }) : new Blob([wsp.editing === path ? $("#wi-ed").value : f.content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = path.split("/").pop() || "file";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { toast("download failed: " + e.message, true); }
}

// ---- file snapshots ------------------------------------------------------------
function wspOnFiles() {
  if (!wsp.open) return;
  const sigs = new Map(wsFiles.map((f) => [f.path, wspSig(f)]));
  const sig = [...sigs].map(([p, s]) => p + "=" + s).sort().join("|");
  if (sig !== wsp.sig) {
    if (wsp.sigs) for (const [p, s] of sigs) if (wsp.sigs.get(p) !== s) {
      wsp.flash.add(p);
      if (p === wsp.editing) { if (wsp.dirty) wsp.stale = p; else wsp.reloadEditor = true; }
    }
    wsp.sig = sig;
    wsp.sigs = sigs;
    if (wsp.live) wspSchedule();
  }
  wspRenderTree();
  if (wsp.reloadEditor) { wsp.reloadEditor = false; wspEdit(wsp.editing, true); }
  else if (!wsp.editing || wsp.stale) wspInspect();
}

// ---- layout ----------------------------------------------------------------------
const wspSupported = () => matchMedia("(min-width: 900px)").matches;
function wspSave() {
  store.set("wsp", { open: wsp.open, entry: wsp.entry, live: wsp.live, vp: wsp.vp, chat: wsp.chat, tree: wsp.tree, treeH: wsp.treeH, con: wsp.con, collapsed: [...wsp.collapsed] });
}
function wspLayout() {
  const view = $("#v-chat");
  view.style.setProperty("--chat-w", (wsp.chat * 100).toFixed(2) + "%");
  view.style.setProperty("--tree-w", wsp.tree + "px");
  view.style.setProperty("--tree-h", (wsp.treeH * 100).toFixed(2) + "%");
  view.style.setProperty("--con-h", wsp.con + "px");
  wspPanes();
  const stage = $("#wsp-stage");
  if (wsp.vp === "auto") { delete stage.dataset.vp; stage.style.removeProperty("--vp"); }
  else { stage.dataset.vp = wsp.vp; stage.style.setProperty("--vp", wsp.vp + "px"); }
  $("#wsp-vp").value = wsp.vp;
  $("#wsp-live").setAttribute("aria-pressed", String(wsp.live));
}
function wspShow(on) {
  wsp.open = on;
  $("#v-chat").classList.toggle("wsp-on", on);
  $("#wsp").hidden = $("#wsp-split").hidden = !on;
  wspSave();
  // A folded chat only makes sense beside the workspace.
  if (!on) { wsWatch(false); $("#wsp-frame").srcdoc = ""; foldSet($("#chat-col"), false); return; }
  wspLayout();
  wsp.sig = "";
  wsWatch(true);
  wspRenderTree();
  wspInspect();
  wsRefresh(true).then(() => { if (!wsp.live) wspBuild(); });
}
// Chrome hit-tests out-of-process frames (the sandboxed live view) against the
// last compositor frame, so a shield added on press can lose the first moves
// and the release to the iframe. Frames are muted from hover on (arm), a
// full-viewport shield plus capture owns the drag, and a move with no button
// held ends a drag whose release was lost.
const wspW = () => $("#v-chat").clientWidth;
splitter($("#wsp-split"), {
  axis: "x",
  get: () => $(".chat", $("#v-chat")).getBoundingClientRect().width,
  set: (px) => { wsp.chat = px / wspW(); },
  min: () => 300, max: () => wspW() - 385,
  reset: () => { wsp.chat = 0.44; },
});
splitter($("#wsp-split-2"), {
  axis: "x",
  get: () => wsp.tree,
  set: (px) => { wsp.tree = px; },
  min: () => 150, max: () => Math.max(150, $("#wsp").clientWidth - 225),
  reset: () => { wsp.tree = 260; },
});
splitter($("#wsp-split-y"), {
  axis: "y",
  get: () => $("#wsp-tree").getBoundingClientRect().height,
  set: (px) => { wsp.treeH = px / Math.max(1, $("#wsp-left").clientHeight); },
  min: () => 48, max: () => Math.max(48, $("#wsp-left").clientHeight - 53),
  reset: () => { wsp.treeH = 0.58; },
});
// The console's top edge resizes it too: drag the header.
$("#wsp-con-h").addEventListener("pointerdown", (e) => {
  if ($("#wsp-con-b").hidden || e.button !== 0 || e.target.id === "wsp-con-clr" || e.target.id === "wsp-con-fix") return;
  const y0 = e.clientY, h0 = wsp.con, h = e.currentTarget;
  let moved = false;
  e.preventDefault();
  dragShield("y", (ev) => {
    if (Math.abs(ev.clientY - y0) > 3) moved = true;
    wsp.con = Math.round(Math.min(innerHeight * 0.7, Math.max(60, h0 - (ev.clientY - y0))));
    wspLayout();
  }, () => {
    if (!moved) return;
    wspSave();
    // A resize is not a toggle: swallow the click that follows the release.
    const swallow = (ev) => ev.stopImmediatePropagation();
    h.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => h.removeEventListener("click", swallow, { capture: true }), 0);
  }, h, e.pointerId);
});
armSplit($("#wsp-con-h"));

$("#wsp-entry").addEventListener("change", (e) => { wsp.entry = e.target.value; wsp.page = ""; wspSave(); wspRenderTree(); wspInspect(); wspBuild(); });
$("#wsp-reload").addEventListener("click", () => { wsp.cache.clear(); wsRefresh(true).then(wspBuild); });
$("#wsp-live").addEventListener("click", () => { wsp.live = !wsp.live; wspLayout(); wspSave(); if (wsp.live) wspBuild(); });
$("#wsp-vp").addEventListener("change", (e) => { wsp.vp = e.target.value; wspLayout(); wspSave(); });
$("#wsp-pop").addEventListener("click", async () => {
  if (wsp.tab === "preview") { if (wsp.doc) launchAppSandbox(wsp.doc, wsp.page || wspEntry()); else toast("nothing built yet", true); return; }
  try { const r = await wspDocNow(); if (r) launchAppSandbox(r.doc, r.page); else toast("no entry point", true); }
  catch (e) { toast("build failed: " + e.message, true); }
});
$("#wsp-more").addEventListener("click", () => wsDrawerOpen());
$("#wsp-close").addEventListener("click", () => wspGuard(() => { wsp.editing = null; wspShow(false); }));
addEventListener("resize", () => { if (wsp.open && !wspSupported()) wspShow(false); });
addEventListener("beforeunload", (e) => { if (wsp.dirty) e.preventDefault(); });
setTimeout(() => { if (wsp.open && wspSupported()) wspShow(true); else wsp.open = false; }, 0);

async function wsOpen(path) {
  wsCur = path;
  $("#ws-editor-wrap").hidden = false;
  $("#ws-cur-path").textContent = path;
  $("#ws-stat").textContent = "loading…";
  try {
    const read = await wsReadFull(path);
    if (read.binary) {
      $("#ws-editor").value = "";
      $("#ws-editor").disabled = true;
      $("#ws-stat").textContent = `binary file (${read.bytes} B) — not editable here`;
    } else {
      $("#ws-editor").disabled = false;
      $("#ws-editor").value = read.content ?? "";
      $("#ws-stat").textContent = `${read.bytes} B`;
    }
  } catch (e) { $("#ws-stat").textContent = "open failed: " + e.message; }
  const tp = $("#ws-transpile");
  if (tp) tp.hidden = !/\.(ts|tsx|jsx|mts)$/i.test(path);
  renderWsFiles();
}

$("#ws-files")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-ws-open]");
  if (b) wsOpenAny(b.dataset.wsOpen);
});
$("#ws-refresh")?.addEventListener("click", wsRefresh);
$("#ws-analyze")?.addEventListener("click", () => analyzeWorkspace());
// ---- rename / move + folders ----------------------------------------------
// There is no fs_move tool: a rename is write-new + delete-old through
// the plane, using the editor buffer so unsaved edits move with the
// file. The activity feed reports it as a create + delete pair.
$("#ws-rename")?.addEventListener("click", () => {
  if (!wsCur) return;
  $("#ws-rename-input").value = wsCur;
  $("#ws-rename-row").hidden = false;
  $("#ws-rename-input").focus();
});
$("#ws-rename-cancel")?.addEventListener("click", () => { $("#ws-rename-row").hidden = true; });
$("#ws-rename-apply")?.addEventListener("click", async () => {
  const from = wsCur;
  const to = $("#ws-rename-input").value.trim().replace(/^\/+/, "");
  if (!from || !to || to === from) { $("#ws-rename-row").hidden = true; return; }
  if (wsFiles.some((f) => f.path === to)) { toast(`"${to}" already exists`, true); return; }
  try {
    await wsExec("fs_write", { path: to, content: $("#ws-editor").value });
    await wsExec("fs_delete", { path: from });
    wsCur = to;
    $("#ws-cur-path").textContent = to;
    $("#ws-rename-row").hidden = true;
    toast(`Moved ${from} → ${to}`);
    wsRefresh();
    renderWsFiles();
  } catch (e) { toast("Rename failed: " + e.message, true); }
});
$("#ws-folder-btn")?.addEventListener("click", async () => {
  const name = $("#ws-new-name").value.trim().replace(/^\/+|\/+$/g, "");
  if (!name) { toast("Type a folder name in the new-file box first", true); return; }
  try {
    await wsExec("fs_write", { path: name + "/.gitkeep", content: "" });
    $("#ws-new-name").value = "";
    toast(`Folder ${name}/ created`);
    wsRefresh();
  } catch (e) { toast("Folder create failed: " + e.message, true); }
});

$("#ws-transpile")?.addEventListener("click", async () => {
  if (!wsCur) return;
  const target = wsCur.replace(/\.(tsx?|jsx|mts)$/i, ".js");
  toast(`Transpiling ${wsCur}…`);
  const r = await sbxTranspile($("#ws-editor").value, wsCur);
  if (r.error) { toast("Transpile failed: " + r.error, true); return; }
  try {
    await wsExec("fs_write", { path: target, content: r.code });
    toast(`Transpiled → ${target}`);
    wsRefresh();
  } catch (e) { toast("Transpile write failed: " + e.message, true); }
});
$("#ws-new-btn")?.addEventListener("click", async () => {
  const name = $("#ws-new-name").value.trim().replace(/^\/+/, "");
  if (!name) { toast("name the new file first", true); return; }
  try {
    await wsExec("fs_write", { path: name, content: "" });
    $("#ws-new-name").value = "";
    await wsRefresh();
    wsOpenAny(name);
  } catch (e) { toast("create failed: " + e.message, true); }
});
$("#ws-save")?.addEventListener("click", async () => {
  if (!wsCur) return;
  $("#ws-stat").textContent = "saving…";
  try {
    const r = await wsExec("fs_write", { path: wsCur, content: $("#ws-editor").value });
    $("#ws-stat").textContent = `saved · ${r.bytes} B`;
    wsRefresh();
  } catch (e) { $("#ws-stat").textContent = "save failed: " + e.message; }
});
// Run the workspace project, not just the open buffer: an HTML file's
// relative <link>/<script src> references are inlined from the workspace
// (marked with data-sbx so debug origins name the real file, and with
// data-sbx-ts when the sibling is TypeScript), and a JS/TS file runs
// wrapped as its own app so it transpiles and debugs under its own name.
async function wsRunProject() {
  if (!wsCur) return;
  const code = $("#ws-editor").value;
  const dir = wsCur.includes("/") ? wsCur.slice(0, wsCur.lastIndexOf("/") + 1) : "";
  if (/\.(tsx?|jsx|mjs)$/i.test(wsCur)) {
    const isTs = /\.(tsx?|mts)$/i.test(wsCur) || /\.jsx$/i.test(wsCur);
    const tag = "<" + "script" + ` data-sbx="${esc(wsCur)}"${isTs ? ' data-sbx-ts="1"' : ""}>\n${code.replace(/<\/script/gi, "<\\/script")}\n` + "<" + "/script>";
    launchAppSandbox(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(wsCur)}</title></head><body>${tag}</body></html>`, wsCur);
    return;
  }
  if (!/\.html?$/i.test(wsCur)) { toast("Run works for HTML and JS/TS files", true); return; }
  const missing = [];
  const resolveRef = (ref) => {
    if (/^(https?:)?\/\//i.test(ref) || ref.startsWith("data:") || ref.startsWith("/")) return null;
    return dir + ref.replace(/^\.\//, "");
  };
  const readSibling = async (path) => {
    try { const r = await wsExec("fs_read", { path }); return r.binary ? null : (r.content ?? ""); }
    catch { return null; }
  };
  let doc = code;
  // script srcs, replaced back-to-front so offsets stay valid
  const sRe = /<[s]cript([^>]*?)src=["']([^"']+)["']([^>]*)>\s*<\/[s]cript>/gi;
  const sTags = [];
  let sm;
  while ((sm = sRe.exec(code))) sTags.push({ full: sm[0], src: sm[2], at: sm.index });
  for (let i = sTags.length - 1; i >= 0; i--) {
    const t = sTags[i];
    const path = resolveRef(t.src);
    if (!path) continue;
    const content = await readSibling(path);
    if (content === null) { missing.push(t.src); continue; }
    const isTs = /\.(tsx?|mts)$/i.test(path) || /\.jsx$/i.test(path);
    const tag = "<" + "script" + ` data-sbx="${esc(path)}"${isTs ? ' data-sbx-ts="1"' : ""}>\n${content.replace(/<\/script/gi, "<\\/script")}\n` + "<" + "/script>";
    doc = doc.slice(0, t.at) + tag + doc.slice(t.at + t.full.length);
  }
  // stylesheet links
  const lRe = /<link[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const lTags = [];
  let lm;
  while ((lm = lRe.exec(doc))) lTags.push({ full: lm[0], href: lm[1], at: lm.index });
  for (let i = lTags.length - 1; i >= 0; i--) {
    const t = lTags[i];
    if (!/\.css($|\?)/i.test(t.href)) continue;
    const path = resolveRef(t.href);
    if (!path) continue;
    const content = await readSibling(path);
    if (content === null) { missing.push(t.href); continue; }
    doc = doc.slice(0, t.at) + `<style data-sbx="${esc(path)}">\n${content}\n</style>` + doc.slice(t.at + t.full.length);
  }
  if (missing.length) toast("Not in the workspace (left as-is): " + missing.join(", "));
  launchAppSandbox(doc, wsCur);
}

$("#ws-run")?.addEventListener("click", () => { if (wsCur) wsRunProject(); });
$("#ws-dl")?.addEventListener("click", () => {
  if (!wsCur) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([$("#ws-editor").value], { type: "text/plain" }));
  a.download = wsCur.split("/").pop() || "file.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
$("#ws-del")?.addEventListener("click", async () => {
  if (!wsCur) return;
  try {
    await wsExec("fs_delete", { path: wsCur });
    toast(`deleted ${wsCur}`);
    wsCur = null;
    $("#ws-editor-wrap").hidden = true;
    wsRefresh();
  } catch (e) { toast("delete failed: " + e.message, true); }
});

