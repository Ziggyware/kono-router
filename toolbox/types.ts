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
  /** Run a sub-agent (a full tool-using completion in the same session).
   *  Absent inside a sub-agent: teams do not nest. */
  subagent?: (task: SubagentTask, signal: AbortSignal) => Promise<SubagentResult>;
  /** The requesting client runs app_test jobs in a browser (it said so with kono_runner). */
  runner?: boolean;
}

export interface SubagentTask { role: string; task: string; model?: string; rounds?: number }
export interface SubagentResult { role: string; ok: boolean; content: string; model?: string; tool_rounds?: number; tools?: string[]; ms: number; error?: string }

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
  /** Argument-name synonyms models reach for (e.g. oldpath → from), renamed before validation. */
  argAliases?: Record<string, string>;
  /** Pure function of its arguments and the injected store — cacheable. */
  deterministic?: boolean;
  /** Requires the admin secret to execute over HTTP. */
  admin?: boolean;
  /** Created at runtime by the forge (persisted in KV, not from source). */
  dynamic?: boolean;
  timeoutMs?: number;
  run: (args: Json, ctx: ToolContext) => unknown;
}
