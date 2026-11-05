// Result references inside plan arguments: "$id.path" substitutes the typed
// value, "${id.path}" interpolates text. Shared by parsing, execution and MBR.
import { canonical, getPath, isObj } from "../toolbox/util.ts";
import type { Json } from "../toolbox/types.ts";

const ID = "[A-Za-z_][\\w-]{0,31}";
const PATH = "((?:\\.[\\w-]+|\\[\\d+\\])*)";
export const WHOLE = new RegExp(`^\\$(${ID})${PATH}$`);
export const INLINE = new RegExp(`\\$\\{(${ID})${PATH}\\}`, "g");
export const ID_RE = new RegExp(`^${ID}$`);

export function walkRefs(v: unknown, visit: (id: string, path: string) => void): void {
  if (typeof v === "string") {
    const w = WHOLE.exec(v);
    if (w) return visit(w[1], w[2]);
    for (const m of v.matchAll(INLINE)) visit(m[1], m[2]);
  } else if (Array.isArray(v)) v.forEach((x) => walkRefs(x, visit));
  else if (isObj(v)) Object.values(v).forEach((x) => walkRefs(x, visit));
}

function lookup(results: ReadonlyMap<string, unknown>, id: string, path: string): unknown {
  const root = results.get(id);
  let p = path.replace(/^\./, "");
  // Planners often address the wrapper they imagine ("$n1.result.x"); strip it when the value has no such key.
  if (/^result\b/.test(p) && !(isObj(root) && "result" in root)) p = p.replace(/^result\.?/, "");
  return p ? getPath(root, p) : root;
}

/** Replaces refs with upstream values. A whole-string ref keeps the value's type. */
export function substitute(args: Json, results: ReadonlyMap<string, unknown>): { ok: true; value: Json } | { ok: false; error: string } {
  let missing = "";
  const map = (v: unknown): unknown => {
    if (typeof v === "string") {
      const w = WHOLE.exec(v);
      if (w && results.has(w[1])) {
        const got = lookup(results, w[1], w[2]);
        if (got === undefined) missing ||= v;
        return got;
      }
      return v.replace(INLINE, (m, id: string, path: string) => {
        if (!results.has(id)) return m;
        const got = lookup(results, id, path);
        if (got === undefined) missing ||= m;
        return typeof got === "string" ? got : JSON.stringify(got);
      });
    }
    if (Array.isArray(v)) return v.map(map);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]));
    return v;
  };
  const value = map(args) as Json;
  return missing ? { ok: false, error: `${missing} resolved to nothing` } : { ok: true, value };
}

/** Id-free call signature: refs become the producing tool, so two samples with different ids compare equal. */
export function signature(node: { tool: string; args: Json }, toolOf: (id: string) => string | undefined): string {
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") {
      const w = WHOLE.exec(v);
      if (w && toolOf(w[1])) return `$${toolOf(w[1])}${w[2]}`;
      return v.replace(INLINE, (m, id: string, path: string) => toolOf(id) ? `\${${toolOf(id)}${path}}` : m);
    }
    if (Array.isArray(v)) return v.map(rewrite);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };
  return `${node.tool}:${canonical(rewrite(node.args))}`;
}
