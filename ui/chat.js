// =====================================================================
// CHAT
// =====================================================================
const conv = store.get("chat", { messages: [] });
let attachments = [];
let chatCtl = null;
const PARAMS = ["pmodel", "ptemp", "pmax", "peffort", "psys", "pstream"];
let accentPref = store.get("accent") || "theme";
let densityPref = store.get("density") || "comfortable";
let reducedPref = Boolean(store.get("reduced"));
const ACCENTS = {
  theme: null,
  lime: { acc: "#c9ff4a", "acc-ink": "#0a1200", "acc-soft": "rgba(201, 255, 74, .12)", "acc-line": "rgba(201, 255, 74, .34)" },
  blue: { acc: "#7fc4ff", "acc-ink": "#05263d", "acc-soft": "rgba(127, 196, 255, .12)", "acc-line": "rgba(127, 196, 255, .34)" },
  ocean: { acc: "#66e4f1", "acc-ink": "#032027", "acc-soft": "rgba(102, 228, 241, .12)", "acc-line": "rgba(102, 228, 241, .34)" },
  violet: { acc: "#c3a6ff", "acc-ink": "#2d0f47", "acc-soft": "rgba(195, 166, 255, .12)", "acc-line": "rgba(195, 166, 255, .34)" },
  rose: { acc: "#f472b6", "acc-ink": "#4a044e", "acc-soft": "rgba(244, 114, 182, .12)", "acc-line": "rgba(244, 114, 182, .34)" },
};
function setTheme(pref) {
  themePref = pref; store.set("theme", themePref); paintTheme(); refreshAppearanceChips();
  toast("theme · " + themePref);
}
function setAccent(key) {
  accentPref = key; store.set("accent", key);
  const root = document.documentElement, a = ACCENTS[key];
  if (a) Object.entries(a).forEach(([k, v]) => root.style.setProperty("--" + k, v));
  else ["acc", "acc-ink", "acc-soft", "acc-line"].forEach((k) => root.style.removeProperty("--" + k));
  refreshAppearanceChips(); toast("accent · " + key);
}
function setDensity(key) {
  densityPref = key; store.set("density", key);
  const root = document.documentElement;
  if (key === "comfortable") root.removeAttribute("data-density");
  else root.dataset.density = key;
  refreshAppearanceChips();
}
function setReduced(on) {
  reducedPref = on;
  document.documentElement.dataset.reduced = on ? "1" : "0";
  store.set("reduced", on);
}
function refreshAppearanceChips() {
  $$("[data-theme]", side).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === themePref)));
  $$("[data-accent]", side).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.accent === accentPref)));
  $$("[data-density]", side).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.density === densityPref)));
}
function applyStoredAppearance() {
  setAccent(accentPref);
  if (densityPref === "comfortable") document.documentElement.removeAttribute("data-density");
  else document.documentElement.dataset.density = densityPref;
  document.documentElement.dataset.reduced = reducedPref ? "1" : "0";
  $("#set-reduced").checked = reducedPref;
  refreshAppearanceChips();
}
function rgbOf(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [201, 255, 74];
}
function openSettings() {
  closeSheets();
  side.hidden = false;
  store.set("side", true);
  requestAnimationFrame(() => {
    side.classList.add("open");
    refreshOverlays();
  });
  prefillConnection();
  updateModelHint();
  refreshAppearanceChips();
}
function closeSettings() {
  side.hidden = true;
  store.set("side", false);
  side.classList.remove("open");
  refreshOverlays();
}
function prefillConnection() {
  const c = creds();
  $("#set-curl").value = c.url; $("#set-ckey").value = c.key; $("#set-cadm").value = c.admin;
  $("#set-cstat").textContent = "";
}
function exportChat() {
  const blob = new Blob([JSON.stringify({ model: $("#pmodel").value, system: $("#psys").value, messages: conv.messages.map((m) => ({ ...wire(m), ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) })) }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `kono-chat-${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href);
}
function confirmDialog(msg, ok, label = "Clear all") {
  $("#dconfirm-msg").textContent = msg;
  $("#dconfirm-ok").textContent = label;
  const d = $("#dconfirm");
  d.showModal();
  d.addEventListener("close", () => { if (d.returnValue === "ok") ok(); }, { once: true });
}
function openChangelog() {
  const pre = $("#changelog-content"); pre.textContent = "Loading…";
  $("#dchangelog").showModal();
  fetch("CHANGES.md").then((r) => r.text()).then((t) => { pre.textContent = t; }).catch((e) => { pre.textContent = "Changelog unavailable: " + e.message; });
}
(function loadParams() {
  const p = store.get("params", {});
  for (const id of PARAMS) if (p[id] !== undefined) { const el = $("#" + id); el.type === "checkbox" ? el.checked = p[id] : el.value = p[id]; }
  $("#ptempv").textContent = $("#ptemp").value;
  if (innerWidth <= 860 || store.get("side") === false) $("#side").hidden = true;
})();
function saveParams() {
  const p = {};
  for (const id of PARAMS) { const el = $("#" + id); p[id] = el.type === "checkbox" ? el.checked : el.value; }
  store.set("params", p);
}
for (const id of PARAMS) $("#" + id).addEventListener("input", saveParams);
$("#ptemp").addEventListener("input", () => $("#ptempv").textContent = $("#ptemp").value);
$("#cside").onclick = () => { go("chat"); openSettings(); };

// ---- chat persistence -------------------------------------------------------
// The stored copy is trimmed: reasoning traces, oversized tool results and
// tool-call arguments (whole file contents ride in fs_write calls) are what
// used to blow the localStorage quota and silently end saving — the old
// saveConv swallowed the failure and its fallback dropped only images. The
// router keeps the same trimmed copy per session (/v1/conversations), so a
// full browser store no longer means a lost chat.
const STORE_MARK = "…[trimmed for storage]";
const capStr = (s, n) => typeof s === "string" && s.length > n ? s.slice(0, n) + STORE_MARK : s;
function capToolArgs(args) {
  if (typeof args !== "string") return args;
  try {
    const o = JSON.parse(args);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      let changed = false;
      for (const key of Object.keys(o)) if (typeof o[key] === "string" && o[key].length > 4000) { o[key] = capStr(o[key], 4000); changed = true; }
      return changed ? JSON.stringify(o) : args;
    }
  } catch { /* not JSON: cap the raw string below */ }
  return capStr(args, 4000);
}
function persistedConv(lean = false) {
  const savedAt = Date.now();
  conv.savedAt = savedAt;
  return {
    savedAt,
    messages: conv.messages.map((m) => {
      const o = { role: m.role };
      const capBody = (s) => lean && m.role === "assistant" ? capStr(s, 20000) : s;
      if (Array.isArray(m.content)) o.content = m.content.filter((b) => !lean || b.type !== "image_url").map((b) => b.type === "text" ? { ...b, text: capBody(b.text) } : b);
      else o.content = capBody(m.content);
      if (m.role === "tool") {
        if (typeof o.content === "string") o.content = capStr(o.content, 4000);
        if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
        if (m.name) o.name = m.name;
      }
      if (m.tool_calls?.length) o.tool_calls = m.tool_calls.map((t) => ({ ...t, function: t.function ? { ...t.function, arguments: capToolArgs(t.function.arguments) } : t.function }));
      if (m._m && (m._m.trace || m._m.feedback)) o._m = { ...(m._m.trace ? { trace: m._m.trace } : {}), ...(m._m.feedback ? { feedback: m._m.feedback } : {}) };
      return o;
    }),
  };
}
let convLocalOk = true;   // last local write result
let convServerOk = null;   // null until a server save attempt settles
let convSaveToastShown = false;
let convPutTimer = 0;
function noteSaveState() {
  if (!convLocalOk && convServerOk === false && !convSaveToastShown) {
    convSaveToastShown = true;
    toast("chat could not be saved — storage full and server unreachable", true);
  }
}
async function putConv(copy, keepalive = false) {
  try {
    const res = await fetch(creds().url + "/v1/conversations/current", { method: "PUT", headers: headers(), body: JSON.stringify({ saved: copy.savedAt, messages: copy.messages }), ...(keepalive ? { keepalive: true } : {}) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    convServerOk = true;
  } catch { convServerOk = false; noteSaveState(); }
}
function saveConv() {
  const copy = persistedConv();
  convLocalOk = store.set("chat", copy);
  if (!convLocalOk) convLocalOk = store.set("chat", persistedConv(true));
  if (!convLocalOk) noteSaveState();
  clearTimeout(convPutTimer);
  convPutTimer = setTimeout(() => putConv(copy), 600);
}
// A closing or hidden tab gets one last synchronous local write plus a
// keepalive PUT — the debounced save alone would die with the page.
function flushConv() {
  const copy = persistedConv();
  convLocalOk = store.set("chat", copy) || store.set("chat", persistedConv(true));
  if (!convLocalOk) noteSaveState();
  putConv(copy, true);
}
addEventListener("pagehide", flushConv);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushConv(); });
// Boot restore: the server copy wins when it is newer than the local one.
async function restoreConvFromServer() {
  try {
    const d = await req("/v1/conversations/current");
    if (!d || !Array.isArray(d.messages) || typeof d.saved !== "number" || d.saved <= (conv.savedAt || 0)) return;
    conv.messages = d.messages;
    conv.savedAt = d.saved;
    store.set("chat", { savedAt: d.saved, messages: d.messages });
    renderThread(); updateModelHint();
  } catch { /* no server copy (404) or offline: the local chat stands */ }
}
const wire = (m) => {
  const o = { role: m.role, content: m.content };
  if (m.tool_calls?.length) o.tool_calls = m.tool_calls;
  if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
  if (m.name) o.name = m.name;
  return o;
};
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";

// ---- rendering ----
const thread = $("#thread");
const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
function answeredIds(i) {
  const s = new Set();
  for (let j = i + 1; j < conv.messages.length && conv.messages[j].role === "tool"; j++) s.add(conv.messages[j].tool_call_id);
  return s;
}
function msgEl(m, i) {
  const el = document.createElement("article");
  el.dataset.i = i;
  if (m.role === "user") {
    el.className = "msg u";
    const imgs = Array.isArray(m.content) ? m.content.filter((b) => b.type === "image_url").map((b) => `<img src="${esc(b.image_url.url)}" alt="attachment">`).join("") : "";
    const rawText = textOf(m.content);
    const lines = (rawText.match(/\n/g) || []).length + 1;
    const isLong = lines > 6 || rawText.length > 350;

    const head = document.createElement("div");
    head.className = "u-header";
    head.innerHTML = `<span class="dim" style="font-size:11px">You</span><span class="u-avatar">U</span>`;

    const body = document.createElement("div");
    body.className = "body md" + (isLong ? " clamped" : "");
    if (imgs) body.innerHTML = imgs;
    renderMd(body, rawText, true);

    el.replaceChildren(head, body);
    if (isLong) {
      const expBtn = document.createElement("button");
      expBtn.className = "btn-expand-msg";
      expBtn.textContent = `Show more (${lines} lines) ▾`;
      expBtn.onclick = () => {
        const clamped = body.classList.toggle("clamped");
        expBtn.textContent = clamped ? `Show more (${lines} lines) ▾` : "Show less ▴";
      };
      el.appendChild(expBtn);
    }
  } else if (m.role === "tool") {
    el.className = "msg t";
    el.innerHTML = `<div class="body"><span class="dim">${esc(m.name ?? "")} ${esc(m.tool_call_id)} →</span> ${esc(textOf(m.content))}</div>`;
  } else {
    el.className = "msg a";
    el.innerHTML = `<div class="meta"></div><details class="rs" hidden><summary></summary><div class="rleg"><i class="rk-plan">plan</i><i class="rk-check">check</i><i class="rk-doubt">doubt</i><i class="rk-done">conclusion</i><i class="rk-q">question</i></div><div class="rb"></div></details><div class="md"></div><div class="tcalls"></div><div class="foot"></div>`;
    paint(el, m, i);
  }
  return el;
}
function paint(el, m, i) {
  const k = m._m ?? {};
  const live = Boolean(k.live);
  const meta = [];
  if (k.degraded) meta.push(`<span class="warn">degraded · every endpoint failed · no answer fabricated</span>`);
  else if (live && !k.ttft) meta.push(`<span class="live">${k.routing ? `routing · ${k.routing} attempts` : "routing"}</span>`);
  else if (live && k.toolRun) meta.push(`<span class="live">tool round ${esc(k.rounds)} · ${esc(k.toolRun)}</span>`);
  else if (live) meta.push(`<span class="live">streaming</span>`);
  if (k.tuple) meta.push(`<b title="${esc(k.provider ?? "")}">${esc(k.tuple)}</b>`);
  $(".meta", el).innerHTML = meta.join("");
  const rs = $("details.rs", el);
  if (m.reasoning_content) {
    rs.hidden = false;
    // Open while thinking, folded once the answer streams; a manual toggle owns it for the rest of the turn.
    if (live && !k.rsTouched) rsSet(rs, k, !m.content);
    const rb = $(".rb", rs), stick = rb.scrollHeight - rb.scrollTop - rb.clientHeight < 40;
    const r = rsRender(rb, m.reasoning_content, !live);
    const thinking = live && !m.content;
    $("summary", rs).innerHTML = `<span class="rhd">${thinking ? "thinking" : "reasoning"} · ${kfmt(m.reasoning_content.length)} chars${k.rsMs ? ` · ${ms(k.rsMs)}` : ""}</span>${rsStrip(r.mix)}${thinking && !rs.open && r.last ? `<span class="rtail">${esc(r.last)}</span>` : ""}`;
    if (stick) rb.scrollTop = rb.scrollHeight;
  }
  renderMd($(".md", el), m.content ?? "", !live);
  const tc = $(".tcalls", el);
  if (m.tool_calls?.length) {
    const done = answeredIds(i);
    const open = !live && i === conv.messages.length - 1 && m.tool_calls.some((t) => !done.has(t.id));
    tc.innerHTML = m.tool_calls.map((t) => {
      let args = t.function?.arguments ?? "";
      try { args = JSON.stringify(JSON.parse(args), null, 2); } catch { /* partial JSON while streaming */ }
      return `<div class="tc"><div class="h"><b>${esc(t.function?.name ?? "")}</b><span class="dim">${esc(t.id ?? "")}</span></div><pre>${esc(args)}</pre>${open ? `<textarea data-id="${esc(t.id)}" data-name="${esc(t.function?.name ?? "")}" aria-label="Result for ${esc(t.function?.name ?? "")}" placeholder="result"></textarea>` : ""}</div>`;
    }).join("") + (open ? `<div class="row"><button class="btn" data-act="results">send ${m.tool_calls.length} result${m.tool_calls.length > 1 ? "s" : ""}</button></div>` : "");
  } else tc.innerHTML = "";
  const foot = [];
  if (k.error) foot.push(`<span class="err">${esc(k.error)}</span>`);
  if (!live) {
    if (k.ttft) foot.push(`ttft ${ms(k.ttft)}`);
    if (k.total) foot.push(`total ${ms(k.total)}`);
    const gen = (k.total ?? 0) - (k.ttft ?? 0);
    if (k.chars && gen > 0) foot.push(`${f(k.chars / 4 / (gen / 1000), 0)} tok/s`);
    if (k.rounds) foot.push(`${esc(k.rounds)} tool round${Number(k.rounds) > 1 ? "s" : ""}${k.executed?.length ? ` · ${esc(k.executed.map((t) => t.tool).join(", "))}` : ""}`);
    if (k.finish) foot.push(esc(k.finish));
    if (k.trace) foot.push(`<button data-act="trace" data-tr="${esc(k.trace)}">trace</button>`);
    if (m.content) foot.push(`<button data-act="copy">copy</button>`);
    if (k.trace && m.content) {
      foot.push(`<button data-act="fb-up" data-on="${k.feedback === "thumbs_up" ? 1 : 0}" title="good answer — teach the router">👍</button>`);
      foot.push(`<button data-act="fb-down" data-on="${k.feedback === "thumbs_down" ? 1 : 0}" title="bad answer — teach the router">👎</button>`);
    }
    if (i === conv.messages.length - 1) foot.push(`<button data-act="retry">retry</button>`);
  }
  $(".foot", el).innerHTML = foot.join(" · ");
}
function renderThread() {
  thread.replaceChildren(...conv.messages.map(msgEl));
  thread.scrollTop = thread.scrollHeight;
}
thread.addEventListener("toggle", (e) => {
  const el = e.target.closest?.("article"); if (!el || !e.target.matches("details.rs")) return;
  const m = conv.messages[el.dataset.i];
  // Auto open/fold also fires toggle; only a state the code did not ask for is the user's.
  if (m?._m && e.target.open !== m._m.rsWant) m._m.rsTouched = true;
}, true);
function rsSet(rs, k, open) { if (rs.open !== open) { k.rsWant = open; rs.open = open; } }
// Sentence-level cue classes for the reasoning trace. First match wins, so
// corrections outrank conclusions ("but so…" is a doubt, not an answer).
const RK = [
  ["doubt", /^(wait|hmm+|actually|but\b|however|no[,.!]|oops|hold on|on second thought|alternatively|maybe|perhaps|though\b|that'?s (wrong|not))/i],
  ["check", /^(check|verify|test|double[- ]check|confirm|sanity|make sure|let'?s (check|verify|test|confirm))/i],
  ["done", /^(so\b|thus|therefore|hence|answer|final|in (summary|short|conclusion)|overall|that (means|gives)|result|ok(ay)?,? so|done\b)/i],
  ["plan", /^(first|then\b|next|now\b|step|let'?s|let me|i('ll| will| need| should| can| must)|we (need|should|can|must|will)|plan|approach|goal|(\d+[.)]|[-*•])\s)/i],
];
const RK_VAR = { plan: "--blue", check: "--vio", doubt: "--warn", done: "--ok", q: "--fg", "": "--line-2" };
function rkClass(t) { t = t.trim(); for (const [c, re] of RK) if (re.test(t)) return c; return /\?["')\]]*$/.test(t) ? "q" : ""; }
const RS_PIECE = /[^.!?\n]*(?:[.!?]+["')\]]*|\n+|$)\s*/g;
function rsPieces(text, into, mix) {
  for (const p of text.match(RS_PIECE) ?? []) {
    if (!p) continue;
    const c = p.trim() ? rkClass(p) : "";
    mix[c] = (mix[c] ?? 0) + p.length;
    const last = into.lastChild;
    if (last && last.dataset.c === c) { last.textContent += p; continue; }
    const s = document.createElement("span");
    s.dataset.c = c;
    if (c) s.className = "rk-" + c;
    s.textContent = p;
    into.appendChild(s);
  }
}
// Incremental: complete sentences are appended once; only the open tail is
// rebuilt per frame, so a long trace costs O(new text), not O(total).
function rsRender(rb, text, final) {
  if (!rb._st || text.length < rb._st.n || !text.startsWith(rb._st.head)) {
    rb.replaceChildren();
    rb._st = { n: 0, mix: {}, head: text.slice(0, 64), tail: document.createElement("span") };
  }
  const st = rb._st;
  let cut = text.length;
  if (!final) {
    const re = /[.!?\n]["')\]]*\s+/g; re.lastIndex = st.n; let mm, end = st.n;
    while ((mm = re.exec(text))) end = mm.index + mm[0].length;
    cut = end;
  }
  if (cut > st.n) { st.tail.remove(); rsPieces(text.slice(st.n, cut), rb, st.mix); st.n = cut; }
  const tailMix = {};
  st.tail.replaceChildren();
  rsPieces(text.slice(st.n), st.tail, tailMix);
  if (st.tail.firstChild) rb.appendChild(st.tail);
  const mix = { ...st.mix };
  for (const [c, n] of Object.entries(tailMix)) mix[c] = (mix[c] ?? 0) + n;
  const sentences = text.trim().split(/(?<=[.!?\n])\s+/);
  return { mix, last: (sentences.at(-1) ?? "").slice(-140) };
}
function rsStrip(mix) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  if (!total) return "";
  return `<span class="rstrip" aria-hidden="true">${["plan", "check", "doubt", "done", "q", ""].filter((c) => mix[c]).map((c) => `<i style="flex:${mix[c]};background:var(${RK_VAR[c]})"></i>`).join("")}</span>`;
}
thread.onclick = async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const el = b.closest("article"), i = Number(el.dataset.i), m = conv.messages[i];
  if (b.dataset.act === "trace") openTrace(b.dataset.tr);
  else if (b.dataset.act === "copy") navigator.clipboard.writeText(m.content).then(() => toast("copied"));
  else if (b.dataset.act === "fb-up" || b.dataset.act === "fb-down") {
    // Explicit delayed reward: joins to the routing decision by trace id and
    // updates the (tuple, task class) posterior server-side.
    const signal = b.dataset.act === "fb-up" ? "thumbs_up" : "thumbs_down";
    const tr = m._m?.trace;
    if (!tr) return;
    m._m.feedback = signal; saveConv(); paint(el, m, i);
    req("/v1/feedback", { method: "POST", body: { trace_id: tr, signal } })
      .then((r) => toast(r.applied ? "feedback recorded — the router learned from it" : `feedback not applied (${r.reason ?? "rejected"})`))
      .catch((err) => toast(`feedback failed: ${err.message}`, true));
  }
  else if (b.dataset.act === "retry") {
    if (chatCtl) return;
    // Retrying an answer is an implicit negative for the decision behind it.
    const lastA = [...conv.messages].reverse().find((x) => x.role === "assistant" && x._m?.trace);
    if (lastA) req("/v1/feedback", { method: "POST", body: { trace_id: lastA._m.trace, signal: "regenerate" } }).catch(() => {});
    while (conv.messages.length && conv.messages.at(-1).role !== "user" && conv.messages.at(-1).role !== "tool") conv.messages.pop();
    saveConv(); renderThread(); complete();
  } else if (b.dataset.act === "results") {
    for (const ta of $$("textarea[data-id]", el)) conv.messages.push({ role: "tool", tool_call_id: ta.dataset.id, name: ta.dataset.name, content: ta.value || "(empty)" });
    saveConv(); renderThread(); complete();
  }
};

// ---- completion ----
function busy(on) { $("#csend").hidden = on; $("#cstop").hidden = !on; }
// One-shot: the next reply runs the build gate even if it changes nothing (fix-errors).
let gateAlways = false;
// App Builder's Generate (studio.js) sets this just before sendChat(): the
// next complete() consumes it and runs as a builder request — fresh wire
// context (the phased build prompt only), an explicit output budget, and
// kono_builder for the server's deterministic builder policy. Length-
// continuation state rides on the object; complete() clears the slot at once.
let builderReq = null;
async function complete() {
  const breq = builderReq; builderReq = null;
  const max = $("#pmax").value.trim();
  if (max && (!Number.isSafeInteger(Number(max)) || Number(max) < 1)) { toast("max tokens must be a positive whole number", true); return; }
  const m = { role: "assistant", content: "", _m: { live: true } };
  const i = conv.messages.push(m) - 1;
  const el = msgEl(m, i);
  thread.append(el);
  thread.scrollTop = thread.scrollHeight;
  const sys = $("#psys").value.trim();
  const stream = $("#pstream").checked;
  const body = {
    model: $("#pmodel").value.trim() || "free:auto",
    messages: [...(sys ? [{ role: "system", content: sys }] : []), ...conv.messages.slice(0, i).map(wire)],
    temperature: Number($("#ptemp").value),
    max_tokens: chatTokenBudget(conv.messages.slice(0, i), sys),
    stream,
    ...($("#peffort").value ? { reasoning_effort: $("#peffort").value } : {}),
    // Tools are supplied behind the scenes: tools:"auto" attaches the
    // router's own tool plane and the router runs the agent loop server-
    // side. The dashboard never forwards client tool definitions and never
    // asks the user to hand-feed tool results into the prompt.
    ...($("#pauto").checked ? { tools: "auto", kono_rounds: 16, ...(wsp.runnerOk ? { kono_runner: true } : {}), ...(gateAlways ? { kono_gate: "always" } : {}) } : {}),
  };
  gateAlways = false;
  if (breq) {
    body.kono_builder = true;
    body.max_tokens = 16384;
    body.temperature = 0.2;
    body.messages = [...(sys ? [{ role: "system", content: sys }] : []), { role: "user", content: breq.prompt }];
  }
  const k = m._m, t0 = performance.now();
  let frame = 0;
  const repaint = () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; const stick = nearBottom(); paint(el, m, i); if (stick) thread.scrollTop = thread.scrollHeight; }); };
  chatCtl = new AbortController();
  busy(true);
  let streamSaveAt = 0;
  // One dispatch against the given wire messages, streamed into m. Split
  // out so a length-truncated builder reply continues into the SAME
  // message instead of starting a new one.
  const attempt = async (wireMessages) => {
    const res = await req("/v1/chat/completions", { method: "POST", body: { ...body, messages: wireMessages }, signal: chatCtl.signal, raw: true });
    k.trace = (res.headers.get("traceparent") ?? "").split("-")[1] ?? "";
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(`${res.status} ${j?.error?.message ?? ""}`.trim()); }
    if (!stream) {
      const j = await res.json();
      const msg = j.choices?.[0]?.message ?? {};
      const prior = m.content ?? "";
      Object.assign(m, { content: prior + (msg.content ?? ""), ...(msg.reasoning_content ? { reasoning_content: (m.reasoning_content ?? "") + msg.reasoning_content } : {}), ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
      Object.assign(k, { ttft: j.telemetry?.observed_ttft_ms, finish: j.choices?.[0]?.finish_reason, tuple: j.kono?.tuple_id, provider: j.provider, degraded: j.kono?.degraded, rounds: j.kono?.tool_rounds, executed: j.kono?.tools_executed });
    } else {
      let rs0 = 0;
      for await (const { data, comment } of sse(res, chatCtl.signal)) {
        const hb = /routing attempts=(\d+)/.exec(comment);
        if (hb) { k.routing = Number(hb[1]); repaint(); }
        if (!data || data === "[DONE]") continue;
        const j = JSON.parse(data);
        if (j.error) throw new Error(j.error.message);
        // Router status frames carry bookkeeping only (empty choices): the
        // plane ran a tool round itself and is about to re-dispatch.
        if (j.kono?.type === "tool_round") {
          k.rounds = j.kono.round;
          k.toolRun = (j.kono.tools ?? []).map((t) => `${t.name}${t.ok ? "" : " ✗"}`).join(", ");
          if ((j.kono.tools ?? []).some((t) => WSP_TOUCH.test(t.name))) { k.touched = true; wspProbe(); }
          repaint();
          continue;
        }
        // The router's build gate sent the agent back: show why, keep streaming.
        if (j.kono?.type === "build_gate") {
          const g = j.kono;
          k.gate = g.gate_round;
          k.toolRun = `build gate ${g.gate_round}: ` + [g.static_errors ? `${g.static_errors} static` : "", g.runtime_errors ? `${g.runtime_errors} runtime` : "", g.tests?.failed ? `${g.tests.failed} failing tests` : "", !g.static_errors && !g.runtime_errors && !g.tests ? "untested" : ""].filter(Boolean).join(", ") + " — continuing";
          k.touched = true;
          wspProbe();
          repaint();
          continue;
        }
        const d = j.choices?.[0]?.delta ?? {};
        if (!k.ttft && (d.content || d.reasoning_content || d.tool_calls)) k.ttft = performance.now() - t0;
        if (d.reasoning_content) { m.reasoning_content = (m.reasoning_content ?? "") + d.reasoning_content; rs0 ||= performance.now(); }
        if (d.content) { m.content += d.content; if (rs0 && !k.rsMs) k.rsMs = performance.now() - rs0; }
        for (const t of d.tool_calls ?? []) {
          m.tool_calls ??= [];
          const c = m.tool_calls[t.index] ??= { id: t.id, type: t.type ?? "function", function: { name: "", arguments: "" } };
          if (t.id) c.id = t.id;
          c.function.name += t.function?.name ?? "";
          c.function.arguments += t.function?.arguments ?? "";
        }
        if (j.provider) k.provider = j.provider;
        if (j.choices?.[0]?.finish_reason) k.finish = j.choices[0].finish_reason;
        if (j.kono) { k.tuple = j.kono.tuple_id ?? k.tuple; k.degraded = j.kono.degraded; k.rounds = j.kono.tool_rounds ?? k.rounds; }
        if (performance.now() - streamSaveAt > 5000) { streamSaveAt = performance.now(); saveConv(); }
        repaint();
      }
    }
  };
  try {
    await attempt(body.messages);
    // A builder reply that hit the output ceiling continues in place: the
    // model picks up from its own partial output, in the same message.
    while (breq && !k.error && k.finish === "length" && breq.continuations < 2) {
      breq.continuations++;
      k.finish = null;
      await attempt([...(sys ? [{ role: "system", content: sys }] : []), { role: "user", content: breq.prompt }, { role: "assistant", content: m.content ?? "" }, { role: "user", content: "Continue exactly where the output stopped. Do not repeat any content." }]);
    }
  } catch (e) {
    k.error = e.name === "AbortError" ? "stopped" : e.message;
  }
  if (!m.content && m.tool_calls?.length) m.content = null;
  k.total = performance.now() - t0;
  k.chars = (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0);
  k.live = false;
  if (frame) cancelAnimationFrame(frame), frame = 0;
  chatCtl = null;
  busy(false);
  const stick = nearBottom();
  paint(el, m, i);
  if (stick) thread.scrollTop = thread.scrollHeight;
  saveConv(); updateModelHint();
  if (k.degraded) toast("every upstream endpoint failed — router returned its status message", true);
  // Files the agent wrote this turn show up in the workspace without waiting for the poll.
  if (k.touched) wspProbe(); else if (wsp.open) wsRefresh(true);
  // The dashboard declares no client tools: any call reaching it is the router's, so run it — never ask.
  if (!k.error && m.tool_calls?.length && !answeredIds(i).size && autoToolTurns++ < 4) await answerToolCalls(m);
}
let autoToolTurns = 0;
async function answerToolCalls(m) {
  try {
    const d = await req("/v1/tools/execute", { method: "POST", admin: true, body: { calls: m.tool_calls } });
    m.tool_calls.forEach((t, j) => {
      const r = d.results?.[j] ?? {};
      conv.messages.push({ role: "tool", tool_call_id: t.id, name: t.function?.name ?? "", content: JSON.stringify(r.ok ? r.result : { error: r.error || r.code || "tool failed" }) });
    });
  } catch (e) { toast(`tool run failed: ${e.message}`, true); return; }
  saveConv(); renderThread(); await complete();
}
async function sendChat() {
  if (chatCtl) return;
  const text = $("#cinput").value.trim();
  if (!text && !attachments.length) return;
  autoToolTurns = 0;
  const max = $("#pmax").value.trim();
  if (max && (!Number.isSafeInteger(Number(max)) || Number(max) < 1)) { toast("max tokens must be a positive whole number", true); return; }
  const content = attachments.length ? [{ type: "text", text }, ...attachments.map((url) => ({ type: "image_url", image_url: { url } }))] : text;
  conv.messages.push({ role: "user", content });
  $("#cinput").value = ""; store.del("draft"); autosize($("#cinput"));
  attachments = []; renderAttach();
  saveConv();
  // Full re-render: a pending tool-call card above drops its inputs once the user moves on.
  renderThread();
  await complete();
}
$("#csend").onclick = sendChat;
$("#cstop").onclick = () => chatCtl?.abort();
// ---- parallel runs + judge --------------------------------------------------
// One prompt, several models at once. The panel shows every request
// live; when all settle, a judge pass scores the answers. A 100%-
// confident judge adopts its pick into the thread; anything less and
// the candidates come back to the user, presented to fit their kind
// (apps get a sandbox preview, code a code block, prose a readable card).
let parRunning = false;

function parallelModels(n) {
  const base = $("#cmodel")?.value.trim() || "free:auto";
  return [...new Set([base, "free:smart", "free:code", "free:reasoning"])].slice(0, n);
}
function parLetter(i) { return String.fromCharCode(65 + i); }

async function parFetch(model, messages, rounds = 8) {
  const body = { model, messages, stream: false, ...(rounds > 0 && $("#pauto")?.checked ? { tools: "auto", kono_rounds: rounds } : {}) };
  const d = await req("/v1/chat/completions", { method: "POST", body });
  const text = d.choices?.[0]?.message?.content ?? "";
  if (!String(text).trim()) throw new Error("empty answer");
  return String(text);
}

function renderParJobs(jobs) {
  const box = $("#par-jobs");
  if (!box) return;
  const running = jobs.filter((j) => j.status === "running").length;
  $("#par-status").textContent = running ? `${running} of ${jobs.length} requests running…` : "all requests finished";
  box.innerHTML = jobs.map((j, i) => `<div class="par-job ${j.status}">
    <span class="par-letter">${parLetter(i)}</span>
    <span class="par-model">${esc(j.model)}</span>
    <span class="par-state">${j.status === "running" ? "running · " + Math.round((Date.now() - j.t0) / 1000) + "s" : j.status === "done" ? "done · " + (j.ms / 1000).toFixed(1) + "s" : "failed" + (j.error ? " · " + esc(j.error) : "")}</span>
  </div>`).join("");
}

function parKind(text) {
  if (/```html|<!doctype html|<html[\s>]/i.test(text)) return "html";
  if (/```/.test(text)) return "code";
  return "text";
}
function parHtmlCode(text) {
  const m = text.match(/```html\n([\s\S]*?)```/);
  return m ? m[1] : text.trim();
}

async function runParallel() {
  if (parRunning) { toast("a parallel run is already going"); return; }
  const prompt = $("#cinput").value.trim();
  if (!prompt) { toast("type the prompt first, then run it in parallel", true); return; }
  const models = parallelModels(Number($("#cparallel-n")?.value || 3));
  parRunning = true;
  // The prompt enters the thread once, exactly like a normal send.
  conv.messages.push({ role: "user", content: prompt });
  $("#cinput").value = ""; autosize($("#cinput"));
  saveConv(); renderThread();
  const panel = $("#par-panel");
  panel.hidden = false;
  $("#par-results").innerHTML = "";
  $("#par-title").textContent = `Parallel run — ${models.length} models, one prompt`;
  const jobs = models.map((model) => ({ model, status: "running", t0: Date.now(), ms: 0, content: "", error: "" }));
  renderParJobs(jobs);
  const timer = setInterval(() => renderParJobs(jobs), 500);
  const sys = $("#psys").value.trim();
  const messages = [...(sys ? [{ role: "system", content: sys }] : []), ...conv.messages.map(wire)];
  await Promise.allSettled(jobs.map(async (j) => {
    try { j.content = await parFetch(j.model, messages); j.status = "done"; }
    catch (e) { j.status = "error"; j.error = e.message || String(e); }
    j.ms = Date.now() - j.t0;
    renderParJobs(jobs);
  }));
  clearInterval(timer);
  renderParJobs(jobs);
  parRunning = false;
  const done = jobs.filter((j) => j.status === "done");
  if (!done.length) {
    $("#par-results").innerHTML = `<div class="par-note">Every request failed — nothing to judge. Check the connection and try again.</div>`;
    return;
  }
  if (done.length === 1) { adoptParAnswer(done[0], jobs, "Only one request finished, so there was nothing to judge."); return; }
  await judgeParAnswers(prompt, jobs, done);
}

async function judgeParAnswers(prompt, jobs, done) {
  $("#par-status").textContent = "judging the answers…";
  let verdict = null;
  try {
    const parts = done.map((j) => `--- ANSWER ${parLetter(jobs.indexOf(j))} (model ${j.model}) ---\n${j.content.slice(0, 5000)}`).join("\n\n");
    const judgePrompt = [
      "You are the judge. Several models answered the same user request. Pick the single best answer.",
      "Judge on correctness, completeness, and how directly it satisfies the request. Do not reward length by itself.",
      'Reply with ONLY a JSON object, no other text: {"winner": <answer number, counting only the answers shown, starting at 1>, "confidence": <0 to 1>, "reason": "<one sentence>", "scores": [<one 0-10 score per answer, in the order shown>]}',
      "confidence is how sure you are that the winner is clearly the best. Use 1 only when it is not close.",
      "", "USER REQUEST:", prompt, "", parts,
    ].join("\n");
    const raw = await parFetch("free:smart", [{ role: "user", content: judgePrompt }], 0);
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) verdict = JSON.parse(m[0]);
  } catch { verdict = null; }
  const winnerJob = verdict ? done[Number(verdict.winner) - 1] : null;
  const conf = verdict ? Number(verdict.confidence) : NaN;
  if (winnerJob && conf >= 0.999) { adoptParAnswer(winnerJob, jobs, verdict.reason || "The judge was 100% confident.", verdict); return; }
  presentParChoices(jobs, done, verdict);
}

function adoptParAnswer(job, jobs, note, verdict) {
  const doneCount = jobs.filter((j) => j.status === "done").length;
  const foot = verdict
    ? `\n\n*⚖️ Judge's pick — answer ${parLetter(jobs.indexOf(job))} (${job.model}) from ${doneCount} parallel answers, confidence ${Math.round(Number(verdict.confidence) * 100)}%. ${verdict.reason || ""}*`
    : `\n\n*⚖️ ${note}*`;
  conv.messages.push({ role: "assistant", content: job.content + foot });
  saveConv(); renderThread();
  $("#par-status").textContent = "done — the judge's pick is in the thread";
  $("#par-results").innerHTML = `<div class="par-note">⚖️ <b>Answer ${parLetter(jobs.indexOf(job))}</b> (${esc(job.model)}) was adopted into the thread. ${esc(note)}</div>`;
}

function presentParChoices(jobs, done, verdict) {
  const lean = verdict && done[Number(verdict.winner) - 1] ? `the judge leaned ${parLetter(jobs.indexOf(done[Number(verdict.winner) - 1]))} but was only ${Math.round(Number(verdict.confidence) * 100)}% confident — your call` : "the judge couldn't decide — your call";
  $("#par-status").textContent = lean;
  const box = $("#par-results");
  box.innerHTML = (verdict?.reason ? `<div class="par-note">Judge's note: ${esc(verdict.reason)}</div>` : "") + done.map((j) => {
    const i = jobs.indexOf(j);
    const kind = parKind(j.content);
    const score = verdict?.scores?.[done.indexOf(j)];
    const body = kind === "text"
      ? `<div class="par-text">${esc(j.content.slice(0, 4000))}</div>`
      : `<pre class="par-code">${esc(j.content.slice(0, 6000))}</pre>`;
    return `<div class="par-card">
      <div class="par-card-h"><span class="par-letter">${parLetter(i)}</span><b>${esc(j.model)}</b><span class="dim">${(j.ms / 1000).toFixed(1)}s${score != null ? " · judge score " + esc(String(score)) + "/10" : ""} · ${kind === "html" ? "app" : kind}</span>
      <span style="margin-left:auto;display:flex;gap:6px">${kind === "html" ? `<button class="btn q" data-par-preview="${i}">▶ preview</button>` : ""}<button class="btn" data-par-use="${i}">Use this answer</button></span></div>
      ${body}
    </div>`;
  }).join("");
  box.querySelectorAll("[data-par-use]").forEach((b) => b.addEventListener("click", () => {
    const idx = Number(b.dataset.parUse);
    const job = jobs[idx];
    conv.messages.push({ role: "assistant", content: job.content + `\n\n*⚖️ Your pick from ${done.length} parallel answers (answer ${parLetter(idx)}, ${job.model}).*` });
    saveConv(); renderThread();
    $("#par-results").innerHTML = `<div class="par-note">⚖️ Answer ${parLetter(idx)} is in the thread.</div>`;
    $("#par-status").textContent = "done — your pick is in the thread";
  }));
  box.querySelectorAll("[data-par-preview]").forEach((b) => b.addEventListener("click", () => {
    const idx = Number(b.dataset.parPreview);
    launchAppSandbox(parHtmlCode(jobs[idx].content), "Parallel answer " + parLetter(idx));
  }));
}

$("#cparallel-run")?.addEventListener("click", runParallel);
$("#par-close")?.addEventListener("click", () => { $("#par-panel").hidden = true; });


function updateInputStats(t) {
  const meta = $("#cinput-meta");
  if (!meta) return;
  const val = t.value;
  const lines = val ? (val.match(/\n/g) || []).length + 1 : 0;
  if (lines > 1 || val.length > 80) {
    meta.hidden = false;
    $("#cline-info").textContent = `${lines} line${lines > 1 ? "s" : ""} · ${val.length} char${val.length === 1 ? "" : "s"}`;
  } else {
    meta.hidden = true;
  }
}

function autosize(t) {
  if (document.querySelector(".composer.expanded")) {
    t.style.height = "100%";
    updateInputStats(t);
    return;
  }
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight + 2, innerHeight * 0.42) + "px";
  updateInputStats(t);
}

$("#cinput").value = store.get("draft", "");
autosize($("#cinput"));
$("#cinput").addEventListener("input", (e) => { autosize(e.target); store.set("draft", e.target.value); });
$("#cinput").addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s = e.target.selectionStart, end = e.target.selectionEnd;
    e.target.value = e.target.value.substring(0, s) + "  " + e.target.value.substring(end);
    e.target.selectionStart = e.target.selectionEnd = s + 2;
    autosize(e.target);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    if (document.querySelector(".composer.expanded")) {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); sendChat(); }
      return;
    }
    e.preventDefault();
    sendChat();
  }
});

$("#cexpand").onclick = () => {
  const comp = document.querySelector(".composer");
  const isExp = comp.classList.toggle("expanded");
  $("#cexpand").title = isExp ? "Contract editor mode" : "Expand editor mode";
  const icon = $("#cexpand use");
  if (icon) icon.setAttribute("href", isExp ? "#i-shrink" : "#i-expand");
  autosize($("#cinput"));
  $("#cinput").focus();
};

// Thread | composer split: the height the user drags to becomes the input's
// minimum (content still grows it); persisted, double-click resets to auto.
let cinH = store.get("cin.h", 0);
const cinLayout = () => { $("#cinput").style.setProperty("--cin-h", cinH ? cinH + "px" : "0px"); autosize($("#cinput")); };
splitter($("#cin-split"), {
  axis: "y",
  get: () => -Math.max(cinH, $("#cinput").getBoundingClientRect().height),
  set: (v) => { cinH = -v; },
  min: () => -Math.max(80, Math.round($("#chat-col").clientHeight * 0.7)),
  max: () => -40,
  reset: () => { cinH = 0; },
  layout: cinLayout,
  save: () => store.set("cin.h", cinH),
});
cinLayout();

// ---- composer menu ----
const cmenu = $("#cmenu"), cmenuBtn = $("#cmenu-btn");
function cmenuOpen(on) {
  cmenu.hidden = !on;
  cmenuBtn.setAttribute("aria-expanded", String(on));
  if (on) $("button", cmenu).focus();
}
cmenuBtn.onclick = () => cmenuOpen(cmenu.hidden);
document.addEventListener("pointerdown", (e) => { if (!cmenu.hidden && !e.target.closest(".cmenu-wrap")) cmenuOpen(false); });
cmenu.addEventListener("keydown", (e) => {
  const items = $$("button", cmenu), i = items.indexOf(document.activeElement);
  if (e.key === "Escape") { cmenuOpen(false); cmenuBtn.focus(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
});
cmenu.addEventListener("click", (e) => {
  const b = e.target.closest("[data-cm]");
  if (!b) return;
  cmenuOpen(false);
  ({ builder: () => openAppBuilder(), workspace: () => openWorkspace(), image: () => $("#cfile").click(), file: () => $("#cupload").click(), new: () => newChat() })[b.dataset.cm]();
});
// Files go into this chat's durable workspace (uploads/), byte-exact, and the
// composer gets a reference the agent can read with fs_read.
async function uploadFiles(files) {
  const done = [];
  for (const file of files) {
    if (file.size > 2 * 1024 * 1024) { toast(`${file.name}: over the 2 MiB workspace file limit`, true); continue; }
    const path = "uploads/" + file.name.replace(/[^\w.\-]+/g, "_");
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      await wsExec("fs_write", { path, content: btoa(bin), encoding: "base64" });
      done.push(`${path} (${file.size} B)`);
    } catch (err) { toast(`upload ${file.name} failed: ${err.message}`, true); }
  }
  if (!done.length) return;
  const input = $("#cinput");
  input.value = (input.value ? input.value.replace(/\s*$/, "\n") : "") + done.map((d) => `[uploaded to workspace: ${d}]`).join("\n") + "\n";
  autosize(input); input.focus();
  toast(`uploaded ${done.length} file${done.length > 1 ? "s" : ""} to this chat's workspace`);
  if (wsp.open) wsRefresh(true);
}
$("#cupload").onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ""; };

// ---- attachments ----
function renderAttach() {
  $("#attach").innerHTML = attachments.map((u, i) => `<span><img src="${esc(u)}" alt="attachment ${i + 1}"><button data-i="${i}" aria-label="Remove attachment">×</button></span>`).join("");
}
$("#attach").onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) { attachments.splice(Number(b.dataset.i), 1); renderAttach(); } };
function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const r = new FileReader();
    r.onload = () => { attachments.push(r.result); renderAttach(); };
    r.readAsDataURL(file);
  }
}
$("#cfile").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("#cinput").addEventListener("paste", (e) => { const fl = [...e.clipboardData.files]; if (fl.length) { e.preventDefault(); addFiles(fl); } });
const chatView = $("#v-chat");
chatView.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); chatView.classList.add("drop"); } });
chatView.addEventListener("dragleave", (e) => { if (e.target === chatView || !chatView.contains(e.relatedTarget)) chatView.classList.remove("drop"); });
chatView.addEventListener("drop", (e) => { e.preventDefault(); chatView.classList.remove("drop"); addFiles(e.dataTransfer.files); });

function switchChatSession(id) {
  store.set("chat_session", id);
  wsp.cache.clear(); wsp.sel = null; wsp.editing = null; wsp.dirty = false; wsp.entry = ""; wsp.page = ""; wsp.sig = ""; wsp.sigs = null;
  wsFiles = []; wsPrev = null;
  if (wsp.open) { wspRenderTree(); wspInspect(); wsRefresh(true).then(() => wspBuild()); }
}
function newChat() {
  wspGuard(() => {
    if (chatCtl) chatCtl.abort();
    conv.messages = []; saveConv(); renderThread(); updateModelHint();
    // The session is NOT rotated: it namespaces the durable workspace, so
    // a new chat keeps the files the previous chats built. Only loading a
    // library snapshot switches sessions — to the one that built its files.
    $("#cinput").focus();
  });
}
$("#cnew").onclick = newChat;
$("#cexport").onclick = exportChat;
$("#set-export").onclick = exportChat;
enter.chat = () => { if (!thread.childElementCount && conv.messages.length) renderThread(); if (innerWidth > 860) $("#cinput").focus(); };
cmd("new chat", () => { go("chat"); newChat(); });
cmd("toggle settings", () => { go("chat"); openSettings(); }, "chat");

