// =====================================================================
// LANES — kernel state; log-normal TTFT densities + EWMA history
// =====================================================================
const MODES = ["fast", "smart", "code", "reasoning"];
const PAL = ["#c9ff4a", "#7fc4ff", "#ff9d6b", "#c3a6ff", "#5cffc0"];
const Z95 = 1.6448536269514722;
const hist = new Map(); // tupleId -> [{t, ttft}]
const kpiPrev = {};
let lanesTimer = 0;
const lnQ = (c, z) => Math.exp(c.logTtftMu + z * c.logTtftSigma);
function record(h) {
  const t = Date.now(), seen = new Set();
  for (const m of MODES) for (const c of h["current_best_" + m] ?? []) {
    if (seen.has(c.tupleId)) continue; seen.add(c.tupleId);
    const a = hist.get(c.tupleId) ?? []; a.push({ t, ttft: c.ewmaTtftMs }); if (a.length > 720) a.shift(); hist.set(c.tupleId, a);
  }
}
function kpis(h) {
  const cv = h.coverage ?? {}, sec = h.security ?? {};
  const items = [["endpoints configured", cv.configured_endpoints], ["in registry", cv.registry_endpoints], ["model endpoints", cv.catalog_tuples], ["sweep pool", cv.sweep_candidates], ["cache entries", sec.l1_cache_entries]];
  const flags = [["auth", sec.auth_enabled], ["admin guard", sec.admin_guard_enabled], ["openrouter", sec.openrouter_free_enabled], ["strict", h.control_kernel?.strict_errors]];
  $("#kpis").innerHTML = items.map(([k, v]) => {
    const d = Number.isFinite(kpiPrev[k]) && v !== kpiPrev[k] ? `<i>${v > kpiPrev[k] ? "+" : ""}${v - kpiPrev[k]}</i>` : "";
    kpiPrev[k] = v;
    return `<div class="kpi"><b>${esc(v ?? "—")}${d}</b><span>${k}</span></div>`;
  }).join("") + flags.map(([k, v]) => `<div class="kpi"><b class="${v ? "ok" : "no"}">${v ? "on" : "off"}</b><span>${k}</span></div>`).join("")
    + (sec.service_json_load_error ? `<div class="kpi"><b class="no">err</b><span>${esc(sec.service_json_load_error)}</span></div>` : "");
}
const LANE_INFO = {
  fast: { title: "Fast", desc: "Quick answers and chat. The lowest-latency endpoints win this lane." },
  smart: { title: "Smart", desc: "Everyday quality — the default balance of speed and capability." },
  code: { title: "Code", desc: "Programming tasks. Code-specialist endpoints are preferred." },
  reasoning: { title: "Reasoning", desc: "Hard, multi-step problems. Deep-thinking models — slower is acceptable." },
};
function lanes(h) {
  const root = $("#lanes");
  if (!root.children.length) root.innerHTML = MODES.map((m) => `<div class="lane" id="l-${m}"><h3>${LANE_INFO[m].title} <span class="dim" style="font:400 11px var(--mono)">free:${m}</span></h3>
    <p class="lane-desc">${LANE_INFO[m].desc}</p>
    <div class="lane-stat dim"></div>
    <table><thead><tr><th class="l">endpoint</th><th>reliability</th><th>first token · typical</th><th>first token · slow case</th><th>speed</th><th>context</th><th class="l">strengths</th></tr></thead><tbody></tbody></table>
    <div class="lane-cap dim">first-token time across recent polls — lower is better</div>
    <div class="plots one"><canvas class="trk" aria-label="${m} first-token history"></canvas></div></div>`).join("");
  for (const m of MODES) {
    const cs = h["current_best_" + m] ?? [], el = $("#l-" + m);
    const best = cs[0];
    $(".lane-stat", el).textContent = cs.length
      ? `${cs.length} endpoint${cs.length === 1 ? "" : "s"} in the current best set · best right now: ${best.tupleId} (typical first token ${ms(lnQ(best, 0))})`
      : "no endpoints in the current best set — the router is still probing this lane";
    $("tbody", el).innerHTML = cs.length ? cs.map((c, i) => `<tr title="iq ${f(c.iqEffective, 3)} · σ ln ${f(c.logTtftSigma, 3)} · ewma ttft ${ms(c.ewmaTtftMs)} · expected-fast ${ms(c.expectedFastMs)} · score ${f(c.smartScore, 3)}">
      <td class="t" title="${esc(c.tupleId)}"><span class="sw" style="background:${PAL[i % PAL.length]}"></span>${esc(c.tupleId)}</td>
      <td>${Math.round((c.reliabilityDraw ?? 0) * 100)}%</td><td>${ms(lnQ(c, 0))}</td><td>${ms(lnQ(c, Z95))}</td>
      <td>${f(c.ewmaTps, 1)} tok/s</td>
      <td>${c.contextWindow ? kfmt(c.contextWindow) : "—"}</td><td class="l">${[c.supportsReasoning && "reasoning", c.supportsVision && "vision", c.isCodingSpecialist && "code"].filter(Boolean).join(", ") || "—"}</td></tr>`).join("")
      : `<tr><td colspan="7">—</td></tr>`;
    drawTrack($(".trk", el), cs);
  }
}
function canvas2d(cv) {
  const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height); g.font = '10px "IBM Plex Mono", monospace';
  return [g, r.width, r.height];
}
function logAxis(g, W, H, lo, hi, horizontal) {
  g.strokeStyle = cvar("--line-2", "#2a2f33"); g.fillStyle = cvar("--dim", "#6b6f63"); g.lineWidth = 1;
  for (let e = Math.ceil(Math.log10(lo)); e <= Math.floor(Math.log10(hi)); e++) {
    const v = 10 ** e, u = (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
    g.beginPath();
    if (horizontal) { const x = 8 + u * (W - 16); g.moveTo(x, 4); g.lineTo(x, H - 14); g.stroke(); g.fillText(ms(v), Math.min(x + 2, W - g.measureText(ms(v)).width - 2), H - 3); }
    else { const y = H - 14 - u * (H - 22); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(ms(v), 4, y - 2); }
  }
}
// Density of ln T ~ N(mu, sigma²): exact per-unit-ln(t) density on a log-time axis.
function drawPdf(cv, cs) {
  const [g, W, H] = canvas2d(cv);
  if (!cs.length) return;
  let lo = Infinity, hi = 0;
  for (const c of cs) { lo = Math.min(lo, lnQ(c, -3)); hi = Math.max(hi, lnQ(c, 3)); }
  lo = Math.max(1, lo); hi = Math.max(hi, lo * 10);
  logAxis(g, W, H, lo, hi, true);
  const L0 = Math.log(lo), L1 = Math.log(hi), N = 240;
  const peak = Math.max(...cs.map((c) => 1 / (Math.max(c.logTtftSigma, 1e-3) * Math.sqrt(2 * Math.PI))));
  cs.forEach((c, i) => {
    const s = Math.max(c.logTtftSigma, 1e-3);
    g.strokeStyle = PAL[i % PAL.length]; g.lineWidth = i ? 1 : 1.5; g.beginPath();
    for (let k = 0; k <= N; k++) {
      const z = (L0 + (k / N) * (L1 - L0) - c.logTtftMu) / s, p = Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
      const x = 8 + (k / N) * (W - 16), y = H - 14 - (p / peak) * (H - 22);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  });
}
function drawTrack(cv, cs) {
  const [g, W, H] = canvas2d(cv);
  const all = cs.flatMap((c) => hist.get(c.tupleId) ?? []);
  const vals = all.map((p) => p.ttft).filter((v) => v > 0);
  if (!vals.length) return;
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(t0 + 1, ...all.map((p) => p.t));
  const lo = Math.max(1, Math.min(...vals) / 1.5), hi = Math.max(lo * 10, Math.max(...vals) * 1.5);
  logAxis(g, W, H, lo, hi, false);
  g.fillStyle = cvar("--dim", "#6b6f63"); g.fillText(`${Math.round((t1 - t0) / 60000)}m`, W - 30, H - 3);
  cs.forEach((c, i) => {
    const a = hist.get(c.tupleId) ?? []; if (!a.length) return;
    g.strokeStyle = g.fillStyle = PAL[i % PAL.length]; g.lineWidth = i ? 1 : 1.5; g.beginPath();
    a.forEach((p, k) => {
      const x = 40 + ((p.t - t0) / (t1 - t0)) * (W - 48), y = H - 14 - ((Math.log(Math.max(p.ttft, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (H - 22);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
      if (a.length === 1) g.fillRect(x - 1.5, y - 1.5, 3, 3);
    });
    g.stroke();
  });
}
async function pollLanes() {
  try { const t = performance.now(); await ping(); record(health); kpis(health); lanes(health); const cv = health.coverage ?? {}; $("#lstat").textContent = `${new Date().toLocaleTimeString()} · ${ms(performance.now() - t)}${cv.providers_active ? ` · ${cv.providers_ranked}/${cv.providers_active} providers ranked (the rest are reached by the exhaustive sweep)` : ""}`; $("#lstat").className = "dim"; }
  catch (e) { $("#lstat").textContent = e.message; $("#lstat").className = "no"; }
}
function scheduleLanes() {
  clearInterval(lanesTimer);
  const every = Number($("#every").value);
  if (every) lanesTimer = setInterval(() => { if (current === "lanes" && !document.hidden) pollLanes(); }, every);
}
$("#every").onchange = scheduleLanes;
addEventListener("resize", () => { if (current === "lanes" && health) lanes(health); });
enter.lanes = () => { pollLanes(); scheduleLanes(); };

// =====================================================================
// ENDPOINTS
// =====================================================================
let endpoints = [], esort = { k: "catalog_tuples", d: -1 };
async function loadEndpoints() { try { endpoints = (await req("/v1/endpoints")).data ?? []; renderEndpoints(); } catch (e) { toast("endpoints: " + e.message, true); } }
function renderEndpoints() {
  const q = $("#efilter").value.trim().toLowerCase();
  const rows = endpoints.filter((e) => !q || [e.id, e.name, e.url, ...(e.models ?? [])].join(" ").toLowerCase().includes(q));
  const key = (e) => esort.k === "models" ? (e.models ?? []).length : e[esort.k];
  rows.sort((a, b) => { const x = key(a), y = key(b); return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * esort.d; });
  $("#ecount").textContent = `${rows.length}/${endpoints.length} · ${rows.reduce((s, e) => s + (e.catalog_tuples || 0), 0)} tuples`;
  $("#etb").innerHTML = rows.map((e) => `<tr class="click" data-id="${esc(e.id)}" aria-selected="${epane.key === e.id}"><td class="t">${esc(e.name)}</td><td class="l t">${esc(e.id)}</td><td class="${e.catalog_tuples ? "" : "no"}">${e.catalog_tuples}</td><td>${(e.models ?? []).length}</td><td class="l t" title="${esc(e.url)}">${esc(e.url)}</td></tr>`
).join("");
}
$("#efilter").oninput = renderEndpoints;
$("#ereload").onclick = loadEndpoints;
$$("#v-endpoints th[data-k]").forEach((th) => th.onclick = () => { esort = { k: th.dataset.k, d: esort.k === th.dataset.k ? -esort.d : (["catalog_tuples", "models"].includes(th.dataset.k) ? -1 : 1) }; renderEndpoints(); });
const epane = pane2("ep2", 0.6);
epane.onhide = () => markRow($("#etb"), "data-id", null);
$("#etb").onclick = (ev) => {
  const tr = ev.target.closest("tr[data-id]");
  if (!tr) return;
  if (epane.key === tr.dataset.id) { epane.hide(); return; }
  const e = endpoints.find((x) => x.id === tr.dataset.id);
  if (!e) return;
  const models = e.models ?? [];
  epane.show(e.id, e.name, `<div class="wi-kv"><span>id</span><b>${esc(e.id)}</b><span>url</span><b>${esc(e.url)}</b><span>tuples</span><b class="${e.catalog_tuples ? "" : "no"}">${e.catalog_tuples}</b><span>model hints</span><b>${models.length}</b></div>${models.length ? `<div class="chips">${models.map((m) => `<button data-use="${esc(m)}" title="use in chat">${esc(m)}</button>`).join("")}</div>` : ""}`);
  markRow($("#etb"), "data-id", e.id);
};
$("#ep2 .p2b").addEventListener("click", (e) => { const b = e.target.closest("[data-use]"); if (b) useModel(b.dataset.use); });
enter.endpoints = () => { if (!endpoints.length) loadEndpoints(); };

