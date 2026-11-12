# Reusable code research — router math, frameworks & source-code analysis

Research for pulling reusable, well-maintained code into kono-router instead of
hand-rolling it. All packages verified against the public registries on
2026-11-06 (registry.npmjs.org / pypi.org / github.com).

## 1. Mathematics (improve the router's lane scoring / hedging)

The router already implements its own Bayesian lane scoring, decorrelated
jitter, Kalman smoothing, Wilson lower bounds and Gumbel noise in `math.ts`.
Reusable libraries that could deepen or replace pieces of it:

| Package | Version | Why it fits |
| --- | --- | --- |
| `mathjs` | 15.2.0 | Extensive math lib with an expression parser — matrices, statistics, distributions; useful for richer posterior/hedging math. https://www.npmjs.com/package/mathjs |
| `ml-matrix` | 6.15.1 | Fast matrix algebra (SVD, eigenvalues) — for covariance-aware provider scoring. https://www.npmjs.com/package/ml-matrix |
| `simple-statistics` | 8.0.0 | Production-grade stats (mean, stdev, quantiles, z-scores, linear regression) — drop-in for Wilson/Beta helpers. https://www.npmjs.com/package/simple-statistics |
| `jstat` | 1.9.6 | Full statistical distributions (beta, normal, t…) — models provider success rates exactly. https://www.npmjs.com/package/jstat |
| `numeric` | 1.2.6 | Classic numerical analysis (linear solve, interpolation) — small, no deps. https://www.npmjs.com/package/numeric |

Recommendation: keep the hand-rolled `math.ts` for the hot path (zero-dep,
Deno-native), adopt `jstat`/`simple-statistics` if richer distribution math is
needed, and `ml-matrix` only if provider covariance is modeled.

## 2. Frameworks

- `hono` 4.13.x is already the HTTP framework (already in `deno.json`) — keep.
- For in-browser transpile/bundling of workspace apps, `esbuild-wasm` 0.28.2
  (https://www.npmjs.com/package/esbuild-wasm) is the reusable bundler behind
  build-type analysis; `sucrase` 3.35.x (already a dependency) stays for
  syntax-level transpile, exactly as the preview does.

## 3. Source-code analysis (per build type, per file type, cross-file)

Already integrated in this repo: the **TypeScript compiler API** (`typescript`
5.9.x, already in `deno.json`) powers `toolbox/semantic.ts` (bug-only diagnostic
codes + type warnings, virtual files for inline HTML scripts) and `sucrase`
powers `toolbox/check.ts` (syntax/import/export checks mirroring the preview).

Reusable projects that can be pulled in to extend each axis:

### JavaScript / TypeScript (per file type + cross-file)
- `ts-morph` 28.0.0 — friendly wrapper over the TS compiler API: rename,
  find references, refactorings across whole projects.
  https://www.npmjs.com/package/ts-morph
- `@typescript-eslint/typescript-estree` 8.72.1 — TS → ESTree AST; the base of
  lint-style rule engines for cross-file semantic rules.
  https://www.npmjs.com/package/@typescript-eslint/typescript-estree
- `eslint` 10.x — AST-based pattern checker; pluggable rules per file type.
- `biomejs` (Biome 2.x) — single-tool lint/format/AST, very fast, good for
  build-time gates in CI-like checks.

### Multi-language parsing (every file type)
- `tree-sitter` 0.25.x + `web-tree-sitter` 0.27.x + `tree-sitter-language-pack`
  1.24.0 (371 pre-compiled grammars) — one incremental parser framework for JS,
  TS, Python, HTML, CSS, JSON, YAML, shell… enables true cross-file-type
  symbol tables, go-to-definition and rename beyond regexes.
  https://www.npmjs.com/package/web-tree-sitter
- `ast-grep` 0.1.x — structural search & rewrite ("grep for ASTs") — ideal for
  automated code fixes/refactors across files.
  https://ast-grep.github.io/
- `lezer` 0.13.x + `@lezer/highlight` 1.2.5 — incremental parser + highlighting
  system used by CodeMirror; a browser-native upgrade path for the editor's
  syntax highlighting.

### Python (per file type)
- `pyright` 1.1.414 / `basedpyright` 1.40.2 (pypi) — static type checking,
  cross-file, for Python workspace files. https://pypi.org/project/basedpyright/
- `jedi` 0.20.1 (pypi) — autocompletion, go-to-definition, rename for Python.
  https://pypi.org/project/jedi/
- `ruff` 0.17.4 (pypi) — Rust-fast linter/formatter for build-time diagnostics.
  https://pypi.org/project/ruff/

### Editor / highlighting in the browser
- `highlight.js` 11.12.0 (already loaded from CDN in `index.html`) and
  `prismjs` 1.30.0 — syntax highlighting; the workspace editor now layers a
  highlighted `<pre>` behind a transparent textarea (this change) using the
  built-in `highlightCode` per file type.
- `codemirror` 6 / `@codemirror/state` 6.7.6 or `monaco-editor` 0.57.0 —
  full editor engines if a heavier code editor is wanted later.

### Runtime diagnostics
- `jsdom` 31 / `happy-dom` 21 — server-side DOM to run workspace apps and
  capture runtime errors without a browser; complements the existing live
  preview report (`app_debug`).

## 4. What this change wires in

- Backend image router: sweeps **every** discovered provider in multiple
  rounds; total failure returns HTTP 503 `still_processing` — never a fake
  "providers unavailable" image (`main.ts`).
- Media page: Enter submits; "∞ loop" generates until stopped; pending cards
  show "still processing" (`index.html`).
- Code editor: per-file-type syntax highlighting overlay; configurable
  tab/vertical/horizontal split with the preview; find-in-files, go-to-
  definition, cross-file rename, build-time (`ws_check`) + run-time
  diagnostics, and an auto-fix toggle that fires the fixer on new errors.
