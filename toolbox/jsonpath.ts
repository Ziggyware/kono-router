// JSONPath-lite: `$`, `.key`, `["key"]`, `[i]`, `[a:b:step]`, `[*]`, `..key`,
// `..*` and `[?(@.field > 3)]`. Compiled paths are cached; every walk is capped
// so a hostile document cannot hang an isolate.

import { isObj } from "./util.ts";

interface Step {
  t: "child" | "index" | "slice" | "wildcard" | "descend" | "filter";
  key?: string;
  i?: number;
  from?: number;
  to?: number;
  step?: number;
  field?: string;
  op?: string;
  value?: string;
}

const CACHE = new Map<string, Step[]>();
const MAX_DEPTH = 24;
const MAX_MATCHES = 5000;

export function compile(path: string): Step[] {
  const hit = CACHE.get(path);
  if (hit) return hit;
  const steps: Step[] = [];
  const src = path.trim();
  let i = src.startsWith("$") ? 1 : 0;

  const readQuoted = (): string => {
    const quote = src[i++];
    let out = "";
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\" && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
      out += src[i++];
    }
    i++;
    return out;
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === ".") {
      if (src[i + 1] === ".") {
        i += 2;
        if (src[i] === "*") { i++; steps.push({ t: "descend" }); continue; }
        if (src[i] === "[") { steps.push({ t: "descend" }); continue; }
        let key = "";
        while (i < src.length && /[\w$-]/.test(src[i])) key += src[i++];
        steps.push({ t: "descend", key: key || undefined });
        continue;
      }
      i++;
      if (src[i] === "*") { i++; steps.push({ t: "wildcard" }); continue; }
      let key = "";
      while (i < src.length && /[\w$-]/.test(src[i])) key += src[i++];
      if (!key) throw new Error(`empty child key at ${i}`);
      steps.push({ t: "child", key });
      continue;
    }
    if (ch === "[") {
      i++;
      if (src[i] === "*") {
        i++;
        if (src[i] !== "]") throw new Error("expected ] after *");
        i++;
        steps.push({ t: "wildcard" });
        continue;
      }
      if (src[i] === "?") {
        i++;
        if (src[i] !== "(") throw new Error("expected ( after ?");
        i++;
        const close = src.indexOf(")", i);
        if (close < 0) throw new Error("unterminated filter");
        const expr = src.slice(i, close).trim();
        i = close + 1;
        if (src[i] === "]") i++;
        const m = expr.match(/^@\.?([\w$-]+)\s*(==|!=|>=|<=|~=|!~|>|<)\s*(.+)$/);
        if (!m) throw new Error(`unsupported filter "${expr.slice(0, 40)}"`);
        steps.push({ t: "filter", field: m[1], op: m[2], value: m[3].trim().replace(/^["']|["']$/g, "") });
        continue;
      }
      if (src[i] === "'" || src[i] === '"') {
        steps.push({ t: "child", key: readQuoted() });
        if (src[i] === "]") i++;
        continue;
      }
      let spec = "";
      while (i < src.length && src[i] !== "]") spec += src[i++];
      if (src[i] === "]") i++;
      spec = spec.trim();
      if (spec.includes(":")) {
        const [from, to, step] = spec.split(":");
        steps.push({
          t: "slice",
          from: from.trim() === "" ? undefined : Number(from),
          to: to.trim() === "" ? undefined : Number(to),
          step: step?.trim() ? Number(step) : undefined,
        });
        continue;
      }
      const index = Number(spec);
      if (!Number.isFinite(index)) throw new Error(`bad index "${spec.slice(0, 20)}"`);
      steps.push({ t: "index", i: index });
      continue;
    }
    let key = "";
    while (i < src.length && /[\w$-]/.test(src[i])) key += src[i++];
    if (!key) throw new Error(`unexpected character "${src[i]}" at ${i}`);
    steps.push({ t: "child", key });
  }
  if (CACHE.size > 1024) CACHE.clear();
  CACHE.set(path, steps);
  return steps;
}

function descend(node: unknown, key: string | undefined, out: unknown[], depth: number): void {
  if (depth > MAX_DEPTH || out.length > MAX_MATCHES) return;
  if (Array.isArray(node)) {
    if (key === undefined) out.push(node);
    for (const item of node) descend(item, key, out, depth + 1);
    return;
  }
  if (isObj(node)) {
    if (key === undefined) out.push(node);
    else if (node[key] !== undefined) out.push(node[key]);
    for (const v of Object.values(node)) descend(v, key, out, depth + 1);
  }
}

function apply(step: Step, nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  switch (step.t) {
    case "child":
      for (const node of nodes) if (isObj(node) && node[step.key!] !== undefined) out.push(node[step.key!]);
      break;
    case "index":
      for (const node of nodes) {
        if (!Array.isArray(node)) continue;
        const idx = step.i! < 0 ? node.length + step.i! : step.i!;
        if (idx >= 0 && idx < node.length) out.push(node[idx]);
      }
      break;
    case "slice":
      for (const node of nodes) {
        if (!Array.isArray(node)) continue;
        const sliced = node.slice(step.from, step.to);
        if (step.step && step.step !== 1) out.push(...sliced.filter((_, i) => i % step.step! === 0));
        else out.push(...sliced);
      }
      break;
    case "wildcard":
      for (const node of nodes) {
        if (Array.isArray(node)) out.push(...node);
        else if (isObj(node)) out.push(...Object.values(node));
      }
      break;
    case "descend":
      for (const node of nodes) descend(node, step.key, out, 0);
      break;
    case "filter": {
      const want = step.value!;
      const compare = (a: unknown): boolean => {
        const numA = typeof a === "number" ? a : Number(a);
        const numB = Number(want);
        const numeric = Number.isFinite(numA) && Number.isFinite(numB) && want.trim() !== "";
        switch (step.op) {
          case "==": return numeric ? numA === numB : String(a) === want;
          case "!=": return numeric ? numA !== numB : String(a) !== want;
          case ">": return numeric && numA > numB;
          case ">=": return numeric && numA >= numB;
          case "<": return numeric && numA < numB;
          case "<=": return numeric && numA <= numB;
          case "~=": return new RegExp(want, "i").test(String(a ?? ""));
          case "!~": return !new RegExp(want, "i").test(String(a ?? ""));
          default: return false;
        }
      };
      for (const node of nodes) {
        if (Array.isArray(node)) for (const item of node) if (isObj(item) && compare(item[step.field!])) out.push(item);
        else if (isObj(node) && compare(node[step.field!])) out.push(node);
      }
      break;
    }
  }
  return out;
}

/** Every match, in document order. A bare path (`items[0]`) works too. */
export function query(data: unknown, path: string): unknown[] {
  let nodes: unknown[] = [data];
  for (const step of compile(path)) {
    nodes = apply(step, nodes);
    if (nodes.length === 0 || nodes.length > MAX_MATCHES) break;
  }
  return nodes.slice(0, MAX_MATCHES);
}
