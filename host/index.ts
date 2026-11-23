// host/index.ts — the public surface. Import from here, never from a stage,
// so the pipeline stays free to move between files.

export type * from "./contracts.ts";
export { Ledger } from "./ledger.ts";
export type { CounterName, LedgerInit, SpanHandle } from "./ledger.ts";
export { intake, mergeLimits } from "./intake.ts";
export { buildRequest, budgetFor } from "./build.ts";
export { decompose, describePlan, validatePlan } from "./decompose.ts";
export { executePlan, substituteRefs } from "./execute.ts";
export { createHostRouter } from "./host.ts";
export type { HostRouterOptions } from "./host.ts";
export { createMemoryPorts, memoryPortsWithEvents } from "./adapters/memory.ts";
export type { MemoryPortsOptions } from "./adapters/memory.ts";
export { DEFAULT_LIMITS } from "./support.ts";
