// A durable task board. Agents that plan without externalising the plan drift;
// this gives them one call to write the plan down, one to advance it, and one to
// read it back after a context reset. Statuses are a small state machine, not
// free text, so "what is next?" has a deterministic answer.

import { store } from "./store.ts";
import { truncate, ulid } from "./util.ts";
import type { Json, ToolSpec } from "./types.ts";

type Status = "pending" | "active" | "blocked" | "done";
const ORDER: Record<Status, number> = { active: 0, pending: 1, blocked: 2, done: 3 };

interface Task {
  id: string;
  title: string;
  status: Status;
  priority: number;
  notes: string;
  created: number;
  updated: number;
  due?: number;
}

const tasks = (ctx: Parameters<ToolSpec["run"]>[1]) => store(ctx.caps);

export const taskTools: ToolSpec[] = [
  {
    name: "task",
    kind: "task",
    aliases: ["todo", "plan", "task_board", "checklist"],
    description:
      "A durable task board for multi-step work. add creates a task, update moves it between pending/active/blocked/done or edits it, list returns the board with the next action first, clear removes finished tasks. Use it to externalise a plan before a long tool-using run and to report progress precisely.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "update", "list", "clear"], default: "list" },
        id: { type: "string", description: "Task id (or a unique prefix)." },
        title: { type: "string" },
        status: { type: "string", enum: ["pending", "active", "blocked", "done"] },
        priority: { type: "integer", minimum: 0, maximum: 3, description: "0 = normal, 1 = high, 2 = urgent, 3 = critical." },
        notes: { type: "string" },
        due: { type: "string", description: "ISO-8601 due date." },
        include_done: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = tasks(ctx);
      const op = String(args.op ?? "list");
      const load = async (): Promise<Task[]> =>
        (await s.list<Task>(["task"], { limit: 500 }))
          .map((r) => r.value)
          .filter((t) => t && typeof t.title === "string")
          .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.priority - a.priority || a.created - b.created);

      const find = (list: Task[], id: string): Task | undefined => {
        const exact = list.find((t) => t.id === id);
        if (exact) return exact;
        const matches = list.filter((t) => t.id.startsWith(id));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw new Error(`id prefix "${id}" is ambiguous`);
        return undefined;
      };

      if (op === "add") {
        const title = String(args.title ?? "").trim();
        if (!title) throw new Error("title is required");
        const task: Task = {
          id: ulid(ctx.now).slice(-12).toLowerCase(),
          title: title.slice(0, 400),
          status: (args.status as Status) ?? "pending",
          priority: Math.max(0, Math.min(3, Number(args.priority ?? 0))),
          notes: String(args.notes ?? "").slice(0, 4000),
          created: ctx.now,
          updated: ctx.now,
          ...(args.due ? { due: Date.parse(String(args.due)) || undefined } : {}),
        };
        await s.put(["task", task.id], task);
        return { op, added: task, next: task.title };
      }

      if (op === "update") {
        const list = await load();
        const id = String(args.id ?? "");
        if (!id) throw new Error("id is required for update");
        const task = find(list, id);
        if (!task) throw new Error(`no task matches "${id}"`);
        const next: Task = {
          ...task,
          ...(args.title !== undefined ? { title: String(args.title).slice(0, 400) } : {}),
          ...(args.status !== undefined ? { status: args.status as Status } : {}),
          ...(args.priority !== undefined ? { priority: Math.max(0, Math.min(3, Number(args.priority))) } : {}),
          ...(args.notes !== undefined ? { notes: String(args.notes).slice(0, 4000) } : {}),
          ...(args.due !== undefined ? { due: Date.parse(String(args.due)) || undefined } : {}),
          updated: ctx.now,
        };
        await s.put(["task", task.id], next);
        return { op, updated: next };
      }

      if (op === "clear") {
        const list = await load();
        const victims = args.status === "done" || args.status === undefined
          ? list.filter((t) => t.status === "done")
          : list.filter((t) => t.status === args.status);
        await Promise.all(victims.map((t) => s.del(["task", t.id])));
        return { op, cleared: victims.length, remaining: list.length - victims.length };
      }

      const list = await load();
      const shown = args.include_done === true ? list : list.filter((t) => t.status !== "done");
      const counts = list.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {});
      const active = shown.find((t) => t.status === "active") ?? shown.find((t) => t.status === "pending");
      return {
        op: "list",
        total: list.length,
        counts,
        next: active ? { id: active.id, title: active.title } : null,
        tasks: shown.map((t) => ({
          id: t.id, title: truncate(t.title, 240), status: t.status, priority: t.priority,
          ...(t.notes ? { notes: truncate(t.notes, 300) } : {}),
          ...(t.due ? { due: new Date(t.due).toISOString() } : {}),
          updated: new Date(t.updated).toISOString(),
        })),
      };
    },
  },
];

export type { Json };
