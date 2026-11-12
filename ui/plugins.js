// =====================================================================
// PLUGINS — SDK v2 (unchanged surface) + traces; user plugins persist
// =====================================================================
const pctx = {
  base: () => creds().url, apiKey: () => creds().key, adminSecret: () => creds().admin,
  fetchJson: async (url, opts = {}) => { const res = await fetch(url, opts); const text = await res.text(); let data; try { data = JSON.parse(text); } catch { throw new Error(`non-JSON response (HTTP ${res.status})`); } return { res, data }; },
  toast: (m, bad) => toast(String(m), bad === true || bad === "error"),
  log: (msg) => irecord({ t: Date.now(), method: "PLUGIN", url: "", path: String(msg).slice(0, 200), status: 200, ms: 0, req: null, res: msg, trace: "" }),
  esc,
  chat: (messages, o = {}) => req("/v1/chat/completions", { method: "POST", admin: true, body: { model: o.model ?? "free:smart", messages, max_tokens: o.max_tokens ?? 1024, temperature: o.temperature ?? 0.7, ...(o.tools ? { tools: o.tools } : {}), stream: false } }),
  chatStream: async (messages, onDelta, o = {}) => {
    const res = await req("/v1/chat/completions", { method: "POST", raw: true, body: { model: o.model ?? "free:smart", messages, max_tokens: o.max_tokens ?? 1024, temperature: o.temperature ?? 0.7, ...(o.tools ? { tools: o.tools } : {}), stream: true } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let full = "", rs = "";
    const calls = [];
    for await (const { data } of sse(res)) {
      if (!data || data === "[DONE]") continue;
      const j = JSON.parse(data);
      if (j.error) throw new Error(j.error.message);
      const d = j.choices?.[0]?.delta ?? {};
      if (d.reasoning_content) { rs += d.reasoning_content; o.onReasoning?.(d.reasoning_content, rs); }
      if (d.content) { full += d.content; onDelta?.(d.content, full); }
      for (const t of d.tool_calls ?? []) {
        const c = calls[t.index] ??= { id: t.id, type: "function", function: { name: "", arguments: "" } };
        c.function.name += t.function?.name ?? ""; c.function.arguments += t.function?.arguments ?? "";
      }
    }
    if (calls.length) o.onToolCalls?.(calls);
    return full;
  },
  image: async (prompt, model = "kono-image") => { const d = await req("/v1/images/generations", { method: "POST", body: { prompt, model, response_format: "url" } }); const it = d.data?.[0] ?? {}; return it.url || (it.b64_json ? "data:image/png;base64," + it.b64_json : ""); },
  models: async () => (await req("/v1/models")).data ?? [],
  health: () => req("/health"),
  probe: (mode = "smart") => req("/v1/probe", { method: "POST", admin: true, body: { mode } }),
  sync: () => req("/v1/sync", { method: "POST", admin: true, body: {} }),
  resurrect: (limit = 6) => req("/v1/resurrect", { method: "POST", admin: true, body: { limit } }),
  source: async (file) => (await req("/v1/source?file=" + encodeURIComponent(file), { admin: true })).content,
  traces: async (limit = 50) => (await req("/v1/traces?limit=" + limit, { admin: true })).data,
  trace: (id) => req("/v1/traces/" + encodeURIComponent(id), { admin: true }),
  storeFor: (id) => ({ get: (k, d = null) => store.get(`plugin:${id}:${k}`, d), set: (k, v) => store.set(`plugin:${id}:${k}`, v), del: (k) => store.del(`plugin:${id}:${k}`) }),
};
let pluginsShown = false, loadingBuiltins = true;
const KonoPlugins = window.KonoPlugins = {
  _list: [],
  register(p) {
    if (!p || typeof p.id !== "string" || typeof p.mount !== "function") throw new Error("register({ id, name, mount(el, ctx) }) required");
    p.builtin = loadingBuiltins;
    this._list = this._list.filter((x) => x.id !== p.id);
    this._list.push(p);
    if (pluginsShown) renderPlugins();
  },
};
function installPlugin(code, persist = true) {
  if (!code.includes("KonoPlugins.register")) return { ok: false, error: "code must call KonoPlugins.register({...})" };
  const before = new Map(KonoPlugins._list.map((p) => [p.id, p]));
  try { new Function("KonoPlugins", "ctx", code)(KonoPlugins, pctx); }
  catch (e) { return { ok: false, error: "plugin threw: " + e.message }; }
  const ids = KonoPlugins._list.filter((p) => before.get(p.id) !== p).map((p) => p.id);
  if (!ids.length) return { ok: false, error: "code ran but registered no plugin" };
  if (persist) { const saved = store.get("plugins", {}); for (const id of ids) saved[id] = code; store.set("plugins", saved); }
  return { ok: true, ids };
}
function renderPlugins() {
  pluginsShown = true;
  $("#plcount").textContent = `${KonoPlugins._list.length} plugins`;
  $("#plgrid").replaceChildren(...KonoPlugins._list.map((p) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="h"><b>${esc(p.name ?? p.id)}</b>${p.admin ? `<span class="badge adm">admin</span>` : ""}<span class="grow"></span>${p.builtin ? "" : `<button class="btn q" data-rm="${esc(p.id)}" aria-label="Uninstall ${esc(p.name ?? p.id)}">×</button>`}</div>
      ${p.description ? `<div class="d">${esc(p.description)}</div>` : ""}<div class="pb"></div>`;
    const body = $(".pb", card);
    if (p.admin && !creds().admin) body.innerHTML = `<span class="dim">needs the admin secret</span>`;
    else try { p.mount(body, pctx); } catch (e) { body.innerHTML = `<span class="no">mount error: ${esc(e.message)}</span>`; }
    return card;
  }));
}
$("#plgrid").onclick = (e) => {
  const b = e.target.closest("[data-rm]"); if (!b) return;
  const saved = store.get("plugins", {}); delete saved[b.dataset.rm]; store.set("plugins", saved);
  KonoPlugins._list = KonoPlugins._list.filter((p) => p.id !== b.dataset.rm);
  renderPlugins();
};
const PLUGIN_EXAMPLE = `KonoPlugins.register({
  id: 'lane-race',
  name: 'Lane Race',
  description: 'Fires the same prompt at every lane in parallel and ranks them by time to answer.',
  mount(el, ctx) {
    el.innerHTML = '<div class="row"><input class="in grow" value="Name three prime numbers."><button class="btn">race</button></div><table style="margin-top:8px"><tbody></tbody></table>';
    const [input, btn, tb] = [el.querySelector('input'), el.querySelector('button'), el.querySelector('tbody')];
    btn.onclick = async () => {
      tb.innerHTML = '';
      const lanes = ['free:fast', 'free:smart', 'free:code', 'free:reasoning'];
      const runs = lanes.map(async (model) => {
        const t0 = performance.now();
        try { const d = await ctx.chat([{ role: 'user', content: input.value }], { model, max_tokens: 64 }); return { model, ms: performance.now() - t0, by: d.kono?.tuple_id ?? d.provider }; }
        catch (e) { return { model, ms: Infinity, by: e.message }; }
      });
      for (const r of (await Promise.all(runs)).sort((a, b) => a.ms - b.ms)) tb.insertAdjacentHTML('beforeend', '<tr><td>' + r.model + '</td><td>' + (isFinite(r.ms) ? Math.round(r.ms) + 'ms' : '—') + '</td><td class="t">' + ctx.esc(r.by) + '</td></tr>');
    };
  }
});`;
$("#plnew").onclick = () => { $("#plinstall").hidden = false; if (!$("#plcode").value) $("#plcode").value = PLUGIN_EXAMPLE; $("#plcode").focus(); };
$("#plcancel").onclick = () => $("#plinstall").hidden = true;
$("#plgo").onclick = () => { const r = installPlugin($("#plcode").value); r.ok ? (toast("installed " + r.ids.join(", ")), $("#plinstall").hidden = true) : toast(r.error, true); };
enter.plugins = renderPlugins;

// built-ins
KonoPlugins.register({
  id: "model-ping", name: "Model Ping", description: "Minimal completion to any model id or lane: latency, serving tuple, trace.",
  mount(el, ctx) {
    el.innerHTML = `<div class="row"><input class="grow" list="modellist" value="free:smart" aria-label="Model"><button class="btn">ping</button></div><div style="margin-top:8px"></div>`;
    const [inp, btn, out] = [$("input", el), $("button", el), $("div:last-child", el)];
    btn.onclick = async () => {
      out.innerHTML = `<span class="dim">…</span>`; const t0 = performance.now();
      try { const d = await ctx.chat([{ role: "user", content: "Reply with exactly: pong" }], { model: inp.value.trim(), max_tokens: 32 });
        out.innerHTML = `<span class="${d.kono?.degraded ? "warn" : "ok"}">${ms(performance.now() - t0)}</span> <span class="mid">${esc(d.kono?.tuple_id ?? d.provider ?? "")}</span> <a href="#" data-tr="${esc(d.kono?.trace_id ?? "")}">trace</a><div class="dim">${esc(String(d.choices?.[0]?.message?.content ?? "").slice(0, 120))}</div>`;
        $("a", out).onclick = (e) => { e.preventDefault(); openTrace(e.target.dataset.tr); };
      } catch (e) { out.innerHTML = `<span class="no">${esc(e.message)}</span>`; }
    };
  },
});
KonoPlugins.register({
  id: "prompt-lab", name: "Prompt Lab", description: "Streaming mini-chat built only on the SDK: models, chatStream with live reasoning, storeFor.",
  mount(el, ctx) {
    const st = ctx.storeFor("prompt-lab"), hist = st.get("history", []);
    el.innerHTML = `<div class="row"><select class="grow" aria-label="Model"><option>free:smart</option></select><button class="btn q">clear</button></div>
      <pre class="wrap" style="height:180px;margin:8px 0"></pre><div class="row"><input class="grow" aria-label="Prompt"><button class="btn">send</button></div>`;
    const [sel, clr, out, inp, snd] = [$("select", el), $(".btn.q", el), $("pre", el), $("input", el), $(".btn:not(.q)", el)];
    const render = (rs = "") => { out.textContent = hist.map((m) => `${m.role === "user" ? "›" : "‹"} ${m.content}`).join("\n\n") + (rs ? `\n\n[reasoning] ${rs.slice(-400)}` : ""); out.scrollTop = out.scrollHeight; };
    render();
    ctx.models().then((ms_) => { sel.innerHTML = ms_.slice(0, 300).map((m) => `<option>${esc(m.id)}</option>`).join(""); sel.value = "free:smart"; }).catch(() => {});
    const send = async () => {
      const text = inp.value.trim(); if (!text) return; inp.value = "";
      hist.push({ role: "user", content: text }); const a = { role: "assistant", content: "" }; hist.push(a); render();
      try { await ctx.chatStream(hist.slice(0, -1), (_d, full) => { a.content = full; render(); }, { model: sel.value, onReasoning: (_d, full) => render(full) }); }
      catch (e) { a.content = "error: " + e.message; }
      render(); st.set("history", hist.slice(-20));
    };
    snd.onclick = send; inp.onkeydown = (e) => { if (e.key === "Enter") send(); };
    clr.onclick = () => { hist.length = 0; st.set("history", []); render(); };
  },
});
KonoPlugins.register({
  id: "image-quickgen", name: "Image QuickGen", description: "One-shot image through /v1/images/generations.",
  mount(el, ctx) {
    el.innerHTML = `<div class="row"><input class="grow" aria-label="Prompt"><button class="btn">generate</button></div><div style="margin-top:8px"></div>`;
    const [inp, btn, out] = [$("input", el), $("button", el), $("div:last-child", el)];
    btn.onclick = async () => {
      if (!inp.value.trim()) return; out.innerHTML = `<span class="dim">…</span>`;
      try { const src = await ctx.image(inp.value.trim()); out.innerHTML = `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="generated" style="width:100%;border:1px solid var(--line)"></a>`; }
      catch (e) { out.innerHTML = `<span class="no">${esc(e.message)}</span>`; }
    };
  },
});
KonoPlugins.register({
  id: "lane-probe", name: "Lane Probe", admin: true, description: "Server canary against a lane's top candidates; verified IQ written back.",
  mount(el, ctx) {
    el.innerHTML = `<div class="row"><select class="grow" aria-label="Lane"><option>fast</option><option selected>smart</option><option>code</option><option>reasoning</option></select><button class="btn">probe</button></div><div style="margin-top:8px"></div>`;
    const [sel, btn, out] = [$("select", el), $("button", el), $("div:last-child", el)];
    btn.onclick = async () => {
      out.innerHTML = `<span class="dim">…</span>`;
      try { const d = await ctx.probe(sel.value); out.innerHTML = (d.results ?? []).map((r) => r.ok ? `<div class="${r.passed ? "ok" : "warn"}">${r.passed ? "pass" : "wrong"} ${esc(r.tupleId)} <span class="dim">${ms(r.ms)}</span></div>` : `<div class="no">fail ${esc(r.tupleId)} <span class="dim">${esc(r.error ?? "")}</span></div>`).join("") || `<span class="dim">no candidates</span>`; }
      catch (e) { out.innerHTML = `<span class="no">${esc(e.message)}</span>`; }
    };
  },
});
KonoPlugins.register({
  id: "catalog-sync", name: "Catalog Sync", admin: true, description: "Full provider sweep: rediscover models, report totals.",
  mount(el, ctx) {
    el.innerHTML = `<button class="btn">sync</button><div style="margin-top:8px"></div>`;
    $("button", el).onclick = async () => { const out = $("div", el); out.innerHTML = `<span class="dim">…</span>`; try { const d = await ctx.sync(); out.innerHTML = `<span class="ok">${d.total_models} models</span>`; } catch (e) { out.innerHTML = `<span class="no">${esc(e.message)}</span>`; } };
  },
});
loadingBuiltins = false;
for (const code of new Set(Object.values(store.get("plugins", {})))) {
  const r = installPlugin(code, false);
  if (!r.ok) console.warn("stored plugin failed:", r.error);
}

