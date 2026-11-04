// Toolbox contracts. Kept dependency-free so every tool module can import them
// without touching the kernel (type-only imports are erased at runtime).

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Json = Record<string, unknown>;

export type ToolKind =
  | "web"
  | "files"
  | "memory"
  | "rag"
  | "vector"
  | "clipboard"
  | "task"
  | "compute"
  | "data"
  | "text"
  | "time"
  | "crypto"
  | "mesh";

/** Runtime capabilities. Everything a tool needs from the outside world is
 *  injected, which keeps every tool testable with a stub fetch and a memory
 *  store — and keeps the kernel free of ambient I/O. */
export interface ToolCaps {
  /** Durable store; absent means the in-isolate memory store. */
  kv?: Deno.Kv;
  /** Tenant / conversation scope. Sanitised by the caller before it lands here. */
  namespace?: string;
  /** Injected fetch so tests never touch the network. */
  fetch?: typeof fetch;
}

export interface ToolContext {
  signal: AbortSignal;
  now: number;
  deadlineMs: number;
  /** Router-injected data (skill snapshot, catalog…). */
  locals: Json;
  caps?: ToolCaps;
  /** Span hook so tool executions show up in the trace waterfall. */
  event?: (name: string, attrs?: Json) => void;
}

export interface ToolSpec {
  /** Canonical id: `^[a-z0-9_]{1,64}$` (valid on every vendor wire). */
  name: string;
  description: string;
  /** JSON Schema (2020-12 subset) for the arguments object. */
  parameters: Json;
  kind: ToolKind;
  aliases?: string[];
  /** Pure function of its arguments and the injected store — cacheable. */
  deterministic?: boolean;
  /** Requires the admin secret to execute over HTTP. */
  admin?: boolean;
  timeoutMs?: number;
  run: (args: Json, ctx: ToolContext) => unknown;
}
