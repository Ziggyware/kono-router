// =====================================================================
// OPS + SOURCE
// =====================================================================
async function op(name) {
  const all = $$("[data-op]"); all.forEach((b) => b.disabled = true);
  $("#ostat").textContent = name + " …"; $("#ostat").className = "dim";
  const t0 = performance.now();
  try {
    const body = name === "probe" ? { mode: $("#omode").value } : name === "resurrect" ? { limit: Math.max(1, Number($("#olimit").value) || 6) } : {};
    const j = await req("/v1/" + name, { method: "POST", admin: true, body });
    const rs = j.results ?? [];
    $("#otab").innerHTML = rs.length ? `<thead><tr><th>tuple</th><th>ok</th><th>canary</th><th>ttft</th><th class="l">error</th></tr></thead><tbody>` +
      rs.map((r) => `<tr><td class="t">${esc(r.tupleId)}</td><td class="${r.ok ? "ok" : "no"}">${r.ok ? "✓" : "✗"}</td><td>${r.passed === undefined ? "—" : r.passed ? "✓" : "✗"}</td><td>${ms(r.ms)}</td><td class="l t" title="${esc(r.error)}">${esc(r.error ?? "")}</td></tr>`).join("") + "</tbody>" : "";
    $("#oraw").hidden = false; $("#oraw").textContent = JSON.stringify(j, null, 2);
    $("#ostat").textContent = `${name} · ${ms(performance.now() - t0)}`; $("#ostat").className = "ok";
  } catch (e) { $("#ostat").textContent = `${name}: ${e.message}`; $("#ostat").className = "no"; }
  all.forEach((b) => b.disabled = false);
}
$$("[data-op]").forEach((b) => b.onclick = () => op(b.dataset.op));
for (const n of ["probe", "sync", "resurrect"]) cmd(n, () => { go("ops"); op(n); }, "admin");
let srcLines = [];
async function loadSource() {
  const file = $("#sfile").value;
  try {
    const j = await req("/v1/source?file=" + encodeURIComponent(file), { admin: true });
    srcLines = j.content.split("\n");
    $("#smeta").textContent = `${j.lines} lines · ${(j.bytes / 1024).toFixed(1)} KiB`;
    renderSource();
  } catch (e) { toast(e.message, true); }
}
// One query, two scopes: "this file" filters the open file's lines (an empty
// query shows the whole file), "all files" lists matches across every file;
// a result opens its file filtered to the same query.
let srcFilter = "";
function renderSource() {
  const q = srcFilter.toLowerCase();
  let hits = 0;
  $("#sout").innerHTML = srcLines.map((l, i) => {
    if (q && !l.toLowerCase().includes(q)) return "";
    hits++;
    const body = q ? esc(l).replace(new RegExp(esc(srcFilter).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`) : esc(l);
    return `<span style="counter-set:l ${i}">${body || " "}</span>`;
  }).join("");
  if (q) $("#smeta").textContent = `${hits} of ${srcLines.length} lines match`;
}
function searchThisFile() {
  srcFilter = $("#sq").value.trim();
  if (!srcLines.length) loadSource(); else renderSource();
}
$("#sfile").onchange = () => { srcFilter = ""; loadSource(); };
$("#sin").onclick = searchThisFile;
$("#sq").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? searchAllFiles() : searchThisFile(); } });

// Search across ALL source files at once; a click jumps to the match by
// loading that file with the line filter set to the same query.
async function searchAllFiles() {
  const q = $("#sq").value.trim();
  if (q.length < 2) { toast("type at least 2 characters", true); return; }
  spane.show("q:" + q, `"${q}"`, `<div class="dim sall-h">searching…</div>`, { flush: true });
  try {
    const j = await req("/v1/source/search?q=" + encodeURIComponent(q), { admin: true });
    const rows = j.results ?? [];
    spane.show("q:" + q, `"${q}" · ${j.count}${j.truncated ? "+" : ""}`, `<div class="sallout">` +
      rows.map((r) => `<button class="sall-r" data-sall-file="${esc(r.file)}" data-sall-line="${r.line}"><b>${esc(r.file)}:${r.line}</b><span>${esc(r.text)}</span></button>`).join("") + `</div>`, { flush: true, sig: String(j.count) });
  } catch (e) { spane.show("q:" + q, `"${q}"`, `<div class="no sall-h">search failed: ${esc(e.message)}</div>`, { flush: true }); }
}
const spane = pane2("sp2", 0.64);
$("#sall").onclick = searchAllFiles;
enter.source = () => { if (!srcLines.length) loadSource(); };
$("#sp2 .p2b").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sall-file]");
  if (!b) return;
  for (const x of $$("#sp2 .sall-r")) x.setAttribute("aria-current", String(x === b));
  srcFilter = "";
  if ($("#sfile").value !== b.dataset.sallFile || !srcLines.length) { $("#sfile").value = b.dataset.sallFile; await loadSource(); }
  else renderSource();
  // Whole file shown; the hit line is scrolled into view and flagged.
  const line = $(`#sout span[style="counter-set:l ${Number(b.dataset.sallLine) - 1}"]`);
  if (line) { line.scrollIntoView({ block: "center" }); line.classList.add("hit"); setTimeout(() => line.classList.remove("hit"), 1600); }
});

