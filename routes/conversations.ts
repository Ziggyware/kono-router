// routes/conversations.ts — server-side conversation persistence:
// the durable counterpart to the dashboard's localStorage chat, which
// silently dies at the browser quota. main.ts calls registerConversations()
// to register these routes.
//
// Storage is the shared `kv` from state.ts (real Deno KV in production,
// the in-memory shim where KV is unavailable — volatile there, but no
// worse than localStorage). Everything is scoped to the caller: the
// owner key is the sha256 of the session id, so one session's
// conversations are invisible to another.
//
//   ["kono_conversation_v1", owner, "current"]      { saved, messages }
//   ["kono_conversation_v1", owner, "lib", id]      { id, title, saved, session?, messages }
//   ["kono_conversation_v1", owner, "lib_index"]    [{ id, title, saved, count }]

import { honoApp, kv } from "../state.ts";

// deno-lint-ignore no-explicit-any
type Ctx = any;
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const CONV_KEY = "kono_conversation_v1";
const MAX_MESSAGES = 2000;
const MAX_BODY_BYTES = 5_000_000;
const MAX_SNAPSHOTS = 30;
const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Identity: the dashboard's session id (x-kono-session, fallback
// x-session-id). Missing/empty → null, which every handler maps to 400.
async function ownerKey(c: Ctx): Promise<string | null> {
  const src = c.req.header("x-kono-session") || c.req.header("x-nokey-session") || c.req.header("x-session-id") || "";
  if (!src.trim()) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Reads and validates a { saved, messages } body. Returns either the
// parsed payload or the error response to send. Byte size is checked on
// the raw text before parsing (content-length alone is not trustworthy),
// message shape after.
async function readPayload(c: Ctx): Promise<{ saved: number; messages: Json[]; raw: Json } | { error: Response }> {
  const raw = await c.req.raw.text().catch(() => "");
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { error: json(413, { error: "too_large" }) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: json(400, { error: "invalid_messages" }) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: json(400, { error: "invalid_messages" }) };
  const body = parsed as Json;
  if (typeof body.saved !== "number" || !Number.isFinite(body.saved)) return { error: json(400, { error: "invalid_messages" }) };
  if (!Array.isArray(body.messages)) return { error: json(400, { error: "invalid_messages" }) };
  if (body.messages.length > MAX_MESSAGES) return { error: json(400, { error: "invalid_messages" }) };
  for (const m of body.messages) {
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof (m as Json).role !== "string") {
      return { error: json(400, { error: "invalid_messages" }) };
    }
  }
  return { saved: body.saved, messages: body.messages as Json[], raw: body };
}

type LibIndexEntry = { id: string; title: string; saved: number; count: number };

async function readIndex(owner: string): Promise<LibIndexEntry[]> {
  const v = (await kv.get([CONV_KEY, owner, "lib_index"])).value;
  return Array.isArray(v) ? (v as LibIndexEntry[]) : [];
}

export function registerConversations() {
  // The live conversation: one slot per session, overwritten wholesale.
  honoApp.get("/v1/conversations/current", async (c) => {
    const owner = await ownerKey(c);
    if (!owner) return json(400, { error: "missing_session" });
    const stored = (await kv.get([CONV_KEY, owner, "current"])).value as { saved: number; messages: Json[] } | null;
    if (!stored) return json(404, { error: "not_found" });
    return json(200, { saved: stored.saved, messages: stored.messages });
  });

  honoApp.put("/v1/conversations/current", async (c) => {
    const owner = await ownerKey(c);
    if (!owner) return json(400, { error: "missing_session" });
    const payload = await readPayload(c);
    if ("error" in payload) return payload.error;
    await kv.set([CONV_KEY, owner, "current"], { saved: payload.saved, messages: payload.messages });
    return json(200, { ok: true, saved: payload.saved });
  });

  // The library: named snapshots of conversations, newest index first.
  honoApp.get("/v1/conversations", async (c) => {
    const owner = await ownerKey(c);
    if (!owner) return json(400, { error: "missing_session" });
    return json(200, { items: await readIndex(owner) });
  });

  honoApp.post("/v1/conversations", async (c) => {
    const owner = await ownerKey(c);
    if (!owner) return json(400, { error: "missing_session" });
    const payload = await readPayload(c);
    if ("error" in payload) return payload.error;
    const raw = payload.raw;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : "c" + Date.now().toString(36);
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : "Conversation";
    const snapshot: Json = { id, title, saved: payload.saved, messages: payload.messages };
    if (typeof raw.session === "string" && raw.session) snapshot.session = raw.session;
    await kv.set([CONV_KEY, owner, "lib", id], snapshot);

    let index = await readIndex(owner);
    index = index.filter((e) => e.id !== id);
    index.unshift({ id, title, saved: payload.saved, count: payload.messages.length });
    // Cap the library: evict oldest by saved, deleting their lib keys.
    if (index.length > MAX_SNAPSHOTS) {
      const bySaved = [...index].sort((a, b) => a.saved - b.saved);
      const evict = bySaved.slice(0, index.length - MAX_SNAPSHOTS);
      const evictIds = new Set(evict.map((e) => e.id));
      for (const e of evict) await kv.delete([CONV_KEY, owner, "lib", e.id]);
      index = index.filter((e) => !evictIds.has(e.id));
    }
    await kv.set([CONV_KEY, owner, "lib_index"], index);
    return json(200, { ok: true, id });
  });

  honoApp.get("/v1/conversations/:id", async (c) => {
    const owner = await ownerKey(c);
    if (!owner) return json(400, { error: "missing_session" });
    const stored = (await kv.get([CONV_KEY, owner, "lib", c.req.param("id")])).value;
    if (!stored) return json(404, { error: "not_found" });
    return json(200, stored);
  });

  honoApp.delete("/v1/conversations/:id", async (c) => {
    const owner = await ownerKey(c);
    if (!owner) return json(400, { error: "missing_session" });
    const id = c.req.param("id");
    await kv.delete([CONV_KEY, owner, "lib", id]);
    const index = (await readIndex(owner)).filter((e) => e.id !== id);
    await kv.set([CONV_KEY, owner, "lib_index"], index);
    return json(200, { ok: true });
  });
}
