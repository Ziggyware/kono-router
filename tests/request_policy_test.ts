// Run with: deno run --unstable-kv -A tests/request_policy_test.ts
import { REQUEST_POLICY, withRequestPolicy } from "../engine/request-policy.ts";
import { collectUpstream, openUpstream, verifyCleanText } from "../engine/dispatch.ts";
import { autoToolsForClass, defaultAutoToolNames } from "../tools.ts";
import { app } from "../main.ts";
import { createHostRouter, createMemoryPorts } from "../host/index.ts";

type Case = { name: string; fn: () => void | Promise<void> };
const cases: Case[] = [];
const test = (name: string, fn: Case["fn"]) => cases.push({ name, fn });
function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const failure = '[Generation failed] Reason: User-visible reply contains "TODO" placeholder';
const answer = 'The word TODO may legitimately appear in ordinary discussion about software.';

function json(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }),
    { headers: { "content-type": "application/json" } });
}
function sse(content: string): Response {
  const fragments = [content.slice(0, 9), content.slice(9, 30), content.slice(30)];
  return new Response(fragments.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join("") + 'data: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } });
}

test("only the upstream diagnostic is rejected, not legitimate TODO text", () => {
  let thrown = false;
  try { verifyCleanText(failure); } catch (e) { thrown = String(e).includes("POISON_SOFTBLOCK"); }
  expect(thrown, "diagnostic must fail the attempt");
  verifyCleanText(answer);
  verifyCleanText("Here is the file:\n```html\n<!doctype html><html><body>hello</body></html>\n```");
  verifyCleanText(`The reported message was: ${failure}`);
});

for (const makeResponse of [json, sse]) {
  test(`rejects the failure before upstream commits (${makeResponse.name})`, async () => {
    const old = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(makeResponse(failure));
    try {
      let thrown = false;
      try { await openUpstream("https://example.test", {}, { model: "x", messages: [] }, new AbortController().signal); }
      catch (e) { thrown = String(e).includes("POISON_SOFTBLOCK"); }
      expect(thrown, "failure should not be sent to the client");
      globalThis.fetch = () => Promise.resolve(makeResponse(answer));
      const clean = await collectUpstream(await openUpstream("https://example.test", {}, { model: "x", messages: [] }, new AbortController().signal));
      expect(clean.content === answer, `legitimate answer changed: ${clean.content}`);
    } finally { globalThis.fetch = old; }
  });
}

test("policy is present without dropping client system messages or duplicating itself", () => {
  const original = [{ role: "system", content: "Client instruction" }, { role: "user", content: "Hello" }];
  const messages = withRequestPolicy(original);
  expect(messages[0].content === REQUEST_POLICY, "missing policy");
  expect(messages[1] === original[0] && messages[2] === original[1], "client messages altered");
  expect(withRequestPolicy(messages).length === messages.length, "duplicate policy");
  expect(REQUEST_POLICY.includes('44. Commitment device') && REQUEST_POLICY.includes('read from memory first'), "policy incomplete");
});

test("auto tool classes retain both memory tools", () => {
  const all = defaultAutoToolNames();
  for (const cls of ["chat", "qa", "math", "json", "reasoning", "summarize", "longform", "creative", "multilingual", "vision", "code", "tool"]) {
    const names = autoToolsForClass(cls, all);
    expect(names.includes("memory_recall") && names.includes("memory_write"), `missing memory tools for ${cls}`);
  }
});

test("host applies policy to chunk and synthesis calls", async () => {
  const calls: Array<{ purpose: string; messages: Array<{ role: string; content: string | null }> }> = [];
  const ports = createMemoryPorts({
    planner: () => ({ rationale: "independent answers", chunks: [
      { id: "one", kind: "answer", prompt: "First", needs: [] },
      { id: "two", kind: "answer", prompt: "Second", needs: [] },
    ] }),
    answer: (call) => { calls.push(call); return "A completed, direct answer to the requested question."; },
  });
  const result = await createHostRouter(ports).handle({ messages: [{ role: "user", content: "Compare two topics." }] }, { tenant: "test" });
  expect(result.finish === "stop", `host failed: ${result.finish}`);
  expect(calls.some((c) => c.purpose === "synthesize"), "synthesis not exercised");
  expect(calls.every((c) => c.messages.some((m) => m.role === "system" && m.content === REQUEST_POLICY)), "missing host policy");
});

for (const stream of [false, true]) test(`chat retries a failed diagnostic with the standing policy (stream=${stream})`, async () => {
  const old = globalThis.fetch;
  let attempts = 0;
  const seen: Array<{ role: string; content: unknown }[]> = [];
  globalThis.fetch = (_input, init) => {
    if (init?.method !== "POST") return Promise.resolve(new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } }));
    const body = JSON.parse(String(init.body));
    seen.push(body.messages);
    return Promise.resolve(++attempts === 1 ? sse(failure) : sse(answer));
  };
  try {
    const res = await app.fetch(new Request("https://router.test/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free:fast", messages: [{ role: "system", content: "client policy" }, { role: "user", content: "search google for the current price of bitcoin" }], stream }),
    }));
    const raw = await res.text();
    const body = stream ? undefined : JSON.parse(raw);
    expect(attempts >= 2, `expected failover, got ${attempts}`);
    if (stream) {
      const content = raw.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "").join("");
      expect(content === answer && raw.includes("[DONE]") && !raw.includes("[Generation failed]"), `unexpected stream ${raw}`);
    } else {
      expect(body.kono?.degraded !== true && body.choices?.[0]?.message?.content === answer, `unexpected answer ${raw}`);
    }
    expect(seen.every((m) => m[0]?.content === REQUEST_POLICY && m.some((x) => x.content === "client policy")), "policy or client instruction missing");
  } finally { globalThis.fetch = old; }
});

if (import.meta.main) {
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); console.log(`ok   ${c.name}`); }
    catch (e) { failed++; console.error(`FAIL ${c.name}: ${e instanceof Error ? e.stack : String(e)}`); }
  }
  console.log(`${cases.length - failed} passed, ${failed} failed`);
  // The app owns long-lived timers; a direct standalone run must terminate.
  Deno.exit(failed ? 1 : 0);
}
