// The toolbox: one registry, built by composition. Each module is independent
// (types in, ToolSpec out), so adding a capability never means touching the
// kernel or the other tools.

import type { ToolSpec } from "./types.ts";
import { webTools } from "./web.ts";
import { fileTools } from "./files.ts";
import { projectTools } from "./project.ts";
import { testingTools } from "./testing.ts";
import { teamTools } from "./team.ts";
import { memoryTools } from "./memory.ts";
import { ragTools } from "./rag.ts";
import { embedTools } from "./vector.ts";
import { clipboardTools } from "./clipboard.ts";
import { taskTools } from "./task.ts";
import { computeTools as makeComputeTools } from "./compute.ts";

/** Kernel facilities a few tools need. Injected, never imported at runtime. */
export interface ToolboxApi {
  validateJson: (input: unknown, schema: unknown, options?: { coerce?: boolean }) => {
    ok: boolean;
    value: unknown;
    repaired?: boolean;
    repairs?: number;
    issues: Array<{ path: string; keyword: string; message: string; severity: string }>;
  };
}

export function toolboxTools(api: ToolboxApi): ToolSpec[] {
  return [
    ...webTools,
    ...fileTools,
    ...projectTools,
    ...testingTools,
    ...teamTools,
    ...memoryTools,
    ...ragTools,
    ...embedTools,
    ...clipboardTools,
    ...taskTools,
    ...makeComputeTools(api),
  ];
}

export function registerToolbox(register: (spec: ToolSpec) => unknown, api: ToolboxApi): void {
  for (const spec of toolboxTools(api)) register(spec);
}

export type { ToolSpec };
