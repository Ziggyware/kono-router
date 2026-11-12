// =====================================================================
// CATALOG
// =====================================================================
let catalog = [], csort = { k: "iq_effective", d: -1 };
const caps = (m) => [m.supports_reasoning && "reasoning", m.supports_vision && "vision", m.is_coding_specialist && "code"].filter(Boolean).join(" ");
// /v1/models emits one row per routable tuple, so a slug repeats once per
// endpoint and provider-qualified ids sit beside bare leaf names. Group and
// dedupe once here; every model datalist on the page renders this shape.
const LANE_IDS = ["free:auto", "free:fast", "free:smart", "free:code", "free:reasoning"];
const LANE_GROUP = "lanes", IMAGE_GROUP = "image";
// A slug can be qualified by a provider and a subprovider, and pinned to a
// routing modifier: "provider/subprovider/model:modifier". Its model name is the
// last "/" segment minus that modifier, so every variant of one model collapses
// into a single group entry. Virtual lane ids are names, not slugs — their colon
// ("free:smart") is not a modifier, so they are left intact.
const leafModelName = (id) => {
  const raw = String(id);
  if (LANE_IDS.includes(raw.toLowerCase())) return raw;
  const leaf = raw.split("/").filter(Boolean).pop() || raw;
  return leaf.split(":")[0] || leaf;
};
// Best routable id for one model name: provider-qualified beats bare, and an
// unmodified id beats one pinned to a routing modifier.
const routePreference = (id) => (id.includes("/") ? 2 : 0) + (id.includes(":") ? 0 : 1);
// registry providers are owned_by "services_json_<endpoint>": same vendor, one group.
const cleanVendor = (v) => String(v ?? "").trim().toLowerCase().replace(/^services_json_/, "").replace(/[_\s]+/g, " ").trim() || "other";
const modelVendor = (m) => {
  const id = String(m?.id ?? "");
  if (/^free:/i.test(id)) return LANE_GROUP;
  if (/^kono-image/i.test(id)) return IMAGE_GROUP;
  const slash = id.indexOf("/");
  return cleanVendor(slash > 0 ? id.slice(0, slash) : m?.owned_by);
};
function groupedModels(models) {
  const groups = new Map();
  for (const raw of models ?? []) {
    const m = typeof raw === "string" ? { id: raw } : raw ?? {};
    const id = String(m.id ?? "").trim();
    if (!id) continue;
    const vendor = modelVendor(m), key = leafModelName(id).toLowerCase();
    if (!groups.has(vendor)) groups.set(vendor, new Map());
    const bucket = groups.get(vendor), seen = bucket.get(key);
    // A provider-qualified slug routes more precisely than a bare leaf name.
    if (!seen || routePreference(id) > routePreference(seen.id)) bucket.set(key, { id, name: leafModelName(id) });
  }
  const lead = [LANE_GROUP, IMAGE_GROUP];
  const rank = (v) => { const i = lead.indexOf(v); return i < 0 ? lead.length : i; };
  const order = (vendor) => (a, b) => vendor === LANE_GROUP
    ? (LANE_IDS.indexOf(a.id) + 1 || LANE_IDS.length + 1) - (LANE_IDS.indexOf(b.id) + 1 || LANE_IDS.length + 1)
    : a.name.localeCompare(b.name);
  // One option per routable id: an id offered by several providers is a single
  // choice, since the router races all of its tuples anyway.
  const emitted = new Set();
  return [...groups].map(([vendor, bucket]) => ({ vendor, items: [...bucket.values()].sort(order(vendor)) }))
    .sort((a, b) => rank(a.vendor) - rank(b.vendor) || a.vendor.localeCompare(b.vendor))
    .map((g) => ({ vendor: g.vendor, items: g.items.filter((it) => !emitted.has(it.id) && Boolean(emitted.add(it.id))) }))
    .filter((g) => g.items.length);
}
function renderModelList(models) {
  const list = $("#modellist");
  if (!list) return;
  list.innerHTML = groupedModels(models).map(({ vendor, items }) => items.map(({ id, name }) =>
    `<option value="${esc(id)}" label="${esc(vendor === LANE_GROUP || vendor === IMAGE_GROUP ? id : `${vendor} · ${name}`)}"></option>`).join("")).join("");
}
async function loadCatalog() {
  try {
    catalog = (await req("/v1/models")).data ?? [];
    renderModelList(catalog);
    updateModelHint();
    renderCatalog();
  } catch (e) { toast("catalog: " + e.message, true); }
}
// Metadata in the mesh is heuristic and may vary by upstream tuple. Keep the
// smallest advertised context for an exact ID rather than promising a limit.
function modelContext(models, id) {
  const contexts = models.filter((m) => m.id === id).map((m) => Number(m.context_window)).filter((n) => Number.isFinite(n) && n > 0);
  return contexts.length ? Math.min(...contexts) : null;
}
function estimatePromptTokens(messages, system, toolsText = "") {
  // Byte-based approximation, not a tokenizer. Images have unknown cost.
  const text = JSON.stringify({ system, tools: toolsText, messages: messages.map((m) => ({ ...wire(m), content: textOf(m.content) })) });
  return Math.ceil(new TextEncoder().encode(text).length / 3) + 32 * messages.length;
}
function automaticBudget(context, estimatedInput) {
  if (!context) return undefined;
  return Math.max(1, Math.min(4096, Math.floor(context - estimatedInput - Math.max(512, context * .05))));
}
function chatTokenBudget(messages, system) {
  const raw = $("#pmax").value.trim();
  if (raw) return Number(raw);
  return automaticBudget(modelContext(catalog, $("#pmodel").value.trim()), estimatePromptTokens(messages, system, ""));
}
function updateModelHint() {
  const id = $("#pmodel").value.trim(), context = modelContext(catalog, id);
  const cm = $("#cmodel"); if (cm && cm.value !== $("#pmodel").value) cm.value = $("#pmodel").value;
  const draft = $("#cinput").value.trim();
  const estimated = estimatePromptTokens(draft ? [...conv.messages, { role: "user", content: draft }] : conv.messages, $("#psys").value, "");
  const budget = automaticBudget(context, estimated);
  $("#model-hint").textContent = context ? `Estimated context: ${kfmt(context)} tokens · capabilities and context may vary by provider.` : "Context unknown for this ID or lane. Capability metadata is estimated.";
  const raw = $("#pmax").value.trim();
  let note = raw ? `Manual output limit: ${raw} tokens.` : budget ? `Auto output budget: up to ${budget} tokens.` : "Auto: provider decides the output limit.";
  if (context && estimated + (raw ? Number(raw) || 0 : budget || 0) > context) note += " Estimated input and output exceed context; shorten the conversation.";
  $("#token-hint").textContent = `${note} Input estimate: ~${estimated} tokens (images and automatic router tools excluded). Provider output limits may be lower.`;
}
const modelInput = $("#pmodel"), modelResults = $("#model-results");
let modelMatches = [], modelIndex = -1, modelSearch = "";
function showModelResults(query = modelSearch) {
  modelSearch = query;
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const capability = $("#model-cap").value, minimum = Number($("#model-context").value);
  const unique = new Map();
  for (const m of catalog) {
    if (!m.id || /^kono-image/i.test(m.id)) continue;
    if (capability && !caps(m).split(" ").includes(capability)) continue;
    const context = Number(m.context_window) || 0;
    if (context < minimum) continue;
    const search = `${m.id} ${m.owned_by || ""} ${caps(m)} ${context} ${context ? kfmt(context) + " " + Math.round(context / 1000) + "k" : ""}`.toLowerCase();
    if (!words.every((w) => search.includes(w))) continue;
    if (!unique.has(m.id)) unique.set(m.id, m);
  }
  modelMatches = [...unique.values()].slice(0, 80);
  modelIndex = -1;
  modelResults.innerHTML = modelMatches.length ? modelMatches.map((m, i) => `<button type="button" class="model-option" role="option" aria-selected="false" data-model-index="${i}">${esc(m.id)}<small>${esc(m.owned_by || "router")} · ${m.context_window ? esc(kfmt(Number(m.context_window))) + " context" : "context unknown"}${caps(m) ? " · " + esc(caps(m)) : ""}</small></button>`).join("") : '<div class="model-hint" style="padding:12px">No matches. You can still enter a custom model ID.</div>';
  modelResults.hidden = false; modelInput.setAttribute("aria-expanded", "true");
}
function closeModelResults() { modelResults.hidden = true; modelInput.setAttribute("aria-expanded", "false"); modelInput.removeAttribute("aria-activedescendant"); }
function chooseModel(index) {
  if (!modelMatches[index]) return;
  modelInput.value = modelMatches[index].id; saveParams(); updateModelHint(); modelInput.focus(); closeModelResults();
}
modelInput.addEventListener("focus", () => showModelResults(""));
modelInput.addEventListener("input", () => { updateModelHint(); showModelResults(modelInput.value); });
modelInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modelResults.hidden) { closeModelResults(); e.stopPropagation(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); if (modelResults.hidden) showModelResults("");
    if (!modelMatches.length) return;
    modelIndex = Math.max(0, Math.min(modelMatches.length - 1, modelIndex + (e.key === "ArrowDown" ? 1 : -1)));
    const options = $$("[role=option]", modelResults); options.forEach((el, i) => { el.setAttribute("aria-selected", String(i === modelIndex)); el.id = `model-option-${i}`; });
    modelInput.setAttribute("aria-activedescendant", `model-option-${modelIndex}`); options[modelIndex]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && !modelResults.hidden && modelIndex >= 0) { e.preventDefault(); chooseModel(modelIndex); }
});
modelResults.addEventListener("mousedown", (e) => e.preventDefault());
modelResults.addEventListener("click", (e) => { const option = e.target.closest("[data-model-index]"); if (option) chooseModel(Number(option.dataset.modelIndex)); });
for (const id of ["model-cap", "model-context"]) $("#" + id).addEventListener("change", () => showModelResults());
document.addEventListener("click", (e) => { if (!e.target.closest(".model-picker")) closeModelResults(); });
$(".model-picker").addEventListener("focusout", () => setTimeout(() => { if (!$(".model-picker").contains(document.activeElement)) closeModelResults(); }, 0));
for (const id of ["pmax", "psys", "cinput"]) $("#" + id).addEventListener("input", updateModelHint);
updateModelHint();
function renderCatalog() {
  const q = $("#cfilter").value.trim().toLowerCase();
  const rows = catalog.filter((m) => !q || `${m.id} ${m.owned_by} ${caps(m)}`.toLowerCase().includes(q));
  const key = (m) => csort.k === "caps" ? caps(m) : m[csort.k] ?? (csort.k === "iq_effective" || csort.k === "context_window" ? -1 : "");
  rows.sort((a, b) => { const x = key(a), y = key(b); return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * csort.d; });
  $("#ccount").textContent = `${rows.length}/${catalog.length}`;
  $("#ctb").innerHTML = rows.map((m) => `<tr class="click" data-id="${esc(m.id)}" aria-selected="${cpane.key === m.id}"><td class="t">${esc(m.id)}</td><td class="l t">${esc(m.owned_by ?? "")}</td><td>${f(m.iq_effective, 3)}</td><td>${m.context_window ? kfmt(m.context_window) : "—"}</td><td class="l dim">${caps(m)}</td></tr>`).join("");
}
$("#cfilter").oninput = renderCatalog;
$("#creload").onclick = loadCatalog;
$$("#v-catalog th[data-k]").forEach((th) => th.onclick = () => { csort = { k: th.dataset.k, d: csort.k === th.dataset.k ? -csort.d : (["iq_effective", "context_window"].includes(th.dataset.k) ? -1 : 1) }; renderCatalog(); });
const cpane = pane2("cp2", 0.58);
cpane.onhide = () => markRow($("#ctb"), "data-id", null);
function useModel(id) { $("#pmodel").value = id; saveParams(); updateModelHint(); go("chat"); toast("model → " + id); }
$("#ctb").onclick = (e) => {
  const tr = e.target.closest("[data-id]");
  if (!tr) return;
  const id = tr.dataset.id;
  if (e.detail >= 2) { useModel(id); return; }
  const m = catalog.find((x) => x.id === id);
  if (!m) return;
  cpane.show(id, id, `<div class="wi-kv"><span>provider</span><b>${esc(m.owned_by ?? "—")}</b><span>iq</span><b>${f(m.iq_effective, 3)}</b><span>context</span><b>${m.context_window ? kfmt(m.context_window) + " tokens" : "—"}</b><span>caps</span><b>${caps(m) || "—"}</b></div><div class="jt-wrap">${jsonTree(m)}</div>`,
    { extra: `<button class="btn q" data-use="${esc(id)}">use in chat</button>` });
  markRow($("#ctb"), "data-id", id);
};
$("#cp2 .p2b").addEventListener("click", (e) => { const b = e.target.closest("[data-use]"); if (b) useModel(b.dataset.use); });
enter.catalog = () => { if (!catalog.length) loadCatalog(); else renderCatalog(); };

// =====================================================================
// HARVESTER — browser-side verification → services.json registry entries
// =====================================================================
const CHALLENGE = { formula: "((17 * 23) + (19^2) - 48) / 2", expected: 352 };
let harvested = [];
function entropy(s) { const fr = new Map(); for (const c of s) fr.set(c, (fr.get(c) ?? 0) + 1); let h = 0; for (const n of fr.values()) { const p = n / s.length; h -= p * Math.log2(p); } return h; }
function shapes(input) {
  const u = input.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(u)) { const base = u.replace(/\/chat\/completions$/, ""); return [{ base, url: u, models: base + "/models" }]; }
  return [{ base: u, url: u + "/chat/completions", models: u + "/models" }, ...(/\/v1$/.test(u) ? [] : [{ base: u + "/v1", url: u + "/v1/chat/completions", models: u + "/v1/models" }])];
}
async function harvestOne(input, key, el) {
  const stage = (name, ok, ms_, detail) => el.insertAdjacentHTML("beforeend", `<div class="st"><span class="mid">${name}</span><span class="${ok ? "ok" : "no"}">${ok ? "ok" : "fail"} ${ms_ ? ms(ms_) : ""}</span><span class="dim">${esc(detail)}</span></div>`);
  const auth = key ? { Authorization: "Bearer " + key } : {};
  const timed = async (fn) => { const t0 = performance.now(); try { return [await fn(), performance.now() - t0, null]; } catch (e) { return [null, performance.now() - t0, e]; } };
  const why = (e) => e?.name === "TypeError" ? "network or CORS blocked from the browser" : e?.name === "TimeoutError" ? "timeout" : e?.message ?? String(e);
  for (const s of shapes(input)) {
    const [list, mMs, mErr] = await timed(async () => {
      const r = await fetch(s.models, { headers: auth, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); const arr = Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j.models) ? j.models : [];
      return arr.map((m) => String(m.id ?? m.name ?? m)).filter(Boolean);
    });
    stage("models", Boolean(list?.length), mMs, list ? `${list.length} models · ${s.models}` : `${why(mErr)} · ${s.models}`);
    const model = list?.[0] ?? "gpt-4o-mini";
    const [reply, cMs, cErr] = await timed(async () => {
      const r = await fetch(s.url, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ model, temperature: 0, max_tokens: 32, messages: [{ role: "user", content: `Compute ${CHALLENGE.formula}. Reply with only the integer.` }] }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      return String(j.choices?.[0]?.message?.content ?? j.response ?? j.content ?? "");
    });
    if (reply === null) { stage("challenge", false, cMs, `${why(cErr)} · ${s.url}`); continue; }
    const got = Number((reply.match(/-?\d+(?:\.\d+)?/) ?? [])[0]);
    const degenerate = reply.length >= 32 && entropy(reply.slice(0, 128)) < 1.15;
    const pass = got === CHALLENGE.expected && !degenerate;
    stage("challenge", pass, cMs, degenerate ? "low-entropy collapse" : `${CHALLENGE.formula} = ${CHALLENGE.expected}; got "${reply.trim().slice(0, 60)}"`);
    if (!pass) continue;
    const host = new URL(s.url).host;
    return {
      name: `Harvested ${host}`, category: "Harvested", baseUrl: s.base, url: s.url, modelsUrl: list?.length ? s.models : null, defaultModel: model,
      authRequired: Boolean(key), authMode: key ? "Bearer" : "None (Omit Header)", authHeader: null,
      notes: `Browser-verified ${new Date().toISOString().slice(0, 10)}${key ? "; needs a bearer key configured server-side" : ""}.`,
      telemetry: { overallStatus: "math_verified", activeModel: model, rttMs: Math.round(cMs), discoveredModels: (list ?? []).slice(0, 50),
        stages: { math: { status: "ok", latencyMs: Math.round(cMs), formula: CHALLENGE.formula, expected: CHALLENGE.expected, actual: got, rawReply: reply.trim().slice(0, 200) } } },
    };
  }
  return null;
}
$("#hgo").onclick = async () => {
  const urls = $("#hurls").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return;
  harvested = []; $("#hout").replaceChildren(); $("#hgo").disabled = true; $("#hcopy").disabled = true;
  await Promise.all(urls.map(async (u) => {
    const el = document.createElement("div"); el.className = "hv";
    el.innerHTML = `<div class="h"><b class="grow">${esc(u)}</b><span class="dim">…</span></div>`;
    $("#hout").append(el);
    const entry = await harvestOne(u, $("#hkey").value.trim(), el);
    $(".h span", el).outerHTML = entry ? `<span class="ok">verified</span>` : `<span class="no">rejected</span>`;
    if (entry) harvested.push(entry);
  }));
  $("#hgo").disabled = false; $("#hcopy").disabled = !harvested.length;
  toast(`${harvested.length}/${urls.length} verified`);
};
$("#hcopy").onclick = () => navigator.clipboard.writeText(JSON.stringify(harvested, null, 2)).then(() => toast(`${harvested.length} services.json entries copied`));

