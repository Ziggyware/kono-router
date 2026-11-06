// Static diagnostics for workspace projects, mirroring what the browser
// preview will do with the same files: Sucrase parses JS/TS/JSX exactly as the
// preview transpiles it, relative imports resolve with the preview's extension
// rules, and only JS/TS modules are importable (everything else must be linked
// from HTML or fetched). A clean report therefore means the preview will at
// least load; runtime behaviour is covered by the live report (app_debug).

export interface Diagnostic {
  path: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  source: "syntax" | "import" | "export" | "html" | "json" | "css" | "runtime" | "semantic";
  message: string;
}

export const JS_RE = /\.(m?js|jsx|tsx?|mts|cjs)$/i;
export const RUN_RE = /\.(html?|m?js|jsx|tsx?|mts)$/i;
const EXTS = [".js", ".ts", ".tsx", ".jsx", ".mjs"];
const INDEX = ["js", "ts", "tsx", "jsx"];
const NODE_ONLY = new Set(["fs", "path", "os", "child_process", "net", "http", "https", "worker_threads", "cluster", "dgram", "tls", "readline", "zlib", "vm"]);

type Transform = "typescript" | "jsx" | "flow" | "imports" | "react-hot-loader" | "jest";
type Sucrase = { transform: (code: string, opts: { transforms: Transform[]; filePath?: string; production?: boolean }) => { code: string } };
let sucrase: Promise<Sucrase> | null = null;
const loadSucrase = (): Promise<Sucrase> => (sucrase ??= import("sucrase") as Promise<Sucrase>);

const transformsFor = (path: string): Transform[] => {
  const p = path.toLowerCase();
  const t: Transform[] = [];
  if (/\.(tsx?|mts)$/.test(p)) t.push("typescript");
  if (/\.(tsx|jsx)$/.test(p)) t.push("jsx");
  return t;
};

/** Offset → 1-based line/col. */
export function position(text: string, offset: number): { line: number; col: number } {
  let line = 1, last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) { line++; last = i; }
  return { line, col: offset - last };
}

/** Parse one JS/TS source the way the preview transpiles it. `kind` overrides
 *  the extension (inline HTML scripts). */
export async function syntaxCheck(path: string, code: string, kind?: string, lineOffset = 0): Promise<Diagnostic[]> {
  const { transform } = await loadSucrase();
  try {
    transform(code, { transforms: transformsFor(kind ?? path), filePath: path, production: true });
    return [];
  } catch (e) {
    const err = e as Error & { loc?: { line: number; column: number } };
    const msg = String(err.message ?? err).replace(/^Error transforming [^:]*:\s*/, "").replace(/\s*\(\d+:\d+\)\s*$/, "");
    const line = (err.loc?.line ?? 1) + lineOffset;
    const col = (err.loc?.column ?? 0) + 1;
    return [{ path, line, col, severity: "error", source: "syntax", message: msg }];
  }
}

export function jsonCheck(path: string, text: string): Diagnostic[] {
  if (!text.trim()) return [{ path, line: 1, col: 1, severity: "error", source: "json", message: "empty JSON document" }];
  try { JSON.parse(text); return []; } catch (e) {
    const msg = String((e as Error).message);
    const at = msg.match(/position (\d+)/);
    const lc = msg.match(/line (\d+) column (\d+)/);
    const pos = lc ? { line: Number(lc[1]), col: Number(lc[2]) } : at ? position(text, Number(at[1])) : { line: 1, col: 1 };
    return [{ path, ...pos, severity: "error", source: "json", message: msg.replace(/\s*(in JSON )?at position \d+.*$/, "").replace(/\s*\(line \d+ column \d+\)/, "") }];
  }
}

/** Brace balance outside strings and comments — the CSS error that silently
 *  drops every rule after it. */
export function cssCheck(path: string, text: string, lineOffset = 0): Diagnostic[] {
  const stack: number[] = [];
  const out: Diagnostic[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); if (end < 0) { const p = position(text, i); out.push({ path, line: p.line + lineOffset, col: p.col, severity: "error", source: "css", message: "unterminated comment" }); break; } i = end + 1; continue; }
    if (ch === '"' || ch === "'") { let j = i + 1; while (j < text.length && text[j] !== ch && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1; i = j; continue; }
    if (ch === "{") stack.push(i);
    else if (ch === "}") {
      if (!stack.length) { const p = position(text, i); out.push({ path, line: p.line + lineOffset, col: p.col, severity: "error", source: "css", message: "unexpected } (no open block)" }); }
      else stack.pop();
    }
  }
  for (const at of stack.slice(0, 3)) { const p = position(text, at); out.push({ path, line: p.line + lineOffset, col: p.col, severity: "error", source: "css", message: "block opened here is never closed" }); }
  return out;
}

/** Blank out comments (keeping offsets and newlines) so regex scans of imports
 *  and exports never see commented-out code. */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i], n = code[i + 1];
    if (c === "/" && n === "/") { while (i < code.length && code[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") { const end = code.indexOf("*/", i + 2); const stop = end < 0 ? code.length : end + 2; for (; i < stop; i++) out += code[i] === "\n" ? "\n" : " "; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && !(c !== "`" && code[j] === "\n")) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c; i++;
  }
  return out;
}

export interface ModuleShape { names: Set<string>; hasDefault: boolean; stars: string[]; opaque: boolean }

/** Exported names of a module, by declaration form. `opaque` means the export
 *  set cannot be known statically (CommonJS, destructured exports). */
export function exportsOf(code: string): ModuleShape {
  const src = stripComments(code);
  const names = new Set<string>();
  let hasDefault = false, opaque = false;
  const stars: string[] = [];
  for (const m of src.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bexport\s+(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var|enum|const\s+enum)\s+([\w$]+|[{[])/g)) {
    if (m[1] === "{" || m[1] === "[") opaque = true; else names.add(m[1]);
  }
  // Further declarators: export const a = 1, b = 2 — only at the top level of the statement.
  for (const m of src.matchAll(/\bexport\s+(?:const|let|var)\s+[^;\n]*?,\s*([\w$]+)\s*=/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bexport\s+(?:declare\s+)?(?:type|interface|namespace|module)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bexport\s+default\b/g)) { hasDefault = true; void m; }
  for (const m of src.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      const name = (as[1] ?? as[0]).trim().replace(/^["']|["']$/g, "");
      if (name === "default") hasDefault = true; else names.add(name);
    }
  }
  for (const m of src.matchAll(/\bexport\s*\*\s*as\s+([\w$]+)\s*from/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bexport\s*\*\s*from\s*(["'])([^"'\n]+)\1/g)) stars.push(m[2]);
  if (/\bmodule\.exports\b|\bexports\.[\w$]+\s*=/.test(src)) opaque = true;
  return { names, hasDefault, stars, opaque };
}

export interface ImportRef {
  spec: string;
  offset: number;
  /** null: side-effect or dynamic import. */
  names: string[] | null;
  default: boolean;
  namespace: boolean;
  reexport: boolean;
}

export function importsOf(code: string): ImportRef[] {
  const src = stripComments(code);
  const out: ImportRef[] = [];
  const seen = new Set<number>();
  const clause = (body: string): Pick<ImportRef, "names" | "default" | "namespace"> => {
    const names: string[] = [];
    let def = false, ns = false;
    const braces = body.match(/\{([^}]*)\}/);
    if (braces) for (const part of braces[1].split(",")) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      const name = p.split(/\s+as\s+/)[0].trim().replace(/^["']|["']$/g, "");
      if (name === "default") def = true; else names.push(name);
    }
    const rest = body.replace(/\{[^}]*\}/, "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const r of rest) { if (/^\*\s*as\s+/.test(r)) ns = true; else if (/^[\w$]+$/.test(r)) def = true; }
    return { names, default: def, namespace: ns };
  };
  for (const m of src.matchAll(/\bimport\s+(type\s+)?([\w$*{}\s,]+?)\s*from\s*(["'])([^"'\n]+)\3/g)) {
    const off = m.index! + m[0].lastIndexOf(m[3] + m[4]);
    seen.add(off);
    if (m[1]) continue; // `import type` is erased
    out.push({ spec: m[4], offset: off, ...clause(m[2]), reexport: false });
  }
  for (const m of src.matchAll(/\bexport\s+(type\s+)?(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\3/g)) {
    const off = m.index! + m[0].lastIndexOf(m[3] + m[4]);
    seen.add(off);
    if (m[1]) continue;
    const star = m[2].startsWith("*");
    out.push({ spec: m[4], offset: off, ...(star ? { names: null, default: false, namespace: true } : clause(m[2])), reexport: true });
  }
  for (const m of src.matchAll(/\bimport\s*(?:\(\s*)?(["'])([^"'\n]+)\1/g)) {
    const off = m.index! + m[0].lastIndexOf(m[1] + m[2]);
    if (seen.has(off)) continue;
    out.push({ spec: m[2], offset: off, names: null, default: false, namespace: false, reexport: false });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

const isUrl = (s: string) => /^[a-z][\w+.-]*:|^\/\//i.test(s);

/** Resolve a relative/absolute spec against `from`, as the preview does. */
export function resolvePath(spec: string, from: string): string | null {
  if (!spec || isUrl(spec) || spec.startsWith("#")) return null;
  try { return decodeURIComponent(new URL(spec.split(/[?#]/)[0], "https://ws.local/" + from.slice(0, from.lastIndexOf("/") + 1)).pathname.slice(1)); } catch { return null; }
}
export function findFile(p: string | null, has: (p: string) => boolean): string | null {
  if (p == null) return null;
  const base = p.replace(/\/$/, "");
  for (const c of [p, ...EXTS.map((x) => base + x), ...INDEX.map((x) => `${base}/index.${x}`)]) if (c && has(c)) return c;
  return null;
}

/** Entry point, chosen exactly as the preview chooses it. */
export function detectEntry(paths: string[], preferred?: string): string {
  const run = paths.filter((p) => RUN_RE.test(p));
  if (preferred && run.includes(preferred)) return preferred;
  const by = (re: RegExp) => run.filter((p) => re.test(p)).sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
  return by(/(^|\/)index\.html?$/i) ?? by(/\.html?$/i) ?? by(/(^|\/)(main|index|app)\.(m?js|jsx|tsx?)$/i) ?? "";
}

function nearest(path: string, pool: string[]): string | null {
  const base = path.split("/").pop()!.replace(/\.\w+$/, "").toLowerCase();
  let best: string | null = null, score = 0;
  for (const p of pool) {
    const b = p.split("/").pop()!.replace(/\.\w+$/, "").toLowerCase();
    const s = b === base ? 1 : b.includes(base) || base.includes(b) ? 0.6 : 0;
    if (s > score || (s === score && s > 0 && best && p.length < best.length)) { best = p; score = s; }
  }
  return score > 0 ? best : null;
}

interface HtmlRef { attr: string; value: string; offset: number; tag: string; attrs: string }
function htmlRefs(html: string): HtmlRef[] {
  const out: HtmlRef[] = [];
  const noComments = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  for (const t of noComments.matchAll(/<(script|link|img|source|video|audio|track|embed|iframe|a)\b([^>]*)>/gi)) {
    for (const a of t[2].matchAll(/\b(src|href|poster)\s*=\s*(["'])([^"']*)\2/gi)) {
      out.push({ attrs: t[2], tag: t[1].toLowerCase(), attr: a[1].toLowerCase(), value: a[3], offset: t.index! + 1 + t[1].length + a.index! });
    }
  }
  return out;
}

export interface CheckResult {
  entry: string;
  files_checked: number;
  diagnostics: Diagnostic[];
  packages: string[];
  /** Present when the semantic pass was requested. */
  semantic?: { ms: number; skipped?: string };
}

/** Check a whole project. `files` maps path → text (binary files map to null). */
export async function checkProject(files: Map<string, string | null>, opts: { entry?: string; only?: (p: string) => boolean; semantic?: boolean } = {}): Promise<CheckResult> {
  const has = (p: string) => files.has(p);
  const paths = [...files.keys()];
  const diags: Diagnostic[] = [];
  const packages = new Set<string>();
  const shapes = new Map<string, ModuleShape>();
  const shape = (p: string): ModuleShape => {
    let s = shapes.get(p);
    if (!s) { s = exportsOf(files.get(p) ?? ""); shapes.set(p, s); }
    return s;
  };
  // Names reachable through `export *`, depth-limited; null when unknowable.
  const exported = (p: string, seen = new Set<string>()): { names: Set<string>; hasDefault: boolean } | null => {
    if (seen.has(p)) return { names: new Set(), hasDefault: false };
    seen.add(p);
    if (files.get(p) == null) return null; // not loaded (or binary): unknowable here
    const s = shape(p);
    if (s.opaque) return null;
    const names = new Set(s.names);
    for (const star of s.stars) {
      const hit = findFile(resolvePath(star, p), has);
      if (!hit || !JS_RE.test(hit)) return null;
      const sub = exported(hit, seen);
      if (!sub) return null;
      for (const n of sub.names) names.add(n);
    }
    return { names, hasDefault: s.hasDefault };
  };

  const checkImports = (path: string, code: string, base: number, lineOffset: number) => {
    for (const ref of importsOf(code)) {
      const at = position(code, ref.offset);
      const loc = { path, line: at.line + lineOffset, col: at.col + (at.line === 1 ? base : 0) };
      const spec = ref.spec;
      if (/^\.{0,2}\//.test(spec)) {
        const target = findFile(resolvePath(spec, path), has);
        if (!target) {
          const want = resolvePath(spec, path) ?? spec;
          const alt = nearest(want, paths.filter((p) => JS_RE.test(p)));
          diags.push({ ...loc, severity: "error", source: "import", message: `cannot resolve '${spec}' (looked for ${want}${/\.\w+$/.test(want) ? "" : ", with " + EXTS.join(" ") + " and /index.*"})${alt ? `; did you mean '${alt}'?` : ""}` });
          continue;
        }
        if (!JS_RE.test(target)) {
          diags.push({ ...loc, severity: "error", source: "import", message: `'${spec}' is ${target}, which is not a JS/TS module: the preview only imports modules — link stylesheets from HTML and fetch() data files` });
          continue;
        }
        if (ref.names === null && !ref.default) continue;
        const ex = exported(target);
        if (!ex) continue;
        const missing = (ref.names ?? []).filter((n) => !ex.names.has(n));
        const list = [...ex.names].slice(0, 12).join(", ") + (ex.hasDefault ? (ex.names.size ? ", " : "") + "default" : "");
        if (missing.length) diags.push({ ...loc, severity: "error", source: "export", message: `${target} does not export ${missing.map((n) => `'${n}'`).join(", ")}${list ? ` (it exports: ${list})` : " (it has no exports)"}` });
        if (ref.default && !ex.hasDefault) diags.push({ ...loc, severity: "error", source: "export", message: `${target} has no default export${list ? ` (it exports: ${list}) — use import { … }` : ""}` });
      } else if (!isUrl(spec)) {
        const bare = spec.replace(/^node:/, "");
        if (spec.startsWith("node:") || NODE_ONLY.has(bare.split("/")[0])) {
          diags.push({ ...loc, severity: "error", source: "import", message: `'${spec}' is a Node built-in; it does not exist in the browser preview` });
          continue;
        }
        packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    }
  };

  let checked = 0;
  for (const [path, content] of files) {
    if (content === null || (opts.only && !opts.only(path))) continue;
    if (/(^|\/)\.gitkeep$/.test(path)) continue;
    const lower = path.toLowerCase();
    if (JS_RE.test(lower)) {
      checked++;
      diags.push(...await syntaxCheck(path, content));
      checkImports(path, content, 0, 0);
    } else if (lower.endsWith(".json")) {
      checked++;
      diags.push(...jsonCheck(path, content));
    } else if (lower.endsWith(".css")) {
      checked++;
      diags.push(...cssCheck(path, content));
      for (const m of stripComments(content).matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)|url\(\s*["']?([^"')]+?)["']?\s*\)/gi)) {
        const ref = m[1] ?? m[2];
        if (!ref || isUrl(ref) || ref.startsWith("#")) continue;
        if (!findFile(resolvePath(ref, path), has)) { const p = position(content, m.index!); diags.push({ path, ...p, severity: "warning", source: "css", message: `'${ref}' does not exist in the workspace` }); }
      }
    } else if (/\.html?$/.test(lower)) {
      checked++;
      for (const r of htmlRefs(content)) {
        const v = r.value.trim();
        if (!v || isUrl(v) || v.startsWith("#") || /^(mailto|tel|javascript|data|blob):/i.test(v) || /\{\{|\$\{/.test(v)) continue;
        if ((r.tag === "a" || r.tag === "iframe") && !/\.html?$/i.test(v.split(/[?#]/)[0])) continue;
        if (findFile(resolvePath(v, path), has)) continue;
        const p = position(content, r.offset);
        const sev = r.tag === "script" || r.tag === "img" || (r.tag === "link" && /stylesheet/i.test(r.attrs)) ? "error" : "warning";
        const alt = nearest(resolvePath(v, path) ?? v, paths);
        diags.push({ path, ...p, severity: sev, source: "html", message: `<${r.tag} ${r.attr}="${v}"> points at a file that does not exist${alt ? `; did you mean '${alt}'?` : ""}` });
      }
      for (const s of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = s[1];
        if (/\bsrc\s*=/.test(attrs)) continue;
        const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "").toLowerCase();
        const bodyAt = s.index! + s[0].indexOf(">") + 1;
        const start = position(content, bodyAt);
        const body = s[2];
        if (type === "importmap" || type === "application/json" || type.endsWith("+json")) {
          for (const d of jsonCheck(path, body)) diags.push({ ...d, line: d.line + start.line - 1 });
          continue;
        }
        const kind = /tsx/.test(type) ? "x.tsx" : /typescript/.test(type) ? "x.ts" : /jsx|babel/.test(type) ? "x.jsx" : !type || /module|javascript|ecmascript/.test(type) ? "x.js" : null;
        if (!kind || !body.trim()) continue;
        diags.push(...await syntaxCheck(path, body, kind, start.line - 1));
        if (type === "module") checkImports(path, body, 0, start.line - 1);
      }
      for (const s of content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
        const start = position(content, s.index! + s[0].indexOf(">") + 1);
        diags.push(...cssCheck(path, s[1], start.line - 1));
      }
    }
  }
  let semantic: CheckResult["semantic"];
  if (opts.semantic) {
    // Files that do not parse are reported above; the type checker would only echo them.
    const broken = new Set(diags.filter((d) => d.source === "syntax").map((d) => d.path));
    const { semanticCheck } = await import("./semantic.ts");
    const r = await semanticCheck(files, { skip: broken });
    semantic = { ms: r.ms, ...(r.skipped ? { skipped: r.skipped } : {}) };
    diags.push(...r.diagnostics.filter((d) => !opts.only || opts.only(d.path)));
  }
  diags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.path.localeCompare(b.path) || a.line - b.line);
  return { entry: detectEntry(paths, opts.entry), files_checked: checked, diagnostics: diags, packages: [...packages].sort(), ...(semantic ? { semantic } : {}) };
}

/** Lines around `line`, numbered, for error reports. */
export function excerpt(text: string, line: number, radius = 2): string {
  const lines = text.split("\n");
  const from = Math.max(1, line - radius), to = Math.min(lines.length, line + radius);
  const w = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${n === line ? ">" : " "}${String(n).padStart(w)}| ${lines[n - 1].length > 200 ? lines[n - 1].slice(0, 199) + "…" : lines[n - 1]}`);
  return out.join("\n");
}
