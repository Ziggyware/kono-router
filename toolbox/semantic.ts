// Semantic diagnostics: the TypeScript checker run over the project's JS/TS
// (checkJs) with the DOM and ES2022 libraries, filtered to the codes that are
// bugs in any program — the ones a syntax check and a single preview run miss:
// assigning a const, misspelled names and properties ("did you mean…"),
// undeclared identifiers, redeclarations, use before declaration, calling a
// non-function, wrong argument counts to platform APIs. TypeScript files also
// get their type errors, as warnings (the preview strips types, so they do not
// stop the app). Libraries load once per isolate from the CDN that serves the
// exact compiler version; if they cannot be fetched the check is skipped and
// says so — it never blocks.

import type { Diagnostic } from "./check.ts";

type TS = typeof import("typescript");
const TS_VERSION = "5.9.3";
const ROOT_LIBS = ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"];

/** Bugs whatever the language: [code, why it is reported]. */
const BUG_CODES = new Set([
  2588, // Cannot assign to 'x' because it is a constant.
  2552, // Cannot find name 'x'. Did you mean 'y'?
  2551, // Property 'x' does not exist on type 'T'. Did you mean 'y'?
  2304, // Cannot find name 'x'.
  2451, // Cannot redeclare block-scoped variable 'x'.
  2448, // Block-scoped variable 'x' used before its declaration.
  2349, // This expression is not callable.
  2554, // Expected n arguments, but got m.
  2555, // Expected at least n arguments, but got m.
  2365, // Operator cannot be applied to types.
  2367, // This comparison appears to be unintentional (no overlap).
  2801, // This condition will always return true since this 'Promise' is always defined.
]);
/** Type errors: real in .ts/.tsx, noise in plain JS (where DOM lookups are untyped). */
const TYPE_CODES = new Set([2322, 2339, 2345, 2353, 2741, 2739, 2740, 2769, 18047, 18048, 2531, 2532]);

let tsP: Promise<TS> | null = null;
const libText = new Map<string, string>();
let libsP: Promise<boolean> | null = null;
const libFiles = new Map<string, unknown>(); // parsed lib SourceFiles, reused across checks

async function fetchLib(name: string): Promise<void> {
  if (libText.has(name)) return;
  libText.set(name, "");
  const r = await fetch(`https://cdn.jsdelivr.net/npm/typescript@${TS_VERSION}/lib/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const t = await r.text();
  libText.set(name, t);
  await Promise.all([...t.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"/g)].map((m) => fetchLib(`lib.${m[1].toLowerCase()}.d.ts`)));
}
function loadLibs(): Promise<boolean> {
  libsP ??= Promise.all(ROOT_LIBS.map(fetchLib)).then(() => true, () => {
    libsP = null; // retry on a later check
    libText.clear();
    return false;
  });
  return libsP;
}

export interface SemanticResult { diagnostics: Diagnostic[]; skipped?: string; ms: number }

/** Virtual sources: workspace JS/TS files plus HTML inline scripts (mapped
 *  back to page lines). Files whose syntax already failed are left out. */
export async function semanticCheck(files: Map<string, string | null>, opts: { skip?: Set<string> } = {}): Promise<SemanticResult> {
  const t0 = performance.now();
  const sources = new Map<string, { text: string; path: string; offset: number; ts: boolean }>();
  let externalScripts = false;
  for (const [path, content] of files) {
    if (content == null || opts.skip?.has(path) || /(^|\/)node_modules\//.test(path)) continue;
    if (/\.(m?js|jsx|tsx?|mts|cjs)$/i.test(path)) sources.set("/w/" + path, { text: content, path, offset: 0, ts: /\.(tsx?|mts)$/i.test(path) });
    else if (/\.html?$/i.test(path)) {
      if (/<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i.test(content)) externalScripts = true;
      let n = 0;
      for (const m of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = m[1];
        const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "").toLowerCase();
        if (/\bsrc\s*=/.test(attrs) || !m[2].trim() || (type && type !== "module" && !/javascript|ecmascript/.test(type))) continue;
        const bodyAt = m.index! + m[0].indexOf(">") + 1;
        const offset = content.slice(0, bodyAt).split("\n").length - 1;
        sources.set(`/w/${path}.inline-${++n}.js`, { text: m[2], path, offset, ts: false });
      }
    }
  }
  if (!sources.size) return { diagnostics: [], ms: 0 };
  if (!(await loadLibs())) return { diagnostics: [], skipped: "type libraries unavailable", ms: Math.round(performance.now() - t0) };
  const ts = await (tsP ??= import("typescript").then((m) => (m.default ?? m) as TS));
  const AMBIENT = "/w/__ambient__.d.ts";
  // Bare imports resolve to `any`: no package types are installed, and their absence is not a bug.
  // The app_test unit-test API is global in *.test.* files.
  const ambient = [
    'declare module "*";',
    "declare function test(name: string, fn: () => unknown): void;",
    "declare function it(name: string, fn: () => unknown): void;",
    "declare function describe(name: string, fn: () => void): void;",
    "declare function expect(value: any): any;",
    "declare function assert(condition: any, message?: string): asserts condition;",
  ].join("\n") + "\n";
  const opt: import("typescript").CompilerOptions = {
    allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, strict: false, noImplicitAny: false,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, jsx: ts.JsxEmit.Preserve, lib: ROOT_LIBS, types: [],
  };
  const host: import("typescript").CompilerHost = {
    getSourceFile: (f, lv) => {
      if (f.startsWith("/lib/")) {
        const name = f.slice(5);
        let sf = libFiles.get(name) as import("typescript").SourceFile | undefined;
        if (!sf && libText.get(name)) { sf = ts.createSourceFile(f, libText.get(name)!, lv); libFiles.set(name, sf); }
        return sf;
      }
      if (f === AMBIENT) return ts.createSourceFile(f, ambient, lv);
      const s = sources.get(f);
      return s ? ts.createSourceFile(f, s.text, lv, true) : undefined;
    },
    getDefaultLibFileName: () => "/lib/lib.d.ts",
    getDefaultLibLocation: () => "/lib",
    writeFile: () => {},
    getCurrentDirectory: () => "/w",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => sources.has(f) || f === AMBIENT || (f.startsWith("/lib/") && Boolean(libText.get(f.slice(5)))),
    readFile: (f) => sources.get(f)?.text ?? (f === AMBIENT ? ambient : f.startsWith("/lib/") ? libText.get(f.slice(5)) : undefined),
  };
  const program = ts.createProgram([...sources.keys(), AMBIENT], opt, host);
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const d of program.getSemanticDiagnostics()) {
    const src = d.file && sources.get(d.file.fileName);
    if (!src || d.start === undefined) continue;
    const bug = BUG_CODES.has(d.code), typed = src.ts && TYPE_CODES.has(d.code);
    if (!bug && !typed) continue;
    const pos = d.file!.getLineAndCharacterOfPosition(d.start);
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    const line = pos.line + 1 + src.offset;
    const key = `${src.path}:${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // An undeclared name may be a global from an external <script src>: say so, don't fail on it.
    const soft = typed && !bug || (d.code === 2304 && externalScripts);
    out.push({ path: src.path, line, col: pos.character + 1, severity: soft ? "warning" : "error", source: "semantic", message: `${message} (TS${d.code})${d.code === 2304 && externalScripts ? " — if a <script src> library defines it, ignore" : ""}` });
  }
  return { diagnostics: out, ms: Math.round(performance.now() - t0) };
}
