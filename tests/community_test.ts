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
