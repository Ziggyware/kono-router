// host/contracts.ts — every type the host-side message router passes between
// stages. Types only: no imports, no runtime, no I/O.
//
// The spine is fixed and five stages long:
//
//   intake → build → decompose → execute → assemble
//   accept   grow a   ask the AI  run the   one answer
//   + tame   full     for the     tiny      out of the
//   the      request  chunk list  chunks    chunk outputs
//   request
//
// Every stage takes the previous stage's value plus the Ledger, returns a
// value plus notes, and can only throw when the caller aborts. That is the
// whole robustness contract: a malformed body, a broken planner, a dead tool
// and an empty catalog are all *values*, never exceptions.

export type Json = Record<string, unknown>;

export type Role = "system" | "user" | "assistant" | "tool";

/** Routing lanes — same vocabulary as the existing engine so the two can share
 *  a catalog, a breaker table and a learning corpus. */
export type RoutingMode = "fast" | "smart" | "code" | "reasoning";

/** What the request is *for*. Drives tool exposure, chunk shape and ranking. */
export type TaskClass =
  | "chat"
  | "code"
  | "math"
  | "json"
  | "tool"
  | "vision"
  | "reasoning";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

// ---------------------------------------------------------------------------
// 1. INTAKE — the caller's bytes, made safe to route.
// ---------------------------------------------------------------------------

export type Severity = "info" | "warn" | "degrade";

/** One thing the host had to change, guess, or give up on. Notes are the
 *  difference between "it worked" and "we know exactly what it cost". */
export interface Note {
  code: string;
  detail: string;
  severity: Severity;
  stage?: StageName;
}

export interface HostContext {
  /** Tenant / API-key namespace. Scopes tools, ranking and caching. */
  tenant: string;
  traceparent?: string | null;
  /** Caller-supplied wall clock for the whole request, in ms. */
  budgetMs?: number;
  /** Client disconnect or gateway timeout. */
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Json;
  source: "client" | "builtin";
}

export interface SamplingParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  toolChoice?: unknown;
  responseFormat?: Json;
  reasoningEffort?: string;
  parallelToolCalls?: boolean;
}

export interface RequestLimits {
  /** Messages kept after intake (system messages are always kept). */
  maxMessages: number;
  /** Total characters across all message content. */
  maxRequestChars: number;
  /** Characters kept per message before middle-elision. */
  maxMessageChars: number;
  /** Model round trips the whole request may spend. */
  maxModelCalls: number;
  /** Chunks the planner may hand back. */
  maxChunks: number;
  /** Chunks allowed in flight at once. */
  maxConcurrency: number;
  /** Per-chunk generation budget. */
  maxChunkMs: number;
  /** Per-tool-execution budget. */
  maxToolMs: number;
  /** Characters kept from one chunk's output. */
  maxChunkOutputChars: number;
  /** Declared tools per request (client + builtin). */
  maxTools: number;
}

export type ToolsRequest = "none" | "auto" | "explicit";

export interface HostRequest {
  id: string;
  /** Epoch ms at which intake started. Every event is relative to this. */
  startedAt: number;
  tenant: string;
  traceparent: string;
  /** Exactly as the caller sent it (`free:auto`, a model id, …). */
  model: string;
  mode: RoutingMode;
  taskClass: TaskClass;
  stream: boolean;
  messages: ChatMessage[];
  /** True when any message carried an image part. */
  hasImages: boolean;
  clientTools: ToolDecl[];
  toolsRequested: ToolsRequest;
  params: SamplingParams;
  budgetMs: number;
  limits: RequestLimits;
  /** Composed caller signal + request deadline. */
  signal: AbortSignal;
  /** Everything intake changed, clamped, dropped or guessed. */
  notes: Note[];
  /** The body after legacy-field aliasing. Never trusted again. */
  raw: Json;
  /** Set when the caller explicitly disabled decomposition. */
  decompose?: boolean;
}

// ---------------------------------------------------------------------------
// 2. CANDIDATES — "who could answer this", asked, never assumed.
// ---------------------------------------------------------------------------

export interface CandidateRef {
  /** Stable tuple id: providerId::modelId. */
  tupleId: string;
  providerId: string;
  modelId: string;
  /** Ranking score in whatever units the candidate port uses. Higher wins. */
  score: number;
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow: number;
  /** Learned time-to-first-token, for budgeting the hedge. */
  p50TtftMs: number;
}

export interface RankQuery {
  mode: RoutingMode;
  taskClass: TaskClass;
  tenant: string;
  requiresTools: boolean;
  requiresVision: boolean;
  limit: number;
  exclude: string[];
}

export interface CandidatePort {
  rank(q: RankQuery): Promise<CandidateRef[]>;
  /** Last-resort pool when `rank` returns nothing. */
  sweep?(q: RankQuery): Promise<CandidateRef[]>;
}

// ---------------------------------------------------------------------------
// 3. MODEL — one buffered completion, no streaming, no hidden retries.
// ---------------------------------------------------------------------------

export type CallPurpose = "planner" | "repair" | "chunk" | "synthesize";

export interface ModelCall {
  purpose: CallPurpose;
  messages: ChatMessage[];
  /** Pinned candidate. Undefined = the adapter routes it. */
  model?: string;
  tupleId?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
  tools?: ToolDecl[];
  /** Wall clock for this call; the adapter must honour it. */
  deadlineMs: number;
  signal: AbortSignal;
  /** Stamped on every ledger event the adapter emits. */
  chunkId?: string;
  attempt: number;
}

export interface ModelReply {
  content: string;
  model: string;
  tupleId?: string;
  finish?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  ttftMs?: number;
  ms: number;
  /** Endpoints tried before this reply (visibility into the hedge). */
  upstreamAttempts: number;
}

export interface ModelPort {
  complete(call: ModelCall): Promise<ModelReply>;
}

// ---------------------------------------------------------------------------
// 4. TOOLS — executed by the host, never by the model.
// ---------------------------------------------------------------------------

export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
  ms: number;
  /** True when the host truncated the value to the output cap. */
  truncated?: boolean;
}

export interface ToolRunOptions {
  signal: AbortSignal;
  tenant: string;
  timeoutMs: number;
}

export interface ToolPort {
  list(): ToolDecl[];
  has(name: string): boolean;
  execute(name: string, args: Json, o: ToolRunOptions): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// 5. PROMPT — the only place router-authored text enters the request.
// ---------------------------------------------------------------------------

export interface PromptContributor {
  /** ASCK-L strategy variant (routing mode / arm prefix). */
  variant?(r: HostRequest): Promise<string | null> | string | null;
  /** Verified lessons for this task class, newest first. */
  lessons?(r: HostRequest): Promise<string[]> | string[];
  /** Session workspace brief: what exists, what is broken. */
  workspaceBrief?(r: HostRequest): Promise<string | null> | string | null;
  /** Tool-use preamble. Defaults to a short built-in text. */
  preamble?(names: string[]): Promise<string> | string;
}

// ---------------------------------------------------------------------------
// 6. BUILD — the manifest is the receipt for every decision build made.
// ---------------------------------------------------------------------------

export interface ToolSelection {
  declared: ToolDecl[];
  /** Builtin names selected by task class. */
  auto: string[];
  dropped: Note[];
}

export interface PromptPart {
  source: "variant" | "lessons" | "workspace" | "preamble" | "client";
  bytes: number;
  digest: string;
  preview: string;
}

export interface BudgetSplit {
  totalMs: number;
  plannerMs: number;
  chunkMs: number;
  synthMs: number;
}

export interface BuildManifest {
  modelRequested: string;
  mode: RoutingMode;
  taskClass: TaskClass;
  candidates: CandidateRef[];
  tools: ToolSelection;
  prompt: PromptPart[];
  params: SamplingParams;
  budget: BudgetSplit;
  limits: RequestLimits;
  notes: Note[];
}

export interface BuiltRequest {
  request: HostRequest;
  /** Ready to send: router system text first, then the caller's messages. */
  messages: ChatMessage[];
  manifest: BuildManifest;
}

// ---------------------------------------------------------------------------
// 7. DECOMPOSE — the chunk plan the AI writes, after validation.
// ---------------------------------------------------------------------------

export type ChunkKind = "answer" | "tool";

export interface Chunk {
  /** ^[a-z][a-z0-9_]{0,23}$ — referenced by later chunks as `$id.path`. */
  id: string;
  title: string;
  kind: ChunkKind;
  /** Required for kind "tool"; must be a declared tool. */
  tool?: string;
  /** Tool arguments. May contain `$id`, `$id/path`, `${id/path}` refs. */
  args?: Json;
  /** Chunk ids that must finish first. Always lower-indexed: no cycles. */
  needs: string[];
  /** kind "answer": the micro-instruction for this chunk. */
  prompt?: string;
  outputCapChars: number;
}

export type PlanSource = "planner" | "fallback";

export interface ChunkPlan {
  requestId: string;
  source: PlanSource;
  rationale: string;
  chunks: Chunk[];
  plannerModel?: string;
  plannerAttempts: number;
  plannerMs: number;
  /** Why candidate chunks were thrown away — visible, not silent. */
  rejects: Note[];
  /** The validation errors that triggered the repair call, if any. */
  repairErrors: string[];
}

// ---------------------------------------------------------------------------
// 8. EXECUTE — one record per chunk, whatever happened to it.
// ---------------------------------------------------------------------------

export type ChunkStatus = "ok" | "failed" | "skipped";

export interface ChunkResult {
  chunk: Chunk;
  status: ChunkStatus;
  /** Normalized text output (tool value stringified, or the answer). */
  output: string;
  /** Raw tool value, for `$id.path` substitution downstream. */
  value?: unknown;
  ms: number;
  attempts: number;
  model?: string;
  error?: string;
  code?: string;
}

export interface Assembled {
  content: string;
  finish: "stop" | "degraded" | "abort";
  modelUsed?: string;
  tupleId?: string;
}

// ---------------------------------------------------------------------------
// 9. VISIBILITY — the event stream is the product, not a debug aid.
// ---------------------------------------------------------------------------

export type StageName =
  | "intake"
  | "build"
  | "rank"
  | "decompose"
  | "chunk"
  | "assemble"
  | "done";

export type Phase = "start" | "end" | "decision" | "retry" | "error" | "info";

export interface HostEvent {
  /** Monotonic per request, starting at 1. Never reordered, never dropped. */
  seq: number;
  requestId: string;
  /** ms since request start. */
  at: number;
  /** Epoch ms. */
  wall: number;
  stage: StageName;
  phase: Phase;
  chunkId?: string;
  attempt?: number;
  model?: string;
  tupleId?: string;
  ok?: boolean;
  ms?: number;
  data?: Json;
}

export type EventSink = (e: HostEvent) => void;

export interface StageSummary {
  stage: StageName;
  events: number;
  ms: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// 10. REPORT — what the model did, and when, in one serializable object.
// ---------------------------------------------------------------------------

export interface RouteReport {
  requestId: string;
  traceparent: string;
  modelRequested: string;
  modelUsed?: string;
  tupleId?: string;
  mode: RoutingMode;
  taskClass: TaskClass;
  planSource: PlanSource;
  stages: StageSummary[];
  modelCalls: number;
  toolCalls: number;
  retries: number;
  errors: number;
  chunks: ChunkResult[];
  notes: Note[];
  totalMs: number;
  budgetMs: number;
  finish: Assembled["finish"];
  /** Human-readable one-screen summary for logs, SSE and the dashboard. */
  explain(): string;
}

export interface HostResponse {
  content: string;
  finish: Assembled["finish"];
  report: RouteReport;
  plan: ChunkPlan;
  events: HostEvent[];
}

// ---------------------------------------------------------------------------
// 11. PORTS — the whole host depends on these six and nothing else.
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export interface IdSource {
  next(prefix: string): string;
}

export interface HostPorts {
  candidates: CandidatePort;
  models: ModelPort;
  tools: ToolPort;
  events?: EventSink;
  clock?: Clock;
  ids?: IdSource;
  prompt?: PromptContributor;
}

export interface HostRouter {
  /** Accept anything, always answer, report everything. */
  handle(raw: unknown, ctx: HostContext): Promise<HostResponse>;
  /** The last report for a request id, if it is still in the ring. */
  report(requestId: string): RouteReport | undefined;
}
