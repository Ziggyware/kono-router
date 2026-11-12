"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const f = (n, d = 0) => Number.isFinite(n) ? n.toFixed(d) : "—";
const ms = (n) => !Number.isFinite(n) ? "—" : n >= 1000 ? (n / 1000).toFixed(2) + "s" : n.toFixed(0) + "ms";
const kfmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem("nk." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("nk." + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem("nk." + k); } catch { /* storage unavailable */ } },
};

// ---------- credentials (one-time migration from the legacy base64+cookie scheme) ----------
(function migrate() {
  if (store.get("creds")) return;
  const old = (k) => { try { const v = localStorage.getItem("enc_" + k); return v ? decodeURIComponent(atob(v)) : ""; } catch { return ""; } };
  const c = { url: old("router_url"), key: old("router_apikey"), admin: old("admin_secret") };
  if (c.url || c.key || c.admin) store.set("creds", c);
  for (const k of ["router_url", "router_apikey", "admin_secret"]) {
    try { localStorage.removeItem("enc_" + k); } catch { /* storage unavailable */ }
    document.cookie = `enc_${k}=; path=/; max-age=0; SameSite=Strict`; // secrets must not ride on every request
  }
})();
const ORIGIN = /^https?:/.test(location.protocol) ? location.origin : "https://nokey-router.ziggyware.deno.net";
const creds = () => { const c = store.get("creds", {}); return { url: (c.url || ORIGIN).replace(/\/+$/, ""), key: c.key || "", admin: c.admin || "" }; };
// A stable per-browser session scopes the tool plane's namespace, so
// memory, RAG and files compound across chats instead of resetting.
// The tool-plane session (durable workspace, clipboard, tasks) is stable
// across chats: a new chat keeps the browser's session, so the workspace a
// build just wrote stays reachable. Only loading a saved conversation
// switches to that conversation's own session. The browser's original
// session id stays with the chat that was live when this was introduced,
// so existing files are not orphaned.
const newSessionId = () => "chat-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
function sessionId() {
  let id = store.get("chat_session", "") || store.get("session_id", "");
  if (!id) id = newSessionId();
  store.set("chat_session", id);
  return id;
}
function headers(admin = false, json = true) {
  const c = creds(), h = {};
  if (json) h["Content-Type"] = "application/json";
  if (c.key) h.Authorization = "Bearer " + c.key;
  if (admin && c.admin) h["x-admin-secret"] = c.admin;
  h["x-nokey-session"] = sessionId();
  return h;
}

// ---------- toast ----------
let toastT = 0;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = bad ? "no" : ""; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, bad ? 6000 : 3000);
}

// ---------- instrumented requests (feed the Inspector) ----------
const ilog = [];
const IMAX = 300;
function irecord(e) {
  ilog.unshift(e);
  if (ilog.length > IMAX) ilog.pop();
  if (current === "inspector") renderInspector();
}
async function req(path, { method = "GET", admin = false, body, signal, raw = false } = {}) {
  const url = /^https?:/.test(path) ? path : creds().url + path;
  const e = { t: Date.now(), method, url, path: url.replace(creds().url, ""), status: 0, ms: 0, req: body, res: null, trace: "" };
  const t0 = performance.now();
  irecord(e);
  try {
    const res = await fetch(url, { method, headers: headers(admin), body: body === undefined ? undefined : JSON.stringify(body), signal });
    e.status = res.status;
    e.trace = (res.headers.get("traceparent") ?? "").split("-")[1] ?? "";
    if (raw) { e.ms = performance.now() - t0; e.res = "(stream)"; return res; }
    const text = await res.text();
    e.ms = performance.now() - t0;
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(text.trimStart().startsWith("<") ? "Router URL returned HTML, not the API" : `Non-JSON response (HTTP ${res.status})`); }
    e.res = data;
    if (!res.ok) throw new Error(`${res.status} ${data?.error?.message ?? ""}`.trim());
    return data;
  } catch (err) {
    e.ms ||= performance.now() - t0;
    e.res ??= { error: String(err.message ?? err) };
    throw err;
  } finally {
    if (current === "inspector") renderInspector();
  }
}
// One SSE block = {data, comment}; works for chat streams and the live trace tail.
async function* sse(res, signal) {
  const rd = res.body.pipeThrough(new TextDecoderStream()).getReader();
  signal?.addEventListener("abort", () => rd.cancel().catch(() => {}), { once: true });
  let buf = "";
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const lines = block.split("\n");
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      const comment = lines.filter((l) => l.startsWith(":")).map((l) => l.slice(1).trim()).join(" ");
      yield { data, comment };
    }
  }
}

// ---------- markdown & syntax highlighting ----------
function highlightCode(code, lang = "") {
  lang = (lang || "").toLowerCase().trim();
  const escH = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (!code) return "";
  const trimmed = code.trim();

  if (lang === "json" || lang === "jsonc" || (!lang && (trimmed.startsWith("{") || trimmed.startsWith("[")) && (trimmed.endsWith("}") || trimmed.endsWith("]")))) {
    // escH leaves quotes alone, so strings are matched on a literal quote.
    return escH(code).replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = "hl-num";
      if (/^"/.test(match)) {
        if (/:$/.test(match)) cls = "hl-key";
        else cls = "hl-str";
      } else if (/true|false/.test(match)) cls = "hl-bool";
      else if (/null/.test(match)) cls = "hl-null";
      return `<span class="${cls}">${match}</span>`;
    });
  }

  if (["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(lang)) {
    const rx = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\`|[\s\S])*?`|"(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"|'(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\'])*')|(\b(?:const|let|var|function|return|import|export|from|async|await|class|extends|if|else|for|while|do|try|catch|finally|throw|new|typeof|instanceof|switch|case|default|break|continue|yield|in|of)\b)|(\b(?:true|false|null|undefined|NaN|Infinity)\b)|(\b(?:string|number|boolean|any|void|unknown|never|object|Promise|Array|Record|Set|Map)\b)|(-?\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\())/g;
    return code.replace(rx, (m, comm, str, kw, lit, type, num, fn) => {
      if (comm) return `<span class="hl-comm">${escH(comm)}</span>`;
      if (str) return `<span class="hl-str">${escH(str)}</span>`;
      if (kw) return `<span class="hl-kw">${escH(kw)}</span>`;
      if (lit) return `<span class="hl-lit">${escH(lit)}</span>`;
      if (type) return `<span class="hl-type">${escH(type)}</span>`;
      if (num) return `<span class="hl-num">${escH(num)}</span>`;
      if (fn) return `<span class="hl-fn">${escH(fn)}</span>`;
      return escH(m);
    });
  }

  if (["python", "py"].includes(lang)) {
    const rx = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"|'(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\'])*')|(\b(?:def|class|return|import|from|as|if|elif|else|for|while|try|except|finally|with|pass|raise|yield|async|await|lambda|global|nonlocal|assert|in|is|not|and|or)\b)|(\b(?:True|False|None)\b)|(\b(?:int|float|str|bool|list|dict|set|tuple|self)\b)|(-?\b\d+(?:\.\d+)?\b)|(@[a-zA-Z_]\w*)/g;
    return code.replace(rx, (m, comm, str, kw, lit, type, num, dec) => {
      if (comm) return `<span class="hl-comm">${escH(comm)}</span>`;
      if (str) return `<span class="hl-str">${escH(str)}</span>`;
      if (kw) return `<span class="hl-kw">${escH(kw)}</span>`;
      if (lit) return `<span class="hl-lit">${escH(lit)}</span>`;
      if (type) return `<span class="hl-type">${escH(type)}</span>`;
      if (num) return `<span class="hl-num">${escH(num)}</span>`;
      if (dec) return `<span class="hl-dec">${escH(dec)}</span>`;
      return escH(m);
    });
  }

  if (["html", "xml", "svg"].includes(lang) || (!lang && trimmed.startsWith("<") && trimmed.endsWith(">"))) {
    const rx = /(<!--[\s\S]*?-->)|(<!DOCTYPE[^>]*>)|(<\/?)([a-zA-Z0-9\-:]+)|(\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?|(\/?>)/g;
    return code.replace(rx, (m, comm, doc, tagOpen, tagName, attrName, attrVal, tagClose) => {
      if (comm) return `<span class="hl-comm">${escH(comm)}</span>`;
      if (doc) return `<span class="hl-doc">${escH(doc)}</span>`;
      if (tagOpen && tagName) return `${escH(tagOpen)}<span class="hl-tag">${escH(tagName)}</span>`;
      if (attrName) {
        let res = `<span class="hl-attr">${escH(attrName)}</span>`;
        if (attrVal) res += `="<span class="hl-str">${escH(attrVal.replace(/^["']|["']$/g, ""))}</span>"`;
        return res;
      }
      if (tagClose) return escH(tagClose);
      return escH(m);
    });
  }

  if (["css"].includes(lang)) {
    const rx = /(\/\*[\s\S]*?\*\/)|([.#]?[a-zA-Z_-][a-zA-Z0-9_-]*(?:\s*,\s*[.#]?[a-zA-Z_-][a-zA-Z0-9_-]*)*\s*\{)|([a-zA-Z_-][a-zA-Z0-9_-]*\s*:)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#(?:[0-9a-fA-F]{3,8})\b)|(\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b)/g;
    return code.replace(rx, (m, comm, sel, prop, str, hex, num) => {
      if (comm) return `<span class="hl-comm">${escH(comm)}</span>`;
      if (sel) return `<span class="hl-tag">${escH(sel)}</span>`;
      if (prop) return `<span class="hl-attr">${escH(prop)}</span>`;
      if (str) return `<span class="hl-str">${escH(str)}</span>`;
      if (hex) return `<span class="hl-lit">${escH(hex)}</span>`;
      if (num) return `<span class="hl-num">${escH(num)}</span>`;
      return escH(m);
    });
  }

  if (["bash", "sh", "shell", "zsh"].includes(lang)) {
    const rx = /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\$[a-zA-Z_]\w*|\$\{[^}]+\})|(\b(?:if|then|else|elif|fi|for|while|in|do|done|case|esac|function|return|exit)\b)|(\b(?:echo|cd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|curl|wget|npm|deno|node|git|docker)\b)|(--?[a-zA-Z0-9_-]+)/g;
    return code.replace(rx, (m, comm, str, v, kw, cmd, flag) => {
      if (comm) return `<span class="hl-comm">${escH(comm)}</span>`;
      if (str) return `<span class="hl-str">${escH(str)}</span>`;
      if (v) return `<span class="hl-fn">${escH(v)}</span>`;
      if (kw) return `<span class="hl-kw">${escH(kw)}</span>`;
      if (cmd) return `<span class="hl-dec">${escH(cmd)}</span>`;
      if (flag) return `<span class="hl-attr">${escH(flag)}</span>`;
      return escH(m);
    });
  }

  if (["sql"].includes(lang)) {
    const rx = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*')|(\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|ADD|INDEX|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|AS|AND|OR|NOT|NULL|IS|LIKE|IN|BETWEEN|EXISTS|CASE|WHEN|THEN|ELSE|END)\b)|(-?\b\d+(?:\.\d+)?\b)/gi;
    return code.replace(rx, (m, comm, str, kw, num) => {
      if (comm) return `<span class="hl-comm">${escH(comm)}</span>`;
      if (str) return `<span class="hl-str">${escH(str)}</span>`;
      if (kw) return `<span class="hl-kw">${escH(kw.toUpperCase())}</span>`;
      if (num) return `<span class="hl-num">${escH(num)}</span>`;
      return escH(m);
    });
  }

  return escH(code);
}

const mdlib = Promise.all([
  import("https://cdn.jsdelivr.net/npm/marked@18.1.3/lib/marked.esm.js"),
  import("https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.es.mjs"),
  import("https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/es/highlight.min.js"),
]).then(([m, p, h]) => ({ marked: m.marked, purify: p.default, hljs: h.default })).catch(() => null);
let MD = null;
mdlib.then((x) => { MD = x; $$(".md[data-src]").forEach((el) => renderMd(el, el.dataset.src)); });

function postProcessCode(el, final) {
  for (const pre of $$("pre", el)) {
    if (pre.closest(".code-block")) continue;
    const code = $("code", pre);
    const rawText = (code ?? pre).innerText;
    let lang = "";
    if (code) {
      const cls = code.className || "";
      const m = cls.match(/language-([a-zA-Z0-9_-]+)/);
      if (m) lang = m[1];
    }
    const isApp = (lang === "html" || rawText.includes("<!DOCTYPE html>") || rawText.includes("<html") || (rawText.includes("<canvas") && rawText.includes("<script")));
    if (final && code && !code.dataset.hl) {
      try {
        if (MD?.hljs) MD.hljs.highlightElement(code);
        else code.innerHTML = highlightCode(rawText, lang);
      } catch {
        code.innerHTML = highlightCode(rawText, lang);
      }
      code.dataset.hl = 1;
    }
    const block = document.createElement("div");
    block.className = "code-block";
    block.innerHTML = `<div class="code-bar"><span class="lang">${esc(lang || "code")}</span><div class="actions">${isApp ? `<button class="btn q btn-run-app">▶ Run in Sandbox</button>` : ""}<button class="btn q cp">copy</button></div></div>`;
    pre.parentNode.insertBefore(block, pre);
    block.appendChild(pre);
    block._sbxRaw = rawText; block._sbxLang = lang;
    const cp = $(".cp", block);
    if (cp) cp.onclick = () => navigator.clipboard.writeText(rawText).then(() => toast("copied"));
    const runBtn = $(".btn-run-app", block);
    if (runBtn) runBtn.onclick = () => launchAppSandbox(sbxAssemble(block), "Interactive App");
  }
}

function renderMd(el, text, final = true) {
  if (!MD) {
    // Robust fallback markdown renderer
    let s = esc(text);
    s = s.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const unescaped = code.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const isApp = (lang === "html" || unescaped.includes("<!DOCTYPE html>") || unescaped.includes("<html"));
      const hl = highlightCode(unescaped, lang);
      return `<div class="code-block"><div class="code-bar"><span class="lang">${esc(lang || "code")}</span><div class="actions">${isApp ? `<button class="btn q btn-run-app" data-app-code="${esc(unescaped)}">▶ Run in Sandbox</button>` : ""}<button class="btn q cp">copy</button></div></div><pre><code>${hl}</code></pre></div>`;
    });
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\n\n/g, "<p></p>");
    s = s.replace(/\n/g, "<br>");
    el.innerHTML = s;
    for (const cp of $$(".cp", el)) {
      cp.onclick = () => {
        const pre = cp.closest(".code-block")?.querySelector("pre");
        if (pre) navigator.clipboard.writeText(pre.innerText).then(() => toast("copied"));
      };
    }
    for (const runBtn of $$(".btn-run-app", el)) {
      runBtn.onclick = () => launchAppSandbox(sbxAssemble(runBtn.closest(".code-block")), "Interactive App");
    }
    if (final) el.dataset.src = text;
    return;
  }
  delete el.dataset.src;
  el.innerHTML = MD.purify.sanitize(MD.marked.parse(text, { gfm: true, breaks: false }), { ADD_ATTR: ["target"] });
  for (const a of $$("a", el)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  postProcessCode(el, final);
}

// ---------- views / routing ----------
const VIEWS = $$("nav [data-v]").map((b) => b.dataset.v);
const enter = {}; // view -> hook run on activation
let current = "";
function go(v) {
  if (!VIEWS.includes(v)) v = "chat";
  current = v;
  for (const b of $$("nav [data-v]")) b.setAttribute("aria-selected", b.dataset.v === v);
  for (const s of $$("main > .view")) s.hidden = s.id !== "v-" + v;
  if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
  enter[v]?.();
}
$("nav").onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) go(b.dataset.v); };
addEventListener("hashchange", () => go(location.hash.slice(1)));

// ---------- connection ----------
let health = null;
function connState(ok, text) {
  $("#conn i").className = ok === null ? "" : ok ? "ok" : "no";
  $("#conn span").textContent = text ?? new URL(creds().url).host;
}
async function ping() {
  try {
    health = await req("/health");
    connState(true, `${new URL(creds().url).host} · ${health.coverage?.configured_endpoints ?? "?"} endpoints`);
    return health;
  } catch (e) { connState(false); throw e; }
}
$("#conn").onclick = () => {
  const c = creds();
  $("#curl").value = c.url; $("#ckey").value = c.key; $("#cadm").value = c.admin; $("#cstat").textContent = "";
  $("#dconn").showModal();
};
$("#csave").onclick = async (e) => {
  e.preventDefault();
  store.set("creds", { url: $("#curl").value.trim(), key: $("#ckey").value.trim(), admin: $("#cadm").value.trim() });
  $("#cstat").textContent = "testing…"; $("#cstat").className = "dim grow";
  try {
    await ping();
    const checks = [];
    try { await req("/v1/models"); checks.push("key ✓"); } catch (err) { checks.push("key ✗ " + err.message); }
    if (creds().admin) { try { await req("/v1/traces?limit=1", { admin: true }); checks.push("admin ✓"); } catch (err) { checks.push("admin ✗ " + err.message); } }
    $("#cstat").textContent = checks.join(" · ");
    $("#cstat").className = checks.some((c) => c.includes("✗")) ? "no grow" : "ok grow";
    armArchitect();
  } catch (err) { $("#cstat").textContent = err.message; $("#cstat").className = "no grow"; }
};

// ---------- command palette ----------
const commands = [];
const cmd = (name, run, hint = "") => commands.push({ name, run, hint });
let palSel = 0, palItems = [];
function palRender() {
  const q = $("#palq").value.trim().toLowerCase();
  palItems = commands.filter((c) => q.split(/\s+/).every((w) => c.name.toLowerCase().includes(w)));
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  $("#pall").innerHTML = palItems.map((c, i) => `<li role="option" data-i="${i}" aria-selected="${i === palSel}">${esc(c.name)}<small>${esc(c.hint)}</small></li>`).join("");
  $("#pall [aria-selected=true]")?.scrollIntoView({ block: "nearest" });
}
function palOpen() { $("#pal").hidden = false; $("#palq").value = ""; palSel = 0; palRender(); $("#palq").focus(); }
function palClose() { $("#pal").hidden = true; }
function palRun(i) { const c = palItems[i]; palClose(); c?.run(); }
$("#kbtn").onclick = palOpen;
$("#palx").onclick = () => palClose();
$("#palq").oninput = () => { palSel = 0; palRender(); };
$("#palq").onkeydown = (e) => {
  if (e.key === "ArrowDown") { palSel = Math.min(palSel + 1, palItems.length - 1); palRender(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { palSel = Math.max(palSel - 1, 0); palRender(); e.preventDefault(); }
  else if (e.key === "Enter") palRun(palSel);
  else if (e.key === "Escape") palClose();
};
$("#pall").onclick = (e) => { const li = e.target.closest("[data-i]"); if (li) palRun(Number(li.dataset.i)); };
$("#pal").onclick = (e) => { if (e.target.id === "pal") palClose(); };
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#pal").hidden ? palOpen() : palClose(); }
});
for (const v of VIEWS) cmd("go " + v, () => go(v), "view");
cmd("connection settings", () => $("#conn").click());
cmd("open api reference", () => window.open("/docs", "_blank", "noopener"));

// ---------- inspector ----------
// Visual JSON: a collapsible tree with typed, coloured values instead of a
// raw dump. Strings/keys/values are capped so a huge payload stays light.
function jsonTree(v, depth = 0) {
  if (v === null || v === undefined) return `<span class="jt-null">null</span>`;
  if (typeof v === "string") return `<span class="jt-str">"${esc(v.length > 300 ? v.slice(0, 300) + "…" : v)}"</span>`;
  if (typeof v === "number" || typeof v === "bigint") return `<span class="jt-num">${v}</span>`;
  if (typeof v === "boolean") return `<span class="jt-bool">${v}</span>`;
  if (Array.isArray(v)) {
    if (!v.length) return `<span class="jt-dim">[ ]</span>`;
    const items = v.slice(0, 50).map((x, i) => `<div class="jt-row"><span class="jt-key">${i}</span>${jsonTree(x, depth + 1)}</div>`).join("");
    return `<details class="jt-node"${depth < 1 ? " open" : ""}><summary><span class="jt-type">array · ${v.length} item${v.length === 1 ? "" : "s"}</span></summary><div class="jt-kids">${items}${v.length > 50 ? `<div class="jt-dim">… ${v.length - 50} more</div>` : ""}</div></details>`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return `<span class="jt-dim">{ }</span>`;
    const rows = keys.slice(0, 60).map((key) => `<div class="jt-row"><span class="jt-key">${esc(key)}</span>${jsonTree(v[key], depth + 1)}</div>`).join("");
    return `<details class="jt-node"${depth < 1 ? " open" : ""}><summary><span class="jt-type">object · ${keys.length} key${keys.length === 1 ? "" : "s"}</span></summary><div class="jt-kids">${rows}${keys.length > 60 ? `<div class="jt-dim">… ${keys.length - 60} more</div>` : ""}</div></details>`;
  }
  return `<span>${esc(String(v))}</span>`;
}

// ---- drag primitives (shared) ---------------------------------------------
// armSplit/dragShield/splitter: one pointer-drag primitive for every split
// pane in the dashboard. Lives in core because chat, traces, panes and the
// workspace all call splitter() at load time.
function armSplit(handle) {
  handle.addEventListener("pointerenter", () => document.body.classList.add("split-armed"));
  handle.addEventListener("pointerleave", () => { if (!document.body.classList.contains("splitting")) document.body.classList.remove("split-armed"); });
}
function dragShield(axis, move, done, handle, pointerId) {
  const sh = document.createElement("div");
  sh.className = "split-shield drag-" + axis;
  document.body.appendChild(sh);
  document.body.classList.add("splitting", "split-armed");
  try { handle?.setPointerCapture(pointerId); } catch { /* pointer already released */ }
  const mv = (e) => { if (e.buttons === 0) up(); else move(e); };
  const up = () => {
    removeEventListener("pointermove", mv); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
    sh.remove();
    document.body.classList.remove("splitting");
    if (!handle?.matches(":hover")) document.body.classList.remove("split-armed");
    done();
  };
  addEventListener("pointermove", mv);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}
// One splitter primitive: pointer drag (shielded), arrows
// (shift = coarse), Home/End to the limits, double-click to the default.
function splitter(handle, { axis, get, set, min, max, reset, layout = wspLayout, save = wspSave }) {
  const apply = (v) => { set(Math.round(Math.min(max(), Math.max(min(), v)))); layout(); };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = axis === "x" ? e.clientX : e.clientY, v0 = get();
    handle.classList.add("drag");
    dragShield(axis, (ev) => apply(v0 + (axis === "x" ? ev.clientX : ev.clientY) - start), () => { handle.classList.remove("drag"); save(); }, handle, e.pointerId);
  });
  armSplit(handle);
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 80 : 16;
    const k = { [axis === "x" ? "ArrowRight" : "ArrowDown"]: get() + step, [axis === "x" ? "ArrowLeft" : "ArrowUp"]: get() - step, Home: min(), End: max() }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    apply(k);
    save();
  });
  handle.addEventListener("dblclick", () => { reset(); layout(); save(); });
}

// ---- split panes: list | detail ----------------------------------------------
// One primitive for every list/detail view: a persisted, draggable split built
// on splitter(); the detail opens on demand and updates in place so its
// scroll survives live list refreshes. Phones stack the two (CSS).
const paneW = store.get("panes", {});
function pane2(id, def) {
  const root = $("#" + id), a = $(":scope > .p2a", root), bar = $(":scope > .split-x", root), b = $(":scope > .p2b", root);
  const lay = () => root.style.setProperty("--p2", ((paneW[id] ?? def) * 100).toFixed(2) + "%");
  splitter(bar, {
    axis: "x",
    get: () => a.getBoundingClientRect().width,
    set: (px) => { paneW[id] = px / Math.max(1, root.clientWidth); },
    min: () => 200, max: () => Math.max(200, root.clientWidth - 235),
    reset: () => { delete paneW[id]; },
    layout: lay, save: () => store.set("panes", paneW),
  });
  lay();
  b.innerHTML = `<div class="p2b-h"><span class="p"></span><span class="x"></span></div><div class="p2b-b"></div>`;
  const pane = {
    key: null, sig: null, body: $(".p2b-b", b), onhide: null,
    show(key, title, html, { sig = null, extra = "", flush = false } = {}) {
      root.classList.add("open");
      foldSet(b, false);
      if (pane.key === key && sig !== null && pane.sig === sig) return;
      const keep = pane.key === key ? pane.body.scrollTop : 0;
      pane.key = key; pane.sig = sig;
      $(".p", b).textContent = title; $(".p", b).title = title;
      $(".x", b).innerHTML = extra;
      pane.body.classList.toggle("flush", flush);
      pane.body.innerHTML = html;
      pane.body.scrollTop = keep;
    },
    hide() { root.classList.remove("open"); pane.key = pane.sig = null; pane.onhide?.(); },
    get open() { return root.classList.contains("open"); },
  };
  return pane;
}
// Marks the selected row without re-rendering the list (keeps dblclick and focus intact).
function markRow(tbody, attr, key) { for (const tr of tbody.querySelectorAll(`tr[${attr}]`)) tr.setAttribute("aria-selected", String(tr.getAttribute(attr) === key)); }

const ipane = pane2("ip2", 0.56);
ipane.onhide = () => markRow($("#itb"), "data-k", null);
function inspectDetail(e) {
  const k = `${e.t}-${e.path}`;
  ipane.show(k, `${e.method} ${e.path}`, `<div class="wi-kv"><span>url</span><b>${esc(e.url)}</b><span>status</span><b class="${e.status >= 200 && e.status < 300 ? "ok" : e.status ? "no" : "dim"}">${e.status || "pending"}</b><span>time</span><b>${new Date(e.t).toLocaleTimeString()} · ${ms(e.ms)}</b>${e.trace ? `<span>trace</span><b><a href="#" data-tr="${e.trace}">${e.trace}</a></b>` : ""}</div>
    <div class="jt-wrap"><div class="jt-sec">request</div>${jsonTree(e.req)}<div class="jt-sec">response</div>${jsonTree(e.res)}<details class="jt-raw"><summary>raw JSON</summary><pre class="wrap">${esc(JSON.stringify({ request: e.req, response: e.res }, null, 2).slice(0, 20000))}</pre></details></div>`,
    { sig: `${e.status}|${e.ms}|${e.trace}` });
}
$("#ip2 .p2b").addEventListener("click", (ev) => { const a = ev.target.closest("[data-tr]"); if (a) { ev.preventDefault(); openTrace(a.dataset.tr); } });

function renderInspector() {
  const q = $("#ifilter").value.trim().toLowerCase();
  const rows = ilog.filter((e) => !q || `${e.method} ${e.path} ${e.status} ${e.trace}`.toLowerCase().includes(q));
  $("#icount").textContent = `${rows.length}/${ilog.length}`;
  $("#itb").innerHTML = rows.map((e) => {
    const k = `${e.t}-${e.path}`;
    const head = `<tr class="click" data-k="${esc(k)}" aria-selected="${ipane.key === k}"><td class="l">${new Date(e.t).toLocaleTimeString()}</td><td class="l">${e.method}</td><td class="l t" title="${esc(e.url)}">${esc(e.path)}</td>
      <td class="${e.status >= 200 && e.status < 300 ? "ok" : e.status ? "no" : "dim"}">${e.status || "…"}</td><td>${ms(e.ms)}</td><td class="l">${e.trace ? `<a href="#" data-tr="${e.trace}">${e.trace.slice(0, 12)}</a>` : ""}</td></tr>`;
    if (ipane.key === k) inspectDetail(e);
    return head;
  }).join("");
}
$("#ifilter").oninput = renderInspector;
$("#iclear").onclick = () => { ilog.length = 0; ipane.hide(); renderInspector(); };
$("#itb").onclick = (ev) => {
  const a = ev.target.closest("[data-tr]");
  if (a) { ev.preventDefault(); openTrace(a.dataset.tr); return; }
  const tr = ev.target.closest("tr[data-k]");
  if (!tr) return;
  if (ipane.key === tr.dataset.k) { ipane.hide(); return; }
  const e = ilog.find((x) => `${x.t}-${x.path}` === tr.dataset.k);
  if (e) { inspectDetail(e); markRow($("#itb"), "data-k", tr.dataset.k); }
};
enter.inspector = renderInspector;

