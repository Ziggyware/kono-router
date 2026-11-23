// Browser regression test. Start the app on port 8000, install playwright-core
// without saving it, and set CHROMIUM_PATH to a local Chromium binary:
//   CHROMIUM_PATH=/path/to/chromium node tests/chat_ui_browser.mjs
// Optional KONO_MD_FIXTURES points to unpacked marked/dompurify/highlight
// packages; without it this exercises the offline markdown renderer.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.env.KONO_UI_URL || 'http://127.0.0.1:8000/';
const fixtures = process.env.KONO_MD_FIXTURES;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [], requests = [], sessions = new Map();
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  window.__copies = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => window.__copies.push(text) } });
});
await page.route('**/*', async (route) => {
  const request = route.request(), u = new URL(request.url());
  if (u.hostname === 'cdn.jsdelivr.net' && fixtures) {
    const match = u.pathname.match(/^\/npm\/(marked@[^/]+|dompurify@[^/]+|@highlightjs\/cdn-assets@[^/]+)\/(.*)$/);
    if (match) {
      const dir = match[1].startsWith('marked') ? 'marked' : match[1].startsWith('dompurify') ? 'dompurify' : 'highlight';
      try { return route.fulfill({ status: 200, contentType: 'application/javascript', body: await readFile(path.join(fixtures, dir, match[2])) }); }
      catch { return route.abort(); }
    }
  }
  if (u.origin !== new URL(url).origin) return route.abort();
  if (!u.pathname.startsWith('/v1/') && u.pathname !== '/health') return route.continue();
  const session = request.headers()['x-kono-session'] || 'none';
  let result = {};
  if (u.pathname === '/v1/tools/execute') {
    const body = request.postDataJSON(), calls = body.calls || [{ name: body.name, arguments: body.arguments }];
    const files = sessions.get(session) || new Map(); sessions.set(session, files);
    result = { results: calls.map((call) => {
      if (call.name === 'fs_write') { files.set(call.arguments.path, call.arguments.content); return { ok: true, result: {} }; }
      if (call.name === 'fs_list') return { ok: true, result: { files: [...files].map(([name, value]) => ({ path: name, bytes: value.length })), sig: 'test' } };
      return { ok: true, result: {} };
    }) };
  } else if (u.pathname === '/v1/chat/completions') {
    requests.push(request.postDataJSON());
    if (requests.at(-1).messages?.at(-1)?.content === 'slow request') await new Promise((resolve) => setTimeout(resolve, 800));
    result = { choices: [{ message: { content: 'A complete answer.' }, finish_reason: 'stop' }] };
  } else if (u.pathname === '/v1/conversations/current' && request.method() === 'GET') {
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  } else if (u.pathname === '/v1/models') result = { data: [] };
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
});
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#cnew');
  if (fixtures) await page.waitForFunction(() => MD !== null);
  await page.evaluate(() => {
    const code = '<img src=x onerror=alert(1)>\n' + Array.from({ length: 140 }, (_, i) => `const item${i} = "<img src=x onerror=alert(1)> & value"; // line ${i}`).join('\n') + '\n';
    window.__code = code;
    window.__message = 'An answer with code.\n\n```js\n' + code + '```\n\nDone.';
    conv.messages = [{ role: 'user', content: 'A question' }, { role: 'assistant', content: window.__message, reasoning_content: 'private reasoning', tool_calls: [{ id: 'one', function: { name: 'private_tool', arguments: 'private args' } }] }];
    renderThread();
  });
  assert.equal(await page.locator('.code-block').count(), 1);
  assert.equal(await page.evaluate(() => document.querySelector('.code-block')._sbxRaw === window.__code), true);
  assert.equal(await page.locator('.code-block img').count(), 0, 'code must not become executable HTML');
  await page.locator('.code-copy-bottom').click();
  assert.equal(await page.evaluate(() => window.__copies.at(-1) === window.__code), true, 'bottom code copy');
  await page.locator('.msg.a [data-act=copy]').click();
  assert.equal(await page.evaluate(() => window.__copies.at(-1) === window.__message), true, 'message copy excludes reasoning and tool data');
  await page.locator('.msg.u [data-act=copy]').click();
  assert.equal(await page.evaluate(() => window.__copies.at(-1)), 'A question');
  await page.evaluate(() => { const t = document.querySelector('#thread'), b = document.querySelector('.code-block'); t.scrollTop = b.offsetTop + 500; });
  const geometry = await page.evaluate(() => {
    const thread = document.querySelector('#thread').getBoundingClientRect(), block = document.querySelector('.code-block').getBoundingClientRect(), icon = document.querySelector('.code-copy-icon').getBoundingClientRect();
    return { threadTop: thread.top, threadBottom: thread.bottom, blockTop: block.top, blockBottom: block.bottom, iconTop: icon.top, iconBottom: icon.bottom };
  });
  assert(geometry.blockTop < geometry.threadTop && geometry.blockBottom > geometry.threadBottom, 'long code must straddle viewport');
  assert(geometry.iconTop >= geometry.threadTop && geometry.iconBottom <= geometry.threadBottom, 'copy icon remains in viewport');
  await page.locator('.code-copy-icon').click();
  assert.equal(await page.evaluate(() => window.__copies.at(-1) === window.__code), true, 'sticky code copy');
  await page.click('#cside');
  assert((await page.locator('#side').boundingBox()).width >= 800, 'settings expands on wide screens');
  assert((await page.locator('.accent-chip svg').first().boundingBox()).width < 25, 'accent icon is not oversized');
  await page.fill('#ptop-p', '0.8');
  await page.fill('#ptool-rounds', '3');
  await page.fill('#pcontinue-rounds', '4');
  await page.uncheck('#pstream');
  await page.check('#pcode-wrap');
  await page.locator('#side [data-close]').click();
  await page.evaluate(async () => wsExec('fs_write', { path: 'old.txt', content: 'old workspace' }));
  const old = await page.evaluate(() => sessionId());
  await page.click('#cnew');
  const next = await page.evaluate(() => sessionId());
  assert.notEqual(next, old, 'new chat rotates workspace namespace');
  assert.equal(sessions.get(old)?.get('old.txt'), 'old workspace', 'previous workspace remains recoverable');
  assert.equal(sessions.get(next)?.size || 0, 0, 'new workspace starts empty');
  await page.fill('#cinput', 'hello');
  await page.click('#csend');
  await page.waitForFunction(() => document.querySelector('.msg.a .md')?.textContent.includes('A complete answer.'));
  const payload = requests.at(-1);
  assert.equal(payload.top_p, 0.8);
  assert.equal(payload.kono_rounds, 3);
  assert.equal(payload.kono_continue_rounds, 4);
  assert.equal(payload.kono_continue, true);
  await page.fill('#cinput', 'slow request');
  await page.click('#csend');
  await page.click('#cnew');
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#thread article').count(), 0, 'aborted previous answer must not enter a new chat');
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#ptop-p').inputValue(), '0.8');
  assert.equal(await page.locator('#pcode-wrap').isChecked(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile viewport must not overflow');
  await page.click('#cside');
  assert((await page.locator('#side').boundingBox()).width <= 390, 'settings fits mobile screen');
  assert.deepEqual(errors, []);
  console.log(`chat browser checks passed (${fixtures ? 'markdown libraries' : 'offline fallback'})`);
} finally { await browser.close(); }
