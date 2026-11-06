// Multi-agent work: one call fans a job out to specialised sub-agents that run
// concurrently, each a complete tool-using agent loop in the same session (so
// they share the workspace), and returns every agent's report. The kernel
// supplies the runner (caps.subagent); sub-agents get none, so teams never nest.

import type { Json, SubagentResult, ToolSpec } from "./types.ts";

export const TEAM_ROLES: Record<string, string> = {
  builder: "You are a builder agent on a team. Implement exactly your assigned part in the workspace with the fs tools: read before editing, patch precisely, keep to your files unless the task says otherwise (teammates are editing other parts concurrently; a refused edit with a changed sha256 means re-read and re-apply). Run ws_check on your files and fix what it reports. Finish with a short report: files changed, what they do, anything left open.",
  tester: "You are a test engineer agent on a team. Write tests for the assigned behaviour into the workspace: tests/<flow>.test.json UI cases ({\"name\", \"steps\": [click/type/press/select/check/wait_for/expect/eval steps]}) for every user-visible flow, and *.test.js unit tests (test/expect) for non-trivial logic. Run app_test {all: true}. Do not change application code. Report each failing case with the step, the message and your diagnosis of the likely cause.",
  reviewer: "You are a code reviewer agent on a team. Read the relevant workspace files and run ws_check and app_debug. Find real defects: logic errors, broken edge cases, unhandled errors, accessibility and security problems, mismatches with the request. Do not edit files. Report each finding as file:line — the problem — the concrete fix, most severe first; say plainly if you found nothing.",
  debugger: "You are a debugging agent on a team. Reproduce the reported problem with app_debug and app_test, locate the root cause in the workspace code, apply the smallest correct fix with fs_patch, and confirm with app_debug (wait_ms) and app_test. Report the cause, the fix and the evidence it works.",
  researcher: "You are a research agent on a team. Use web_search and web_fetch to answer the assigned question with current, sourced facts (APIs, library usage, versions). Do not edit workspace files. Report concise findings with source URLs.",
};

export const teamTools: ToolSpec[] = [
  {
    name: "agent_team",
    kind: "task",
    aliases: ["spawn_agents", "delegate", "subagents", "parallel_agents", "team"],
    timeoutMs: 900_000,
    description:
      "Run up to 4 sub-agents concurrently and get each one's report. Every sub-agent is a full tool-using agent in this session, sharing the workspace. Roles: builder (implements an assigned part), tester (writes UI/unit tests and runs app_test; never edits app code), reviewer (reads and reports defects; never edits), debugger (reproduces, fixes root cause, confirms), researcher (web research). Use it to parallelise independent work — builders on separate files or areas, a tester writing tests while builders build, a reviewer after — and give each task the context it needs (files, conventions, acceptance criteria); sub-agents do not see this conversation. Sub-agents cannot start their own teams.",
    parameters: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: Object.keys(TEAM_ROLES) },
              task: { type: "string", description: "Self-contained assignment: goal, files/areas owned, constraints, how done is judged." },
              model: { type: "string", description: "Optional model or lane, e.g. free:code." },
            },
            required: ["role", "task"],
            additionalProperties: false,
          },
        },
      },
      required: ["agents"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const spawn = ctx.caps?.subagent;
      if (!spawn) throw new Error("sub-agents cannot start their own teams; do the work directly");
      const agents = (args.agents as Json[]).slice(0, 4).map((a) => ({ role: String(a.role), task: String(a.task ?? "").trim(), ...(typeof a.model === "string" && a.model ? { model: a.model } : {}) }));
      for (const a of agents) {
        if (!TEAM_ROLES[a.role]) throw new Error(`unknown role ${a.role}; use ${Object.keys(TEAM_ROLES).join(", ")}`);
        if (a.task.length < 8) throw new Error(`${a.role}: task is empty — give each agent a self-contained assignment`);
      }
      ctx.event?.("agent_team", { agents: agents.map((a) => a.role).join(",") });
      const settled = await Promise.allSettled(agents.map((a) => spawn(a, ctx.signal)));
      const reports: SubagentResult[] = settled.map((r, i) =>
        r.status === "fulfilled" ? r.value : { role: agents[i].role, ok: false, content: "", ms: 0, error: String((r.reason as Error)?.message ?? r.reason).slice(0, 300) }
      );
      return { agents: reports.length, ok: reports.every((r) => r.ok), reports };
    },
  },
];
