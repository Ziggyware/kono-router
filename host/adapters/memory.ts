// host/adapters/memory.ts — a complete set of ports with no network, no KV and
// no clock of its own. This is the adapter the tests use and the one a host
// boots with before it has a catalog: if the pipeline cannot run the simplest
// possible request through these, it cannot run anything.

import type {
  CandidateRef,
  HostEvent,
  HostPorts,
  Json,
  ModelCall,
  ModelReply,
  ToolDecl,
  ToolResult,
} from "../contracts.ts";
import { isRecord, safeStringify, sleep } from "../support.ts";

export interface MemoryPortsOptions {
  /** Planner reply. Return a string, a JSON value, or null for the default plan. */
  planner?: (call: ModelCall) => Json | string | null | Promise<Json | string | null>;
  /** Answer text for a chunk or synthesis call. */
  answer?: (call: ModelCall) => string | Promise<string>;
  /** Make every planner call throw (exercises the fallback path). */
  failPlanner?: boolean;
  /** Tool implementations by name. Defaults to a tiny lookup/calc pair. */
  tools?: Record<string, (args: Json, signal: AbortSignal) => unknown | Promise<unknown>>;
  candidates?: CandidateRef[];
  /** Artificial latency per model call. */
  latencyMs?: number;
}

const BUILTIN_TOOLS: ToolDecl[] = [
  {
    name: "web_lookup",
    description: "Look up current facts about a topic.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
    source: "builtin",
  },
  {
    name: "calculate",
    description: "Evaluate an arithmetic expression exactly.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    source: "builtin",
  },
];

const DEFAULT_CANDIDATES: CandidateRef[] = [
  {
    tupleId: "memory::planner-1",
    providerId: "memory",
    modelId: "memory-model",
    score: 0.9,
    supportsTools: true,
    supportsVision: false,
    contextWindow: 32_000,
    p50TtftMs: 40,
  },
  {
    tupleId: "memory::planner-2",
    providerId: "memory",
    modelId: "memory-model-alt",
    score: 0.8,
    supportsTools: true,
    supportsVision: false,
    contextWindow: 32_000,
    p50TtftMs: 60,
  },
];

/** The default plan: one lookup, one draft, one tighten. Written to be small,
 *  ordered, and to exercise a real dependency edge. */
function defaultPlan(hasLookup: boolean): Json {
  const chunks: Json[] = [];
  if (hasLookup) {
    chunks.push({
      id: "facts",
      title: "Collect facts",
      kind: "tool",
      tool: "web_lookup",
      args: { topic: "the user's request" },
      needs: [],
    });
  }
  chunks.push({
    id: "draft",
    title: "Draft the answer",
    kind: "answer",
    needs: hasLookup ? ["facts"] : [],
    prompt: "Answer the user's request in two sentences.",
  });
  chunks.push({
    id: "polish",
    title: "Tighten the answer",
    kind: "answer",
    needs: ["draft"],
    prompt: "Rewrite the draft as one short, concrete sentence.",
  });
  return { rationale: "look up, draft, tighten", chunks };
}

function catalogText(call: ModelCall): string {
  const user = [...call.messages].reverse().find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

export function createMemoryPorts(options: MemoryPortsOptions = {}): HostPorts {
  const toolImpls = options.tools ?? {
    web_lookup: (args: Json) => ({
      topic: typeof args.topic === "string" ? args.topic : "unknown",
      facts: ["a", "b", "c"],
    }),
    calculate: (args: Json) => ({
      expression: typeof args.expression === "string" ? args.expression : "",
      value: 42,
    }),
  };

  const complete = async (call: ModelCall): Promise<ModelReply> => {
    const started = Date.now();
    if (options.latencyMs) await sleep(options.latencyMs, call.signal);
    if (call.signal.aborted) throw call.signal.reason ?? new Error("ABORTED");

    if (call.purpose === "planner" || call.purpose === "repair") {
      if (options.failPlanner) throw new Error("HTTP_503: planner unavailable");
      const reply = options.planner
        ? await options.planner(call)
        : defaultPlan(/-\s*web_lookup/.test(catalogText(call)));
      const content = reply === null
        ? safeStringify(defaultPlan(/-\s*web_lookup/.test(catalogText(call))))
        : typeof reply === "string"
        ? reply
        : safeStringify(reply);
      return {
        content,
        model: "memory-planner",
        ms: Date.now() - started,
        upstreamAttempts: 1,
      };
    }

    if (call.purpose === "synthesize") {
      const content = options.answer
        ? await options.answer(call)
        : `[synthesize] ${catalogText(call).split("\n").filter(Boolean).slice(-1)[0] ?? ""}`;
      return { content, model: "memory-synth", ms: Date.now() - started, upstreamAttempts: 1 };
    }

    const content = options.answer
      ? await options.answer(call)
      : `[${call.chunkId ?? "single"}] answered`;
    return { content, model: "memory-answer", ms: Date.now() - started, upstreamAttempts: 1 };
  };

  return {
    candidates: {
      async rank() {
        return options.candidates ?? DEFAULT_CANDIDATES;
      },
    },
    models: { complete },
    tools: {
      list() {
        return BUILTIN_TOOLS;
      },
      has(name: string) {
        return Object.prototype.hasOwnProperty.call(toolImpls, name);
      },
      async execute(name: string, args: Json, o): Promise<ToolResult> {
        const impl = toolImpls[name];
        const started = Date.now();
        if (!impl) {
          return { ok: false, error: `unknown tool ${name}`, code: "unknown_tool", ms: 0 };
        }
        try {
          const value = await impl(args, o.signal);
          return { ok: true, value, ms: Date.now() - started };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : safeStringify(e, 200),
            code: isRecord(e) && typeof (e as Json).code === "string"
              ? String((e as Json).code)
              : "tool_error",
            ms: Date.now() - started,
          };
        }
      },
    },
  };
}

/** Convenience: an in-memory router that can be called in one line. */
export function memoryPortsWithEvents(
  collected: HostEvent[],
  options: MemoryPortsOptions = {},
): HostPorts {
  const ports = createMemoryPorts(options);
  return { ...ports, events: (e) => collected.push(e) };
}
