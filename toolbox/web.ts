// Web access: a guarded fetcher, an HTML→Markdown reader, and keyless search.
//
// The guard is the important part: every URL (including every redirect hop) is
// checked against private address space before it is fetched, so a model cannot
// use the tool as an SSRF primitive against the sandbox's metadata service.
// Responses are capped, cached in KV and reduced to readable text — a 900KB
// page costs the model ~4k tokens instead of 250k.

import { cacheGet, cachePut, store } from "./store.ts";
import { decodeEntities, oneLine, stripTags, truncate, utf8 } from "./util.ts";
import type { Json, ToolContext, ToolSpec } from "./types.ts";

const UA = "nokey-router-toolbox/2 (+https://github.com/Ziggyware/nokey-router)";
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_CACHE_MS = 15 * 60_000;

// --- SSRF guard -------------------------------------------------------------

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function privateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.some((re) => re.test(h));
  if (h.includes(":")) {
    if (h === "::1" || h === "::" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
    const mapped = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]);
  }
  return false;
}

async function guard(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${truncate(raw, 120)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`refusing non-HTTP protocol ${url.protocol}`);
  if (privateAddress(url.hostname)) throw new Error(`refusing private address ${url.hostname}`);
  try {
    const [a, aaaa] = await Promise.allSettled([
      Deno.resolveDns(url.hostname, "A"),
      Deno.resolveDns(url.hostname, "AAAA"),
    ]);
    const addresses = [...(a.status === "fulfilled" ? a.value : []), ...(aaaa.status === "fulfilled" ? aaaa.value : [])];
    for (const addr of addresses) if (privateAddress(addr)) throw new Error(`refusing ${url.hostname}: resolves to private ${addr}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("refusing")) throw err;
    // Resolver unavailable (Deploy, custom runtime): the literal check above still stands.
  }
  return url;
}

// --- fetcher ----------------------------------------------------------------

export interface Fetched {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  contentType: string;
  truncated: boolean;
  cached: boolean;
  ms: number;
}

interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  cacheMs?: number;
  follow?: number;
}

function signalFor(ctx: ToolContext, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(250, timeoutMs));
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

function headerObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of h) {
    if (n++ >= 40) break;
    out[k] = v.slice(0, 400);
  }
  return out;
}

async function readCapped(res: Response, maxBytes: number): Promise<{ body: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { body: new Uint8Array(await res.arrayBuffer()), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { body.set(c, at); at += c.length; }
  void size;
  return { body, truncated };
}

export async function httpFetch(raw: string, opts: FetchOpts, ctx: ToolContext): Promise<Fetched> {
  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = Math.min(opts.maxBytes ?? MAX_BYTES, 8 * 1024 * 1024);
  const doFetch = ctx.caps?.fetch ?? fetch;
  const method = (opts.method ?? "GET").toUpperCase();
  const cacheMs = opts.cacheMs ?? DEFAULT_CACHE_MS;
  const cacheKey = ["http", method, raw, opts.body ? raw.length + ":" + opts.body.slice(0, 200) : ""];

  if (method === "GET" && cacheMs > 0) {
    const hit = await cacheGet<{ status: number; headers: Record<string, string>; body: string; contentType: string }>(
      store(ctx.caps), cacheKey, cacheMs, Math.max(cacheMs, 60_000),
    ).catch(() => null);
    if (hit) {
      ctx.event?.("web.cache_hit", { url: raw });
      return {
        url: raw, status: hit.status, headers: hit.headers, body: utf8(hit.body),
        contentType: hit.contentType, truncated: false, cached: true,
        ms: Math.max(0, Math.round(performance.now() - started)),
      };
    }
  }

  let url = await guard(raw);
  const signal = signalFor(ctx, timeoutMs);
  let res: Response | undefined;
  const follow = Math.min(opts.follow ?? 5, 8);
  for (let hop = 0; hop <= follow; hop++) {
    res = await doFetch(url, {
      method,
      headers: {
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.8",
        ...(opts.headers ?? {}),
      },
      body: opts.body,
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) break;
      url = await guard(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!res) throw new Error("fetch failed");
  const { body, truncated } = await readCapped(res, maxBytes);
  const contentType = res.headers.get("content-type") ?? "";
  const headers = headerObject(res.headers);

  if (method === "GET" && cacheMs > 0 && res.status === 200 && !truncated) {
    const textish = /json|text|xml|javascript/i.test(contentType);
    if (textish && body.length < 512 * 1024) {
      await cachePut(store(ctx.caps), cacheKey, {
        status: res.status, headers, contentType, body: new TextDecoder().decode(body),
      }, Math.max(cacheMs, 60_000)).catch(() => {});
    }
  }
  return {
    url: url.toString(), status: res.status, headers, body, contentType,
    truncated, cached: false, ms: Math.max(0, Math.round(performance.now() - started)),
  };
}

// --- readable extraction ----------------------------------------------------

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
};

const absolutize = (href: string, base: string): string => {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
};

function mainRegion(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  for (const tag of ["article", "main"]) {
    const m = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (m && stripTags(m[1]).length > 500) return m[1];
  }
  return body;
}

/** HTML → Markdown. Deliberately lossy: structure and prose survive, chrome dies. */
export function toMarkdown(html: string, base = ""): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe|video|audio|object|map)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(nav|footer|aside|form|button|select|dialog)\b[\s\S]*?<\/\1>/gi, " ");

  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
    blocks.push("```\n" + code.replace(/\n{3,}/g, "\n\n").trim() + "\n```");
    return `\n\n\u0001${blocks.length - 1}\u0001\n\n`;
  });
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t: string) => `\`${stripTags(t)}\``);
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, "src");
    return src ? `![${attr(tag, "alt") ?? ""}](${absolutize(src, base)})` : "";
  });
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (tag, inner: string) => {
    const label = stripTags(inner);
    if (!label) return "";
    const href = attr(tag, "href");
    if (!href || /^(javascript:|#|mailto:)/i.test(href)) return label;
    return `[${label}](${absolutize(href, base)})`;
  });
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, t: string) => `\n\n${"#".repeat(Number(lvl))} ${stripTags(t)}\n\n`);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t: string) => `**${stripTags(t)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t: string) => `_${stripTags(t)}_`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `\n- ${stripTags(t)}`);
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t: string) => `\n\n> ${stripTags(t)}\n\n`);
  s = s.replace(/<\/(td|th)>/gi, " | ");
  s = s.replace(/<\/(tr|table)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|header|article|main|h[1-6]|ul|ol|dl|figure|figcaption)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => blocks[Number(i)] ?? "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

export interface Page {
  title: string;
  description: string;
  canonical: string;
  published: string;
  markdown: string;
  text: string;
  headings: string[];
  links: Array<{ text: string; url: string }>;
}

export function extractPage(html: string, base: string): Page {
  const title = stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") ||
    stripTags(html.match(/<meta\b[^>]*property=["']og:title["'][^>]*>/i)?.[0] ?? "");
  const meta = (name: string): string => {
    const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of tags) {
      const key = (attr(tag, "name") ?? attr(tag, "property") ?? "").toLowerCase();
      if (key === name) return attr(tag, "content") ?? "";
    }
    return "";
  };
  const markdown = toMarkdown(mainRegion(html), base);
  const headings = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]).slice(0, 60);
  const links: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, "href");
    if (!href || /^(javascript:|#)/i.test(href)) continue;
    const url = absolutize(href, base);
    if (seen.has(url) || !/^https?:/i.test(url)) continue;
    seen.add(url);
    const text = stripTags(m[2]).slice(0, 140);
    if (text) links.push({ text, url });
    if (links.length >= 150) break;
  }
  return {
    title: oneLine(title, 200),
    description: oneLine(meta("description") || meta("og:description"), 400),
    canonical: meta("og:url") || (html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0] ? attr(html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)![0], "href") ?? "" : "") || base,
    published: meta("article:published_time") || meta("datePublished"),
    markdown,
    text: markdown.replace(/[#>*_`]|\(([^)]+)\)|\[|\]/g, "").replace(/\n{2,}/g, "\n\n").trim(),
    headings,
    links,
  };
}

// --- keyless search ---------------------------------------------------------

export interface Hit {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  rank: number;
}

const cleanUrl = (raw: string): string => {
  let href = decodeEntities(raw).trim();
  if (href.startsWith("//")) href = "https:" + href;
  try {
    const url = new URL(href);
    // DuckDuckGo wraps results: //duckduckgo.com/l/?uddg=<target>
    const target = url.searchParams.get("uddg") ?? url.searchParams.get("u") ?? url.searchParams.get("url");
    if (target && /^https?:/.test(target)) return target;
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return href;
  }
};

function anchorsWithClass(html: string, cls: string): Array<{ href: string; text: string; end: number }> {
  const out: Array<{ href: string; text: string; end: number }> = [];
  const re = new RegExp(`<a\\b([^>]*class=["'][^"']*${cls}[^"']*["'][^>]*)>([\\s\\S]*?)<\\/a>`, "gi");
  for (const m of html.matchAll(re)) {
    const href = attr(`<a ${m[1]}>`, "href");
    if (!href) continue;
    out.push({ href, text: stripTags(m[2]), end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

function snippetAfter(html: string, from: number, to: number): string {
  const slice = html.slice(from, to);
  const m = slice.match(/class=["'][^"']*(?:result__snippet|result-snippet|snippet|s)["'][^>]*>([\s\S]*?)<\/(?:a|div|td|p)>/i);
  return m ? oneLine(stripTags(m[1]), 400) : "";
}

async function searchDDG(query: string, limit: number, ctx: ToolContext): Promise<Hit[]> {
  const body = new URLSearchParams({ q: query, kl: "us-en" }).toString();
  const res = await httpFetch("https://html.duckduckgo.com/html/", {
    method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, timeoutMs: 12_000, cacheMs: 0,
  }, ctx);
  if (res.status >= 400) throw new Error(`duckduckgo ${res.status}`);
  const html = new TextDecoder().decode(res.body);
  const anchors = anchorsWithClass(html, "result__a");
  return anchors.slice(0, limit).map((a, i) => ({
    title: oneLine(a.text, 200),
    url: cleanUrl(a.href),
    snippet: snippetAfter(html, a.end, anchors[i + 1]?.end ?? Math.min(html.length, a.end + 2000)),
    engine: "duckduckgo",
    rank: i,
  })).filter((h) => h.title && /^https?:/.test(h.url));
}

async function searchDDGLite(query: string, limit: number, ctx: ToolContext): Promise<Hit[]> {
  const res = await httpFetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { timeoutMs: 12_000, cacheMs: 0 }, ctx);
  if (res.status >= 400) throw new Error(`ddg-lite ${res.status}`);
  const html = new TextDecoder().decode(res.body);
  const anchors = anchorsWithClass(html, "result-link");
  return anchors.slice(0, limit).map((a, i) => ({
    title: oneLine(a.text, 200),
    url: cleanUrl(a.href),
    snippet: snippetAfter(html, a.end, anchors[i + 1]?.end ?? Math.min(html.length, a.end + 2000)),
    engine: "duckduckgo-lite",
    rank: i,
  })).filter((h) => h.title && /^https?:/.test(h.url));
}

async function searchMojeek(query: string, limit: number, ctx: ToolContext): Promise<Hit[]> {
  const res = await httpFetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, { timeoutMs: 12_000, cacheMs: 0 }, ctx);
  if (res.status >= 400) throw new Error(`mojeek ${res.status}`);
  const html = new TextDecoder().decode(res.body);
  const anchors = anchorsWithClass(html, "ob");
  return anchors.slice(0, limit).map((a, i) => ({
    title: oneLine(a.text, 200),
    url: cleanUrl(a.href),
    snippet: snippetAfter(html, a.end, anchors[i + 1]?.end ?? Math.min(html.length, a.end + 1500)),
    engine: "mojeek",
    rank: i,
  })).filter((h) => h.title && /^https?:/.test(h.url));
}

async function searchWikipedia(query: string, limit: number, ctx: ToolContext): Promise<Hit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${Math.min(limit, 20)}&srsearch=${encodeURIComponent(query)}`;
  const res = await httpFetch(url, { timeoutMs: 10_000 }, ctx);
  if (res.status >= 400) throw new Error(`wikipedia ${res.status}`);
  const data = JSON.parse(new TextDecoder().decode(res.body)) as Json;
  const rows = ((data.query as Json | undefined)?.search as Json[] | undefined) ?? [];
  return rows.map((row, i) => ({
    title: String(row.title ?? ""),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(row.title ?? "")).replace(/%20/g, "_")}`,
    snippet: oneLine(stripTags(String(row.snippet ?? "")), 400),
    engine: "wikipedia",
    rank: i,
  })).filter((h) => h.title);
}

const ENGINES: Record<string, (q: string, n: number, ctx: ToolContext) => Promise<Hit[]>> = {
  duckduckgo: searchDDG,
  "duckduckgo-lite": searchDDGLite,
  mojeek: searchMojeek,
  wikipedia: searchWikipedia,
};

/** Fuse every engine that answered with reciprocal rank fusion. */
export async function search(query: string, opts: { limit?: number; engine?: string; ctx: ToolContext }): Promise<{ hits: Array<Hit & { score: number; engines: string[] }>; engines: string[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const wanted = opts.engine && opts.engine !== "auto" ? [opts.engine] : ["duckduckgo", "wikipedia", "mojeek"];
  const runs = await Promise.allSettled(wanted.map((name) => ENGINES[name](query, limit, opts.ctx)));
  const answers = runs.flatMap((r, i) => (r.status === "fulfilled" && r.value.length ? [{ engine: wanted[i], hits: r.value }] : []));
  const merged = new Map<string, { hit: Hit; score: number; engines: string[] }>();
  for (const { engine, hits } of answers) {
    hits.forEach((hit, rank) => {
      const key = hit.url.replace(/\/$/, "");
      const existing = merged.get(key);
      const contribution = 1 / (60 + rank + 1);
      if (existing) {
        existing.score += contribution;
        if (!existing.engines.includes(engine)) existing.engines.push(engine);
        if (!existing.hit.snippet && hit.snippet) existing.hit.snippet = hit.snippet;
      } else merged.set(key, { hit: { ...hit }, score: contribution, engines: [engine] });
    });
  }
  const max = Math.max(...[...merged.values()].map((m) => m.score), 1e-9);
  const hits = [...merged.values()]
    .map((m) => ({ ...m.hit, score: Number((m.score / max).toFixed(4)), engines: m.engines }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { hits, engines: answers.map((a) => a.engine) };
}

// --- tools ------------------------------------------------------------------

const cacheStore = (ctx: ToolContext) => store(ctx.caps);

export const webTools: ToolSpec[] = [
  {
    name: "web_search",
    kind: "web",
    aliases: ["search_web", "google", "search", "browse_search"],
    description:
      "Search the live web without an API key. Queries several engines in parallel (DuckDuckGo, Wikipedia, Mojeek), fuses their rankings with reciprocal rank fusion and de-duplicates by canonical URL. Set fetch_pages>0 to also read the top results, so one call can return real page text instead of teaser snippets.",
    timeoutMs: 30_000,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Plain keywords beat full sentences." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
        engine: { type: "string", enum: ["auto", "duckduckgo", "duckduckgo-lite", "mojeek", "wikipedia"], default: "auto" },
        fetch_pages: { type: "integer", minimum: 0, maximum: 3, default: 0, description: "Fetch and read the top N results (adds latency but removes a round trip)." },
        max_chars: { type: "integer", minimum: 200, maximum: 8000, default: 1500, description: "Per-page passage budget when fetch_pages > 0." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is empty");
      const cached = await cacheGet<{ hits: unknown[]; engines: string[] }>(cacheStore(ctx), ["search", query, String(args.engine ?? "auto"), String(args.limit ?? 8)], 10 * 60_000, 15 * 60_000).catch(() => null);
      const found = cached ? { hits: cached.hits as never[], engines: cached.engines } : await search(query, { limit: Number(args.limit ?? 8), engine: String(args.engine ?? "auto"), ctx });
      if (!cached) await cachePut(cacheStore(ctx), ["search", query, String(args.engine ?? "auto"), String(args.limit ?? 8)], found, 15 * 60_000).catch(() => {});

      const results = (found.hits as Array<Hit & { score: number; engines: string[] }>).map((h) => ({
        title: h.title, url: h.url, snippet: h.snippet, engines: h.engines, score: h.score,
      }));
      const pages: Json[] = [];
      const wantPages = Math.min(Number(args.fetch_pages ?? 0), 3);
      for (let i = 0; i < wantPages && i < found.hits.length; i++) {
        const hit = found.hits[i] as Hit;
        try {
          const res = await httpFetch(hit.url, { timeoutMs: 12_000 }, ctx);
          const page = extractPage(new TextDecoder().decode(res.body), res.url);
          pages.push({
            url: res.url,
            title: page.title || hit.title,
            passage: truncate(page.markdown, Number(args.max_chars ?? 1500)),
          });
        } catch {
          pages.push({ url: hit.url, title: hit.title, error: "fetch failed" });
        }
      }
      return {
        query,
        engines_answered: found.engines,
        cached: Boolean(cached),
        count: results.length,
        results,
        ...(pages.length ? { pages } : {}),
      };
    },
  },
  {
    name: "web_fetch",
    kind: "web",
    aliases: ["fetch_url", "read_url", "browse", "url_to_markdown", "scrape"],
    description:
      "Fetch a URL and return it as clean Markdown (or text/JSON/raw HTML): title, description, headings, main content and optionally links. Strips scripts, navigation and chrome, caps size and time, and refuses private/loopback addresses. Answers are cached so re-reading is nearly free.",
    timeoutMs: 30_000,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        format: { type: "string", enum: ["markdown", "text", "html", "json"], default: "markdown" },
        max_chars: { type: "integer", minimum: 200, maximum: 60_000, default: 12_000 },
        include_links: { type: "boolean", default: false },
        include_headings: { type: "boolean", default: false },
        cache_seconds: { type: "integer", minimum: 0, maximum: 86_400, default: 900 },
      },
      required: ["url"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const url = String(args.url ?? "").trim();
      const format = String(args.format ?? "markdown");
      const maxChars = Math.min(Number(args.max_chars ?? 12_000), 60_000);
      const cacheMs = Math.min(Number(args.cache_seconds ?? 900), 86_400) * 1000;
      const res = await httpFetch(url, { cacheMs, timeoutMs: 20_000 }, ctx);
      const raw = new TextDecoder().decode(res.body);
      const isJson = /json/i.test(res.contentType) || (format === "json" && /^[\s]*[[{]/.test(raw));
      const isHtml = /html|xml/i.test(res.contentType) || /^\s*<(?:!doctype|html)/i.test(raw);

      if (format === "html") {
        return { url: res.url, status: res.status, content_type: res.contentType, html: truncate(raw, maxChars), truncated: raw.length > maxChars, bytes: res.body.length, cached: res.cached, ms: res.ms };
      }
      if (format === "json" || (isJson && format === "markdown")) {
        try {
          return { url: res.url, status: res.status, content_type: res.contentType, json: JSON.parse(raw), bytes: res.body.length, cached: res.cached, ms: res.ms };
        } catch {
          if (format === "json") throw new Error("response is not valid JSON");
        }
      }
      if (isHtml) {
        const page = extractPage(raw, res.url);
        const bodyOut = format === "text" ? page.text : page.markdown;
        return {
          url: res.url,
          status: res.status,
          title: page.title,
          description: page.description,
          published: page.published || undefined,
          content_type: res.contentType,
          content: truncate(bodyOut, maxChars),
          chars: bodyOut.length,
          truncated: bodyOut.length > maxChars || res.truncated,
          ...(args.include_headings ? { headings: page.headings } : {}),
          ...(args.include_links ? { links: page.links.slice(0, 80) } : {}),
          cached: res.cached,
          ms: res.ms,
        };
      }
      return {
        url: res.url, status: res.status, content_type: res.contentType,
        content: truncate(raw, maxChars), chars: raw.length, truncated: raw.length > maxChars || res.truncated,
        cached: res.cached, ms: res.ms,
      };
    },
  },
  {
    name: "http_request",
    kind: "web",
    aliases: ["call_api", "http", "fetch_json", "api_request"],
    description:
      "Call any HTTP API: choose method, headers and a JSON or text body. Returns status, selected headers and the parsed JSON (or text) response. Same SSRF guard and size caps as web_fetch — use it for POSTs, webhooks and API endpoints that web_fetch cannot reach.",
    timeoutMs: 30_000,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], default: "GET" },
        headers: { type: "object", description: "Request headers as a flat object.", additionalProperties: { type: "string" } },
        json: { type: "object", description: "JSON body (sets content-type automatically)." },
        body: { type: "string", description: "Raw body, used when `json` is absent." },
        timeout_ms: { type: "integer", minimum: 500, maximum: 30_000, default: 20_000 },
        max_bytes: { type: "integer", minimum: 1024, maximum: 4_194_304, default: 524_288 },
        response: { type: "string", enum: ["auto", "json", "text", "base64"], default: "auto" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const headers: Record<string, string> = {};
      if (args.headers && typeof args.headers === "object") {
        for (const [k, v] of Object.entries(args.headers as Json).slice(0, 24)) {
          if (/^(host|content-length|connection)$/i.test(k)) continue;
          headers[k.toLowerCase()] = String(v).slice(0, 2000);
        }
      }
      const method = String(args.method ?? "GET").toUpperCase();
      let body: string | undefined;
      if (args.json !== undefined && method !== "GET" && method !== "HEAD") {
        body = JSON.stringify(args.json);
        headers["content-type"] = headers["content-type"] ?? "application/json";
      } else if (typeof args.body === "string") {
        body = args.body;
      }
      const res = await httpFetch(String(args.url ?? ""), {
        method, headers, body, timeoutMs: Number(args.timeout_ms ?? 20_000), maxBytes: Number(args.max_bytes ?? 524_288), cacheMs: 0,
      }, ctx);
      const raw = new TextDecoder().decode(res.body);
      const mode = String(args.response ?? "auto");
      let parsed: unknown;
      if (mode === "base64") parsed = btoa(String.fromCharCode(...res.body.subarray(0, 100_000)));
      else if (mode === "json" || (mode === "auto" && /json/i.test(res.contentType))) {
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      } else parsed = raw;
      return {
        url: res.url,
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        content_type: res.contentType,
        headers: res.headers,
        body: typeof parsed === "string" ? truncate(parsed, 40_000) : parsed,
        bytes: res.body.length,
        truncated: res.truncated,
        ms: res.ms,
      };
    },
  },
];

/** Exposed for tests: the same predicate the fetcher enforces. */
export const isPrivateProbe = privateAddress;
