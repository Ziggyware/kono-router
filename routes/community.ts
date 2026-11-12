// routes/community.ts — Community route registrations extracted from main.ts.
// main.ts calls registerCommunity() at the position of this area's first route, preserving registration order.

import type { CommunityMessage, Json } from "../main.ts";
import { communityRooms, communitySubscribers, honoApp, kv } from "../state.ts";



export function getRoomMessages(room: string): CommunityMessage[] {
  let list = communityRooms.get(room);
  if (!list) {
    list = [
      {
        id: "sys-init",
        room,
        user: "System",
        avatar: "⚡",
        content: `Welcome to #${room}! Connect and chat with other developers and users in real time. Share tool calls, code, prompts, and apps.`,
        createdAt: new Date().toISOString(),
        reactions: { "👋": 3, "🚀": 2 },
      },
    ];
    communityRooms.set(room, list);
  }
  return list;
}



export function broadcastCommunityMessage(msg: CommunityMessage): void {
  const subs = communitySubscribers.get(msg.room);
  if (subs) {
    for (const sub of subs) {
      try { sub(msg); } catch { /* client disconnected */ }
    }
  }
}



// =====================================================================
// COMMUNITY POSTS — reddit-style: anyone posts, up/down votes, comments.
// KV is the source of truth (shared across isolates). One vote per voter id
// per post; score changes commit atomically against both records' versions.
// Ranking "hot" is score / (age_h + 2)^1.5 (Hacker News gravity).
// =====================================================================
export interface CommunityPost {
  id: string;
  user: string;
  title: string;
  body: string;
  createdAt: string;
  up: number;
  down: number;
  score: number;
  comments: number;
}


export interface CommunityComment { id: string; postId: string; user: string; body: string; createdAt: string }



export const cleanHandle = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 32) : "Anonymous");


export const newId = (p: string) => `${p}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;


export const hotRank = (p: CommunityPost, now: number) => p.score / Math.pow((now - Date.parse(p.createdAt)) / 3_600_000 + 2, 1.5);



export async function allPosts(): Promise<CommunityPost[]> {
  const out: CommunityPost[] = [];
  for await (const e of kv.list<CommunityPost>({ prefix: ["cposts"] }, { limit: 1000 })) if (e.value) out.push(e.value);
  return out;
}

export function registerCommunity() {


honoApp.get("/v1/community/messages", (c) => {
  const room = c.req.query("room") || "general";
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const since = c.req.query("since");
  let messages = getRoomMessages(room);
  if (since) {
    messages = messages.filter((m) => m.createdAt > since);
  }
  return c.json({
    ok: true,
    room,
    messages: messages.slice(-limit),
  });
});


honoApp.post("/v1/community/messages", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: { message: "Message content is required" } }, 400);
  }
  const user = typeof body.user === "string" && body.user.trim() ? body.user.trim().slice(0, 32) : "Anonymous";
  const room = typeof body.room === "string" && body.room.trim() ? body.room.trim().toLowerCase().slice(0, 32) : "general";
  const avatar = typeof body.avatar === "string" ? body.avatar.slice(0, 32) : undefined;
  const replyTo = body.replyTo && typeof body.replyTo === "object" ? body.replyTo as { id: string; user: string; text: string } : undefined;

  const msg: CommunityMessage = {
    id: "msg-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    room,
    user,
    avatar,
    content: body.content.slice(0, 20000),
    createdAt: new Date().toISOString(),
    reactions: {},
    replyTo,
  };

  const list = getRoomMessages(room);
  list.push(msg);
  if (list.length > 300) list.shift();

  try {
    kv.set(["community_messages", room, msg.id], msg).catch(() => {});
  } catch { /* KV optional */ }

  broadcastCommunityMessage(msg);
  return c.json({ ok: true, message: msg });
});


honoApp.get("/v1/community/posts", async (c) => {
  const sort = c.req.query("sort") ?? "hot";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const voter = c.req.query("voter") ?? "";
  const now = Date.now();
  const posts = await allPosts();
  posts.sort(sort === "new" ? (a, b) => b.createdAt.localeCompare(a.createdAt)
    : sort === "top" ? (a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)
    : (a, b) => hotRank(b, now) - hotRank(a, now));
  const page = posts.slice(0, limit);
  // Deno KV reads at most 10 keys per getMany.
  const votes: Array<{ value: number | null }> = [];
  if (voter) {
    for (let i = 0; i < page.length; i += 10) {
      votes.push(...await kv.getMany<number[]>(page.slice(i, i + 10).map((p) => ["cvotes", p.id, voter])));
    }
  }
  return c.json({ ok: true, sort, posts: page.map((p, i) => ({ ...p, myVote: votes[i]?.value ?? 0 })) });
});


honoApp.post("/v1/community/posts", async (c) => {
  const body = await c.req.json().catch(() => null) as Json | null;
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) return c.json({ error: { message: "title is required" } }, 400);
  const post: CommunityPost = {
    id: newId("post"), user: cleanHandle(body!.user), title,
    body: typeof body!.body === "string" ? body!.body.slice(0, 20000) : "",
    createdAt: new Date().toISOString(), up: 0, down: 0, score: 0, comments: 0,
  };
  await kv.set(["cposts", post.id], post);
  return c.json({ ok: true, post });
});


honoApp.get("/v1/community/posts/:id", async (c) => {
  const id = c.req.param("id");
  const post = (await kv.get<CommunityPost>(["cposts", id])).value;
  if (!post) return c.json({ error: { message: "no such post" } }, 404);
  const comments: CommunityComment[] = [];
  for await (const e of kv.list<CommunityComment>({ prefix: ["ccomments", id] }, { limit: 1000 })) if (e.value) comments.push(e.value);
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const voter = c.req.query("voter");
  const myVote = voter ? (await kv.get<number>(["cvotes", id, voter])).value ?? 0 : 0;
  return c.json({ ok: true, post: { ...post, myVote }, comments });
});


honoApp.post("/v1/community/posts/:id/vote", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Json | null;
  const voter = typeof body?.voter === "string" ? body.voter.slice(0, 64) : "";
  const value = Number(body?.value);
  if (!voter || ![1, 0, -1].includes(value)) return c.json({ error: { message: "voter and value (1, 0 or -1) are required" } }, 400);
  for (let attempt = 0; attempt < 8; attempt++) {
    const [p, v] = await kv.getMany<[CommunityPost, number]>([["cposts", id], ["cvotes", id, voter]]);
    if (!p.value) return c.json({ error: { message: "no such post" } }, 404);
    const prev = v.value ?? 0;
    if (prev === value) return c.json({ ok: true, post: { ...p.value, myVote: value } });
    const post = { ...p.value };
    post.up += (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
    post.down += (value === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
    post.score = post.up - post.down;
    const tx = kv.atomic().check(p).check(v).set(["cposts", id], post);
    const res = await (value === 0 ? tx.delete(["cvotes", id, voter]) : tx.set(["cvotes", id, voter], value)).commit();
    if (res.ok) return c.json({ ok: true, post: { ...post, myVote: value } });
  }
  return c.json({ error: { message: "vote contended, retry" } }, 409);
});


honoApp.post("/v1/community/posts/:id/comments", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Json | null;
  const text = typeof body?.body === "string" ? body.body.trim().slice(0, 5000) : "";
  if (!text) return c.json({ error: { message: "comment body is required" } }, 400);
  const comment: CommunityComment = { id: newId("cmt"), postId: id, user: cleanHandle(body!.user), body: text, createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = await kv.get<CommunityPost>(["cposts", id]);
    if (!p.value) return c.json({ error: { message: "no such post" } }, 404);
    const res = await kv.atomic().check(p).set(["cposts", id], { ...p.value, comments: p.value.comments + 1 }).set(["ccomments", id, comment.id], comment).commit();
    if (res.ok) return c.json({ ok: true, comment });
  }
  return c.json({ error: { message: "comment contended, retry" } }, 409);
});


honoApp.get("/v1/community/stats", async (c) => {
  const posts = await allPosts();
  const day = Date.now() - 86_400_000;
  const people = new Map<string, { posts: number; comments: number; messages: number; score: number }>();
  const bump = (u: string, k: "posts" | "comments" | "messages", score = 0) => {
    const r = people.get(u) ?? { posts: 0, comments: 0, messages: 0, score: 0 };
    r[k]++; r.score += score; people.set(u, r);
  };
  const active = new Set<string>();
  let comments = 0;
  for (const p of posts) {
    bump(p.user, "posts", p.score);
    if (Date.parse(p.createdAt) > day) active.add(p.user);
    for await (const e of kv.list<CommunityComment>({ prefix: ["ccomments", p.id] }, { limit: 1000 })) {
      if (!e.value) continue;
      comments++;
      bump(e.value.user, "comments");
      if (Date.parse(e.value.createdAt) > day) active.add(e.value.user);
    }
  }
  const rooms: Record<string, number> = {};
  for (const [room, list] of communityRooms) {
    const real = list.filter((m) => m.user !== "System");
    rooms[room] = real.length;
    for (const m of real) { bump(m.user, "messages"); if (Date.parse(m.createdAt) > day) active.add(m.user); }
  }
  return c.json({
    ok: true,
    posts: posts.length,
    comments,
    votes: posts.reduce((a, p) => a + p.up + p.down, 0),
    messages: Object.values(rooms).reduce((a, n) => a + n, 0),
    rooms,
    members: people.size,
    active_24h: active.size,
    top_posts: [...posts].sort((a, b) => b.score - a.score).slice(0, 5).map((p) => ({ id: p.id, title: p.title, user: p.user, score: p.score, comments: p.comments })),
    top_people: [...people].map(([user, r]) => ({ user, ...r })).sort((a, b) => (b.posts + b.comments + b.messages) - (a.posts + a.comments + a.messages)).slice(0, 10),
  });
});


honoApp.get("/v1/community/stream", (c) => {
  const room = c.req.query("room") || "general";
  let subscriber: ((msg: CommunityMessage) => void) | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": connected\n\n"));

      subscriber = (msg: CommunityMessage) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message", message: msg })}\n\n`));
        } catch { /* disconnected */ }
      };

      let subs = communitySubscribers.get(room);
      if (!subs) {
        subs = new Set();
        communitySubscribers.set(room, subs);
      }
      subs.add(subscriber);

      keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepAliveTimer);
        }
      }, 20_000);
    },
    cancel() {
      if (subscriber) {
        const subs = communitySubscribers.get(room);
        if (subs) {
          subs.delete(subscriber);
          if (subs.size === 0) communitySubscribers.delete(room);
        }
      }
      if (keepAliveTimer) clearInterval(keepAliveTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
});
}
