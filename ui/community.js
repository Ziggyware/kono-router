// =====================================================================
// PEOPLE CHAT (COMMUNITY PEER CHAT)
// =====================================================================
let commRoom = "general";
let commMessages = [];
let commStreamCtl = null;
const commChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("nokey-community") : null;

function getCommUser() {
  let user = store.get("comm_user", "");
  if (!user) {
    user = "User-" + Math.floor(1000 + Math.random() * 9000);
    store.set("comm_user", user);
  }
  return user;
}

function initCommunityChat() {
  const usernameInput = $("#comm-username");
  if (usernameInput) {
    usernameInput.value = getCommUser();
    usernameInput.addEventListener("change", () => {
      const v = usernameInput.value.trim() || "Anonymous";
      store.set("comm_user", v);
      toast(`Handle updated to ${v}`);
    });
  }

  // BroadcastChannel listener
  if (commChannel) {
    commChannel.onmessage = (e) => {
      if (e.data?.room === commRoom && e.data?.message) {
        appendCommMessage(e.data.message);
      }
    };
  }

  connectCommSSE();
  loadCommMessages();
}

function connectCommSSE() {
  // EventSource cannot send an Authorization header and the /v1/* auth
  // middleware requires one, so the stream always 401'd. Stream it with
  // fetch() instead and parse the SSE frames here.
  if (commStreamCtl) commStreamCtl.abort();
  const ctl = new AbortController();
  commStreamCtl = ctl;
  (async () => {
    try {
      const url = new URL("/v1/community/stream", location.origin);
      url.searchParams.set("room", commRoom);
      const res = await fetch(url.toString(), { headers: headers(false, false), signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error("stream HTTP " + res.status);
      const st = $("#comm-conn-status");
      if (st) st.textContent = "Online (SSE)";
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const j = JSON.parse(line.slice(5).trim());
              if (j.type === "message" && j.message) appendCommMessage(j.message);
            } catch { /* comment/keepalive frame */ }
          }
        }
      }
      throw new Error("stream ended");
    } catch (e) {
      if (ctl.signal.aborted) return;
      const st = $("#comm-conn-status");
      if (st) st.textContent = "Reconnecting (Relay active)";
      setTimeout(() => { if (commStreamCtl === ctl && current === "community") connectCommSSE(); }, 3500);
    }
  })();
}

async function loadCommMessages() {
  try {
    const d = await req(`/v1/community/messages?room=${encodeURIComponent(commRoom)}&limit=100`);
    commMessages = d.messages ?? [];
    renderCommThread();
  } catch (err) {
    console.error("loadCommMessages error", err);
  }
}

function renderCommThread() {
  const thread = $("#comm-thread");
  if (!thread) return;
  thread.innerHTML = "";
  commMessages.forEach((msg) => appendCommMessageEl(msg, thread));
  thread.scrollTop = thread.scrollHeight;
  const countEl = $("#comm-msg-count");
  if (countEl) countEl.textContent = `${commMessages.length} messages`;
}

function appendCommMessage(msg) {
  if (commMessages.some((m) => m.id === msg.id)) return;
  commMessages.push(msg);
  const thread = $("#comm-thread");
  if (thread) {
    appendCommMessageEl(msg, thread);
    thread.scrollTop = thread.scrollHeight;
    const countEl = $("#comm-msg-count");
    if (countEl) countEl.textContent = `${commMessages.length} messages`;
  }
}

function appendCommMessageEl(msg, thread) {
  const card = document.createElement("div");
  card.className = "comm-msg-card";
  card.dataset.id = msg.id;
  
  const avatar = msg.avatar || msg.user?.slice(0, 1)?.toUpperCase() || "U";
  const time = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const lines = (msg.content.match(/\n/g) || []).length + 1;
  const isLong = lines > 6 || msg.content.length > 380;

  card.innerHTML = `
    <div class="comm-msg-avatar">${esc(avatar)}</div>
    <div class="comm-msg-body">
      <div class="comm-msg-head">
        <span class="comm-msg-user">${esc(msg.user || "Anonymous")}</span>
        <span class="comm-msg-time">${esc(time)}</span>
      </div>
      <div class="comm-msg-text md ${isLong ? "clamped" : ""}"></div>
      ${isLong ? `<button class="btn-expand-msg" data-act="toggle-comm-expand">Show more (${lines} lines) ▾</button>` : ""}
      <div class="comm-reactions">
        <button class="comm-reaction-chip" data-emoji="👍">👍 <span class="cnt">1</span></button>
        <button class="comm-reaction-chip" data-emoji="🚀">🚀 <span class="cnt">1</span></button>
        <button class="comm-reaction-chip comm-reaction-add" data-act="add-reaction">+ 😀</button>
      </div>
    </div>
  `;

  renderMd($(".comm-msg-text", card), msg.content, true);

  if (isLong) {
    const btn = card.querySelector(".btn-expand-msg");
    const textEl = card.querySelector(".comm-msg-text");
    btn.onclick = () => {
      const clamped = textEl.classList.toggle("clamped");
      btn.textContent = clamped ? `Show more (${lines} lines) ▾` : "Show less ▴";
    };
  }

  thread.appendChild(card);
}

async function sendCommMessage() {
  const input = $("#comm-input");
  const content = input.value.trim();
  if (!content) return;
  const user = getCommUser();
  const msgObj = {
    room: commRoom,
    user,
    content,
    avatar: "💬",
  };
  input.value = "";
  input.style.height = "auto";
  try {
    const d = await req("/v1/community/messages", { method: "POST", body: msgObj });
    if (d.ok && d.message) {
      appendCommMessage(d.message);
      commChannel?.postMessage({ room: commRoom, message: d.message });
    }
  } catch (err) {
    toast(`Send failed: ${err.message}`, true);
  }
}

$("#comm-send-btn")?.addEventListener("click", sendCommMessage);
$("#comm-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCommMessage();
  }
});
$("#comm-refresh-btn")?.addEventListener("click", loadCommMessages);

// Channel switching
$("#comm-channels")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-room]");
  if (!btn) return;
  for (const b of $$("#comm-channels button")) b.classList.toggle("active", b === btn);
  commRoom = btn.dataset.room;
  $("#comm-room-title").textContent = `# ${commRoom}`;
  connectCommSSE();
  loadCommMessages();
});

$("#comm-add-channel")?.addEventListener("click", () => {
  openFormModal("#comm-channel-modal");
});
$("#btn-create-channel")?.addEventListener("click", (e) => {
  e.preventDefault();
  const name = $("#new-channel-name").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!name) return;
  const list = $("#comm-channels");
  const btn = document.createElement("button");
  btn.className = "comm-channel-btn";
  btn.dataset.room = name;
  btn.innerHTML = `<span class="hash">#</span> ${esc(name)}`;
  list.appendChild(btn);
  $("#comm-channel-modal").close();
  btn.click();
  toast(`Joined #${name}`);
});

$("#comm-share-app")?.addEventListener("click", () => {
  const input = $("#comm-input");
  input.value += `Hey everyone, check out this application built with nokey-router App Builder:\n\`\`\`html\n<!DOCTYPE html>\n<html>\n<head><title>Community App</title></head>\n<body><h1>Hello from App Builder!</h1></body>\n</html>\n\`\`\`\n`;
  input.focus();
});

$("#comm-share-tool")?.addEventListener("click", () => {
  const input = $("#comm-input");
  input.value += `Executed tool call snippet:\n\`\`\`json\n{\n  "tool": "calculate",\n  "expression": "(23 * 19) + 14",\n  "result": 451\n}\n\`\`\`\n`;
  input.focus();
});

$("#comm-insert-code")?.addEventListener("click", () => {
  const input = $("#comm-input");
  input.value += `\`\`\`typescript\n// Paste code here\n\`\`\`\n`;
  input.focus();
});

// Reactions
$("#comm-thread")?.addEventListener("click", (e) => {
  const chip = e.target.closest(".comm-reaction-chip");
  if (!chip) return;
  const cnt = chip.querySelector(".cnt");
  if (cnt) {
    cnt.textContent = String(Number(cnt.textContent) + 1);
    chip.classList.add("sel");
  } else if (chip.dataset.act === "add-reaction") {
    const parent = chip.closest(".comm-reactions");
    const b = document.createElement("button");
    b.className = "comm-reaction-chip sel";
    b.innerHTML = `🔥 <span class="cnt">1</span>`;
    parent.insertBefore(b, chip);
  }
});

// ---- community tabs: dashboard · posts · chat ----
const commVoter = (() => { let v = store.get("comm_voter", ""); if (!v) { v = crypto.randomUUID(); store.set("comm_voter", v); } return v; })();
let cmTab = store.get("community.tab", "posts"), cmSort = "hot", cmOpen = null, commChatStarted = false;
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago"; };
function showCommTab(name) {
  cmTab = name;
  store.set("community.tab", name);
  for (const b of $$("#v-community [data-ctab]")) b.setAttribute("aria-selected", String(b.dataset.ctab === name));
  for (const p of $$("#v-community [data-cpage]")) p.hidden = p.dataset.cpage !== name;
  if (name === "chat" && !commChatStarted) { commChatStarted = true; initCommunityChat(); }
  if (name === "posts") cmOpen ? openPost(cmOpen) : loadPosts();
  if (name === "dashboard") loadCommStats();
}
$("#v-community .cm-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-ctab]"); if (b) showCommTab(b.dataset.ctab); });
function voteBox(p) {
  const cls = p.score > 0 ? "pos" : p.score < 0 ? "neg" : "";
  return `<div class="cm-vote" data-post="${esc(p.id)}"><button data-v="1" aria-pressed="${p.myVote === 1}" aria-label="Upvote">▲</button><b class="${cls}">${p.score}</b><button data-v="-1" aria-pressed="${p.myVote === -1}" aria-label="Downvote">▼</button></div>`;
}
async function loadPosts() {
  $("#cm-detail").hidden = true;
  $("#cm-list").hidden = false;
  $(".cm-bar").hidden = false;
  try {
    const j = await req(`/v1/community/posts?sort=${cmSort}&voter=${encodeURIComponent(commVoter)}`);
    const posts = j.posts ?? [];
    $("#cm-stat").textContent = `${posts.length} posts`;
    $("#cm-list").innerHTML = posts.length ? posts.map((p) => `<article class="cm-post">${voteBox(p)}<div><button class="cm-title" data-open="${esc(p.id)}">${esc(p.title)}</button>
      <div class="cm-meta"><b>${esc(p.user)}</b> · ${ago(p.createdAt)} · ${p.comments} comment${p.comments === 1 ? "" : "s"}</div>${p.body ? `<div class="cm-prev">${esc(p.body.slice(0, 300))}</div>` : ""}</div></article>`).join("")
      : `<div class="cm-empty">no posts yet — start the first thread</div>`;
  } catch (e) { $("#cm-list").innerHTML = `<div class="cm-empty no">${esc(e.message)}</div>`; }
}
async function openPost(id) {
  cmOpen = id;
  const box = $("#cm-detail");
  $("#cm-list").hidden = true;
  $(".cm-bar").hidden = true;
  $("#cm-compose").hidden = true;
  box.hidden = false;
  try {
    const j = await req(`/v1/community/posts/${encodeURIComponent(id)}?voter=${encodeURIComponent(commVoter)}`);
    const p = j.post;
    box.innerHTML = `<button class="cm-back" data-back>← all posts</button><article class="cm-post" style="border-top:1px solid var(--line)">${voteBox(p)}<div><div class="cm-title" style="cursor:default">${esc(p.title)}</div>
      <div class="cm-meta"><b>${esc(p.user)}</b> · ${ago(p.createdAt)} · ${p.comments} comment${p.comments === 1 ? "" : "s"}</div><div class="cm-body md"></div></div></article>
      <div class="cm-cmts">${(j.comments ?? []).map((c) => `<div class="cm-cmt"><div class="cm-meta"><b>${esc(c.user)}</b> · ${ago(c.createdAt)}</div><div class="md" data-c="${esc(c.id)}"></div></div>`).join("") || `<div class="cm-meta" style="padding:10px 0">no comments yet</div>`}</div>
      <form class="cm-cbox" data-comment="${esc(p.id)}"><textarea rows="3" maxlength="5000" placeholder="comment as ${esc(getCommUser())}" aria-label="Comment"></textarea><div><button class="btn" type="submit">comment</button></div></form>`;
    renderMd($(".cm-body", box), p.body || "", true);
    for (const c of j.comments ?? []) renderMd($(`[data-c="${CSS.escape(c.id)}"]`, box), c.body, true);
  } catch (e) { box.innerHTML = `<button class="cm-back" data-back>← all posts</button><div class="cm-empty no">${esc(e.message)}</div>`; }
}
$("#cm-detail").addEventListener("click", (e) => { if (e.target.closest("[data-back]")) { cmOpen = null; loadPosts(); } });
$("#cm-list").addEventListener("click", (e) => { const t = e.target.closest("[data-open]"); if (t) openPost(t.dataset.open); });
// Votes apply optimistically and reconcile with the server's count.
$("#v-community").addEventListener("click", async (e) => {
  const b = e.target.closest(".cm-vote button");
  if (!b) return;
  const box = b.closest(".cm-vote"), id = box.dataset.post, want = Number(b.dataset.v);
  const value = b.getAttribute("aria-pressed") === "true" ? 0 : want;
  try {
    const j = await req(`/v1/community/posts/${encodeURIComponent(id)}/vote`, { method: "POST", body: { voter: commVoter, value } });
    box.outerHTML = voteBox(j.post);
  } catch (err) { toast("vote failed: " + err.message, true); }
});
$("#v-community").addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-comment]");
  if (!f) return;
  e.preventDefault();
  const ta = $("textarea", f), text = ta.value.trim();
  if (!text) return;
  try {
    await req(`/v1/community/posts/${encodeURIComponent(f.dataset.comment)}/comments`, { method: "POST", body: { user: getCommUser(), body: text } });
    openPost(f.dataset.comment);
  } catch (err) { toast("comment failed: " + err.message, true); }
});
$(".cm-sort").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sort]");
  if (!b) return;
  cmSort = b.dataset.sort;
  for (const x of $$(".cm-sort [data-sort]")) x.setAttribute("aria-checked", String(x === b));
  loadPosts();
});
$("#cm-new").addEventListener("click", () => { const f = $("#cm-compose"); f.hidden = !f.hidden; $("#cm-as").textContent = getCommUser(); if (!f.hidden) $("#cm-title").focus(); });
$("#cm-cancel").addEventListener("click", () => { $("#cm-compose").hidden = true; });
$("#cm-compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#cm-title").value.trim();
  if (!title) return;
  try {
    const j = await req("/v1/community/posts", { method: "POST", body: { user: getCommUser(), title, body: $("#cm-body").value } });
    $("#cm-title").value = ""; $("#cm-body").value = ""; $("#cm-compose").hidden = true;
    openPost(j.post.id);
  } catch (err) { toast("post failed: " + err.message, true); }
});
async function loadCommStats() {
  const box = $("#cm-dash");
  try {
    const j = await req("/v1/community/stats");
    const rows = (list, cols) => list.length ? `<table><tbody>${list.map((r) => `<tr>${cols(r)}</tr>`).join("")}</tbody></table>` : `<div class="dim">nothing yet</div>`;
    box.innerHTML = `<div class="cm-kpis">${[["members", j.members], ["active · 24h", j.active_24h], ["posts", j.posts], ["comments", j.comments], ["votes", j.votes], ["chat messages", j.messages]].map(([k, v]) => `<span><b>${v}</b>${k}</span>`).join("")}</div>
      <div class="cm-grid">
        <div class="td-card"><h4>Top posts</h4>${rows(j.top_posts, (p) => `<td class="l"><button class="cm-title" style="font-size:13px" data-goto-post="${esc(p.id)}">${esc(p.title)}</button><div class="cm-meta">${esc(p.user)} · ${p.comments} comments</div></td><td>${p.score}</td>`)}</div>
        <div class="td-card"><h4>Most active</h4>${rows(j.top_people, (p) => `<td class="l">${esc(p.user)}</td><td>${p.posts} posts</td><td>${p.comments} comments</td><td>${p.messages} msgs</td>`)}</div>
        <div class="td-card"><h4>Chat rooms</h4>${rows(Object.entries(j.rooms).map(([room, n]) => ({ room, n })), (r) => `<td class="l">#${esc(r.room)}</td><td>${r.n} messages</td>`)}</div>
      </div>`;
    $("#cm-stat").textContent = `${j.members} members`;
  } catch (e) { box.innerHTML = `<div class="cm-empty no">${esc(e.message)}</div>`; }
}
$("#cm-dash").addEventListener("click", (e) => { const b = e.target.closest("[data-goto-post]"); if (b) { showCommTab("posts"); openPost(b.dataset.gotoPost); } });
enter.community = () => showCommTab(cmTab);

