// Embeddings without a key. `hash-384` is a signed feature-hashing projection of
// word unigrams, word bigrams and character 4-grams — deterministic, ~5µs per KB,
// and honest about what it is: lexical-semantic, not a neural encoder. If the
// deployment has a real OpenAI-compatible endpoint, set NOKEY_EMBED_URL and the
// tool upgrades transparently.

import { truncate } from "./util.ts";
import { cosineI8, embed, quantize } from "./vec.ts";
import type { Json, ToolSpec } from "./types.ts";

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

async function remoteEmbed(texts: string[]): Promise<{ vectors: number[][]; model: string } | null> {
  const url = Deno.env.get("NOKEY_EMBED_URL");
  if (!url) return null;
  const model = Deno.env.get("NOKEY_EMBED_MODEL") ?? "text-embedding-3-small";
  const key = Deno.env.get("NOKEY_EMBED_KEY");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json() as { data?: Array<{ embedding: number[] }> };
    const vectors = (data.data ?? []).map((d) => d.embedding);
    return vectors.length === texts.length ? { vectors, model } : null;
  } catch {
    return null;
  }
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "")).slice(0, 64);

export const embedTools: ToolSpec[] = [
  {
    name: "embed",
    kind: "vector",
    aliases: ["embeddings", "vectorize", "semantic_similarity", "cosine"],
    description:
      "Turn text into vectors and measure semantic closeness. Default model `hash-384` is keyless, deterministic and instant (word + bigram + char-4gram projection); set NOKEY_EMBED_URL to use a neural endpoint instead. Use `compare_to` to get cosine scores without dragging raw vectors through context.",
    timeoutMs: 25_000,
    parameters: {
      type: "object",
      properties: {
        text: { type: ["string", "array"], items: { type: "string" }, description: "One string or a list to embed." },
        compare_to: { type: ["string", "array"], items: { type: "string" }, description: "String(s) to score against every input." },
        format: { type: "string", enum: ["summary", "int8", "floats"], default: "summary" },
        include_text: { type: "boolean", default: false },
      },
      required: ["text"],
      additionalProperties: false,
    },
    run: async (args) => {
      const texts = asList(args.text);
      const compares = args.compare_to === undefined ? [] : asList(args.compare_to);
      const inputs = texts.filter((t) => t.trim());
      if (inputs.length === 0) throw new Error("text is empty");
      const all = [...texts, ...compares];
      const remote = await remoteEmbed(all);
      const model = remote ? remote.model : "hash-384";
      const vectors = remote ? remote.vectors.map((v) => Float32Array.from(v)) : all.map((t) => embed(t));
      const quantized = vectors.map((v) => quantize(v));
      const compareOffset = texts.length;

      const similarities: Json[] = [];
      if (compares.length) {
        texts.forEach((a, i) => {
          compares.forEach((b, j) => {
            similarities.push({
              a: truncate(a, 100),
              b: truncate(b, 100),
              cosine: Number(cosineI8(decode(quantized[i]), decode(quantized[compareOffset + j])).toFixed(4)),
            });
          });
        });
      }

      const out: Json = {
        model,
        dims: vectors[0]?.length ?? 0,
        count: texts.length,
        inputs: texts.map((t, i) => ({
          index: i,
          chars: t.length,
          estimated_tokens: estimateTokens(t),
          norm: Number(Math.sqrt(vectors[i].reduce((n, x) => n + x * x, 0)).toFixed(4)),
          ...(args.include_text ? { text: truncate(t, 160) } : {}),
        })),
        ...(similarities.length ? { similarities } : {}),
        ...(args.format === "int8" ? { vectors: quantized } : {}),
        ...(args.format === "floats" ? { vectors: vectors.map((v) => Array.from(v, (x) => Number(x.toFixed(5)))) } : {}),
      };
      return out;
    },
  },
];

import { dequantize } from "./vec.ts";
const decode = (b64: string): Int8Array => dequantize(b64);
