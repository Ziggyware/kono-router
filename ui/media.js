// =====================================================================
// MEDIA
// =====================================================================
const gallery = [];
let mLoop = false, mBusy = false; // mLoop: "generate as many as possible until stopped"
const msleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One generation request. A pending card is shown while the router reviews
// every image provider; the card NEVER turns into an "unavailable" image —
// if no provider answers, it stays "still processing" and the caller retries.
async function genOnce() {
  const prompt = $("#mprompt").value.trim();
  if (!prompt) return false;
  const model = $("#mmodel").value, size = $("#msize").value, n = Math.max(1, Number($("#mn").value) || 1);
  const card = { pending: true, prompt, model, note: "generating — reviewing every image provider…", t0: performance.now() };
  gallery.unshift(card);
  renderGallery();
  let ok = false;
  try {
    const d = await req("/v1/images/generations", { method: "POST", body: { prompt, model, size, n } });
    const got = d.data ?? [];
    const items = got.map((it, i) => ({ src: it.url || "data:image/png;base64," + it.b64_json, prompt, model, backend: d.kono?.backends?.[i] ?? "", ms: performance.now() - card.t0, trace: d.kono?.trace_id }));
    const pend = Number(d.kono?.pending || 0);
    const idx = gallery.indexOf(card);
    const repl = [...items];
    if (pend > 0) { card.note = `still processing — ${pend} image${pend > 1 ? "s" : ""} still under review across all providers`; repl.push(card); }
    if (idx >= 0) gallery.splice(idx, 1, ...repl); else gallery.unshift(...repl);
    ok = items.length > 0;
  } catch (e) {
    // HTTP 503 still_processing or a transient failure: keep the processing
    // card — the backend keeps reviewing each provider, so we show that.
    const why = String(e.message || "").replace(/^\d+\s*/, "").slice(0, 90);
    card.note = `still processing — all providers reviewed, none answered yet${why ? ` (${why})` : ""} — retrying`;
  }
  renderGallery();
  return ok;
}
async function genMedia() {
  if (mBusy) return;
  if (!$("#mprompt").value.trim()) { toast("type an image prompt first"); return; }
  mBusy = true; setMButtons();
  let tries = 0;
  try {
    do {
      const ok = await genOnce();
      tries++;
      if (mLoop) { await msleep(ok ? 800 : 4000); continue; } // loop until the user stops
      if (!ok && tries < 4) { await msleep(4000); continue; } // still processing — auto-retry a few times
      break;
    } while (mLoop);
  } finally {
    mBusy = false; setMButtons();
  }
}
function setMButtons() {
  const go = $("#mgo"), lp = $("#mloop");
  go.disabled = mBusy;
  go.textContent = mBusy ? "generating…" : "generate";
  lp.textContent = mLoop ? "■ stop" : "∞ loop";
  lp.setAttribute("aria-pressed", String(mLoop));
  lp.title = mLoop ? "Stop continuous generation" : "Generate as many images as possible for this prompt until you stop it";
}
function renderGallery() {
  $("#mgal").innerHTML = gallery.map((g) => g.pending
    ? `<figure class="pending"><div class="ph"><span class="spin" aria-hidden="true"></span><span>${esc(g.note || "generating…")}</span></div>
      <figcaption><span title="${esc(g.prompt)}">${esc(g.prompt)}</span><b title="model">${esc(g.model)}</b></figcaption></figure>`
    : `<figure><a href="${esc(g.src)}" target="_blank" rel="noopener"><img src="${esc(g.src)}" alt="${esc(g.prompt)}" loading="lazy"></a>
    <figcaption><span title="${esc(g.prompt)}">${esc(g.prompt)}</span>${g.backend ? `<b title="backend that produced this image">${esc(g.backend.split("::").pop())}</b>` : ""}<b>${ms(g.ms)}</b>${g.trace ? `<a href="#" data-tr="${esc(g.trace)}">trace</a>` : ""}<a href="${esc(g.src)}" download="kono-${Date.now()}.png">save</a></figcaption></figure>`).join("");
}
$("#mgo").onclick = genMedia;
$("#mloop").onclick = () => { mLoop = !mLoop; setMButtons(); if (mLoop && !mBusy) genMedia(); };
// Enter in the prompt box submits the generation (Shift+Enter inserts a newline).
$("#mprompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); genMedia(); }
});
// Built-in backends first, then every OpenAI-standard image model discovered on
// configured providers (grouped by provider). Any of them can be pinned.
let mediaModelsLoaded = false;
enter.media = async () => {
  if (mediaModelsLoaded) return;
  try {
    const all = (await req("/v1/models")).data ?? [];
    const img = all.filter((m) => String(m.owned_by).startsWith("kono-image:"));
    if (!img.length) return;
    const by = new Map();
    for (const m of img) { const p = m.id.split("::")[0].replace(/^services_json_/, ""); by.set(p, [...(by.get(p) ?? []), m.id]); }
    const sel = $("#mmodel"), keep = sel.value;
    sel.insertAdjacentHTML("beforeend", [...by].map(([p, ids]) => `<optgroup label="${esc(p)}">${ids.map((id) => `<option value="${esc(id)}">${esc(id.split("::").pop())}</option>`).join("")}</optgroup>`).join(""));
    sel.value = keep;
    mediaModelsLoaded = true;
  } catch { /* the built-in backends still work */ }
};
$("#mprompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) genMedia(); });
$("#mgal").onclick = (e) => { const a = e.target.closest("[data-tr]"); if (a) { e.preventDefault(); openTrace(a.dataset.tr); } };

