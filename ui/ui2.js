// =====================================================================
// UI v2 — theme, mobile shell, responsive tables, request progress
// =====================================================================
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MQ_MOBILE = matchMedia("(max-width: 860px)");
const cvar = (n, f = "#888") => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;

// ---- theme ----
const THEME_SEQ = ["auto", "dark", "light", "ocean", "violet"];
let themePref = store.get("theme", "auto");
const themeResolved = (p) => p === "auto" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : p;
function paintTheme() {
  const r = themeResolved(themePref);
  document.documentElement.dataset.theme = r;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", r === "light" ? "#f5f7fa" : "#06070a");
  const use = document.querySelector("#thm use");
  if (use) use.setAttribute("href", themePref === "auto" ? "#i-auto" : r === "light" ? "#i-sun" : "#i-moon");
  const btn = $("#thm");
  if (btn) {
    btn.title = `Theme: ${themePref} (click to change)`;
    btn.setAttribute("aria-label", `Theme: ${themePref}`);
  }
  if (current === "lanes" && health) requestAnimationFrame(() => lanes(health));
}
function cycleTheme() {
  themePref = THEME_SEQ[(THEME_SEQ.indexOf(themePref) + 1) % THEME_SEQ.length];
  store.set("theme", themePref);
  paintTheme();
  toast(`theme · ${themePref}`);
}

// ---- request progress bar ----
const progBar = $("#prog");
const reqBase = req;
let inflight = 0, progTimer = 0;
req = (...args) => {
  inflight++;
  if (inflight === 1) progTimer = setTimeout(() => progBar.classList.add("on"), 240);
  return reqBase(...args).finally(() => {
    if (--inflight) return;
    clearTimeout(progTimer);
    progBar.classList.remove("on");
  });
};

// ---- view metadata (mobile sheet) ----
const VIEW_META = [
  ["chat", "Chat", "Stream completions", "#i-chat"],
  ["community", "Community", "Posts, votes and chat", "#i-users"],
  ["architect", "Architect", "Agentic admin tools", "#i-wand"],
  ["media", "Media", "Image generation", "#i-image"],
  ["plugins", "Plugins", "Mounted widgets", "#i-plug"],
  ["catalog", "Catalog", "Every routable model", "#i-grid"],
  ["lanes", "Lanes", "Live lane telemetry", "#i-pulse"],
  ["endpoints", "Endpoints", "Upstream pool", "#i-server"],
  ["tools", "Tools", "Executable tool plane", "#i-tool"],
  ["harvester", "Harvester", "Verify new keys", "#i-radar"],
  ["traces", "Traces", "Span waterfall", "#i-branch"],
  ["ops", "Ops", "Probe · sync · resurrect", "#i-wrench"],
  ["source", "Source", "Read deployed files", "#i-file"],
  ["inspector", "Inspector", "Request log", "#i-terminal"],
];
$("#vgrid").innerHTML = VIEW_META.map(([v, name, desc, icon]) =>
  `<button class="vcard" data-go="${v}" aria-selected="false"><svg aria-hidden="true"><use href="${icon}"/></svg><b>${name}</b><small>${desc}</small></button>`
).join("");

// ---- overlays ----
const scrim = $("#scrim"), moreSheet = $("#more"), side = $("#side");
function refreshOverlays() {
  const sideOpen = !side.hidden;
  scrim.classList.toggle("open", sideOpen || moreSheet.classList.contains("open"));
  side.classList.toggle("open", sideOpen);
}
function openSheet(el) {
  closeSheets();
  el.classList.add("open");
  el.setAttribute("aria-hidden", "false");
  refreshOverlays();
}
function closeSheets() {
  wsWatch(false);
  // Every sheet openSheet() can open (all-views, tools drawer, app
  // builder) — not just moreSheet, or the drawers can never be closed.
  for (const s of $$(".sheet.open")) { s.classList.remove("open"); s.setAttribute("aria-hidden", "true"); }
  if (!side.hidden) closeSettings();
  refreshOverlays();
}
for (const drawer of [appBuilderDrawer, chatToolsDrawer]) {
  drawer?.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheets(); });
}
scrim.onclick = closeSheets;
side.onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.closest("#model-results")) return;
  if (b.dataset.theme) { setTheme(b.dataset.theme); return; }
  if (b.dataset.accent) {
    if (b.dataset.accent === "custom") { accentPref = "custom"; store.set("accent", "custom"); refreshAppearanceChips(); return; }
    setAccent(b.dataset.accent); return;
  }
  if (b.dataset.density) { setDensity(b.dataset.density); return; }
  if (b.matches("[data-close], [data-close] *")) { closeSettings(); return; }
  if (b.id === "set-docs") { closeSettings(); window.open("/docs", "_blank", "noopener"); return; }
  if (b.id === "set-keys") { closeSettings(); openKeys(); return; }
  if (b.id === "set-changelog") { closeSettings(); openChangelog(); return; }
  if (b.id === "set-import-pick") { $("#set-import").click(); return; }
};
$("#set-reduced").addEventListener("input", (e) => setReduced(e.target.checked));
$("#set-accent").onchange = (e) => {
  const c = e.target.value; const [r, g, b] = rgbOf(c);
  const lum = (.2126 * r + .7152 * g + .0722 * b) / 255;
  accentPref = "custom"; store.set("accent", "custom");
  const root = document.documentElement;
  root.style.setProperty("--acc", c);
  root.style.setProperty("--acc-ink", lum > .55 ? "#0a1200" : "#ffffff");
  root.style.setProperty("--acc-soft", `rgba(${r}, ${g}, ${b}, .12)`);
  root.style.setProperty("--acc-line", `rgba(${r}, ${g}, ${b}, .34)`);
  refreshAppearanceChips(); toast("accent · custom");
};
$("#set-csave").onclick = async (e) => {
  e.preventDefault();
  store.set("creds", { url: $("#set-curl").value.trim(), key: $("#set-ckey").value.trim(), admin: $("#set-cadm").value.trim() });
  const st = $("#set-cstat"); st.textContent = "testing…"; st.className = "dim grow";
  try {
    await ping();
    const checks = [];
    try { await req("/v1/models"); checks.push("key ✓"); } catch (err) { checks.push("key ✗ " + err.message); }
    if (creds().admin) { try { await req("/v1/traces?limit=1", { admin: true }); checks.push("admin ✓"); } catch (err) { checks.push("admin ✗ " + err.message); } }
    st.textContent = checks.join(" · ");
    st.className = checks.some((c) => c.includes("✗")) ? "no grow" : "ok grow";
    armArchitect();
  } catch (err) { st.textContent = err.message; st.className = "no grow"; }
};
$("#set-clear").onclick = () => { newChat(); closeSettings(); };
$("#set-clearall").onclick = () => confirmDialog("Clear all stored data — chats, settings, plugins and drafts cannot be recovered.", () => {
  for (const k of Object.keys(localStorage)) if (k.startsWith("nk.")) localStorage.removeItem(k);
  location.reload();
});
$("#set-import").onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      const j = JSON.parse(ev.target.result);
      if (!j || !Array.isArray(j.messages)) throw new Error("not a chat export");
      conv.messages = j.messages.map((m) => wire(m));
      saveConv(); renderThread(); closeSettings(); toast("imported " + conv.messages.length + " messages");
    } catch (err) { toast("import failed: " + err.message, true); }
  };
  r.readAsText(file);
  e.target.value = "";
};
$("#bmore").onclick = () => openSheet(moreSheet);
$("#more").addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) { closeSheets(); return; }
  const b = e.target.closest("[data-go]");
  if (b) go(b.dataset.go);
});
$("#bnav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) go(b.dataset.go);
});

// ---- navigation sync + view transitions ----
const PRIMARY = new Set(["chat", "community", "architect", "media", "traces"]);
const navEl = $("#nav");
const navFit = () => navEl.classList.toggle("overflowing", navEl.scrollWidth > navEl.clientWidth + 1);
function syncNav() {
  for (const b of $$("#bnav [data-go]")) b.setAttribute("aria-selected", String(b.dataset.go === current));
  navEl.querySelector(`[data-v="${current}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  const vt = $("#vtitle");
  if (vt) vt.textContent = VIEW_META.find((m) => m[0] === current)?.[1] ?? "";
  navFit();
  const more = $("#bmore");
  if (more) more.setAttribute("aria-selected", String(!PRIMARY.has(current)));
  for (const c of $$("#vgrid [data-go]")) c.setAttribute("aria-selected", String(c.dataset.go === current));
}
const goBase = go;
let booted = false, vt = null;
const canVT = () => !REDUCED && !MQ_MOBILE.matches && typeof document.startViewTransition === "function";
go = (v) => {
  const settle = () => {
    goBase(v);
    syncNav();
    requestAnimationFrame(() => { annotate(document); jumpState(); });
  };
  moreSheet.classList.remove("open");
  moreSheet.setAttribute("aria-hidden", "true");
  refreshOverlays();
  if (booted && !vt && canVT()) {
    // A second transition started mid-flight would drop this one's callback.
    try {
      vt = document.startViewTransition(settle);
      vt.finished.then(() => (vt = null), () => (vt = null));
      booted = true;
      return;
    } catch { vt = null; }
  }
  booted = true;
  settle();
};

// ---- responsive tables: label every cell with its column ----
function annotate(root) {
  for (const t of root.querySelectorAll("table")) {
    if (t.closest(".md")) continue;
    const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    if (!heads.length) continue;
    t.classList.add("resp");
    for (const tr of t.querySelectorAll("tbody tr")) {
      if (tr.querySelector("td[colspan], th[colspan]")) continue;
      [...tr.children].forEach((td, i) => {
        if (td.tagName === "TD" && heads[i]) td.dataset.label = heads[i];
      });
    }
  }
}
let scanQueued = false;
new MutationObserver((recs) => {
  if (scanQueued) return;
  let hit = false;
  for (const r of recs) {
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches?.("tr, table, tbody, thead") || n.querySelector?.("table, tr")) { hit = true; break; }
    }
    if (hit) break;
  }
  if (!hit) return;
  scanQueued = true;
  requestAnimationFrame(() => { scanQueued = false; annotate(document); });
}).observe(document.body, { childList: true, subtree: true });

// ---- chat: empty state, jump to bottom ----
const threadEl = $("#thread"), jumpBtn = $("#jump");
$("#welcome").addEventListener("click", (e) => {
  const b = e.target.closest("[data-p]");
  if (!b) return;
  const inp = $("#cinput");
  inp.value = b.dataset.p;
  autosize(inp);
  inp.focus();
  sendChat();
});
function jumpState() {
  const gap = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
  jumpBtn.classList.toggle("show", gap > 240);
}
threadEl.addEventListener("scroll", jumpState, { passive: true });
jumpBtn.onclick = () => {
  threadEl.scrollTo({ top: threadEl.scrollHeight, behavior: REDUCED ? "auto" : "smooth" });
  jumpBtn.classList.remove("show");
};
new MutationObserver(jumpState).observe(threadEl, { childList: true, subtree: true });

// ---- keyboard ----
function openKeys() {
  const k = $("#dkeys");
  if (typeof k.showModal === "function") k.showModal();
  else k.setAttribute("open", "");
}
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "?") { e.preventDefault(); openKeys(); }
  else if (e.key === "Escape") {
    closeSheets();
    const k = $("#dkeys");
    if (k.open) k.close();
  }
});

// ---- palette commands ----
cmd("toggle theme", () => cycleTheme(), "ui");
cmd("keyboard shortcuts", () => openKeys(), "help");
cmd("new chat", () => { go("chat"); newChat(); }, "chat");
cmd("people chat", () => go("community"), "community");
cmd("app builder studio", () => openAppBuilder(), "builder");
cmd("tools workbench", () => go("tools"), "tools");
cmd("all views", () => openSheet(moreSheet), "nav");

// ---- panel notches ----------------------------------------------------------
// One mechanism for every collapsible control panel. A panel declares the side
// it sits on (data-fold), its name (data-fold-label) and optionally the
// splitter beside it (data-fold-split = prev|next), hidden while folded. The
// notch is appended to the panel itself; panels whose content is re-rendered
// wholesale wear a .fold-box wrapper so the notch survives. Folded state
// persists per panel; a "fold" event lets owners react (the workspace stops
// its preview while folded). The name shows in a top-layer popover, so no
// clipping container or sheet can hide it.
const folds = store.get("folds", {});
const notchTip = Object.assign(document.createElement("div"), { id: "pnotch-tip" });
notchTip.setAttribute("popover", "manual");
notchTip.setAttribute("role", "tooltip");
document.body.append(notchTip);
const foldKey = (p) => p.dataset.foldKey || p.id;
function tipShow(n) {
  const p = n.parentElement;
  notchTip.textContent = p.dataset.foldLabel;
  if (!notchTip.matches(":popover-open")) notchTip.showPopover();
  const r = n.getBoundingClientRect(), t = notchTip.getBoundingClientRect(), gap = 8;
  const side = matchMedia("(max-width: 860px)").matches && p.classList.contains("p2b") ? "bottom" : p.dataset.fold;
  let x, y;
  if (side === "left") { x = r.right + gap; y = r.top + r.height / 2 - t.height / 2; }
  else if (side === "right") { x = r.left - t.width - gap; y = r.top + r.height / 2 - t.height / 2; }
  else if (side === "top") { x = r.left + r.width / 2 - t.width / 2; y = r.bottom + gap; }
  else { x = r.left + r.width / 2 - t.width / 2; y = r.top - t.height - gap; }
  notchTip.style.left = Math.max(4, Math.min(innerWidth - t.width - 4, x)) + "px";
  notchTip.style.top = Math.max(4, Math.min(innerHeight - t.height - 4, y)) + "px";
}
function tipHide() { if (notchTip.matches(":popover-open")) notchTip.hidePopover(); }
function foldSet(p, folded, persist = true) {
  if (p.classList.contains("folded") === folded) return;
  p.classList.toggle("folded", folded);
  const n = $(":scope > .pnotch", p);
  n?.setAttribute("aria-expanded", String(!folded));
  n?.setAttribute("aria-label", (folded ? "Show " : "Hide ") + p.dataset.foldLabel);
  const split = p.dataset.foldSplit === "prev" ? p.previousElementSibling : p.dataset.foldSplit === "next" ? p.nextElementSibling : null;
  split?.classList.toggle("fold-hide", folded);
  if (persist && foldKey(p)) {
    if (folded) folds[foldKey(p)] = 1; else delete folds[foldKey(p)];
    store.set("folds", folds);
  }
  p.dispatchEvent(new CustomEvent("fold", { detail: { folded } }));
  if (n && notchTip.matches(":popover-open")) requestAnimationFrame(() => n.matches(":hover, :focus-visible") ? tipShow(n) : tipHide());
}
const foldToggle = (p) => foldSet(p, !p.classList.contains("folded"));
function foldMount(root = document) {
  for (const p of $$("[data-fold]", root)) {
    if ($(":scope > .pnotch", p)) continue;
    const label = p.dataset.foldLabel;
    const n = document.createElement("button");
    n.type = "button";
    n.className = "pnotch";
    if (p.id) n.setAttribute("aria-controls", p.id);
    n.setAttribute("aria-expanded", "true");
    n.setAttribute("aria-label", "Hide " + label);
    n.addEventListener("click", () => foldToggle(p));
    n.addEventListener("pointerenter", () => tipShow(n));
    n.addEventListener("pointerleave", tipHide);
    n.addEventListener("focus", () => { if (n.matches(":focus-visible")) tipShow(n); });
    n.addEventListener("blur", tipHide);
    p.append(n);
    if (folds[foldKey(p)]) foldSet(p, true, false);
    cmd("toggle " + label.toLowerCase(), () => foldToggle(p), "panel");
  }
}
addEventListener("scroll", tipHide, true);

// ---- AI field notches -------------------------------------------------------
// A small ✦ AI tab pinned to a field's top-right corner. Clicking it opens a
// panel that knows the field's label, its purpose (data-notch-context) and
// its current contents, so the user can ask about what is in the field — or
// have the AI rewrite the contents and apply the result back to the field.
let notchField = null, notchReplacement = null;

function notchHostFor(field) {
  const existing = field.closest(".notch-host");
  if (existing) return existing;
  const host = document.createElement("div");
  host.className = "notch-host";
  if (field.classList.contains("grow")) { host.style.display = "flex"; host.style.flex = "1"; }
  field.parentNode.insertBefore(host, field);
  host.appendChild(field);
  field.style.flex = "1";
  field.style.width = "100%";
  return host;
}

function mountNotches() {
  for (const field of $$("[data-notch]")) {
    if (field.dataset.notchMounted) continue;
    field.dataset.notchMounted = "1";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ai-notch";
    btn.textContent = "✦ AI";
    btn.title = "Ask AI about this field";
    btn.setAttribute("aria-label", "Ask AI about this field");
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openNotch(field); };
    notchHostFor(field).appendChild(btn);
  }
}

function notchLabel(field) {
  return field.dataset.notchLabel || field.getAttribute("aria-label") || field.id || "field";
}

function openNotch(field) {
  notchField = field;
  notchReplacement = null;
  // A modal <dialog> renders in the top layer, above everything outside
  // it — the shared panel included. When the field lives in a dialog,
  // move the panel inside that dialog so it stays reachable; otherwise
  // keep it at body level.
  const panel0 = $("#ai-notch-panel");
  const hostDlg = field.closest("dialog");
  if (hostDlg) { if (panel0.parentNode !== hostDlg) hostDlg.appendChild(panel0); }
  else if (panel0.parentNode !== document.body) document.body.appendChild(panel0);
  $("#anp-title").textContent = "✦ Ask AI — " + notchLabel(field);
  $("#anp-ctx").textContent = field.dataset.notchContext || "";
  const val = field.value ?? "";
  $("#anp-cur").textContent = val ? val.slice(0, 900) : "(empty)";
  $("#anp-ans").hidden = true;
  $("#anp-ans").textContent = "";
  $("#anp-apply-row").hidden = true;
  $("#ai-notch-panel").hidden = false;
  $("#anp-q").focus();
}

function closeNotch() {
  $("#ai-notch-panel").hidden = true;
  notchField = null;
}

async function askNotch() {
  if (!notchField) return;
  const q = $("#anp-q").value.trim();
  if (!q) return;
  const field = notchField;
  const btn = $("#anp-ask");
  btn.disabled = true;
  btn.textContent = "asking…";
  const ans = $("#anp-ans");
  ans.hidden = false;
  ans.textContent = "…";
  try {
    const sys = "You are an inline assistant inside the nokey-router dashboard, helping the user with ONE form field.\n"
      + "Field: " + notchLabel(field) + "\n"
      + "What it is: " + (field.dataset.notchContext || "") + "\n"
      + "Current contents:\n" + (field.value || "(empty)") + "\n\n"
      + "Answer questions about this field and its contents briefly and concretely. If the user asks you to write, draft, fix or change the contents, output the COMPLETE new contents inside a single triple-backtick code block (no other code blocks), with at most one short sentence outside it.";
    const j = await req("/v1/chat/completions", { method: "POST", body: { model: $("#pmodel")?.value || "free:auto", messages: [{ role: "system", content: sys }, { role: "user", content: q }] } });
    const text = j?.choices?.[0]?.message?.content ?? "(no answer)";
    ans.textContent = text;
    const m = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
    notchReplacement = m ? m[1].replace(/\n$/, "") : null;
    $("#anp-apply-row").hidden = !notchReplacement;
    if (notchReplacement) $("#anp-note").textContent = "The AI proposed new contents — Apply replaces the field value.";
  } catch (e) {
    ans.textContent = "AI request failed: " + e.message;
  }
  btn.disabled = false;
  btn.textContent = "Ask";
}

$("#anp-ask").onclick = askNotch;
$("#anp-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); askNotch(); } });
$("#anp-close").onclick = closeNotch;
$("#anp-apply").onclick = () => {
  if (!notchField || notchReplacement === null) return;
  notchField.value = notchReplacement;
  notchField.dispatchEvent(new Event("input", { bubbles: true }));
  notchField.dispatchEvent(new Event("change", { bubbles: true }));
  $("#anp-cur").textContent = notchReplacement.slice(0, 900);
  $("#anp-note").textContent = "Applied to the field.";
  $("#anp-apply-row").hidden = true;
};
mountNotches();

