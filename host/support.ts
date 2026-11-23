// host/support.ts — the handful of helpers every stage shares. Anything larger
// belongs to a stage. Deliberately free of Deno/Node globals so the whole host
// runs unchanged in Deno, Node, workers and tests.

import type {
  ChatMessage,
  Json,
  Note,
  RequestLimits,
  Severity,
  StageName,
} from "./contracts.ts";

export const DEFAULT_LIMITS: RequestLimits = {
  maxMessages: 64,
  maxRequestChars: 96_000,
  maxMessageChars: 24_000,
  maxModelCalls: 10,
  maxChunks: 8,
  maxConcurrency: 4,
  maxChunkMs: 45_000,
  maxToolMs: 30_000,
  maxChunkOutputChars: 8_000,
  maxTools: 48,
};

export function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  return Math.round(clampNum(v, lo, hi, fallback));
}

export function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function note(
  code: string,
  detail: string,
  severity: Severity = "warn",
  stage?: StageName,
): Note {
  return { code, detail, severity, ...(stage ? { stage } : {}) };
}

const encoder = new TextEncoder();

export function byteLen(s: string): number {
  return encoder.encode(s).length;
}

/** FNV-1a 32-bit, hex. Stable across processes: safe in a manifest or a cache key. */
export function digest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function preview(s: string, n = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : `${oneLine.slice(0, n - 1)}…`;
}

/** Middle-elision: keeps the head and the tail, which is what instructions and
 *  code need; the middle of a long paste is the safest thing to lose. */
export function elide(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const keep = Math.max(0, max - 24);
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  return {
    text: `${s.slice(0, head)}\n…[${s.length - keep} chars elided]…\n${tail > 0 ? s.slice(-tail) : ""}`,
    truncated: true,
  };
}

export function tailCap(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…[${s.length - max} chars truncated]`, truncated: true };
}

/** First complete JSON value in `text`. Models wrap JSON in prose, fences and
 *  thinking blocks; the host must never require a clean body. */
export function extractJson(text: string): unknown {
  const start = (() => {
    const obj = text.indexOf("{");
    const arr = text.indexOf("[");
    if (obj < 0) return arr;
    if (arr < 0) return obj;
    return Math.min(obj, arr);
  })();
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function safeStringify(v: unknown, max = 20_000): string {
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v ?? null);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(v);
  }
}

export function isAbort(e: unknown): boolean {
  if (e instanceof Error) {
    return e.name === "AbortError" || /abort|cancel|disconnect/i.test(e.message);
  }
  return false;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return typeof e === "string" ? e : safeStringify(e, 400);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(finish, ms);
    function finish(): void {
      cleanup();
      resolve();
    }
    function cleanup(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort(): void {
      cleanup();
      reject(signal?.reason ?? new Error("ABORTED"));
    }
    if (signal?.aborted) {
      cleanup();
      reject(signal.reason ?? new Error("ABORTED"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Race a promise against an abort signal. The loser is abandoned, not leaked:
 *  callers pass signals down to the underlying work. */
export function abortable<T>(p: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error(`ABORTED: ${label}`));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new Error(`ABORTED: ${label}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** A fresh deadline composed with the caller's signal. The child controller is
 *  always cleaned up, and the timer never outlives the work. */
export async function withDeadline<T>(
  ms: number,
  parent: AbortSignal,
  label: string,
  fn: (signal: AbortSignal, remaining: () => number) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw parent.reason ?? new Error(`ABORTED: ${label}`);
  const ctrl = new AbortController();
  const end = Date.now() + Math.max(0, ms);
  const remaining = () => Math.max(0, end - Date.now());
  const onParent = () => ctrl.abort(parent.reason ?? new Error(`ABORTED: ${label}`));
  parent.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(
    () => ctrl.abort(new Error(`DEADLINE: ${label} exceeded ${Math.round(ms)}ms`)),
    Math.max(1, ms),
  );
  try {
    return await fn(ctrl.signal, remaining);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParent);
  }
}

/** Resolve after `ms` or when `p` settles — whichever comes first. Never throws
 *  and never leaves an unhandled rejection behind. */
export async function raceSoft<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = p.then(
    (v) => ({ v }),
    () => ({ v: undefined as T | undefined }),
  );
  const timeout = new Promise<{ v: T | undefined }>((resolve) => {
    timer = setTimeout(() => resolve({ v: undefined }), Math.max(1, ms));
  });
  try {
    const out = await Promise.race([settled, timeout]);
    return out.v;
  } finally {
    clearTimeout(timer);
  }
}

/** Random-ish but cheap id suffixes for hosts without crypto.randomUUID. */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

export function newTraceparent(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `00-${hex(32)}-${hex(16)}-01`;
}

/** The caller's actual ask, newest last, without assistant/tool chatter. */
export function goalText(messages: ChatMessage[], max = 4_000): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" || m.role === "tool") continue;
    if (typeof m.content === "string" && m.content.trim()) parts.push(m.content.trim());
  }
  return tailCap(parts.slice(-3).join("\n\n"), max).text;
}
