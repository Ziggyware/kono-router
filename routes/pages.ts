// routes/pages.ts — Pages route registrations extracted from main.ts.
// main.ts calls registerPages() at the position of this area's first route, preserving registration order.

import { honoApp } from "../state.ts";
import { loadTextFile } from "../engine/providers.ts";
import { buildHealthPayload } from "../engine/mesh.ts";





export const PRICING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nokey-router — Pricing</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; background: #0a0c10; color: #e8eaf0; }
  main { max-width: 680px; margin: 0 auto; padding: 48px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -.02em; }
  .sub { color: #9aa3b2; margin: 0 0 32px; }
  .card { background: #12151c; border: 1px solid #232833; border-radius: 16px; padding: 22px 24px; margin: 0 0 16px; }
  .card.hot { border-color: #b6f09c55; }
  .price { font-size: 30px; font-weight: 700; letter-spacing: -.02em; }
  .per { color: #9aa3b2; font-size: 14px; font-weight: 400; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  ul { margin: 8px 0 0; padding-left: 20px; color: #c6ccd8; }
  a { color: #b6f09c; }
  .contact { font-size: 17px; line-height: 2; }
  .back { display: inline-block; margin-top: 24px; color: #9aa3b2; }
</style>
</head>
<body>
<main>
  <h1>nokey-router — pricing</h1>
  <p class="sub">One router for open models: chat, tools, images. No keys, no sign-up to start.</p>

  <div class="card">
    <div class="price">$0</div>
    <h2>Free tier</h2>
    <ul>
      <li>50 requests per day, per IP address</li>
      <li>No API key and no account — just call the API</li>
      <li>Every lane (fast, smart, code, reasoning) and the tool plane included</li>
    </ul>
  </div>

  <div class="card hot">
    <div class="price">$5 <span class="per">USD / month</span></div>
    <h2>Unlimited</h2>
    <ul>
      <li>Unlimited requests with your own API key — no daily cap</li>
      <li>Same lanes, tools and forged tools, no per-IP counting</li>
      <li>Cancel anytime by simply not renewing</li>
    </ul>
  </div>

  <div class="card">
    <h2>How to pay</h2>
    <p>Unlimited is activated personally — there is no checkout form. Contact Michael Morton, say you want <b>nokey-router unlimited ($5/month)</b>, and you will get payment instructions and your API key in reply:</p>
    <p class="contact">
      Email: <a href="mailto:ziggyware@gmail.com">ziggyware@gmail.com</a><br>
      Phone: <a href="tel:+19796612553">+1-979-661-2553</a>
    </p>
  </div>

  <a class="back" href="/">← back to the router</a>
</main>
</body>
</html>`;



export const FORGE_DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nokey-router — Forge tool format</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.65 -apple-system, "Segoe UI", Roboto, sans-serif; background: #0a0c10; color: #e8eaf0; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -.02em; }
  h2 { font-size: 18px; margin: 34px 0 8px; }
  h3 { font-size: 15px; margin: 22px 0 6px; }
  .sub, .dim { color: #9aa3b2; }
  .card { background: #12151c; border: 1px solid #232833; border-radius: 16px; padding: 18px 22px; margin: 0 0 14px; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; background: #1a1e27; padding: 1px 5px; border-radius: 5px; }
  pre { background: #12151c; border: 1px solid #232833; border-radius: 12px; padding: 14px 16px; overflow: auto; }
  pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.55; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  td, th { border: 1px solid #232833; padding: 6px 10px; text-align: left; font-size: 14px; vertical-align: top; }
  a { color: #b6f09c; }
  ul { padding-left: 20px; color: #c6ccd8; }
  .back { display: inline-block; margin-top: 24px; color: #9aa3b2; }
</style>
</head>
<body>
<main>
  <h1>Forge tool format</h1>
  <p class="sub">How to create a router tool on the fly — from the dashboard's Forge card, from <code>POST /v1/tools/forge</code>, or by asking a model to call <code>forge_tool</code>. A forged tool is a name, a description, a JSON Schema and a JavaScript body. The router compiles it, registers it next to its built-ins, persists it in Deno KV, and executes it with the same validation, deadlines and telemetry as any built-in tool.</p>

  <h2>The four fields</h2>
  <div class="card">
    <h3>name</h3>
    <p>Lowercase letters, digits and underscores, up to 64 characters (<code>^[a-z0-9_]{1,64}$</code> after normalization). It must not reuse a built-in tool's name. Forging a name that is already forged <i>replaces</i> that tool. Models call the tool by this exact name.</p>
    <h3>description</h3>
    <p>One or two concrete sentences, up to 1024 characters: what the tool does, what goes in, what comes back. This text is the main signal models use when deciding which tool to call — vague descriptions get skipped.</p>
    <h3>parameters</h3>
    <p>A JSON Schema (2020-12 subset) for the arguments object — see below. The dashboard's Forge card can build it with web controls that stay in sync with the JSON both ways.</p>
    <h3>code</h3>
    <p>A JavaScript function body, up to 16 KiB — see below. A body that does not parse is rejected at forge time and never registers.</p>
  </div>

  <h2>Parameters format</h2>
  <p>The top level is an object schema. Each argument is a property with a <code>type</code> and a <code>description</code>; list mandatory arguments in <code>required</code>.</p>
  <pre><code>{
  "type": "object",
  "properties": {
    "text":  { "type": "string",  "description": "The text to process" },
    "limit": { "type": "integer", "description": "Max results", "default": 10 }
  },
  "required": ["text"]
}</code></pre>
  <table>
    <tr><th>type</th><th>notes</th></tr>
    <tr><td><code>string</code></td><td>Text. <code>enum</code>, <code>format</code> and length bounds are honored where the schema states them.</td></tr>
    <tr><td><code>integer</code> / <code>number</code></td><td>Numeric arguments; <code>minimum</code> / <code>maximum</code> apply.</td></tr>
    <tr><td><code>boolean</code></td><td>True / false flags.</td></tr>
    <tr><td><code>array</code></td><td>Lists; describe the element shape with <code>items</code>.</td></tr>
    <tr><td><code>object</code></td><td>Nested objects; describe with nested <code>properties</code>.</td></tr>
  </table>
  <p>Before the code runs, the router parses and validates every call against this schema — repairing common model mistakes (stringified JSON, coerced scalars) where it safely can, and rejecting the call with a precise error when it cannot. A <code>default</code> on a property is applied when the model omits the argument.</p>

  <h2>Code format</h2>
  <p>The body runs as an async function. It receives two values:</p>
  <table>
    <tr><th>in scope</th><th>what it is</th></tr>
    <tr><td><code>args</code></td><td>The arguments object, already validated against the parameters schema.</td></tr>
    <tr><td><code>api.fetch</code></td><td>The router's fetch — call other APIs and return parsed results.</td></tr>
    <tr><td><code>api.kv</code></td><td>The Deno KV handle from the call's capabilities, when present — durable storage for the tool.</td></tr>
    <tr><td><code>api.namespace</code></td><td>The caller's session namespace (from the <code>x-nokey-session</code> header), so state can be scoped per user.</td></tr>
    <tr><td><code>api.signal</code></td><td>An AbortSignal that fires at the tool's deadline — pass it to fetch.</td></tr>
    <tr><td><code>api.now</code></td><td>Current time in milliseconds.</td></tr>
    <tr><td><code>api.locals</code></td><td>Router-injected data for the call (for example the tool-skill snapshot).</td></tr>
  </table>
  <p>Whatever the body returns becomes the tool result (it is JSON-serialized; return plain data). Throwing an error fails the call with that message. The ambient globals <code>Deno</code>, <code>process</code>, <code>globalThis</code> and <code>Function</code> are shadowed inside the body — a forged tool gets the narrow <code>api</code> surface, not the whole server. Default deadline is 4 s per call (a forge may set <code>timeout_ms</code> between 100 and 30000). Mark a tool <code>deterministic: true</code> when it is a pure function of its arguments, and <code>admin: true</code> when executing it should require the admin secret.</p>

  <h2>A complete example</h2>
  <pre><code>POST /v1/tools/forge   (admin secret required over HTTP)

{
  "name": "word_count",
  "description": "Count the words and characters in a text.",
  "parameters": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "The text to process" }
    },
    "required": ["text"]
  },
  "code": "const t = String(args.text ?? '');\\nreturn { words: t.split(/\\s+/).filter(Boolean).length, chars: t.length };"
}</code></pre>
  <p>From that moment the tool appears in <code>GET /v1/tools</code> (marked <code>dynamic</code>), joins the default auto tool set offered to models, and can be called through chat completions or <code>POST /v1/tools/execute</code>. Retire it with <code>retire_tool</code> or <code>DELETE /v1/tools/forge/word_count</code> (admin).</p>

  <h2>Trust note</h2>
  <p>Forging over HTTP requires the admin secret, and a model can only call <code>forge_tool</code> in a session whose tools include it. Forged code executes inside the router isolate with the <code>api</code> surface above — treat it as operator code: only forge code you would run yourself.</p>

  <a class="back" href="/">← back to the router</a> · <a class="back" href="/pricing">pricing</a>
</main>
</body>
</html>`;

export function registerPages() {


honoApp.get("/pricing", (_c) => {
  return new Response(PRICING_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
});


honoApp.get("/forge-docs", (_c) => {
  return new Response(FORGE_DOCS_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
});



honoApp.get("/", (_c) => {
        return new Response(loadTextFile("index.html"), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
});

// The workspace at / absorbed the standalone admin page; old links land on its Lanes view.
honoApp.get("/admin", (c) => c.redirect("/#lanes", 301));


honoApp.get("/health", async (c) => c.json(await buildHealthPayload()));
}
