// Tool retrieval: Okapi BM25 (Robertson & Zaragoza 2009) over each tool's
// name, aliases, description and parameter text, so the planner sees the
// k relevant signatures instead of the whole registry.
import { listTools, resolveTool } from "../tools.ts";
import { isObj, tokenize, truncate } from "../toolbox/util.ts";
import type { Json, ToolSpec } from "../toolbox/types.ts";

const K1 = 1.2;
const B = 0.75;

function docText(t: ToolSpec): string {
  const props = isObj(t.parameters.properties) ? t.parameters.properties : {};
  const params = Object.entries(props).map(([k, p]) => `${k} ${isObj(p) && typeof p.description === "string" ? p.description : ""}`);
  return [t.name.replace(/_/g, " "), ...(t.aliases ?? []).map((a) => a.replace(/_/g, " ")), t.kind, t.description, ...params].join(" ");
}

export function bm25Rank(query: string, tools: readonly ToolSpec[]): Array<{ name: string; score: number }> {
  const docs = tools.map((t) => tokenize(docText(t)));
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(tokenize(query))];
  const N = docs.length;
  return tools
    .map((t, i) => {
      const tf = new Map<string, number>();
      for (const w of docs[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
      let score = 0;
      for (const w of q) {
        const f = tf.get(w);
        if (!f) continue;
        const n = df.get(w)!;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * docs[i].length / avg));
      }
      return { name: t.name, score: Number(score.toFixed(4)) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Explicit names always win; else BM25 top-k with positive score; else the fallback set. */
export function retrieveTools(query: string, o: { k: number; admin: boolean; explicit?: string[]; fallback: string[] }): ToolSpec[] {
  const pool = listTools().filter((t) => o.admin || !t.admin);
  const pick = new Map<string, ToolSpec>();
  for (const name of o.explicit ?? []) {
    const t = resolveTool(name).tool;
    if (t && (o.admin || !t.admin)) pick.set(t.name, t);
  }
  if (pick.size === 0) {
    for (const r of bm25Rank(query, pool)) {
      if (pick.size >= o.k || r.score <= 0) break;
      pick.set(r.name, pool.find((t) => t.name === r.name)!);
    }
  }
  if (pick.size === 0) {
    for (const name of o.fallback.slice(0, o.k)) {
      const t = resolveTool(name).tool;
      if (t && (o.admin || !t.admin)) pick.set(t.name, t);
    }
  }
  return [...pick.values()];
}

function typeOf(p: unknown): string {
  if (!isObj(p)) return "any";
  if (Array.isArray(p.enum)) return p.enum.slice(0, 8).map((e) => JSON.stringify(e)).join("|");
  if (p.type === "array") return `${typeOf(p.items)}[]`;
  return Array.isArray(p.type) ? p.type.join("|") : typeof p.type === "string" ? p.type : "any";
}

/** Compact TypeScript-like signature: a fraction of the tokens of raw JSON Schema. */
export function signatureLine(t: ToolSpec): string {
  const schema = t.parameters as Json;
  const props = isObj(schema.properties) ? schema.properties : {};
  const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  const args = Object.entries(props).map(([k, p]) => `${k}${req.has(k) ? "" : "?"}: ${typeOf(p)}`).join(", ");
  return `${t.name}(${args}) — ${truncate(t.description.replace(/\s+/g, " "), 200)}`;
}
