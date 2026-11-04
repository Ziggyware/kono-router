// Retrieval core: a keyless embedder, int8 vector compression, BM25, reciprocal
// rank fusion and MMR. Everything is deterministic and allocation-light so the
// same code serves the `embed`, `memory_*` and `rag_*` tools.

import { base64ToBytes, bytesToBase64, tokenize } from "./util.ts";

export const DIM = 384;

// --- feature hashing --------------------------------------------------------
// Words, word bigrams and character 4-grams are hashed into a fixed 384-dim
// space with signed buckets (Weiss et al., 2009). This is a random projection of
// a sparse tf vector: no model, no key, no network, ~5µs per KB. Cosine between
// two hash projections is the cosine of their n-gram profiles — a strong lexical
// signal that degrades gracefully on typos and morphology.

function fnv(s: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  return h >>> 0;
}

function addFeature(vec: Float32Array, feature: string, weight: number): void {
  const h = fnv(feature);
  const bucket = h % DIM;
  const sign = (h & 0x80000000) === 0 ? 1 : -1;
  vec[bucket] += sign * weight;
}

/** Embed one document. Returns a unit vector (or zeros for empty input). */
export function embed(text: string): Float32Array {
  const vec = new Float32Array(DIM);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    bump(`w:${t}`);
    if (i > 0) bump(`b:${tokens[i - 1]}_${t}`);
    if (t.length >= 5) {
      for (let j = 0; j + 4 <= t.length; j++) bump(`c:${t.slice(j, j + 4)}`);
    }
  }
  for (const [key, n] of counts) {
    const weight = key[0] === "w" ? 1 : key[0] === "b" ? 0.55 : 0.28;
    addFeature(vec, key, weight * (1 + Math.log(n)));
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

// --- int8 compression -------------------------------------------------------
// Symmetric per-vector quantisation: 4 bytes/dim → 1 byte/dim, i.e. 1536B → 384B
// for a 384-d vector. Cosine is scale-invariant, so `cosineI8` needs no scale
// factor at all — the quantisation error on retrieved rankings is ~1e-3.

export function quantize(vec: Float32Array): string {
  const q = new Int8Array(vec.length);
  let max = 0;
  for (const v of vec) max = Math.max(max, Math.abs(v));
  const scale = max > 0 ? max / 127 : 1;
  for (let i = 0; i < vec.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
  return bytesToBase64(new Uint8Array(q.buffer, q.byteOffset, q.byteLength));
}

export function dequantize(b64: string): Int8Array {
  return new Int8Array(base64ToBytes(b64).buffer);
}

export function cosineI8(a: Int8Array, b: Int8Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export const toI8 = (vec: Float32Array): Int8Array => new Int8Array(quantizeBytes(vec).buffer);

function quantizeBytes(vec: Float32Array): Uint8Array {
  const i8 = dequantize(quantize(vec));
  return new Uint8Array(i8.buffer, i8.byteOffset, i8.byteLength);
}

// --- BM25 -------------------------------------------------------------------

const TOKEN_CACHE = new Map<string, string[]>();
function cachedTokens(text: string): string[] {
  const hit = TOKEN_CACHE.get(text);
  if (hit) return hit;
  const tokens = tokenize(text);
  if (TOKEN_CACHE.size > 4096) TOKEN_CACHE.clear();
  TOKEN_CACHE.set(text, tokens);
  return tokens;
}

/** Okapi BM25 over an in-memory document set. Documents are `{ text }`; the
 *  token cache means repeated queries pay only for scoring. */
export function bm25(query: string, docs: Array<{ text: string }>, k1 = 1.2, b = 0.75): number[] {
  const qt = [...new Set(tokenize(query))];
  const n = docs.length;
  if (n === 0 || qt.length === 0) return new Array(n).fill(0);
  const toks = docs.map((d) => cachedTokens(d.text));
  const lens = toks.map((t) => t.length);
  const avg = lens.reduce((a, x) => a + x, 0) / n || 1;

  const tf: Array<Map<string, number>> = toks.map((tokens) => {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const df = new Map<string, number>();
  for (const term of qt) {
    let d = 0;
    for (const m of tf) if (m.has(term)) d++;
    df.set(term, d);
  }
  const scores = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const term of qt) {
      const f = tf[i].get(term) ?? 0;
      if (!f) continue;
      const d = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * lens[i]) / avg));
    }
    scores[i] = s;
  }
  return scores;
}

// --- fusion & diversity -----------------------------------------------------

/** Reciprocal rank fusion (Cormack et al., 2009) over several rankings. */
export function rrf(rankings: number[][], k = 60): number[] {
  // Size by the largest *document index*, not by ranking length: two rankings
  // can each be short and still point at different documents.
  const size = rankings.reduce((m, r) => r.reduce((mm, doc) => Math.max(mm, doc + 1), m), 0);
  const scores = new Array(size).fill(0);
  for (const ranking of rankings) {
    ranking.forEach((doc, rank) => { scores[doc] += 1 / (k + rank + 1); });
  }
  const max = Math.max(...scores, 1e-9);
  return scores.map((s) => s / max);
}

/** Order candidates best-first with a normalised score vector. */
export function rankOf(scores: number[]): number[] {
  return scores
    .map((score, i) => ({ score, i }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);
}

/** Maximal marginal relevance: relevance minus redundancy (Carbonell & Goldstein). */
export function mmrOrder(relevance: number[], vectors: Int8Array[], k: number, lambda = 0.7): number[] {
  const pool = relevance.map((r, i) => i).filter((i) => relevance[i] > 0);
  const picked: number[] = [];
  while (picked.length < k && pool.length > 0) {
    let bestAt = 0;
    let best = -Infinity;
    for (let p = 0; p < pool.length; p++) {
      const i = pool[p];
      let overlap = 0;
      for (const j of picked) overlap = Math.max(overlap, cosineI8(vectors[i], vectors[j]));
      const score = lambda * relevance[i] - (1 - lambda) * overlap;
      if (score > best) { best = score; bestAt = p; }
    }
    picked.push(pool[bestAt]);
    pool.splice(bestAt, 1);
  }
  return picked;
}

// --- chunking ---------------------------------------------------------------

/** Paragraph-first chunker with overlap: keeps prose intact, tolerates code. */
export function chunkText(input: string, chars = 900, overlap = 120): string[] {
  const clean = input.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!clean) return [];
  if (clean.length <= chars * 1.15) return [clean];
  const blocks = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    const out = buf.trim();
    if (out) chunks.push(out);
    buf = overlap > 0 && out.length > overlap ? out.slice(-overlap) : "";
  };
  for (const block of blocks) {
    if (block.length <= chars) {
      if (buf.length + block.length + 2 > chars) flush();
      buf += (buf ? "\n\n" : "") + block;
      continue;
    }
    for (const sentence of block.split(/(?<=[.!?])\s+|\n/)) {
      if (sentence.length > chars) {
        if (buf) flush();
        for (let i = 0; i < sentence.length; i += chars) {
          chunks.push(sentence.slice(i, i + chars));
          buf = sentence.slice(Math.max(0, i + chars - overlap), i + chars);
        }
        continue;
      }
      if (buf.length + sentence.length + 1 > chars) flush();
      buf += (buf ? " " : "") + sentence;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/** Extractive summary: sentence scoring by centroid similarity + position. */
export function summarize(input: string, maxChars = 600): string {
  const sentences = input.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/).filter((s) => s.length > 24);
  if (sentences.length <= 1) return input.slice(0, maxChars);
  const centroid = embed(input);
  const scored = sentences.map((s, i) => {
    const vec = embed(s);
    let dot = 0;
    for (let d = 0; d < DIM; d++) dot += vec[d] * centroid[d];
    return { s, score: dot + (i === 0 ? 0.08 : 0) + Math.min(0.08, s.length / 4000) };
  }).sort((a, b) => b.score - a.score);
  const picked: string[] = [];
  let used = 0;
  for (const { s } of scored) {
    if (used + s.length > maxChars) continue;
    picked.push(s);
    used += s.length;
    if (used > maxChars * 0.85) break;
  }
  return picked.join(" ");
}
