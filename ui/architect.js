// =====================================================================
// ARCHITECT — tool-using agent; one fenced ```action JSON per reply, max 8 rounds
// =====================================================================
const AFILES = ["main.ts", "math.ts", "trace.ts", "index.html", "openapi.json", "CHANGES.md", "services.json", "deno.json"];
const ARCH_PROMPT = [
  "You are the Architect, the embedded agent of the kono-router workspace. You act through tools.",
  "",
  "TO CALL A TOOL reply with exactly one fenced block:",
  "```action",
  '{"tool": "file_map", "file": "main.ts"}',
  "```",
  'The next message starts with "[Tool result:". Then call another tool or answer. A reply with no action block ends the turn.',
  "",
  "TOOLS:",
  `- read_file {file, start_line?, byte_budget?} — byte-budgeted read (default 120000 chars, max 200000) of: ${AFILES.join(", ")}. Returns whole lines and the next start_line. Server files need the admin secret.`,
  "- search_code {file, query} — case-insensitive regex over a file; line numbers + text.",
  "- file_map {file} — outline: functions, routes, crons, consts, sections, headings. Use first on large files.",
  "- router_health {} — engine, coverage, top tuples per lane.",
  "- endpoints {filter?} — every configured upstream endpoint with catalog tuple counts.",
  "- list_models {filter?} — catalog model ids.",
  "- traces {limit?} — admin. Recent request traces: model, mode, winning tuple, duration, failed attempts.",
  "- get_trace {id} — admin. Full span tree of one trace (rank, tiers, every attempt with outcome/error, negotiation events).",
  "- ping_model {model} — one minimal completion; latency + serving provider.",
  "- run_probe {mode} — admin. Canary-probe top candidates.",
  "- force_sync {} — admin. Full catalog sync.",
  "- list_plugins {} — installed workspace plugins.",
  "- install_plugin {code} — installs a plugin LIVE and persists it. code must call KonoPlugins.register({ id, name, description, admin?, mount(el, ctx) }).",
  "  ctx: base(), apiKey(), adminSecret(), fetchJson(url, opts) -> {res, data}, toast(msg, bad?), log(msg), esc(s), chat(messages, opts) -> completion JSON,",
  "  chatStream(messages, onDelta(delta, full), opts{model, max_tokens, temperature, tools, onReasoning(delta, full), onToolCalls(calls)}) -> full text, image(prompt, model?) -> URL,",
  "  models(), health(), probe(mode), sync(), resurrect(limit), source(file), traces(limit), trace(id), storeFor(id) -> {get, set, del}.",
  "  Style with the workspace classes: .btn (button), .btn.q (quiet), .in (full-width input), .box (bordered), .row (flex row), .grow, .dim, .mid, .acc, .ok, .no, .warn, .lbl, pre, table.",
  "",
  "RULES:",
  "- Server files are immutable at runtime. For server changes: read the code, give the exact patch text, never claim it was applied.",
  "- Read before claiming. Navigate by file_map and search_code, then read_file exact ranges.",
  "- Diagnose routing problems from traces/get_trace evidence, not guesses.",
  "- Plugins: complete code, lowercase-dash ids, no closing script tag inside strings. After install, verify with list_plugins.",
].join("\n");

const arch = { history: store.get("arch", []), ctl: null };
const athread = $("#athread");
function armArchitect() { $("#aarm").textContent = creds().admin ? "admin tools armed" : "admin tools locked"; $("#aarm").className = creds().admin ? "acc" : "dim"; }
function parseAction(text) {
  const s = String(text);
  const tryParse = (raw) => {
    for (const r of [raw, raw.replace(/,\s*([}\]])/g, "$1")]) { try { const o = JSON.parse(r); if (o && typeof o.tool === "string") return o; } catch { /* next */ } }
    return null;
  };
  for (const m of s.matchAll(/```(?:action|json)?\s*\n?([\s\S]*?)```/g)) { const o = tryParse(m[1].trim()); if (o) return o; }
  const start = s.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, bs = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (bs) bs = false; else if (ch === "\\") bs = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return tryParse(s.slice(start, i + 1));
    }
  }
  return null;
}
const srcCache = new Map();
async function source(file) {
  if (srcCache.has(file)) return srcCache.get(file);
  let content = null;
  if (creds().admin) {
    try { content = (await req("/v1/source?file=" + encodeURIComponent(file), { admin: true })).content; }
    catch (e) { if (file !== "index.html") throw e; }
  }
  if (content === null) {
    if (file !== "index.html") throw new Error("server files need the admin secret (connection settings)");
    content = await (await fetch(location.pathname)).text();
  }
  srcCache.set(file, content);
  return content;
}
const fileOk = (tool, file) => AFILES.includes(file) ? null : `${tool}: "${file}" not readable. Allowed: ${AFILES.join(", ")}`;
async function runTool(a) {
  const needAdmin = () => { if (!creds().admin) throw new Error(`${a.tool} needs the admin secret`); };
  switch (a.tool) {
    case "read_file": {
      const file = String(a.file ?? ""); const bad = fileOk("read_file", file); if (bad) return { ok: false, detail: bad };
      const content = await source(file), lines = content.split("\n");
      const start = Math.max(1, parseInt(a.start_line) || 1), budget = Math.min(200000, Math.max(4000, parseInt(a.byte_budget) || 120000));
      let end = start - 1, used = 0;
      while (end < lines.length && (end < start || used + lines[end].length + 1 <= budget)) used += lines[end++].length + 1;
      const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join("\n");
      return { ok: true, detail: `${file} — ${lines.length} lines; showing ${start}-${end}.${end < lines.length ? ` Continue with start_line ${end + 1}.` : " End of file."}\n${slice}` };
    }
    case "search_code": {
      const file = String(a.file ?? ""); const bad = fileOk("search_code", file); if (bad) return { ok: false, detail: bad };
      const q = String(a.query ?? ""); if (!q) return { ok: false, detail: "search_code: query required" };
      let re; try { re = new RegExp(q, "i"); } catch { re = null; }
      const hits = []; let n = 0;
      (await source(file)).split("\n").forEach((l, i) => { if (re ? re.test(l) : l.toLowerCase().includes(q.toLowerCase())) { n++; if (hits.length < 40) hits.push(`L${i + 1}: ${l.trim().slice(0, 200)}`); } });
      return { ok: true, detail: `${file}: ${n} match(es)${n > hits.length ? `, first ${hits.length}` : ""}:\n${hits.join("\n") || "(none)"}` };
    }
    case "file_map": {
      const file = String(a.file ?? ""); const bad = fileOk("file_map", file); if (bad) return { ok: false, detail: bad };
      const out = [];
      (await source(file)).split("\n").forEach((l, i) => {
        if (out.length >= 250) return;
        const m = l.match(/^(?:export\s+)?(?:async\s+)?function\*?\s+([\w$]+)/) ?? l.match(/honoApp\.(get|post|use)\(\s*"([^"]+)"/) ?? l.match(/Deno\.cron\(\s*"([^"]+)"/) ??
          l.match(/^(?:export\s+)?const\s+([\w$]+)\s*=/) ?? l.match(/^(?:export\s+)?class\s+([\w$]+)/) ?? l.match(/<section class="view[^"]*" id="(v-[\w-]+)"/) ?? l.match(/^(#{1,3})\s+(.*)/) ?? l.match(/^\/\/ =+\s*$|^\/\/ ([A-Z][A-Z0-9 —\-]{4,})$/);
        if (m && m[0].trim()) out.push(`L${i + 1}: ${l.trim().slice(0, 100)}`);
      });
      return { ok: true, detail: `${file} outline (${out.length} landmarks):\n${out.join("\n")}` };
    }
    case "router_health": {
      const h = await ping();
      const lanes = ["fast", "smart", "code", "reasoning"].map((l) => `${l}: ${(h["current_best_" + l] ?? []).slice(0, 3).map((x) => `${x.tupleId} (p50 ${ms(Math.exp(x.logTtftMu))}, rel ${f(x.reliabilityDraw, 2)})`).join(" | ") || "none"}`);
      return { ok: true, detail: `engine ${h.engine}\ncoverage ${JSON.stringify(h.coverage)}\nsecurity ${JSON.stringify(h.security)}\n${lanes.join("\n")}` };
    }
    case "endpoints": {
      const d = await req("/v1/endpoints"), q = String(a.filter ?? "").toLowerCase();
      const rows = (d.data ?? []).filter((e) => !q || `${e.id} ${e.name} ${e.url}`.toLowerCase().includes(q));
      return { ok: true, detail: `${d.configured_endpoints} configured, ${d.catalog_tuples} tuples, ${d.sweep_candidates} sweep candidates. ${rows.length} shown:\n${rows.slice(0, 120).map((e) => `${e.id} · ${e.catalog_tuples} tuples · ${e.url}`).join("\n")}` };
    }
    case "list_models": {
      const d = await req("/v1/models"), q = String(a.filter ?? "").toLowerCase();
      const ids = (d.data ?? []).map((m) => m.id).filter((id) => !q || id.toLowerCase().includes(q));
      return { ok: true, detail: `${d.data?.length ?? 0} models, ${ids.length} shown:\n${ids.slice(0, 120).join("\n")}` };
    }
    case "traces": {
      needAdmin();
      const d = await req(`/v1/traces?limit=${Math.min(100, parseInt(a.limit) || 20)}`, { admin: true });
      return { ok: true, detail: (d.data ?? []).map((t) => { const r = t.root, at = r.attrs; return `${t.id} ${r.name} ${at["model.requested"] ?? ""} ${at.mode ?? ""} ${r.status} ${ms((r.end ?? Date.now()) - r.start)} tuple=${at.tuple ?? "-"} attempts=${at.attempts ?? "-"} failed_spans=${t.errors}${at.error ? ` error=${at.error}` : ""}`; }).join("\n") || "no traces in this isolate" };
    }
    case "get_trace": {
      needAdmin();
      const t = await req("/v1/traces/" + encodeURIComponent(String(a.id ?? "")), { admin: true });
      const t0 = Math.min(...t.spans.map((s) => s.start));
      return { ok: true, detail: t.spans.map((s) => `${s.name} +${ms(s.start - t0)} ${ms((s.end ?? Date.now()) - s.start)} ${s.status} ${JSON.stringify(s.attrs)}${s.events.length ? " events=" + JSON.stringify(s.events.map((e) => ({ n: e.name, ...e.attrs }))) : ""}`).join("\n") };
    }
    case "ping_model": {
      const model = String(a.model ?? "free:smart"), t0 = performance.now();
      const d = await req("/v1/chat/completions", { method: "POST", body: { model, messages: [{ role: "user", content: "Reply with exactly: pong" }], max_tokens: 32 } });
      return { ok: true, detail: `${model}: ${ms(performance.now() - t0)} via ${d.kono?.tuple_id ?? d.provider}; degraded=${Boolean(d.kono?.degraded)}; reply "${String(d.choices?.[0]?.message?.content ?? "").slice(0, 100)}"; trace ${d.kono?.trace_id ?? ""}` };
    }
    case "run_probe": { needAdmin(); const d = await req("/v1/probe", { method: "POST", admin: true, body: { mode: a.mode ?? "smart" } }); return { ok: true, detail: (d.results ?? []).map((r) => r.ok ? `${r.passed ? "PASS" : "WRONG"} ${r.tupleId} ${ms(r.ms)}` : `FAIL ${r.tupleId} ${r.error ?? ""}`).join("\n") || "no candidates" }; }
    case "force_sync": { needAdmin(); const d = await req("/v1/sync", { method: "POST", admin: true, body: {} }); return { ok: true, detail: `catalog synced: ${d.total_models} models` }; }
    case "list_plugins": return { ok: true, detail: KonoPlugins._list.map((p) => `- ${p.id} "${p.name}"${p.admin ? " [admin]" : ""}${p.builtin ? " [builtin]" : ""}: ${p.description ?? ""}`).join("\n") || "none" };
    case "install_plugin": {
      const r = installPlugin(String(a.code ?? ""));
      return r.ok ? { ok: true, detail: `installed and persisted: ${r.ids.join(", ")} (Plugins view)` } : { ok: false, detail: r.error };
    }
    default: return { ok: false, detail: `unknown tool "${a.tool}". Valid: read_file, search_code, file_map, router_health, endpoints, list_models, traces, get_trace, ping_model, run_probe, force_sync, list_plugins, install_plugin` };
  }
}
function archMsg(role, html) {
  const el = document.createElement("article");
  el.className = "msg " + (role === "user" ? "u" : "a");
  el.innerHTML = role === "user" ? `<div class="body"></div>` : `<div class="alog"></div><div class="md"></div><div class="foot"></div>`;
  if (role === "user") $(".body", el).textContent = html;
  athread.append(el);
  athread.scrollTop = athread.scrollHeight;
  return el;
}
function renderArch() {
  athread.replaceChildren();
  for (const m of arch.history) {
    if (m.role === "user" && !m.content.startsWith("[Tool result:")) archMsg("user", m.content);
    else if (m.role === "assistant" && !parseAction(m.content)) renderMd($(".md", archMsg("assistant")), m.content);
  }
}
async function sendArch() {
  const text = $("#ainput").value.trim();
  if (!text || arch.ctl) return;
  $("#ainput").value = ""; autosize($("#ainput"));
  arch.history.push({ role: "user", content: text });
  archMsg("user", text);
  const el = archMsg("assistant"), log = $(".alog", el), md = $(".md", el);
  const line = (html) => { const d = document.createElement("div"); d.innerHTML = html; log.append(d); athread.scrollTop = athread.scrollHeight; return d; };
  arch.ctl = new AbortController();
  $("#asend").hidden = true; $("#astop").hidden = false;
  const t0 = performance.now();
  let final = "", rounds = 0;
  try {
    for (rounds = 1; rounds <= 8; rounds++) {
      const working = line(`<span class="dim">round ${rounds} · thinking</span>`);
      const res = await req("/v1/chat/completions", { method: "POST", signal: arch.ctl.signal, body: { model: $("#amodel")?.value.trim() || "free:smart", temperature: 0.2, messages: [{ role: "system", content: ARCH_PROMPT }, ...arch.history] } });
      const reply = res.choices?.[0]?.message?.content ?? "";
      const tr = res.kono?.trace_id ?? "";
      working.remove();
      arch.history.push({ role: "assistant", content: reply });
      const action = parseAction(reply);
      if (!action) {
        if ((reply.includes("```action") || /"tool"\s*:/.test(reply)) && rounds < 8) {
          line(`<span class="warn">unparseable action · asking for valid JSON</span>`);
          arch.history.push({ role: "user", content: "[Tool result: system] (FAILED) Action block was not valid JSON. Resend exactly one ```action block with valid JSON only." });
          continue;
        }
        final = reply;
        break;
      }
      const fence = reply.indexOf("```");
      if (fence > 0) line(`<span class="mid">${esc(reply.slice(0, fence).trim().slice(0, 300))}</span>`);
      const l = line(`<span class="acc">${esc(action.tool)}</span> <span class="dim">running</span>`);
      let r;
      try { r = await runTool(action); } catch (e) { r = { ok: false, detail: `${action.tool} failed: ${e.message}` }; }
      l.innerHTML = `<span class="acc">${esc(action.tool)}</span> <span class="${r.ok ? "ok" : "no"}">${r.ok ? "ok" : "failed"}</span> <span class="dim">${esc(r.detail.split("\n")[0].slice(0, 140))}</span>${tr ? ` <a href="#" data-tr="${tr}">trace</a>` : ""}`;
      arch.history.push({ role: "user", content: `[Tool result: ${action.tool}]${r.ok ? "" : " (FAILED)"} ${r.detail}` });
      if (rounds === 8) final = "Used all 8 tool rounds. Say continue to resume.";
    }
  } catch (e) {
    final = "";
    line(`<span class="err">${esc(e.name === "AbortError" ? "stopped" : e.message)}</span>`);
  }
  if (final) renderMd(md, final);
  $(".foot", el).textContent = `${Math.min(rounds, 8)} round${rounds > 1 ? "s" : ""} · ${ms(performance.now() - t0)}`;
  store.set("arch", arch.history.slice(-60));
  arch.ctl = null;
  $("#asend").hidden = false; $("#astop").hidden = true;
}
$("#asend").onclick = sendArch;
$("#astop").onclick = () => arch.ctl?.abort();
$("#ainput").addEventListener("input", (e) => autosize(e.target));
$("#ainput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendArch(); } });
$("#areset").onclick = () => { arch.history = []; store.set("arch", []); athread.replaceChildren(); };
athread.onclick = (e) => { const a = e.target.closest("[data-tr]"); if (a) { e.preventDefault(); openTrace(a.dataset.tr); } };
enter.architect = () => { armArchitect(); if (!athread.childElementCount && arch.history.length) renderArch(); $("#ainput").focus(); };
cmd("reset architect", () => { go("architect"); $("#areset").click(); });

