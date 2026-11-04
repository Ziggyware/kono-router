// Long-term memory with compounding value: write, recall, forget, link.
//
// Every memory is embedded (134-byte int8 vector) at write time. A new write is
// consolidated into an existing near-duplicate instead of piling up: that is the
// compression step. Recall is hybrid (BM25 + cosine, RRF-fused) then re-ranked by
// recency, importance and usage — the Generative-Agents retrieval score — and
// finally diversified with MMR, so ten paraphrases of one fact cannot crowd out
// the rest of the answer. Reads reinforce: usage raises future retrieval odds.

import { store } from "./store.ts";
import { contentId, isObj, oneLine, tokenize, truncate, ulid } from "./util.ts";
import { bm25, cosineI8, dequantize, embed, mmrOrder, quantize, rankOf, rrf } from "./vec.ts";
import type { Json, ToolContext, ToolSpec } from "./types.ts";

interface Link { to: string; rel: string; at: number }
interface Memory {
  id: string;
  text: string;
  kind: string;
  tags: string[];
  importance: number;
  created: number;
  updated: number;
  accessed: number;
  uses: number;
  expires?: number;
  vec: string;
  hash: string;
  links: Link[];
  source?: string;
}

const MAX_MEMORIES = 5000;
const HALF_LIFE_DAYS = 14;

const memStore = (ctx: ToolContext) => store(ctx.caps);
const keyOf = (id: string): string[] => ["mem", "i", id];

async function allMemories(ctx: ToolContext): Promise<Memory[]> {
  const rows = await memStore(ctx).list<Memory>(["mem", "i"], { limit: MAX_MEMORIES });
  const now = Date.now();
  return rows.map((r) => r.value).filter((m) => m && typeof m.text === "string" && (!m.expires || m.expires > now));
}

const recency = (m: Memory, now: number): number => Math.exp(-(now - m.updated) / (HALF_LIFE_DAYS * 86_400_000));

// Consolidation needs to merge true duplicates without merging two different
// facts that happen to share boilerplate ("the user prefers …"). Cosine alone
// is not enough for a lexically-projected vector, so the decision is a
// conjunction: very high cosine, or high cosine *and* near-total containment of
// the shorter memory's content words.
const STOP = new Set("a an and are as at be but by for from has have he her his i if in is it its of on or that the their them then there these they this to was were will with you your we our not no do does did can could should would about into over under than so such very just".split(" "));
function contentTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((w) => w.length > 1 && !STOP.has(w)));
}
function containment(a: string, b: string): number {
  const A = contentTokens(a), B = contentTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

function tagsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 20);
  if (typeof v === "string") return v.split(/[,\s]+/).map((s) => s.toLowerCase().trim()).filter(Boolean).slice(0, 20);
  return [];
}

function parseLinks(v: unknown): Link[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 20).flatMap((raw) => {
    if (typeof raw === "string") return [{ to: raw.trim(), rel: "related", at: Date.now() }];
    if (!isObj(raw)) return [];
    const to = String(raw.to ?? raw.id ?? "").trim();
    return to ? [{ to, rel: String(raw.rel ?? raw.relation ?? "related").slice(0, 40), at: Date.now() }] : [];
  });
}

/** Hybrid memory ranking. Returns indices into `memories`. */
function rank(memories: Memory[], query: string, opts: { tags?: string[]; kind?: string; minScore?: number }): Array<{ i: number; score: number; cosine: number }> {
  const now = Date.now();
  const filtered = memories
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => (!opts.kind || m.kind === opts.kind) && (!opts.tags?.length || opts.tags.some((t) => m.tags.includes(t))));
  if (filtered.length === 0) return [];
  const docs = filtered.map(({ m }) => ({ text: m.text }));
  const lexical = bm25(query, docs);
  const qv = quantize(embed(query));
  const qvec = dequantize(qv);
  const dense = filtered.map(({ m }) => cosineI8(qvec, dequantize(m.vec)));
  const fused = rrf([rankOf(lexical), rankOf(dense)]);
  const maxUse = Math.log1p(50);
  return filtered.map(({ m }, k) => {
    const sem = Math.max(0, dense[k]);
    // A query with no positive signal still returns the most important recent
    // memories instead of nothing: recall is a prior, not a filter.
    const hybrid = Math.max((fused[k] ?? 0) * 0.75, sem * 0.25);
    const score = hybrid * 0.6 + recency(m, now) * 0.15 + m.importance * 0.15 + Math.min(1, Math.log1p(m.uses) / maxUse) * 0.1;
    return { i: filtered[k].i, score, cosine: sem };
  }).filter((x) => x.score >= (opts.minScore ?? 0)).sort((a, b) => b.score - a.score);
}

export const memoryTools: ToolSpec[] = [
  {
    name: "memory_write",
    kind: "memory",
    aliases: ["remember", "save_memory", "memory_add", "store_fact"],
    description:
      "Persist a fact, preference or decision across conversations. Near-duplicates are consolidated automatically (cosine ≥ threshold) instead of stored twice, so the store stays small and sharp. Tag memories and set importance 0–1; you can add links to other memory ids. Returns the id needed by memory_recall / memory_graph.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The memory, stated as a self-contained fact." },
        tags: { type: "array", items: { type: "string" }, description: "Retrieval tags, e.g. [\"user\", \"preference\"]." },
        kind: { type: "string", enum: ["fact", "preference", "decision", "insight", "task", "event"], default: "fact" },
        importance: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        ttl_days: { type: "number", minimum: 0, description: "Optional expiry; omit for permanent." },
        links: {
          type: "array",
          description: "Edges to other memories.",
          items: { type: "object", properties: { to: { type: "string" }, rel: { type: "string" } }, required: ["to"] },
        },
        dedupe: { type: "boolean", default: true },
        dedupe_threshold: { type: "number", minimum: 0.5, maximum: 1, default: 0.92 },
        source: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = memStore(ctx);
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("text is empty");
      if (text.length > 8000) throw new Error("memory text exceeds 8000 characters");
      const tags = tagsOf(args.tags);
      const kind = String(args.kind ?? "fact");
      const importance = Math.max(0, Math.min(1, Number(args.importance ?? 0.5)));
      const now = ctx.now;
      const vec = quantize(embed(text));
      const hash = await contentId(text.toLowerCase().replace(/\s+/g, " "));
      const existing = await allMemories(ctx);

      if (args.dedupe !== false) {
        const threshold = Math.max(0.5, Math.min(1, Number(args.dedupe_threshold ?? 0.92)));
        const qvec = dequantize(vec);
        let best: { m: Memory; sim: number } | null = null;
        for (const m of existing) {
          if (!m.vec) continue;
          const sim = cosineI8(qvec, dequantize(m.vec));
          if (m.hash === hash) { best = { m, sim: 1 }; break; }
          const duplicate = sim >= Math.max(threshold, 0.92) || (sim >= 0.8 && containment(text, m.text) >= 0.8);
          if (duplicate && (!best || sim > best.sim)) best = { m, sim };
        }
        if (best) {
          const merged: Memory = {
            ...best.m,
            text: text.length > best.m.text.length ? text : best.m.text,
            tags: [...new Set([...best.m.tags, ...tags])],
            importance: Math.max(best.m.importance, importance),
            updated: now,
            uses: best.m.uses + 1,
            links: [...best.m.links, ...parseLinks(args.links)].slice(-40),
            expires: args.ttl_days ? now + Number(args.ttl_days) * 86_400_000 : best.m.expires,
          };
          await s.put(keyOf(merged.id), merged);
          return { id: merged.id, consolidated: true, similarity: Number(best.sim.toFixed(4)), text: merged.text, tags: merged.tags, importance: merged.importance, message: "merged into the existing near-duplicate instead of adding a new memory" };
        }
      }

      // Evict the least valuable 5% when full: low importance, old, rarely used.
      if (existing.length >= MAX_MEMORIES) {
        const nowMs = Date.now();
        const victims = existing
          .map((m) => ({ m, v: m.importance * 0.5 + recency(m, nowMs) * 0.3 + Math.min(1, m.uses / 20) * 0.2 }))
          .sort((a, b) => a.v - b.v)
          .slice(0, Math.ceil(MAX_MEMORIES * 0.05));
        await Promise.all(victims.map((v) => s.del(keyOf(v.m.id))));
      }

      const id = ulid(now);
      const record: Memory = {
        id, text, kind, tags, importance,
        created: now, updated: now, accessed: now, uses: 0,
        ...(args.ttl_days ? { expires: now + Number(args.ttl_days) * 86_400_000 } : {}),
        vec, hash,
        links: parseLinks(args.links),
        ...(args.source ? { source: String(args.source) } : {}),
      };
      await s.put(keyOf(id), record);
      ctx.event?.("memory.write", { id, tags: tags.join(","), bytes: text.length });
      return { id, consolidated: false, text, tags, kind, importance, expires: record.expires ?? null };
    },
  },
  {
    name: "memory_recall",
    kind: "memory",
    aliases: ["recall", "search_memory", "remember_search", "memory_search"],
    description:
      "Retrieve what you know. Hybrid lexical + semantic search, re-ranked by recency, importance and how often the memory proved useful, then diversified with MMR so results are not five paraphrases of one fact. Reads reinforce the memories they surface. Set expand=true to pull in one hop of linked memories.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to remember. Empty returns the most useful recent memories." },
        k: { type: "integer", minimum: 1, maximum: 50, default: 8 },
        tags: { type: "array", items: { type: "string" } },
        kind: { type: "string", enum: ["fact", "preference", "decision", "insight", "task", "event"] },
        min_score: { type: "number", minimum: 0, maximum: 1, default: 0 },
        mmr: { type: "number", minimum: 0, maximum: 1, default: 0.7, description: "Relevance vs diversity. 1 = pure relevance." },
        expand: { type: "boolean", default: false, description: "Include one hop of linked memories." },
        reinforce: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = memStore(ctx);
      const memories = await allMemories(ctx);
      const query = String(args.query ?? "").trim();
      const k = Math.max(1, Math.min(50, Number(args.k ?? 8)));
      const ranked = query
        ? rank(memories, query, { tags: tagsOf(args.tags), kind: args.kind as string | undefined, minScore: Number(args.min_score ?? 0) }).slice(0, Math.max(k * 4, k))
        : memories
          .map((m, i) => ({ i, score: m.importance * 0.5 + recency(m, Date.now()) * 0.4 + Math.min(1, m.uses / 20) * 0.1, cosine: 0 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(k * 4, k));

      const order = mmrOrder(
        ranked.map((r) => r.score),
        ranked.map((r) => dequantize(memories[r.i].vec)),
        k,
        Math.max(0, Math.min(1, Number(args.mmr ?? 0.7))),
      ).map((idx) => ranked[idx]);
      const seen = new Set(order.map((r) => r.i));
      const indexOf = new Map(memories.map((m, i) => [m.id, i]));
      type Row = ReturnType<typeof toRow> & { linked?: boolean };
      const toRow = (m: Memory, score: number, cosine: number) => ({
        id: m.id, text: m.text, kind: m.kind, tags: m.tags, importance: m.importance,
        score: Number(score.toFixed(4)), similarity: Number(cosine.toFixed(4)),
        age_days: Number(((Date.now() - m.updated) / 86_400_000).toFixed(1)), uses: m.uses,
        ...(m.links.length ? { links: m.links.map((l) => ({ to: l.to, rel: l.rel })) } : {}),
      });
      const rows: Row[] = order.map((r) => {
        return toRow(memories[r.i], r.score, r.cosine);
      });

      if (args.expand === true) {
        const ids = new Set(rows.flatMap((r) => (r.links ?? []).map((l) => l.to)));
        for (const m of memories) {
          const at = indexOf.get(m.id) ?? -1;
          if (!ids.has(m.id) || at < 0 || seen.has(at)) continue;
          seen.add(at);
          rows.push({ ...toRow(m, 0.01, 0), linked: true });
        }
      }

      if (args.reinforce !== false && rows.length) {
        const now = Date.now();
        const reinforced = new Set(order.slice(0, 10).map((r) => r.i));
        await Promise.all([...reinforced].map((i) => {
          const m = memories[i];
          return s.put(keyOf(m.id), { ...m, uses: m.uses + 1, accessed: now });
        }));
        // The response reports post-reinforcement usage, not the stale count.
        rows.forEach((row, i) => {
          if (reinforced.has(order[i].i)) row.uses += 1;
        });
      }
      return { query: query || null, total: memories.length, returned: rows.length, memories: rows };
    },
  },
  {
    name: "memory_forget",
    kind: "memory",
    aliases: ["forget", "delete_memory", "memory_delete", "prune_memory"],
    description:
      "Remove memories: by explicit ids, by a query (deletes the best matches), by tag, by age, or everything. Use it to honour a deletion request or to prune stale facts. Reports how many were removed.",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        query: { type: "string" },
        tag: { type: "string" },
        older_than_days: { type: "number", minimum: 0 },
        all: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 20 },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = memStore(ctx);
      const memories = await allMemories(ctx);
      const victims = new Map<string, string>();
      if (args.all === true) for (const m of memories) victims.set(m.id, "all");
      for (const id of Array.isArray(args.ids) ? args.ids : []) {
        const found = memories.find((m) => m.id === String(id));
        if (found) victims.set(found.id, "id");
      }
      const limit = Math.max(1, Math.min(500, Number(args.limit ?? 20)));
      if (typeof args.query === "string" && args.query.trim()) {
        for (const r of rank(memories, args.query, {}).slice(0, limit)) victims.set(memories[r.i].id, "query");
      }
      if (typeof args.tag === "string" && args.tag.trim()) {
        const tag = args.tag.toLowerCase();
        for (const m of memories) if (m.tags.includes(tag)) victims.set(m.id, "tag");
      }
      if (typeof args.older_than_days === "number") {
        const cutoff = Date.now() - args.older_than_days * 86_400_000;
        for (const m of memories) if (m.updated < cutoff) victims.set(m.id, "age");
      }
      if (victims.size === 0) return { deleted: 0, message: "no selector matched — pass ids, query, tag, older_than_days or all=true" };
      await Promise.all([...victims.keys()].map((id) => s.del(keyOf(id))));
      return { deleted: victims.size, ids: [...victims.keys()].slice(0, 50), remaining: Math.max(0, memories.length - victims.size) };
    },
  },
  {
    name: "memory_graph",
    kind: "memory",
    aliases: ["knowledge_graph", "memory_link", "graph"],
    description:
      "Walk the memory graph: link two memory ids, unlink them, list a memory's neighbours, find a path between two memories, or summarise the graph. Links turn isolated facts into structure you can traverse.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["link", "unlink", "neighbors", "path", "stats"], default: "stats" },
        from: { type: "string" },
        to: { type: "string" },
        rel: { type: "string", default: "related" },
        depth: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      },
      required: ["op"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = memStore(ctx);
      const memories = await allMemories(ctx);
      const byId = new Map(memories.map((m) => [m.id, m]));
      const op = String(args.op ?? "stats");
      const from = String(args.from ?? "");
      const to = String(args.to ?? "");

      if (op === "link" || op === "unlink") {
        const src = byId.get(from);
        if (!src) throw new Error(`unknown memory id: ${from || "(empty)"}`);
        if (!byId.has(to)) throw new Error(`unknown memory id: ${to || "(empty)"}`);
        const links = op === "link"
          ? [...src.links.filter((l) => l.to !== to), { to, rel: String(args.rel ?? "related").slice(0, 40), at: Date.now() }]
          : src.links.filter((l) => l.to !== to);
        await s.put(keyOf(src.id), { ...src, links, updated: Date.now() });
        return { op, from, to, rel: String(args.rel ?? "related"), links: links.length };
      }

      if (op === "neighbors") {
        if (!from.trim()) throw new Error("from is required");
        const depth = Math.max(1, Math.min(3, Number(args.depth ?? 1)));
        const seen = new Set<string>([from]);
        let frontier = [from];
        const edges: Json[] = [];
        for (let d = 0; d < depth; d++) {
          const next: string[] = [];
          for (const id of frontier) {
            const m = byId.get(id);
            if (!m) continue;
            for (const l of m.links) {
              edges.push({ from: id, to: l.to, rel: l.rel, depth: d + 1 });
              if (!seen.has(l.to)) { seen.add(l.to); next.push(l.to); }
            }
            for (const other of memories) {
              if (!other.links.some((l) => l.to === id)) continue;
              edges.push({ from: other.id, to: id, rel: other.links.find((l) => l.to === id)!.rel, depth: d + 1, reverse: true });
              if (!seen.has(other.id)) { seen.add(other.id); next.push(other.id); }
            }
          }
          frontier = next;
          if (!frontier.length) break;
        }
        return { from, depth, nodes: [...seen].map((id) => ({ id, text: truncate(byId.get(id)?.text ?? "(missing)", 240) })), edges: edges.slice(0, 100) };
      }

      if (op === "path") {
        if (!byId.has(from) || !byId.has(to)) throw new Error("from/to must be existing memory ids");
        const prev = new Map<string, string>();
        const queue = [from];
        const visited = new Set([from]);
        while (queue.length) {
          const id = queue.shift()!;
          if (id === to) break;
          for (const l of byId.get(id)?.links ?? []) {
            if (visited.has(l.to)) continue;
            visited.add(l.to);
            prev.set(l.to, id);
            queue.push(l.to);
          }
        }
        if (!visited.has(to)) return { from, to, found: false };
        const path = [to];
        while (path[0] !== from) path.unshift(prev.get(path[0])!);
        return { from, to, found: true, hops: path.length - 1, path: path.map((id) => ({ id, text: truncate(byId.get(id)?.text ?? "", 160) })) };
      }

      const edgeCount = memories.reduce((n, m) => n + m.links.length, 0);
      const degree = memories.map((m) => ({ id: m.id, degree: m.links.length, text: oneLine(m.text, 80) })).sort((a, b) => b.degree - a.degree);
      const kinds: Record<string, number> = {};
      for (const m of memories) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
      return {
        memories: memories.length,
        edges: edgeCount,
        orphans: degree.filter((d) => d.degree === 0).length,
        kinds,
        top_connected: degree.slice(0, 5),
        oldest_days: memories.length ? Number(((Date.now() - Math.min(...memories.map((m) => m.created))) / 86_400_000).toFixed(1)) : 0,
      };
    },
  },
];
