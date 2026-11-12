// conversation library: named snapshots of the one live conversation.
// The router is the durable home (/v1/conversations); the localStorage
// library stays as cache and offline fallback, and entries that exist
// only locally are marked as such instead of claiming a save happened.
let convRemote = null; // server snapshot list; null while unknown/unreachable
const localLib = () => store.get("chat_library", []);
function convListMerged() {
  const byId = new Map();
  for (const c of localLib()) byId.set(c.id, { ...c, localOnly: true });
  for (const it of convRemote ?? []) {
    const ex = byId.get(it.id);
    byId.set(it.id, { id: it.id, title: it.title, saved: it.saved, count: it.count, session: ex?.session, messages: ex?.messages, localOnly: false });
  }
  return [...byId.values()].sort((a, b) => (b.saved || 0) - (a.saved || 0));
}
function paintConvList() {
  const box = $("#ws-convs");
  if (!box) return;
  const list = convListMerged();
  if (!list.length) { box.innerHTML = `<div class="dim" style="font-size:12px">No saved conversations yet.</div>`; return; }
  box.innerHTML = list.map((c) => `<div class="row" style="gap:6px;border:1px solid var(--line);border-radius:10px;padding:7px 9px">
    <div style="min-width:0"><div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.title || "Conversation")}</div>
    <div class="dim" style="font-size:10.5px">${c.count ?? (c.messages ?? []).length} messages · ${esc(new Date(c.saved || 0).toLocaleString())}${c.localOnly ? " · local only" : ""}</div></div>
    <span class="grow"></span>
    <button class="btn q" data-conv-load="${esc(c.id)}" style="font-size:10.5px;padding:2px 8px">Load</button>
    <button class="btn q" data-conv-del="${esc(c.id)}" style="font-size:10.5px;padding:2px 8px">Delete</button>
  </div>`).join("");
}
async function refreshConvList() {
  try { const d = await req("/v1/conversations"); convRemote = d.items ?? []; }
  catch { convRemote = null; }
  paintConvList();
}
function renderWsConvs() { paintConvList(); refreshConvList(); }
$("#ws-save-conv")?.addEventListener("click", async () => {
  if (!conv.messages.length) { toast("the current conversation is empty", true); return; }
  const first = conv.messages.find((m) => m.role === "user");
  const title = (typeof first?.content === "string" ? first.content : "Conversation").slice(0, 60) || "Conversation";
  const snap = { id: "c" + Date.now().toString(36), title, saved: Date.now(), session: sessionId(), messages: persistedConv().messages };
  const cacheLocally = () => { const lib = localLib(); lib.unshift(snap); return store.set("chat_library", lib.slice(0, 30)); };
  try {
    const r = await req("/v1/conversations", { method: "POST", body: { id: snap.id, title: snap.title, saved: snap.saved, messages: snap.messages, session: snap.session } });
    if (r?.id) snap.id = r.id;
    cacheLocally();
    if (convRemote) convRemote.unshift({ id: snap.id, title: snap.title, saved: snap.saved, count: snap.messages.length });
    renderWsConvs();
    toast("conversation saved to the library");
  } catch {
    if (cacheLocally()) { renderWsConvs(); toast("saved locally only — server unreachable", true); }
    else toast("conversation could not be saved — storage full and server unreachable", true);
  }
});
$("#ws-convs")?.addEventListener("click", async (e) => {
  const load = e.target.closest("[data-conv-load]");
  if (load) {
    const id = load.dataset.convLoad;
    let item = null;
    try { item = await req("/v1/conversations/" + encodeURIComponent(id)); } catch { /* fall back to the local copy */ }
    if (!item || !Array.isArray(item.messages)) item = localLib().find((c) => c.id === id) ?? null;
    if (!item) { toast("conversation not found", true); return; }
    conv.messages = JSON.parse(JSON.stringify(item.messages ?? []));
    conv.savedAt = item.saved || Date.now();
    saveConv(); renderThread(); updateModelHint();
    if (item.session) switchChatSession(item.session);
    closeSheets(); go("chat");
    toast("conversation loaded");
    return;
  }
  const del = e.target.closest("[data-conv-del]");
  if (del) {
    const id = del.dataset.convDel;
    store.set("chat_library", localLib().filter((c) => c.id !== id));
    if (convRemote) convRemote = convRemote.filter((c) => c.id !== id);
    try { await req("/v1/conversations/" + encodeURIComponent(id), { method: "DELETE" }); } catch { /* the local removal stands */ }
    renderWsConvs();
  }
});

// GitHub sync (Contents API; token stays in this browser)
function ghCfg() { return store.get("gh", { repo: "", branch: "main", token: "" }); }
function ghSave() { store.set("gh", { repo: $("#gh-repo").value.trim(), branch: $("#gh-branch").value.trim() || "main", token: $("#gh-token").value }); }
function ghLoad() { const c = ghCfg(); $("#gh-repo").value = c.repo || ""; $("#gh-branch").value = c.branch || "main"; $("#gh-token").value = c.token || ""; }
for (const id of ["#gh-repo", "#gh-branch", "#gh-token"]) $(id)?.addEventListener("change", ghSave);
const ghPath = (path) => path.split("/").map(encodeURIComponent).join("/");
async function ghApi(path, opts = {}) {
  const { token } = ghCfg();
  const res = await fetch("https://api.github.com" + path, { ...opts, headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.status === 204 ? null : res.json();
}
function b64encodeText(str) { const bytes = new TextEncoder().encode(str); let bin = ""; for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(bin); }
function b64decodeText(b) { const bin = atob(String(b).replace(/\s/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); }

$("#gh-push")?.addEventListener("click", async () => {
  ghSave();
  const { repo, branch } = ghCfg();
  const stat = $("#gh-stat");
  if (!repo.includes("/")) { stat.textContent = "set owner/repo first"; return; }
  stat.textContent = "pushing…";
  try {
    const list = await wsExec("fs_list", { limit: 200 });
    let done = 0, skipped = 0;
    for (const file of list.files ?? []) {
      if (file.bytes > 900000) { skipped++; continue; }
      const read = await wsExec("fs_read", { path: file.path });
      if (read.binary) { skipped++; continue; }
      let sha;
      try { sha = (await ghApi(`/repos/${repo}/contents/${ghPath(file.path)}?ref=${encodeURIComponent(branch)}`)).sha; } catch { /* new file */ }
      await ghApi(`/repos/${repo}/contents/${ghPath(file.path)}`, { method: "PUT", body: JSON.stringify({ message: "sync from kono workspace", branch, content: b64encodeText(read.content ?? ""), ...(sha ? { sha } : {}) }) });
      done++;
      stat.textContent = `pushing… ${done}`;
    }
    stat.textContent = `pushed ${done} file(s)${skipped ? `, skipped ${skipped} (binary or too large)` : ""}`;
    toast("workspace pushed to GitHub");
  } catch (e) { stat.textContent = "push failed: " + e.message; }
});
$("#gh-pull")?.addEventListener("click", async () => {
  ghSave();
  const { repo, branch } = ghCfg();
  const stat = $("#gh-stat");
  if (!repo.includes("/")) { stat.textContent = "set owner/repo first"; return; }
  stat.textContent = "pulling…";
  try {
    const tree = await ghApi(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const blobs = (tree.tree ?? []).filter((n) => n.type === "blob").slice(0, 100);
    let done = 0, skipped = 0;
    for (const node of blobs) {
      if ((node.size ?? 0) > 512000) { skipped++; continue; }
      const file = await ghApi(`/repos/${repo}/contents/${ghPath(node.path)}?ref=${encodeURIComponent(branch)}`);
      if (file.encoding !== "base64" || typeof file.content !== "string") { skipped++; continue; }
      await wsExec("fs_write", { path: node.path, content: b64decodeText(file.content) });
      done++;
      stat.textContent = `pulling… ${done}`;
    }
    stat.textContent = `pulled ${done} file(s)${skipped ? `, skipped ${skipped}` : ""}`;
    wsRefresh();
    toast("workspace pulled from GitHub");
  } catch (e) { stat.textContent = "pull failed: " + e.message; }
});

// local development: zip export (store-only, no compression library needed)
function crc32(bytes) {
  let t = crc32.t;
  if (!t) { t = crc32.t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } }
  let c = ~0;
  for (const b of bytes) c = t[(c ^ b) & 255] ^ (c >>> 8);
  return (~c) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const push = (u8) => { parts.push(u8); offset += u8.length; };
  const u16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const cat = (...arrs) => { const out = new Uint8Array(arrs.reduce((a, x) => a + x.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.bytes);
    const localOffset = offset;
    push(cat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(file.bytes.length), u32(file.bytes.length), u16(name.length), u16(0), name));
    push(file.bytes);
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(file.bytes.length), u32(file.bytes.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset), name));
  }
  const cdStart = offset;
  for (const c of central) push(c);
  push(cat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(offset - cdStart), u32(cdStart), u16(0)));
  return new Blob(parts, { type: "application/zip" });
}
$("#ws-zip")?.addEventListener("click", async () => {
  try {
    const list = await wsExec("fs_list", { limit: 200 });
    const files = [];
    for (const file of list.files ?? []) {
      const read = await wsExec("fs_read", { path: file.path });
      if (read.binary) continue;
      files.push({ name: file.path, bytes: new TextEncoder().encode(read.content ?? "") });
    }
    if (!files.length) { toast("workspace is empty", true); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipStore(files));
    a.download = "kono-workspace.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`downloaded ${files.length} file(s)`);
  } catch (e) { toast("zip failed: " + e.message, true); }
});
$("#ws-import-btn")?.addEventListener("click", () => $("#ws-import").click());
$("#ws-import")?.addEventListener("change", async (e) => {
  const files = [...(e.target.files ?? [])];
  e.target.value = "";
  let done = 0;
  for (const file of files) {
    try { await wsExec("fs_write", { path: file.name, content: await file.text() }); done++; } catch { /* counted below */ }
  }
  toast(done ? `imported ${done} file(s) into the workspace` : "nothing imported", !done);
  wsRefresh();
});

// ---- workspace intelligence -------------------------------------------------
// A read-only analysis pass over the real workspace: structure,
// endpoints, dependencies, tests, loose ends, and a checklist of the
// things a healthy project has. Everything shown is computed from the
// files themselves — no invented grades.
async function analyzeWorkspace() {
  const box = $("#ws-intel");
  const stat = $("#ws-intel-stat");
  if (!box) return;
  stat.textContent = "analyzing…";
  try {
    const list = await wsExec("fs_list", { limit: 200 });
    const files = list.files ?? [];
    wsFiles = files;
    diffWsFiles(files);
    const readable = files.filter((file) => !/\.(png|jpe?g|gif|webp|ico|woff2?|mp4|zip|pdf)$/i.test(file.path) && file.bytes <= 256000).slice(0, 40);
    const contents = new Map();
    for (const file of readable) {
      try { const r = await wsExec("fs_read", { path: file.path }); if (!r.binary && typeof r.content === "string") contents.set(file.path, r.content); } catch { /* skip unreadable */ }
    }
    const folders = new Set(files.map((file) => file.path.split("/").slice(0, -1).join("/")).filter(Boolean));
    const endpoints = [];
    const epRe = /\b(get|post|put|delete|patch)\(\s*["'`]([^"'`\s]+)["'`]/gi;
    const fetchRe = /fetch\(\s*["'`](\/[^"'`\s]+)["'`]/g;
    for (const text of contents.values()) {
      let m;
      while ((m = epRe.exec(text))) endpoints.push(m[1].toUpperCase() + " " + m[2]);
      while ((m = fetchRe.exec(text))) endpoints.push("CALL " + m[1]);
      epRe.lastIndex = 0; fetchRe.lastIndex = 0;
    }
    let deps = [];
    if (contents.has("package.json")) {
      try { const pkg = JSON.parse(contents.get("package.json")); deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]; } catch { /* fall through to import scan */ }
    }
    if (!deps.length) {
      const found = new Set();
      const impRe = /(?:from|import)\s+["']([^"'.][^"']*)["']/g;
      for (const text of contents.values()) { let m; while ((m = impRe.exec(text))) found.add(m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0]); impRe.lastIndex = 0; }
      deps = [...found].slice(0, 24);
    }
    const tests = files.filter((file) => /(^|\/)(tests?|__tests__)\//i.test(file.path) || /\.(test|spec)\.[a-z]+$/i.test(file.path));
    let todoCount = 0;
    try { const g = await wsExec("fs_grep", { pattern: "TODO|FIXME", limit: 200 }); todoCount = g.count ?? 0; } catch { /* optional */ }
    const has = (re) => files.some((file) => re.test(file.path));
    const checks = [
      ["files in the workspace", files.length > 0],
      ["README present", has(/readme\.md$/i)],
      ["project manifest (package.json / deno.json)", has(/(package|deno)\.json$/i)],
      ["tests present", tests.length > 0],
      ["builder config recorded (.appbuilder/config.json)", has(/\.appbuilder\/config\.json$/)],
      ["architecture decisions recorded (docs/adr/)", has(/^docs\/adr\//)],
    ];
    const passed = checks.filter((c) => c[1]).length;
    const chip = (label, val) => `<span class="wb-kpi-chip">${label}: <b>${val}</b></span>`;
    const epShown = endpoints.slice(0, 12).map((e) => `<div style="font-family:ui-monospace,monospace;font-size:11px">${esc(e)}</div>`).join("");
    box.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">${chip("files", files.length)}${chip("folders", folders.size)}${chip("endpoints", endpoints.length)}${chip("dependencies", deps.length)}${chip("test files", tests.length)}${chip("TODO/FIXME", todoCount)}${chip("checklist", passed + "/" + checks.length)}</div>
      <div style="display:grid;gap:2px;margin-bottom:8px">${checks.map((c) => `<div style="font-size:12px" class="${c[1] ? "" : "dim"}">${c[1] ? "✓" : "✗"} ${esc(c[0])}</div>`).join("")}</div>
      ${endpoints.length ? `<div class="lbl" style="margin-bottom:4px">Endpoints</div>${epShown}${endpoints.length > 12 ? `<div class="dim" style="font-size:11px">+${endpoints.length - 12} more</div>` : ""}` : ""}
      ${deps.length ? `<div class="lbl" style="margin:8px 0 4px">Dependencies</div><div style="font-size:12px">${deps.map((d) => esc(d)).join(" · ")}</div>` : ""}
      ${folders.size ? `<div class="lbl" style="margin:8px 0 4px">Folders</div><div style="font-size:12px">${[...folders].slice(0, 14).map((f) => esc(f) + "/").join(" · ")}${folders.size > 14 ? " · …" : ""}</div>` : ""}`;
    stat.textContent = `analyzed ${contents.size} readable file(s) of ${files.length} · just now`;
    renderWsFiles();
  } catch (e) {
    stat.textContent = "analysis failed: " + (e.message || e);
  }
}

// The workspace opens as the split pane beside the chat; narrow screens and
// the project menu (intelligence, conversations, GitHub, zip) use the drawer.
function openWorkspace(path) {
  if (!wspSupported()) { wsDrawerOpen(); if (path) wsOpen(path); return; }
  closeSheets();
  go("chat");
  if (!wsp.open) wspShow(true);
  foldSet($("#wsp"), false);
  if (path) { foldSet($("#wsp-left"), false); path.endsWith("/") ? wspSelect(path) : wspEdit(path); }
}
// Desktop: drawer files open in the docked editor beside the tree; phones keep the drawer editor.
const wsOpenAny = (path) => wspSupported() ? openWorkspace(path) : wsOpen(path);
function wsDrawerOpen() {
  wsWatch(true);
  ghLoad();
  renderWsConvs();
  openSheet(wsDrawer);
  wsRefresh();
}

wsDrawer?.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheets(); });
$("#ws-open-builder")?.addEventListener("click", () => openAppBuilder());
cmd("workspace", () => openWorkspace(), "builder");

// Model selector in the chat tab itself, two-way synced with Settings.
const cmodelEl = $("#cmodel");
if (cmodelEl) {
  cmodelEl.value = $("#pmodel").value;
  cmodelEl.addEventListener("input", () => { $("#pmodel").value = cmodelEl.value; saveParams(); });
  cmodelEl.addEventListener("change", () => { if (!cmodelEl.value.trim()) cmodelEl.value = "free:auto"; $("#pmodel").value = cmodelEl.value; saveParams(); updateModelHint(); });
  $("#pmodel").addEventListener("input", () => { if (cmodelEl.value !== $("#pmodel").value) cmodelEl.value = $("#pmodel").value; });
}
const amodelEl = $("#amodel");
if (amodelEl) {
  amodelEl.value = store.get("amodel", "free:smart");
  amodelEl.addEventListener("change", () => store.set("amodel", amodelEl.value.trim() || "free:smart"));
}

// ---- forge a tool (Tools view) ----------------------------------------------
$("#fg-go").onclick = async () => {
  const stat = $("#fg-stat");
  const fail = (msg) => { stat.textContent = msg; stat.style.color = "var(--bad, #e5484d)"; };
  const name = $("#fg-name").value.trim();
  const description = $("#fg-desc").value.trim();
  const code = $("#fg-code").value;
  let parameters;
  try { parameters = JSON.parse($("#fg-params").value || "{}"); }
  catch (e) { fail("parameters: " + e.message); return; }
  if (!name || !description || !code.trim()) { fail("name, description and code are all required"); return; }
  stat.textContent = "forging…";
  stat.style.color = "";
  try {
    const j = await req("/v1/tools/forge", { method: "POST", admin: true, body: { name, description, parameters, code } });
    stat.textContent = "forged: " + j.forged + " — live in the registry now";
    stat.style.color = "var(--ok)";
    loadTools();
  } catch (e) { fail("forge failed: " + e.message); }
};

// ---- forge parameters: web controls <-> JSON, two-way sync ------------------
// The controls edit a friendly subset (name / type / description / required /
// default). Sync is conservative: regenerating JSON starts from the parsed
// current schema and keeps keys the controls do not model (enum, minimum,
// nested items...). If the JSON grows a shape the rows cannot represent at
// all, the controls pause instead of overwriting it.
const FORGE_EXAMPLES = {
  name: "word_count",
  desc: "Count the words and characters in a text.",
  params: `{
  "type": "object",
  "properties": {
    "text": { "type": "string", "description": "The text to process" }
  },
  "required": ["text"]
}`,
  code: `// args is validated against the parameters schema before this runs.
const t = String(args.text ?? "");
return { words: t.split(/\\s+/).filter(Boolean).length, chars: t.length };`,
};
const FGP_TYPES = ["string", "integer", "number", "boolean", "array", "object"];
let fgpMode = "controls";
const fgpEl = $("#fg-params");

function fgpParse() { try { return JSON.parse(fgpEl.value || "{}"); } catch { return null; } }

function fgpCompatible(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  if (s.type !== undefined && s.type !== "object") return false;
  const props = s.properties ?? {};
  if (!props || typeof props !== "object" || Array.isArray(props)) return false;
  return Object.values(props).every((p) => p && typeof p === "object" && !Array.isArray(p) && (p.type === undefined || FGP_TYPES.includes(p.type)));
}

function fgpDefaultText(v, type) {
  if (v === undefined) return "";
  return (type === "array" || type === "object" || typeof v === "object") ? JSON.stringify(v) : String(v);
}

function fgpRowHTML(name, p, required) {
  const type = FGP_TYPES.includes(p?.type) ? p.type : "string";
  return `<div class="fgp-row">
    <input class="tool-form-in fgp-name" placeholder="argument name" spellcheck="false" value="${esc(name)}" aria-label="Argument name">
    <select class="tool-form-in fgp-type" aria-label="Argument type">${FGP_TYPES.map((t) => `<option ${t === type ? "selected" : ""}>${t}</option>`).join("")}</select>
    <input class="tool-form-in fgp-desc" placeholder="description for the model" spellcheck="false" value="${esc(p?.description ?? "")}" aria-label="Argument description">
    <label class="fgp-req-wrap" title="Required argument"><input type="checkbox" class="fgp-req" ${required ? "checked" : ""}> req</label>
    <input class="tool-form-in fgp-def" placeholder="default (optional)" spellcheck="false" value="${esc(fgpDefaultText(p?.default, type))}" aria-label="Argument default value">
    <button class="btn q fgp-del" type="button" aria-label="Remove argument">✕</button>
  </div>`;
}

function fgpRenderRows(schema) {
  const props = schema?.properties ?? {};
  const req = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const names = Object.keys(props);
  $("#fgp-rows").innerHTML = (names.length ? names : [""]).map((n) => fgpRowHTML(n, props[n] ?? {}, req.has(n))).join("");
}

function fgpCoerceDefault(raw, type) {
  const t = raw.trim();
  if (type === "integer" || type === "number") { const n = Number(t); return Number.isFinite(n) ? n : undefined; }
  if (type === "boolean") return t === "true" ? true : t === "false" ? false : undefined;
  if (type === "array" || type === "object") { try { return JSON.parse(t); } catch { return undefined; } }
  return t;
}

function fgpCollect() {
  if (fgpMode !== "controls") return;
  const prev = fgpParse() ?? {};
  const prevProps = (prev.properties && typeof prev.properties === "object" && !Array.isArray(prev.properties)) ? prev.properties : {};
  const props = {}, required = [];
  for (const row of $$("#fgp-rows .fgp-row")) {
    const name = row.querySelector(".fgp-name").value.trim();
    if (!name) continue;
    const type = row.querySelector(".fgp-type").value;
    const p = { ...(prevProps[name] ?? {}), type };
    const desc = row.querySelector(".fgp-desc").value.trim();
    if (desc) p.description = desc; else delete p.description;
    const dv = fgpCoerceDefault(row.querySelector(".fgp-def").value, type);
    if (dv !== undefined) p.default = dv; else delete p.default;
    props[name] = p;
    if (row.querySelector(".fgp-req").checked) required.push(name);
  }
  const out = { ...prev, type: "object", properties: props };
  if (required.length) out.required = required; else delete out.required;
  fgpEl.value = JSON.stringify(out, null, 2);
}

function fgpSetMode(mode) {
  fgpMode = mode;
  const off = mode !== "controls";
  $("#fgp-fieldset").disabled = off;
  $("#fgp-use-controls").hidden = !off;
  $("#fgp-note").textContent = off
    ? "This schema uses features the controls can't show — edit the JSON directly; nothing is overwritten."
    : "";
}

let fgpSyncT = 0;
fgpEl.addEventListener("input", () => {
  clearTimeout(fgpSyncT);
  fgpSyncT = setTimeout(() => {
    const s = fgpParse();
    if (s && fgpCompatible(s)) { if (fgpMode !== "controls") fgpSetMode("controls"); fgpRenderRows(s); }
    else if (s) fgpSetMode("advanced");
  }, 350);
});
$("#fgp-rows").addEventListener("input", fgpCollect);
$("#fgp-rows").addEventListener("change", fgpCollect);
$("#fgp-rows").addEventListener("click", (e) => {
  const del = e.target.closest(".fgp-del");
  if (del) { del.closest(".fgp-row").remove(); fgpCollect(); }
});
$("#fgp-add").onclick = () => {
  $("#fgp-rows").insertAdjacentHTML("beforeend", fgpRowHTML("", {}, false));
  $("#fgp-rows .fgp-row:last-child .fgp-name")?.focus();
};
$("#fgp-use-controls").onclick = () => { fgpSetMode("controls"); fgpCollect(); };
fgpRenderRows(fgpParse());

// ---- forge field resets -------------------------------------------------------
$$(".fg-reset").forEach((b) => {
  b.onclick = () => {
    const which = b.dataset.fgReset;
    if (which === "name") $("#fg-name").value = FORGE_EXAMPLES.name;
    else if (which === "desc") $("#fg-desc").value = FORGE_EXAMPLES.desc;
    else if (which === "code") { $("#fg-code").value = FORGE_EXAMPLES.code; $("#fg-code").dispatchEvent(new Event("input", { bubbles: true })); }
    else if (which === "params") {
      fgpEl.value = FORGE_EXAMPLES.params;
      fgpSetMode("controls");
      fgpRenderRows(fgpParse());
      fgpEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    toast("example restored");
  };
});

// ---- boot the shell ----
$("#thm").onclick = cycleTheme;
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (themePref === "auto") paintTheme(); });
MQ_MOBILE.addEventListener("change", () => { refreshOverlays(); annotate(document); });
paintTheme();
applyStoredAppearance();
annotate(document);
refreshOverlays();
if (typeof ResizeObserver !== "undefined") new ResizeObserver(navFit).observe(navEl);
addEventListener("resize", navFit);

// =====================================================================
