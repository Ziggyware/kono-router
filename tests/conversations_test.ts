// deno-lint-ignore-file no-explicit-any
/**
 * Conversation persistence tests: the KV-backed store behind
 * /v1/conversations (live conversation + snapshot library), scoped per
 * session by the sha256 of the session id.
 *
 * Everything is exercised in-process through `app.fetch()` — no network.
 * Each test uses its own session id so stored state never collides.
 *
 * Run: deno test --unstable-kv -A tests/
 */
import { app } from "../main.ts";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const assertEq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};

// KV keeps a long-lived resource open and background syncs may outlive a test.
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const BASE = "https://router.test";
let seq = 0;
const session = () => `conv-test-${Date.now()}-${seq++}`;

function req(method: string, path: string, sess?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (sess) headers["x-kono-session"] = sess;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const MESSAGES = [
  { role: "user", content: "build me a notes app" },
  { role: "assistant", content: "Here is a complete notes app…" },
  { role: "user", content: "now add dark mode" },
];

test("conversations: PUT then GET current round-trips identical messages", async () => {
  const s = session();
  const put = await app.fetch(req("PUT", "/v1/conversations/current", s, { saved: 1234, messages: MESSAGES }));
  assertEq(put.status, 200, "PUT current status");
  const putBody = await put.json();
  assertEq(putBody, { ok: true, saved: 1234 }, "PUT current body");

  const get = await app.fetch(req("GET", "/v1/conversations/current", s));
  assertEq(get.status, 200, "GET current status");
  const got = await get.json();
  assertEq(got.saved, 1234, "GET current saved");
  assertEq(got.messages, MESSAGES, "GET current messages identical");
});

test("conversations: a different session sees 404 current and an empty library", async () => {
  const a = session();
  const b = session();
  await app.fetch(req("PUT", "/v1/conversations/current", a, { saved: 1, messages: MESSAGES }));
  await app.fetch(req("POST", "/v1/conversations", a, { title: "t", saved: 1, messages: MESSAGES }));

  const get = await app.fetch(req("GET", "/v1/conversations/current", b));
  assertEq(get.status, 404, "foreign session current status");
  assertEq((await get.json()).error, "not_found", "foreign session current error");

  const list = await app.fetch(req("GET", "/v1/conversations", b));
  assertEq(list.status, 200, "foreign session list status");
  assertEq((await list.json()).items, [], "foreign session list empty");
});

test("conversations: snapshot create, list, get by id, delete, get 404", async () => {
  const s = session();
  const create = await app.fetch(req("POST", "/v1/conversations", s, { title: "Notes app build", saved: 42, messages: MESSAGES }));
  assertEq(create.status, 200, "create status");
  const { ok, id } = await create.json();
  assert(ok === true && typeof id === "string" && id.length > 0, "create returns ok + generated id");

  const list = await app.fetch(req("GET", "/v1/conversations", s));
  const items = (await list.json()).items;
  assertEq(items.length, 1, "list has the snapshot");
  assertEq(items[0], { id, title: "Notes app build", saved: 42, count: MESSAGES.length }, "index entry shape");

  const got = await app.fetch(req("GET", `/v1/conversations/${id}`, s));
  assertEq(got.status, 200, "get by id status");
  const snap = await got.json();
  assertEq(snap.title, "Notes app build", "snapshot title");
  assertEq(snap.messages, MESSAGES, "snapshot messages identical");

  const del = await app.fetch(req("DELETE", `/v1/conversations/${id}`, s));
  assertEq(del.status, 200, "delete status");
  assertEq((await del.json()).ok, true, "delete ok");

  const gone = await app.fetch(req("GET", `/v1/conversations/${id}`, s));
  assertEq(gone.status, 404, "get after delete is 404");
  const listAfter = await app.fetch(req("GET", "/v1/conversations", s));
  assertEq((await listAfter.json()).items, [], "index entry removed");

  const delAgain = await app.fetch(req("DELETE", `/v1/conversations/${id}`, s));
  assertEq(delAgain.status, 200, "delete is idempotent");
});

test("conversations: the 31st snapshot evicts the oldest", async () => {
  const s = session();
  let firstId = "";
  for (let i = 0; i < 31; i++) {
    const res = await app.fetch(req("POST", "/v1/conversations", s, {
      id: `snap-${i}`,
      title: `snapshot ${i}`,
      saved: 1000 + i,
      messages: [{ role: "user", content: `message ${i}` }],
    }));
    assertEq(res.status, 200, `create ${i} status`);
    const body = await res.json();
    if (i === 0) firstId = body.id;
  }
  const list = await app.fetch(req("GET", "/v1/conversations", s));
  const items = (await list.json()).items;
  assertEq(items.length, 30, "library capped at 30");
  assert(!items.some((e: any) => e.id === firstId), "oldest evicted from index");

  const gone = await app.fetch(req("GET", `/v1/conversations/${firstId}`, s));
  assertEq(gone.status, 404, "oldest snapshot key deleted");
  const newest = await app.fetch(req("GET", "/v1/conversations/snap-30", s));
  assertEq(newest.status, 200, "newest snapshot survives");
});

test("conversations: missing session header is a 400 on every route", async () => {
  for (const [method, path, body] of [
    ["GET", "/v1/conversations/current", undefined],
    ["PUT", "/v1/conversations/current", { saved: 1, messages: [] }],
    ["GET", "/v1/conversations", undefined],
    ["POST", "/v1/conversations", { title: "t", saved: 1, messages: [] }],
    ["GET", "/v1/conversations/abc", undefined],
    ["DELETE", "/v1/conversations/abc", undefined],
  ] as const) {
    const res = await app.fetch(req(method, path, undefined, body));
    assertEq(res.status, 400, `${method} ${path} status`);
    assertEq((await res.json()).error, "missing_session", `${method} ${path} error`);
  }
});

test("conversations: x-session-id works as the fallback identity header", async () => {
  const s = session();
  const put = await app.fetch(new Request(BASE + "/v1/conversations/current", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-session-id": s },
    body: JSON.stringify({ saved: 7, messages: MESSAGES }),
  }));
  assertEq(put.status, 200, "PUT via fallback header");
  const get = await app.fetch(req("GET", "/v1/conversations/current", s));
  assertEq(get.status, 200, "same identity via primary header");
  assertEq((await get.json()).messages, MESSAGES, "messages visible across header spellings");
});

test("conversations: invalid payloads are rejected", async () => {
  const s = session();
  const nonArray = await app.fetch(req("PUT", "/v1/conversations/current", s, { saved: 1, messages: "not-an-array" }));
  assertEq(nonArray.status, 400, "non-array messages status");
  assertEq((await nonArray.json()).error, "invalid_messages", "non-array messages error");

  const noRole = await app.fetch(req("PUT", "/v1/conversations/current", s, { saved: 1, messages: [{ content: "hi" }] }));
  assertEq(noRole.status, 400, "message without role status");

  const tooMany = await app.fetch(req("PUT", "/v1/conversations/current", s, {
    saved: 1,
    messages: Array.from({ length: 2001 }, () => ({ role: "user", content: "x" })),
  }));
  assertEq(tooMany.status, 400, "2001 messages status");
  assertEq((await tooMany.json()).error, "invalid_messages", "2001 messages error");

  // A rejected write must not clobber a previously stored conversation.
  const get = await app.fetch(req("GET", "/v1/conversations/current", s));
  assertEq(get.status, 404, "nothing stored by rejected writes");
});
