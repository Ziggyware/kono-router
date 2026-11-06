// Project-level checking and live debugging for the workspace app.
//
//   ws_check   static diagnostics for every file (syntax, imports, exports,
//              HTML references, JSON, CSS) — what will fail before it runs.
//   app_report the browser preview posts what actually happened when it ran
//              the app (uncaught errors, rejections, console.error, failed
//              loads), stamped with the workspace sig it was built from.
//   app_debug  both views at once, each runtime error located in a workspace
//              file with the surrounding lines, and whether the runtime view
//              is current; wait_ms blocks until the preview has run the
//              current files.

import { store } from "./store.ts";
import { text, truncate } from "./util.ts";
import { checkProject, detectEntry, type Diagnostic, excerpt } from "./check.ts";
import { allManifests, type Manifest, readAll, workspaceSig } from "./files.ts";
import type { Json, ToolCaps, ToolSpec } from "./types.ts";

type S = ReturnType<typeof store>;
const MAX_CHECK_BYTES = 512 * 1024;

export interface RuntimeIssue { message: string; path?: string; line?: number; col?: number; kind?: string; stack?: string; count?: number }
export interface RuntimeReport { sig: string; at: number; page: string; entry: string; errors: RuntimeIssue[]; warnings: RuntimeIssue[]; logs: number; ms?: number }

async function loadFiles(s: S, all: Manifest[]): Promise<Map<string, string | null>> {
  const files = new Map<string, string | null>();
  await Promise.all(all.map(async (m) => {
    files.set(m.path, m.binary || m.bytes > MAX_CHECK_BYTES ? null : text(await readAll(s, m)));
  }));
  return files;
}

const issue = (raw: unknown): RuntimeIssue | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Json;
  const message = truncate(String(r.message ?? r.text ?? ""), 600);
  if (!message) return null;
  const out: RuntimeIssue = { message };
  if (typeof r.path === "string" && r.path) out.path = r.path.slice(0, 300);
  if (Number.isFinite(Number(r.line)) && Number(r.line) > 0) out.line = Math.floor(Number(r.line));
  if (Number.isFinite(Number(r.col)) && Number(r.col) > 0) out.col = Math.floor(Number(r.col));
  if (typeof r.kind === "string") out.kind = r.kind.slice(0, 40);
  if (typeof r.stack === "string" && r.stack) out.stack = truncate(r.stack, 1200);
  if (Number(r.count) > 1) out.count = Math.floor(Number(r.count));
  return out;
};

async function located(s: S, issues: RuntimeIssue[], all: Manifest[]): Promise<Json[]> {
  const byPath = new Map(all.map((m) => [m.path, m]));
  const cache = new Map<string, string>();
  const out: Json[] = [];
  for (const i of issues) {
    const m = i.path ? byPath.get(i.path) : undefined;
    let ex: string | undefined;
    if (m && !m.binary && i.line) {
      if (!cache.has(m.path)) cache.set(m.path, text(await readAll(s, m)));
      ex = excerpt(cache.get(m.path)!, i.line, 2);
    }
    out.push({ ...i, ...(ex ? { excerpt: ex } : {}), ...(i.stack && ex ? { stack: undefined } : {}) });
  }
  return out;
}

const compact = (d: Diagnostic, files: Map<string, string | null>): Json => {
  const body = files.get(d.path);
  return { path: d.path, line: d.line, col: d.col, severity: d.severity, source: d.source, message: d.message, ...(body ? { excerpt: excerpt(body, d.line, 1) } : {}) };
};

async function runCheck(s: S, all: Manifest[], opts: { entry?: string; prefix?: string; limit?: number }) {
  const files = await loadFiles(s, all);
  const res = await checkProject(files, { entry: opts.entry, semantic: true, only: opts.prefix ? (p) => p === opts.prefix || p.startsWith(opts.prefix + "/") : undefined });
  const errors = res.diagnostics.filter((d) => d.severity === "error");
  const limit = opts.limit ?? 60;
  return {
    entry: res.entry,
    files_checked: res.files_checked,
    errors: errors.length,
    warnings: res.diagnostics.length - errors.length,
    packages: res.packages,
    ...(res.semantic ? { semantic: res.semantic } : {}),
    diagnostics: res.diagnostics.slice(0, limit).map((d) => compact(d, files)),
    truncated: res.diagnostics.length > limit,
  };
}

export async function workspaceSigFor(caps: ToolCaps): Promise<string> {
  return await workspaceSig(store(caps));
}

export async function latestReport(s: S): Promise<RuntimeReport | null> {
  return await s.get<RuntimeReport>(["app", "runtime"]);
}

/** A compact description of the workspace for the system prompt: what exists,
 *  what runs, and what is currently broken. Null when the workspace is empty. */
export async function workspaceBrief(caps: ToolCaps, opts: { maxFiles?: number } = {}): Promise<string | null> {
  const s = store(caps);
  const all = (await allManifests(s)).filter((m) => !/(^|\/)\.gitkeep$/.test(m.path));
  if (!all.length) return null;
  const sig = await workspaceSig(s, all);
  const max = opts.maxFiles ?? 80;
  const entry = detectEntry(all.map((m) => m.path));
  const tree = all.slice(0, max).map((m) => `${m.path}${m.binary ? ` (${m.bytes} B binary)` : ` (${m.lines} lines)`}`);
  const lines = [
    `Workspace (${all.length} file${all.length === 1 ? "" : "s"}; preview entry: ${entry || "none"}):`,
    ...tree.map((t) => "  " + t),
    ...(all.length > max ? [`  … ${all.length - max} more (fs_list to see them)`] : []),
  ];
  const r = await latestReport(s);
  if (r) {
    const age = Math.round((Date.now() - r.at) / 1000);
    const state = r.sig === sig ? "current files" : "an older version of the files";
    if (r.errors.length) {
      lines.push(`Live preview of ${r.page} (${state}, ${age}s ago) reported ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}:`);
      for (const e of r.errors.slice(0, 6)) lines.push(`  - ${e.path ? `${e.path}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ""}` : ""} ` : ""}${truncate(e.message, 200)}`);
    } else {
      lines.push(`Live preview of ${r.page} (${state}, ${age}s ago) ran without errors.`);
    }
  }
  const t = await s.get<{ sig: string; at: number; passed: number; failed: number; failures: string[] }>(["app", "tests"]);
  if (t) {
    const state = t.sig === sig ? "current files" : "an older version of the files";
    lines.push(`Last app_test run (${state}, ${Math.round((Date.now() - t.at) / 1000)}s ago): ${t.passed} passed, ${t.failed} failed${t.failures.length ? ` — ${t.failures.slice(0, 3).join("; ")}` : ""}.`);
  }
  return lines.join("\n");
}

export const projectTools: ToolSpec[] = [
  {
    name: "ws_check",
    kind: "files",
    aliases: ["check_project", "lint", "typecheck", "check_workspace", "ws_lint"],
    timeoutMs: 15_000,
    description:
      "Statically check the workspace project the way the browser preview will load it: JS/TS/JSX syntax (with line:col), unresolvable or non-module imports, imported names a file does not export, missing default exports, Node built-ins, HTML src/href to missing files, inline <script>/<style> errors, JSON and CSS errors, plus semantic bugs found by the TypeScript checker over JS and TS — assignment to a const, misspelled names and properties (with did-you-mean suggestions), undeclared identifiers, redeclarations, use before declaration, non-callable calls, wrong argument counts (and type errors in .ts/.tsx, as warnings). Each diagnostic has the surrounding lines. Run it after a set of edits and fix every error it reports.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", default: "", description: "Only report on files under this directory (resolution still sees the whole workspace)." },
        entry: { type: "string", description: "Entry point to report as the one the preview runs." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 60 },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const all = (await allManifests(s)).filter((m) => !/(^|\/)\.gitkeep$/.test(m.path));
      if (!all.length) return { ok: true, files_checked: 0, errors: 0, warnings: 0, diagnostics: [], message: "workspace is empty" };
      const res = await runCheck(s, all, { entry: typeof args.entry === "string" ? args.entry : undefined, prefix: String(args.path ?? "").replace(/^\/+|\/+$/g, "") || undefined, limit: Number(args.limit ?? 60) });
      return { ok: res.errors === 0, sig: await workspaceSig(s, all), ...res };
    },
  },
  {
    name: "app_report",
    kind: "files",
    admin: true,
    timeoutMs: 6_000,
    description: "Record what the browser preview observed while running the workspace app (internal: posted by the workspace UI after each build).",
    parameters: {
      type: "object",
      properties: {
        sig: { type: "string" },
        page: { type: "string" },
        entry: { type: "string" },
        errors: { type: "array", items: { type: "object" } },
        warnings: { type: "array", items: { type: "object" } },
        logs: { type: "integer", minimum: 0 },
        ms: { type: "number", minimum: 0 },
      },
      required: ["sig", "page"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const list = (v: unknown) => (Array.isArray(v) ? v : []).map(issue).filter((x): x is RuntimeIssue => x !== null).slice(0, 40);
      const report: RuntimeReport = {
        sig: String(args.sig).slice(0, 64),
        at: Date.now(),
        page: String(args.page).slice(0, 300),
        entry: String(args.entry ?? args.page).slice(0, 300),
        errors: list(args.errors),
        warnings: list(args.warnings),
        logs: Math.max(0, Math.floor(Number(args.logs ?? 0))),
        ...(Number.isFinite(Number(args.ms)) ? { ms: Math.round(Number(args.ms)) } : {}),
      };
      await s.put(["app", "runtime"], report, 86_400_000);
      return { stored: true, errors: report.errors.length, warnings: report.warnings.length };
    },
  },
  {
    name: "app_debug",
    kind: "files",
    aliases: ["debug_app", "app_errors", "preview_errors", "run_app", "test_app"],
    timeoutMs: 20_000,
    description:
      "Debug the workspace app: static diagnostics (as ws_check) plus what the live browser preview observed running it — uncaught exceptions, promise rejections, console.error output and failed loads — each located at workspace file:line with the surrounding code. `runtime.status` says whether the preview has run the current files (current), only an older version (stale), or never (none — the user's workspace preview is not open). After edits, call with wait_ms≈6000 to wait for the preview to rebuild and run the new files.",
    parameters: {
      type: "object",
      properties: {
        wait_ms: { type: "integer", minimum: 0, maximum: 15000, default: 0, description: "Wait up to this long for a runtime report of the current files." },
        static: { type: "boolean", default: true, description: "Include static diagnostics." },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      let all = (await allManifests(s)).filter((m) => !/(^|\/)\.gitkeep$/.test(m.path));
      if (!all.length) return { ok: true, message: "workspace is empty — write the app's files first" };
      let sig = await workspaceSig(s, all);
      let report = await latestReport(s);
      const wait = Math.max(0, Math.min(15_000, Number(args.wait_ms ?? 0)));
      const deadline = Math.min(ctx.deadlineMs - 1500, performance.now() + wait);
      while (wait && report?.sig !== sig && performance.now() < deadline && !ctx.signal.aborted) {
        await new Promise((r) => setTimeout(r, 300));
        report = await latestReport(s);
      }
      // Files may have changed while waiting; re-read so `current` is exact.
      all = (await allManifests(s)).filter((m) => !/(^|\/)\.gitkeep$/.test(m.path));
      sig = await workspaceSig(s, all);
      const status = !report ? "none" : report.sig === sig ? "current" : "stale";
      const runtime: Json = report
        ? {
          status,
          page: report.page,
          age_s: Math.round((Date.now() - report.at) / 1000),
          errors: await located(s, report.errors, all),
          warnings: report.warnings.slice(0, 10),
          console_lines: report.logs,
        }
        : { status, note: "no preview has run this workspace; ask the user to open the workspace panel to see runtime behaviour" };
      const stat = args.static === false ? null : await runCheck(s, all, { limit: 40 });
      const rtErrors = status === "current" ? report!.errors.length : 0;
      const errors = (stat?.errors ?? 0) + rtErrors;
      const next = errors
        ? "Fix every error listed (start with static ones: they often cause the runtime ones), then call app_debug again with wait_ms to confirm."
        : status === "current"
        ? "No errors: the current files load and run cleanly in the preview."
        : status === "stale"
        ? "No static errors; the runtime report is for older files — call again with wait_ms to see the current run."
        : "No static errors; runtime unverified (preview not open).";
      return { ok: errors === 0, sig, ...(stat ? { static: stat } : {}), runtime, next };
    },
  },
];
