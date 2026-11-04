// Retrieval-augmented generation over a durable, per-collection index.
//
// Index: paragraph-aware chunks, int8 embeddings, content-addressed ids (the
// same paragraph indexed twice costs nothing). Search: BM25 and dense cosine,
// fused with reciprocal rank fusion, diversified with MMR, then packed into a
// character budget with citations. One KV namespace, no vector database.

import { store } from "./store.ts";
import { contentId, truncate, ulid } from "./util.ts";
import { bm25, chunkText, cosineI8, dequantize, embed, mmrOrder, quantize, rankOf, rrf } from "./vec.ts";
import { extractPage, httpFetch } from "./web.ts";
import type { Json, ToolContext, ToolSpec } from "./types.ts";

interface Chunk {
  id: string;
  coll: string;
  doc: string;
  source: string;
  ord: number;
  text: string;
  vec: string;
  hash: string;
  at: number;
  meta?: Json;
}

interface Collection {
  name: string;
  created: number;
  updated: number;
  docs: number;
  chunks: number;
  chars: number;
  searches: number;
}

const MAX_CHUNKS = 5000;
const MAX_DOC_CHARS = 2_000_000;

const ragStore = (ctx: ToolContext) => store(ctx.caps);
const collKey = (name: string): string[] => ["rag", "c", name];
const chunkKey = (coll: string, id: string): string[] => ["rag", "d", coll, id];

const validName = (raw: string): string => {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 48);
  if (!name) throw new Error("collection name is empty");
  return name;
};

async function getCollection(ctx: ToolContext, name: string): Promise<Collection> {
  return (await ragStore(ctx).get<Collection>(collKey(name))) ?? {
    name, created: Date.now(), updated: Date.now(), docs: 0, chunks: 0, chars: 0, searches: 0,
  };
}

async function allChunks(ctx: ToolContext, coll: string): Promise<Chunk[]> {
  const rows = await ragStore(ctx).list<Chunk>(["rag", "d", coll], { limit: MAX_CHUNKS });
  return rows.map((r) => r.value).filter((c) => c && typeof c.text === "string");
}

/** Fetch and read a URL as ingestion source. */
async function readUrl(url: string, ctx: ToolContext): Promise<{ text: string; title: string }> {
  const res = await httpFetch(url, { timeoutMs: 20_000 }, ctx);
  const raw = new TextDecoder().decode(res.body);
  const page = /html/i.test(res.contentType) ? extractPage(raw, res.url) : { markdown: raw, title: "" };
  return { text: page.markdown.slice(0, MAX_DOC_CHARS), title: page.title };
}

export const ragTools: ToolSpec[] = [
  {
    name: "rag_index",
    kind: "rag",
    aliases: ["index_documents", "add_to_index", "ingest", "knowledge_add", "upsert_docs"],
    description:
      "Add documents to a searchable knowledge collection. Pass text documents, or URLs to fetch and index. Text is chunked by paragraph, embedded and stored content-addressed (re-indexing identical text is free). Use it whenever material is too large to keep in context but may be needed later.",
    timeoutMs: 60_000,
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", default: "default", description: "Logical collection, e.g. \"project-x\" or \"api-docs\"." },
        docs: {
          type: "array",
          description: "Documents to index.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              source: { type: "string" },
              meta: { type: "object" },
            },
            required: ["text"],
          },
        },
        urls: { type: "array", items: { type: "string" }, description: "URLs to fetch and index (one document each)." },
        chunk_chars: { type: "integer", minimum: 200, maximum: 4000, default: 1000 },
        overlap: { type: "integer", minimum: 0, maximum: 500, default: 120 },
        replace: { type: "boolean", default: false, description: "Delete the collection before indexing." },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = ragStore(ctx);
      const coll = validName(String(args.collection ?? "default"));
      if (args.replace === true) {
        for (const c of await allChunks(ctx, coll)) await s.del(chunkKey(coll, c.id));
      }
      const chunkChars = Math.max(200, Math.min(4000, Number(args.chunk_chars ?? 1000)));
      const overlap = Math.max(0, Math.min(500, Number(args.overlap ?? 120)));
      const docs: Array<{ id: string; text: string; source: string; meta?: Json }> = [];

      for (const raw of Array.isArray(args.docs) ? args.docs as Json[] : []) {
        const text = String(raw.text ?? "");
        if (!text.trim()) continue;
        docs.push({
          id: String(raw.id ?? ulid()).slice(0, 80),
          text: text.slice(0, MAX_DOC_CHARS),
          source: String(raw.source ?? raw.id ?? "inline"),
          ...(raw.meta && typeof raw.meta === "object" ? { meta: raw.meta as Json } : {}),
        });
      }
      for (const url of Array.isArray(args.urls) ? args.urls.map(String).slice(0, 10) : []) {
        const page = await readUrl(url, ctx);
        if (!page.text.trim()) continue;
        docs.push({ id: ulid(), text: page.text, source: url, meta: { title: page.title } });
      }
      if (docs.length === 0) throw new Error("nothing to index: provide docs[] or urls[]");

      const known = new Set((await allChunks(ctx, coll)).map((c) => c.id));
      let added = 0, duplicates = 0, chars = 0;
      const byDoc: Json[] = [];
      for (const doc of docs) {
        const pieces = chunkText(doc.text, chunkChars, overlap);
        let indexed = 0;
        for (const [ord, piece] of pieces.entries()) {
          const hash = await contentId(piece);
          const id = hash;
          if (known.has(id)) { duplicates++; continue; }
          known.add(id);
          chars += piece.length;
          const chunk: Chunk = {
            id, coll, doc: doc.id, source: doc.source, ord,
            text: piece, vec: quantize(embed(piece)), hash, at: Date.now(),
            ...(doc.meta ? { meta: doc.meta } : {}),
          };
          await s.put(chunkKey(coll, id), chunk);
          added++;
          indexed++;
        }
        byDoc.push({ id: doc.id, source: doc.source, chunks: indexed, chars: doc.text.length });
      }

      const meta = await getCollection(ctx, coll);
      const stored = await allChunks(ctx, coll);
      const count = stored.length;
      const next: Collection = {
        ...meta,
        updated: Date.now(),
        docs: new Set(stored.map((c) => c.doc)).size,
        chunks: count,
        chars: (meta.chars ?? 0) + chars,
      };
      await s.put(collKey(coll), next);
      ctx.event?.("rag.index", { collection: coll, added, duplicates });
      return {
        collection: coll,
        documents: byDoc,
        chunks_added: added,
        duplicates_skipped: duplicates,
        collection_chunks: count,
        collection_chars: next.chars,
        note: added === 0 ? "all content was already indexed" : undefined,
      };
    },
  },
  {
    name: "rag_search",
    kind: "rag",
    aliases: ["search_index", "knowledge_search", "retrieve", "rag_query", "lookup"],
    description:
      "Search an indexed collection and get the best passages back with sources. Hybrid BM25 + dense retrieval fused by RRF, diversified with MMR so one document cannot monopolise the result, packed into a character budget. Prefer this over stuffing whole documents into context.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        collection: { type: "string", default: "default" },
        k: { type: "integer", minimum: 1, maximum: 30, default: 8 },
        mode: { type: "string", enum: ["hybrid", "bm25", "vector"], default: "hybrid" },
        mmr: { type: "number", minimum: 0, maximum: 1, default: 0.7 },
        budget_chars: { type: "integer", minimum: 200, maximum: 40_000, default: 6000, description: "Total passage budget for the answer." },
        per_hit_chars: { type: "integer", minimum: 100, maximum: 4000, default: 900 },
        include_text: { type: "boolean", default: true },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = ragStore(ctx);
      const started = performance.now();
      const coll = validName(String(args.collection ?? "default"));
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is empty");
      const chunks = await allChunks(ctx, coll);
      if (chunks.length === 0) return { collection: coll, query, count: 0, hits: [], message: `collection "${coll}" is empty — index documents with rag_index first` };

      const mode = String(args.mode ?? "hybrid");
      const qvec = dequantize(quantize(embed(query)));
      const lexical = bm25(query, chunks);
      const dense = chunks.map((c) => Math.max(0, cosineI8(qvec, dequantize(c.vec))));
      const lexicalNorm = normalize(lexical);
      const relevance = mode === "bm25"
        ? normalize(lexical)
        : mode === "vector"
          ? normalize(dense)
          : rrf([rankOf(lexical), rankOf(dense)]);

      const k = Math.max(1, Math.min(30, Number(args.k ?? 8)));
      const order = mmrOrder(
        relevance,
        chunks.map((c) => dequantize(c.vec)),
        k,
        Math.max(0, Math.min(1, Number(args.mmr ?? 0.7))),
      );
      const budget = Math.max(200, Math.min(40_000, Number(args.budget_chars ?? 6000)));
      const perHit = Math.max(100, Math.min(4000, Number(args.per_hit_chars ?? 900)));
      let used = 0;
      const hits: Json[] = [];
      for (const i of order) {
        const c = chunks[i];
        if (used >= budget) break;
        const allowance = Math.min(perHit, budget - used);
        const body = truncate(c.text, allowance);
        used += body.length;
        hits.push({
          id: c.id,
          source: c.source,
          doc: c.doc,
          chunk: c.ord,
          score: Number(relevance[i].toFixed(4)),
          lexical: Number(lexicalNorm[i].toFixed(4)),
          similarity: Number(dense[i].toFixed(4)),
          chars: body.length,
          ...(args.include_text === false ? {} : { text: body }),
        });
      }

      const meta = await getCollection(ctx, coll);
      await s.put(collKey(coll), { ...meta, searches: (meta.searches ?? 0) + 1, updated: Date.now() }).catch(() => {});
      return {
        collection: coll,
        query,
        mode,
        scanned_chunks: chunks.length,
        returned: hits.length,
        budget_chars: budget,
        used_chars: used,
        took_ms: Math.max(0, Math.round(performance.now() - started)),
        hits,
        citations: hits.map((h) => `${h.source}#${h.chunk}`),
      };
    },
  },
  {
    name: "rag_collections",
    kind: "rag",
    aliases: ["list_collections", "index_stats", "rag_stats"],
    description:
      "Inspect the knowledge index: collections, document and chunk counts, indexed characters, and the documents inside one collection. Use it before searching to see what is actually available.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Omit to list all collections." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = ragStore(ctx);
      if (typeof args.collection === "string" && args.collection.trim()) {
        const coll = validName(args.collection);
        const meta = await getCollection(ctx, coll);
        const docs = new Map<string, { source: string; chunks: number; chars: number }>();
        for (const c of await allChunks(ctx, coll).then((cs) => cs.slice(0, Number(args.limit ?? 50) * 20))) {
          const entry = docs.get(c.doc) ?? { source: c.source, chunks: 0, chars: 0 };
          entry.chunks++;
          entry.chars += c.text.length;
          docs.set(c.doc, entry);
        }
        return {
          collection: coll,
          ...meta,
          documents: [...docs.entries()].slice(0, Number(args.limit ?? 50)).map(([id, v]) => ({ id, ...v })),
        };
      }
      const rows = await s.list<Collection>(["rag", "c"], { limit: 200 });
      const collections = rows.map((r) => r.value).filter(Boolean).sort((a, b) => b.updated - a.updated).map((c) => ({
        ...c, updated_iso: new Date(c.updated).toISOString(),
      }));
      return {
        count: collections.length,
        total_chunks: collections.reduce((n, c) => n + (c.chunks ?? 0), 0),
        total_chars: collections.reduce((n, c) => n + (c.chars ?? 0), 0),
        collections,
      };
    },
  },
];

function normalize(values: number[]): number[] {
  const max = Math.max(...values, 1e-9);
  return values.map((v) => Math.max(0, v) / max);
}
