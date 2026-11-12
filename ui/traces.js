// =====================================================================
// TRACES — live tail + span waterfall
// =====================================================================
const traces = new Map(); // id -> Map(spanId -> span)
let tsel = null, tliveCtl = null, tdirty = false;
const OUT_COLOR = { won: "var(--acc)", failed: "var(--bad)", timeout: "var(--warn)", late: "var(--dim)", cancelled: "var(--line-2)" };
const spanColor = (s) => OUT_COLOR[s.attrs.outcome] ?? (s.status === "error" ? "var(--bad)" : s.end === null ? "var(--blue)" : s.status === "ok" ? "var(--mid)" : "var(--dim)");
function upsert(id, span) {
  let t = traces.get(id);
  if (!t) { t = new Map(); traces.set(id, t); while (traces.size > 300) traces.delete(traces.keys().next().value); }
  t.set(span.id, span);
  if (!tdirty && current === "traces") { tdirty = true; requestAnimationFrame(renderTraces); }
}
function rootOf(t) { for (const s of t.values()) if (!t.has(s.parent)) return s; }
function renderTraces() {
  tdirty = false;
  const q = $("#trfilter").value.trim().toLowerCase(), errOnly = $("#terr").checked;
  const rows = [];
  for (const [id, t] of [...traces].reverse()) {
    const r = rootOf(t); if (!r) continue;
    if (errOnly && r.status !== "error") continue;
    const tuple = r.attrs.tuple ?? "";
    if (q && ![id, r.name, r.attrs["model.requested"], r.attrs.mode, tuple].join(" ").toLowerCase().includes(q)) continue;
    const failed = [...t.values()].filter((s) => s.status === "error" && s.name === "attempt").length;
    rows.push(`<div class="it" role="option" data-id="${id}" aria-current="${id === tsel}"><span class="dot" style="background:${spanColor(r)}"></span>
      <div>${esc(r.name)} <span class="mid">${esc(r.attrs["model.requested"] ?? "")}</span> ${esc(r.attrs.mode ?? "")}<small>${esc(tuple || r.attrs.error || id)}</small></div>
      <div style="text-align:right">${ms((r.end ?? Date.now()) - r.start)}<small>${t.size} spans ${failed ? `<span class="no">${failed}✗</span>` : ""}</small></div></div>`);
  }
  $("#tlist").innerHTML = rows.join("");
  $("#tcount").textContent = `${rows.length}/${traces.size}`;
  if (tsel) renderTraceDetail();
}
// ---- detail pane: request / response / spans, highlighted JSON ----
let ttab = "request", tspan = null;
function traceIo(id) {
  const t = traces.get(id);
  for (const sp of t?.values() ?? []) if (sp.io) return sp.io;
  return null;
}
let tdetailKey = "";
function renderTraceDetail(force = false) {
  const out = $("#trx-out"), t = traces.get(tsel);
  const rr = t && rootOf(t), io = t && traceIo(tsel);
  const key = [tsel, ttab, tspan, t?.size, rr?.end, io?.request?.length, io?.response?.length, ttab === "spans" ? [...(t?.values() ?? [])].map((x) => x.end ?? 0).join() : ""].join("|");
  if (!force && key === tdetailKey) return;
  tdetailKey = key;
  for (const b of $$(".trx-tabs [data-tt]")) b.setAttribute("aria-selected", String(b.dataset.tt === ttab));
  if (!t) { out.innerHTML = `<div class="dim trx-empty">select a trace above</div>`; $("#trx-meta").textContent = ""; return; }
  const r = rootOf(t);
  $("#trx-meta").textContent = `${tsel.slice(0, 12)}… · ${r ? ms((r.end ?? Date.now()) - r.start) : ""} · ${t.size} spans`;
  const json = (text) => `<pre><code>${highlightCode(text, "json")}</code></pre>`;
  if (ttab === "spans") {
    out.innerHTML = `<div class="wf" id="wf"></div>${tspan && t.get(tspan) ? json(JSON.stringify(t.get(tspan), null, 2)) : `<div class="dim trx-empty">select a span for its attributes and events</div>`}`;
    renderWaterfall(tsel);
    return;
  }
  const body = io?.[ttab];
  out.innerHTML = body ? json(body)
    : `<div class="dim trx-empty">${io ? `no ${ttab} recorded yet${r?.end === null ? " — still running" : ""}` : "this trace carries no bodies (recorded for chat completions, image generations and tool executions); see spans"}</div>`;
}
$(".trx-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tt]"); if (b) { ttab = b.dataset.tt; renderTraceDetail(true); } });
function selectTrace(id) {
  tsel = id; tspan = null;
  renderTraces();
  $(`#tlist [data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  // The live tail and the list carry spans; bodies arrive with the full trace.
  if (!traceIo(id)) req("/v1/traces/" + id, { admin: true }).then((full) => { for (const sp of full.spans ?? []) upsert(id, sp); renderTraces(); }).catch(() => {});
}
$("#tlist").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const ids = $$("#tlist [data-id]").map((n) => n.dataset.id);
  if (!ids.length) return;
  const i = ids.indexOf(tsel);
  selectTrace(ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))]);
});
const trxPref = { top: store.get("traces.top", 0.42) };
const trxLayout = () => $("#trx").style.setProperty("--trx-top", (trxPref.top * 100).toFixed(2) + "%");
trxLayout();
splitter($("#trx-split"), {
  axis: "y",
  get: () => $("#tlist").getBoundingClientRect().height,
  set: (px) => { trxPref.top = px / Math.max(1, $("#trx").clientHeight - 60); },
  min: () => 60, max: () => Math.max(60, $("#trx").clientHeight - 140),
  reset: () => { trxPref.top = 0.42; },
  layout: trxLayout,
  save: () => store.set("traces.top", trxPref.top),
});
function renderWaterfall(id) {
  const t = traces.get(id); if (!t) return;
  const spans = [...t.values()], root = rootOf(t);
  const t0 = Math.min(...spans.map((s) => s.start));
  const t1 = Math.max(t0 + 1, ...spans.map((s) => s.end ?? Date.now()), ...spans.flatMap((s) => s.events.map((e) => e.t)));
  const W = t1 - t0, kids = new Map();
  for (const s of spans) { const p = s === root ? null : s.parent; kids.set(p, [...(kids.get(p) ?? []), s]); }
  const order = [];
  const walk = (p, d) => { for (const s of (kids.get(p) ?? []).sort((a, b) => a.start - b.start)) { order.push([s, d]); walk(s.id, d + 1); } };
  walk(null, 0);
  const pct = (x) => ((x - t0) / W * 100).toFixed(3) + "%";
  $("#wf").innerHTML = `<div class="ax"><div class="l">${esc(id)}</div><div><span>0</span><span>${ms(W / 2)}</span><span>${ms(W)}</span></div></div>` +
    order.map(([s, d]) => {
      const label = s.name === "attempt" ? (s.attrs.tuple ?? s.attrs.backend ?? "") : s.name === "tier" ? `${s.attrs.tier} ${s.attrs.label}` : s.name;
      const tip = Object.entries(s.attrs).map(([k, v]) => `${k}=${v}`).join("\n");
      const dur = (s.end ?? Date.now()) - s.start;
      return `<div class="r" data-sid="${s.id}" title="${esc(tip)}"><div class="l" style="padding-left:${8 + d * 12}px"><i>${esc(s.attrs.outcome ?? (s.end === null ? "…" : ""))} ${ms(dur)}</i> ${esc(label)}</div>
        <div class="tr"><span class="b" style="left:${pct(s.start)};width:${(dur / W * 100).toFixed(3)}%;background:${spanColor(s)}"></span>${s.events.map((e) => `<span class="ev" style="left:${pct(e.t)}" title="${esc(e.name + " " + JSON.stringify(e.attrs ?? {}))}"></span>`).join("")}</div></div>`;
    }).join("");
}
async function loadTraces() {
  try {
    const j = await req("/v1/traces?limit=60", { admin: true });
    await Promise.all(j.data.reverse().map(async (s) => {
      const full = await req("/v1/traces/" + s.id, { admin: true }).catch(() => null);
      for (const sp of full?.spans ?? [s.root]) upsert(s.id, sp);
    }));
    renderTraces();
  } catch (e) { toast("traces: " + e.message, true); }
}
async function toggleLive() {
  const btn = $("#tlive");
  if (tliveCtl) { tliveCtl.abort(); tliveCtl = null; btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); return; }
  tliveCtl = new AbortController(); btn.classList.add("on"); btn.setAttribute("aria-pressed", "true");
  try {
    const res = await fetch(creds().url + "/v1/traces/live", { headers: headers(true, false), signal: tliveCtl.signal });
    if (!res.ok) throw new Error(`${res.status} ${(await res.json().catch(() => ({})))?.error?.message ?? ""}`);
    for await (const { data } of sse(res, tliveCtl.signal)) { if (data) { const e = JSON.parse(data); upsert(e.trace, e.span); } }
  } catch (e) { if (e.name !== "AbortError") toast("live: " + e.message, true); }
  if (tliveCtl) toggleLive();
}
function openTrace(id) {
  if (!id) return;
  tsel = id; go("traces");
  req("/v1/traces/" + id, { admin: true }).then((t) => { for (const s of t.spans) upsert(id, s); renderTraces(); })
    .catch((e) => toast(creds().admin ? e.message : "traces need the admin secret (connection settings)", true));
}
$("#tlive").onclick = toggleLive;
$("#tload").onclick = loadTraces;
$("#trfilter").oninput = renderTraces;
$("#terr").onchange = renderTraces;
$("#tlist").onclick = (ev) => { const it = ev.target.closest("[data-id]"); if (it) selectTrace(it.dataset.id); };
$("#trx-out").addEventListener("click", (ev) => { const r = ev.target.closest("[data-sid]"); if (!r) return; tspan = r.dataset.sid; renderTraceDetail(); });
enter.traces = () => { renderTraces(); if (!traces.size && creds().admin) loadTraces(); };
cmd("toggle live traces", () => { go("traces"); toggleLive(); });

