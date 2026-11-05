import { app } from "../main.ts";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

Deno.test("community messages: post and get messages in a room", async () => {
  // Post a message
  const postRes = await app.fetch(new Request("http://x/v1/community/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room: "test-room",
      user: "Alice",
      content: "Hello everyone from test!",
    }),
  }));
  assert(postRes.status === 200, "post message status 200");
  const postJson = await postRes.json();
  assert(postJson.ok === true, "post ok true");
  assert(postJson.message.user === "Alice", "post user Alice");
  assert(postJson.message.content === "Hello everyone from test!", "post content");

  // Get messages
  const getRes = await app.fetch(new Request("http://x/v1/community/messages?room=test-room"));
  assert(getRes.status === 200, "get status 200");
  const getJson = await getRes.json();
  assert(getJson.ok === true, "get ok true");
  assert(getJson.room === "test-room", "room match");
  assert(Array.isArray(getJson.messages), "messages array");
  assert(getJson.messages.some((m: { user: string }) => m.user === "Alice"), "messages contains Alice");
});

Deno.test("community messages: requires content", async () => {
  const badRes = await app.fetch(new Request("http://x/v1/community/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: "test", content: "" }),
  }));
  assert(badRes.status === 400, "empty content returns 400");
});

Deno.test("community posts: create, one vote per voter, comments, stats", async () => {
  const call = async (path: string, body?: unknown) => {
    const r = await app.fetch(new Request("http://x" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { status: r.status, json: await r.json() };
  };
  assert((await call("/v1/community/posts", { user: "Ada", title: "" })).status === 400, "title required");
  const { json: created } = await call("/v1/community/posts", { user: "Ada", title: "Hedging deep dive", body: "How the router hedges." });
  const id = created.post.id;
  const up1 = await call(`/v1/community/posts/${id}/vote`, { voter: "v1", value: 1 });
  const up1again = await call(`/v1/community/posts/${id}/vote`, { voter: "v1", value: 1 });
  assert(up1.json.post.score === 1 && up1again.json.post.score === 1, "a repeated vote does not double count");
  const flip = await call(`/v1/community/posts/${id}/vote`, { voter: "v1", value: -1 });
  assert(flip.json.post.score === -1 && flip.json.post.up === 0 && flip.json.post.down === 1, "flip moves the vote");
  await call(`/v1/community/posts/${id}/vote`, { voter: "v2", value: 1 });
  await call(`/v1/community/posts/${id}/vote`, { voter: "v3", value: 1 });
  const cmt = await call(`/v1/community/posts/${id}/comments`, { user: "Bo", body: "Great write-up" });
  assert(cmt.status === 200, "comment ok");
  const { json: one } = await call(`/v1/community/posts/${id}?voter=v1`);
  assert(one.post.score === 1 && one.post.comments === 1 && one.post.myVote === -1 && one.comments[0].user === "Bo", JSON.stringify(one));
  const { json: list } = await call("/v1/community/posts?sort=top&voter=v2");
  assert(list.posts.some((p: { id: string; myVote: number }) => p.id === id && p.myVote === 1), "list carries my vote");
  const { json: stats } = await call("/v1/community/stats");
  assert(stats.posts >= 1 && stats.comments >= 1 && stats.top_people.some((p: { user: string }) => p.user === "Ada"), JSON.stringify(stats).slice(0, 300));
});
