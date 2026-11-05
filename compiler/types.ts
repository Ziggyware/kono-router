// Compiler contracts shared by the kernel, the HTTP route and the tests.
import type { Json } from "../toolbox/types.ts";
import type { Candidate, Complete } from "./sample.ts";

export type { Candidate, Complete };

export interface ExecResult { ok: boolean; result?: unknown; error?: string; code?: string; ms: number }
export type Exec = (tool: string, args: Json, signal: AbortSignal) => Promise<ExecResult>;

export interface NodeRun {
  id: string;
  tool: string;
  args: Json;
  deps: string[];
  rank_ms: number;
  status: "ok" | "error" | "skipped";
  start_ms: number;
  end_ms: number;
  ms: number;
  result?: unknown;
  error?: string;
  code?: string;
}

export interface RunMetrics {
  makespan_ms: number;
  work_ms: number;
  critical_path_ms: number;
  parallelism: number;
  depth: number;
}

export interface RunOptions {
  exec: Exec;
  concurrency: number;
  estimateMs: (tool: string) => number;
  stateful: (tool: string) => boolean;
  signal: AbortSignal;
}

export interface CompileOptions {
  question: string;
  complete: Complete;
  exec: Exec;
  samples?: number;
  rounds?: number;
  concurrency?: number;
  k?: number;
  tools?: string[];
  admin?: boolean;
  fallbackTools?: string[];
  estimateMs?: (tool: string) => number;
  budgetMs?: number;
  signal?: AbortSignal;
}

export interface Round {
  candidates: Candidate[];
  selected: number | null;
  consensus: number | null;
  runs: NodeRun[];
  metrics: RunMetrics | null;
  join: { action: "finish" | "replan"; reason?: string; model?: string };
}
export interface CompileResult {
  answer: string;
  tools: string[];
  rounds: Round[];
  usage: { llm_calls: number; tool_calls: number; react_round_trips: number; compiler_round_trips: number };
  ms: number;
}
