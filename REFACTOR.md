# Nokey Router — Val Town-ready modular refactor

Generated from the 8415a25 tree (the Deno Deploy v6 build) by restructuring
`main.ts` (278,755 chars) and `tools.ts` (81,504 chars) into small,
human-editable modules. All code is readable source — no minification, no
mangling — so every file can be edited directly in the Val Town UI.

Verified after the restructure (Deno 2.9.6):
- `deno check` clean across the whole tree
- `deno test --unstable-kv -A tests/` — **140 passed, 0 failed** (identical to
  the unmodified tree)
- Live boot smoke: `/health`, `/v1/models`, `/pricing`, `/` all respond 200

## New structure

| File | Size | Role |
| --- | --- | --- |
| `main.ts` | ~27k | Thin entry: imports, Hono app assembly, middleware, register calls, cron/serve bootstrap. Still exports `app` (tests import it from here). |
| `state.ts` | ~7k | Shared runtime state: `kv` (with in-memory fallback, below), `honoApp`, L1 cache, registries. |
| `util.ts` | ~9k | Shared helper functions (errText, logErr, …). |
| `engine/providers.ts` | ~47k | Provider catalog, scoring, candidates, sync, canary/resurrect probes. |
| `engine/mesh.ts` | ~28k | Mesh tool registration, sub-agents, forged tools. |
| `engine/dispatch.ts` | ~25k | Upstream execution, streaming delta machinery. |
| `engine/learning.ts` | ~11k | ASCK-L learning glue (rewards, lessons, posteriors). |
| `engine/core.ts` | ~5k | Shared engine glue (requireAdmin, loadTextFile, health payload, traced tool runner). |
| `routes/chat.ts` | ~71k | `POST /v1/chat/completions` + its private machinery. The one big file left — a single cohesive handler. |
| `routes/community.ts` | ~12k | Community routes (messages, posts, votes, stream). |
| `routes/images.ts` | ~13k | Image probe/generation routes. |
| `routes/pages.ts` | ~11k | `/`, `/pricing`, `/forge-docs`, `/admin`, `/health` + the page HTML. |
| `routes/learning.ts` | ~10k | `/v1/feedback`, `/v1/learning*`. |
| `routes/ops.ts` | ~7k | `/v1/agent/compile`, probe, sync, resurrect. |
| `routes/tools.ts` | ~6k | `/v1/tools*` registrations. |
| `routes/catalog.ts` | ~2k | `/v1/models`, `/v1/endpoints`, `/v1/source*`. |
| `routes/traces.ts` | ~2k | `/v1/traces*`. |
| `routes/agent-protocols.ts` | ~31k | Agent protocols: `POST /mcp` (MCP), `POST /a2a` + `GET /.well-known/agent-card.json` (A2A), `POST /v1/responses` (Responses API). Adapters over in-process dispatch. |
| `routes/agent-run.ts` | ~18k | `POST /v1/agent/run` — plan → parallel workers → verify → synthesize; AG-UI event streaming. |
| `tools.ts` | ~71k | The tool plane (was 81.5k). |
| `tools-text.ts` | ~11k | Text tool-call parsing (`parseTextToolCalls`, `repairJsonText`, openers), re-exported from `tools.ts`. |

Route modules export `register<Area>()`; `main.ts` calls each at the position
of the area's first original route, so middleware and registration order are
unchanged. Cross-module wiring is explicit imports throughout.

## Val Town notes

- Every `.ts` file is now under the ~80k Val Town file limit, most under 50k.
- `state.ts` wraps `Deno.openKv()` in a fallback: if KV is unavailable
  (Val Town), the router runs on a process-local in-memory store with the
  same API surface. Data is volatile there (lost on restart) but all
  features work. On Deno Deploy nothing changes — the real KV is used.
- Data files are unchanged and still over the limit (`index.html` 570k,
  `services.json` 339k, `openapi.json` 85k, `CHANGES.md` 85k). They are not
  code: deploy them with deploy.py's parts-split + the parts manifest, and
  the router's `loadTextFile` loader reassembles them at read time.
- The ~80k Val Town cap itself is still unverified against the live API —
  worth one probe PUT before a full deploy.
- `deno.json` is unchanged (import map, tasks). To run locally:
  `deno task start`; to verify: `deno task check` + `deno task test`.

## Tooling (in the packer workspace)

- `refactor.mjs` — the single-shot restructuring of main.ts (routes, state,
  util, engine extraction). Run it against a pristine tree only.
- `partition.mjs` — split the intermediate engine.ts into engine/* modules
  and rewrote importers.
- `extract.mjs` — seeded cluster extraction used for tools-text.ts.
All three are checker-driven (TypeScript compiler API) and preserve
comments with the code they document.
