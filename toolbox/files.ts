// A durable virtual workspace: read, write, list, grep, patch, delete.
//
// Files live in the tenant's KV namespace in 32KiB chunks with a manifest, so
// content survives redeploys and is bounded by a per-tenant quota. Paths are
// relative and normalised — `../` cannot escape the workspace, and there is no
// ambient filesystem access at all.

import { delBytes, getBytes, putBytes, store } from "./store.ts";
import { base64ToBytes, bytesToBase64, contentId, globToRegex, normalizePath, text, truncate, utf8 } from "./util.ts";
import type { Json, ToolContext, ToolSpec } from "./types.ts";

const MAX_FILE = 2 * 1024 * 1024;
const QUOTA_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;

interface Manifest {
  path: string;
  bytes: number;
  chunks: number;
  sha: string;
  mtime: number;
  mime: string;
  lines: number;
  binary: boolean;
}

const MIME: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values",
  html: "text/html", css: "text/css", js: "text/javascript", ts: "text/typescript", py: "text/x-python",
  sh: "text/x-shellscript", yml: "text/yaml", yaml: "text/yaml", xml: "application/xml", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  zip: "application/zip", gz: "application/gzip",
};

const mimeOf = (path: string): string => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const decode = (bytes: Uint8Array): { text: string; binary: boolean } => {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false };
  } catch {
    return { text: "", binary: true };
  }
};

async function manifest(s: ReturnType<typeof store>, path: string): Promise<Manifest | null> {
  return await s.get<Manifest>(["fs", "m", path]);
}

async function readAll(s: ReturnType<typeof store>, m: Manifest): Promise<Uint8Array> {
  return await getBytes(s, ["fs", "b", m.path], m.chunks);
}

async function quota(s: ReturnType<typeof store>): Promise<{ bytes: number; files: number }> {
  return (await s.get<{ bytes: number; files: number }>(["fs", "quota"])) ?? { bytes: 0, files: 0 };
}

async function adjustQuota(s: ReturnType<typeof store>, dBytes: number, dFiles: number): Promise<void> {
  const q = await quota(s);
  await s.put(["fs", "quota"], { bytes: Math.max(0, q.bytes + dBytes), files: Math.max(0, q.files + dFiles) });
}

async function putFile(s: ReturnType<typeof store>, path: string, bytes: Uint8Array): Promise<{ manifest: Manifest; created: boolean; previous?: Manifest }> {
  if (bytes.length === 0) bytes = new Uint8Array();
  const previous = await manifest(s, path);
  const before = await quota(s);
  if (!previous && before.files >= MAX_FILES) throw new Error(`workspace file limit reached (${MAX_FILES}); delete something first`);
  const projected = before.bytes - (previous?.bytes ?? 0) + bytes.length;
  if (projected > QUOTA_BYTES) throw new Error(`workspace quota exceeded (${QUOTA_BYTES} bytes)`);
  if (previous?.chunks) await delBytes(s, ["fs", "b", path], previous.chunks);
  const chunks = await putBytes(s, ["fs", "b", path], bytes);
  const decoded = decode(bytes);
  const entry: Manifest = {
    path,
    bytes: bytes.length,
    chunks,
    sha: await contentId(bytes),
    mtime: Date.now(),
    mime: mimeOf(path),
    lines: decoded.binary ? 0 : decoded.text.split("\n").length,
    binary: decoded.binary,
  };
  await s.put(["fs", "m", path], entry);
  await adjustQuota(s, bytes.length - (previous?.bytes ?? 0), previous ? 0 : 1);
  return { manifest: entry, created: !previous, previous: previous ?? undefined };
}

async function removeFile(s: ReturnType<typeof store>, path: string): Promise<boolean> {
  const m = await manifest(s, path);
  if (!m) return false;
  if (m.chunks) await delBytes(s, ["fs", "b", path], m.chunks);
  await s.del(["fs", "m", path]);
  await adjustQuota(s, -m.bytes, -1);
  return true;
}

async function allManifests(s: ReturnType<typeof store>): Promise<Manifest[]> {
  const rows = await s.list<Manifest>(["fs", "m"], { limit: MAX_FILES });
  return rows.map((r) => r.value).filter((m) => m && typeof m.path === "string").sort((a, b) => a.path.localeCompare(b.path));
}

/** Apply a unified diff. Hunk positions are re-anchored by content, so a patch
 *  still lands when earlier lines have drifted (fuzzy ∈ [0,1]). */
function applyHunks(lines: string[], patch: string, fuzzy: number): { lines: string[]; hunks: number; failed: string[] } {
  interface Hunk { oldStart: number; lines: Array<{ t: " " | "+" | "-"; text: string }> }
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    const head = raw.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s+@@/);
    if (head) {
      if (current) hunks.push(current);
      current = { oldStart: Number(head[1]), lines: [] };
      continue;
    }
    if (!current) continue;
    if (raw === "") continue; // artifact of the trailing newline, not context
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) current.lines.push({ t: "+", text: raw.slice(1) });
    else if (raw.startsWith("-")) current.lines.push({ t: "-", text: raw.slice(1) });
    else current.lines.push({ t: " ", text: raw.slice(1) });
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) throw new Error("no @@ hunks found in patch");

  const failed: string[] = [];
  let applied = 0;
  for (const hunk of [...hunks].reverse()) {
    const oldBlock = hunk.lines.filter((l) => l.t !== "+").map((l) => l.text);
    const newBlock = hunk.lines.filter((l) => l.t !== "-").map((l) => l.text);
    const expected = Math.max(0, hunk.oldStart - 1);
    const window = Math.max(0, Math.round(fuzzy * Math.max(12, oldBlock.length)));
    let at = -1;
    for (let delta = 0; delta <= window && at < 0; delta++) {
      for (const candidate of delta === 0 ? [expected] : [expected - delta, expected + delta]) {
        if (candidate < 0 || candidate + oldBlock.length > lines.length) continue;
        const slice = lines.slice(candidate, candidate + oldBlock.length);
        if (slice.every((line, i) => line === oldBlock[i]) ||
          (fuzzy > 0 && slice.every((line, i) => line.trimEnd() === oldBlock[i].trimEnd()))) {
          at = candidate;
          break;
        }
      }
    }
    if (at < 0) {
      failed.push(`@@ -${hunk.oldStart} could not be anchored`);
      continue;
    }
    lines.splice(at, oldBlock.length, ...newBlock);
    applied++;
  }
  if (failed.length) throw new Error(`patch failed: ${failed.join("; ")}`);
  return { lines, hunks: applied, failed };
}

function lineDiff(before: string[], after: string[]): string {
  const n = before.length, m = after.length;
  if (n * m > 4_000_000) return "(diff too large)";
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { out.push(` ${before[i]}`); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push(`-${before[i++]}`); }
    else out.push(`+${after[j++]}`);
  }
  while (i < n) out.push(`-${before[i++]}`);
  while (j < m) out.push(`+${after[j++]}`);
  return out.slice(0, 400).join("\n");
}

export const fileTools: ToolSpec[] = [
  {
    name: "fs_read",
    kind: "files",
    aliases: ["read_file", "cat", "open_file", "file_read"],
    description:
      "Read a file from the durable workspace. Supports line ranges (offset/limit) for large files and reports size, line count and content hash so later patches can be verified. Binary files come back as base64.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path, e.g. notes/todo.md." },
        offset: { type: "integer", minimum: 1, default: 1, description: "First line to return (1-based)." },
        limit: { type: "integer", minimum: 1, maximum: 5000, default: 2000, description: "Maximum lines to return." },
        encoding: { type: "string", enum: ["auto", "utf8", "base64"], default: "auto" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const path = normalizePath(String(args.path ?? ""));
      const m = await manifest(s, path);
      if (!m) throw new Error(`no such file: ${path}`);
      const bytes = await readAll(s, m);
      const decoded = decode(bytes);
      const encoding = String(args.encoding ?? "auto");
      if (encoding === "base64" || (encoding === "auto" && decoded.binary)) {
        return { path, bytes: m.bytes, mime: m.mime, binary: true, sha256: m.sha, encoding: "base64", content: bytesToBase64(bytes).slice(0, 400_000) };
      }
      const lines = decoded.text.split("\n");
      const offset = Math.max(1, Number(args.offset ?? 1));
      const limit = Math.max(1, Math.min(5000, Number(args.limit ?? 2000)));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      return {
        path,
        mime: m.mime,
        bytes: m.bytes,
        lines: lines.length,
        start_line: offset,
        end_line: Math.min(lines.length, offset + slice.length - 1),
        sha256: m.sha,
        mtime: new Date(m.mtime).toISOString(),
        truncated: offset - 1 + slice.length < lines.length,
        content: slice.join("\n"),
      };
    },
  },
  {
    name: "fs_write",
    kind: "files",
    aliases: ["write_file", "save_file", "create_file", "append_file"],
    description:
      "Create, overwrite or append a file in the durable workspace. Parent directories are implicit. Returns byte count, line count and SHA-256 — keep the hash if you intend to patch the file later.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "File content (or base64 when encoding=base64)." },
        mode: { type: "string", enum: ["write", "append"], default: "write" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const path = normalizePath(String(args.path ?? ""));
      if (!path) throw new Error("path is required");
      const incoming = String(args.encoding ?? "utf8") === "base64" ? base64ToBytes(String(args.content ?? "")) : utf8(String(args.content ?? ""));
      const existing = await manifest(s, path);
      const prior = existing ? await readAll(s, existing) : new Uint8Array();
      const merged = String(args.mode ?? "write") === "append"
        ? (() => { const out = new Uint8Array(prior.length + incoming.length); out.set(prior); out.set(incoming, prior.length); return out; })()
        : incoming;
      if (merged.length > MAX_FILE) throw new Error(`file exceeds ${MAX_FILE} bytes`);
      const { manifest: entry, created } = await putFile(s, path, merged);
      return {
        path, created, bytes: entry.bytes, lines: entry.lines, sha256: entry.sha,
        mime: entry.mime, total_workspace_bytes: (await quota(s)).bytes,
      };
    },
  },
  {
    name: "fs_list",
    kind: "files",
    aliases: ["list_files", "ls", "dir", "glob"],
    description:
      "List workspace files under a directory, optionally filtered by a glob (`*.md`, `src/**/*.ts`). Returns paths, sizes and timestamps, plus the directories implied by those files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", default: "", description: "Directory prefix; empty means the whole workspace." },
        glob: { type: "string", description: "Glob matched against the full path, e.g. **/*.md." },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const prefix = normalizePath(String(args.path ?? ""));
      const glob = typeof args.glob === "string" && args.glob.trim() ? globToRegex(args.glob.trim()) : null;
      const limit = Math.max(1, Math.min(1000, Number(args.limit ?? 200)));
      const all = await allManifests(s);
      const rows = all
        .filter((m) => (!prefix || m.path === prefix || m.path.startsWith(prefix + "/")) && (!glob || glob.test(m.path)))
        .slice(0, limit)
        .map((m) => ({ path: m.path, bytes: m.bytes, lines: m.lines, mime: m.mime, mtime: new Date(m.mtime).toISOString() }));
      const dirs = [...new Set(rows.map((r) => r.path.split("/").slice(0, -1).join("/")).filter(Boolean))].sort();
      return { prefix: prefix || "/", count: rows.length, total_files: all.length, quota_bytes: QUOTA_BYTES, dirs, files: rows };
    },
  },
  {
    name: "fs_grep",
    kind: "files",
    aliases: ["grep", "search_files", "search_code", "rg"],
    description:
      "Regex search across workspace files. Returns file, line number and matching text, with optional context lines. Use it to locate code before patching instead of reading whole files.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", default: "", description: "Restrict to this directory prefix." },
        glob: { type: "string", description: "Restrict by glob, e.g. **/*.ts." },
        flags: { type: "string", default: "i", description: "Regex flags (i, m, s)." },
        context: { type: "integer", minimum: 0, maximum: 3, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("pattern is required");
      const flags = String(args.flags ?? "i").replace(/[^ims]/g, "");
      const re = new RegExp(pattern, flags);
      const prefix = normalizePath(String(args.path ?? ""));
      const glob = typeof args.glob === "string" && args.glob.trim() ? globToRegex(args.glob.trim()) : null;
      const context = Math.max(0, Math.min(3, Number(args.context ?? 0)));
      const limit = Math.max(1, Math.min(200, Number(args.limit ?? 50)));
      const matches: Json[] = [];
      let scanned = 0;
      for (const m of await allManifests(s)) {
        if (prefix && m.path !== prefix && !m.path.startsWith(prefix + "/")) continue;
        if (glob && !glob.test(m.path)) continue;
        if (m.binary || m.bytes > 512 * 1024) continue;
        scanned++;
        const bytes = await readAll(s, m);
        const lines = text(bytes).split("\n");
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (!re.test(lines[i])) continue;
          matches.push({
            path: m.path,
            line: i + 1,
            text: truncate(lines[i], 400),
            ...(context > 0
              ? { before: lines.slice(Math.max(0, i - context), i).map((l) => truncate(l, 200)), after: lines.slice(i + 1, i + 1 + context).map((l) => truncate(l, 200)) }
              : {}),
          });
          if (matches.length >= limit) return { pattern, scanned, count: matches.length, truncated: true, matches };
        }
      }
      return { pattern, scanned, count: matches.length, truncated: false, matches };
    },
  },
  {
    name: "fs_patch",
    kind: "files",
    aliases: ["patch", "edit_file", "apply_patch", "str_replace", "modify_file"],
    description:
      "Edit an existing file surgically. Two modes: `edits` performs exact string replacements (cheap, preferred), or `patch` applies a unified diff with @@ hunks that are re-anchored by content so line drift does not break it. Atomic: nothing is written unless every hunk applies. Use dry_run to preview.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          description: "Exact replacements, applied in order.",
          items: {
            type: "object",
            properties: {
              old: { type: "string" },
              new: { type: "string" },
              replace_all: { type: "boolean", default: false },
            },
            required: ["old", "new"],
          },
        },
        patch: { type: "string", description: "Unified diff body with @@ hunks." },
        fuzzy: { type: "number", minimum: 0, maximum: 1, default: 0.2, description: "Anchor search window as a fraction of hunk size." },
        dry_run: { type: "boolean", default: false },
      },
      required: ["path"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const path = normalizePath(String(args.path ?? ""));
      const m = await manifest(s, path);
      if (!m) throw new Error(`no such file: ${path}`);
      if (m.binary) throw new Error("refusing to patch a binary file");
      const before = text(await readAll(s, m));
      let after = before;
      const applied: string[] = [];

      if (Array.isArray(args.edits) && args.edits.length > 0) {
        for (const [i, raw] of (args.edits as Json[]).entries()) {
          const old = String(raw.old ?? "");
          const next = String(raw.new ?? "");
          if (!old) throw new Error(`edit ${i}: old is empty`);
          const count = after.split(old).length - 1;
          if (count === 0) throw new Error(`edit ${i}: anchor not found (${truncate(old, 80)})`);
          if (count > 1 && raw.replace_all !== true) throw new Error(`edit ${i}: anchor is ambiguous (${count} matches); add context or set replace_all`);
          after = raw.replace_all === true ? after.split(old).join(next) : after.replace(old, next);
          applied.push(`edit ${i}: ${count} replacement${count === 1 ? "" : "s"}`);
        }
      } else if (typeof args.patch === "string" && args.patch.trim()) {
        const result = applyHunks(before.split("\n"), args.patch, Number(args.fuzzy ?? 0.2));
        after = result.lines.join("\n");
        applied.push(`${result.hunks} hunk${result.hunks === 1 ? "" : "s"}`);
      } else {
        throw new Error("provide `edits` or `patch`");
      }

      const diff = lineDiff(before.split("\n"), after.split("\n"));
      if (String(after) === before) return { path, changed: false, message: "patch produced no change", diff: "" };
      if (args.dry_run === true) return { path, changed: true, dry_run: true, diff: truncate(diff, 6000), applied };
      const { manifest: entry } = await putFile(s, path, utf8(after));
      return { path, changed: true, bytes: entry.bytes, lines: entry.lines, sha256: entry.sha, applied, diff: truncate(diff, 6000) };
    },
  },
  {
    name: "fs_delete",
    kind: "files",
    aliases: ["delete_file", "rm", "remove_file", "unlink"],
    description:
      "Delete a workspace file, or a whole directory with recursive=true. Returns how many files were removed and the reclaimed bytes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", default: false },
      },
      required: ["path"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = store(ctx.caps);
      const path = normalizePath(String(args.path ?? ""));
      if (!path) throw new Error("refusing to delete the workspace root");
      const exact = await manifest(s, path);
      if (exact) {
        const bytes = exact.bytes;
        await removeFile(s, path);
        return { path, deleted: 1, bytes: bytes };
      }
      const children = (await allManifests(s)).filter((m) => m.path.startsWith(path + "/"));
      if (children.length === 0) throw new Error(`no such file or directory: ${path}`);
      if (args.recursive !== true) throw new Error(`${path} is a directory with ${children.length} files; pass recursive=true`);
      let bytes = 0;
      for (const m of children) { bytes += m.bytes; await removeFile(s, m.path); }
      return { path, deleted: children.length, bytes };
    },
  },
];

export { applyHunks, lineDiff };
