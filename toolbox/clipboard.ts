// A durable, named clipboard. Servers have no OS clipboard, so this is the
// practical equivalent: a small, versioned, per-tenant scratch board that survives
// turns and can be read by any tool or client. Slots let one board hold a draft,
// another a payload, without either clobbering the other.

import { store } from "./store.ts";
import { truncate } from "./util.ts";
import type { Json, ToolSpec } from "./types.ts";

const MAX_CHARS = 32_000;
const HISTORY = 5;

interface Slot {
  slot: string;
  text: string;
  rev: number;
  at: number;
  expires: number;
  history: Array<{ text: string; at: number; rev: number }>;
}

const slots = (ctx: Parameters<ToolSpec["run"]>[1]) => store(ctx.caps);

export const clipboardTools: ToolSpec[] = [
  {
    name: "clipboard",
    kind: "clipboard",
    aliases: ["clip", "scratchpad", "copy_paste", "buffer"],
    description:
      "Read and write a durable named clipboard. Use it to hand a payload between turns, keep a growing draft, or let a human pick something up from the workspace. Supports get/set/append/list/clear, per-slot TTL and a short revision history so a bad write can be undone.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["get", "set", "append", "list", "clear", "undo"], default: "get" },
        slot: { type: "string", default: "default", description: "Named buffer, e.g. draft, payload, todo." },
        text: { type: "string", description: "Content for set/append." },
        ttl_seconds: { type: "integer", minimum: 0, maximum: 2_592_000, default: 0, description: "0 = never expires." },
      },
      required: ["op"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const s = slots(ctx);
      const slot = String(args.slot ?? "default").replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 60) || "default";
      const key = ["clip", slot];
      const op = String(args.op ?? "get");
      const existing = await s.get<Slot>(key);

      if (op === "list") {
        const rows = await s.list<Slot>(["clip"], { limit: 200 });
        return {
          count: rows.length,
          slots: rows.map((r) => ({
            slot: r.value.slot, chars: r.value.text.length, rev: r.value.rev,
            at: new Date(r.value.at).toISOString(),
            preview: truncate(r.value.text.replace(/\s+/g, " "), 120),
          })),
        };
      }
      if (op === "clear") {
        if (!existing) return { op, slot, cleared: false };
        await s.del(key);
        return { op, slot, cleared: true, chars: existing.text.length };
      }
      if (op === "get") {
        if (!existing) return { op, slot, found: false, text: "" };
        return { op, slot, found: true, text: existing.text, chars: existing.text.length, rev: existing.rev, at: new Date(existing.at).toISOString(), history: existing.history.map((h) => ({ rev: h.rev, at: new Date(h.at).toISOString(), preview: truncate(h.text, 120) })) };
      }
      if (op === "undo") {
        if (!existing?.history.length) return { op, slot, undone: false, reason: "no history" };
        const [prev, ...rest] = existing.history;
        const restored: Slot = { ...existing, text: prev.text, at: Date.now(), rev: existing.rev + 1, history: rest };
        await s.put(key, restored, existing.expires || undefined);
        return { op, slot, undone: true, rev: restored.rev, chars: restored.text.length, text: restored.text };
      }

      const incoming = String(args.text ?? "");
      if (!incoming) throw new Error(`${op} needs text`);
      const merged = op === "append" && existing ? `${existing.text}${incoming}` : incoming;
      if (merged.length > MAX_CHARS) throw new Error(`clipboard slot exceeds ${MAX_CHARS} characters`);
      const ttl = Math.max(0, Math.min(2_592_000, Number(args.ttl_seconds ?? 0))) * 1000;
      const record: Slot = {
        slot,
        text: merged,
        rev: (existing?.rev ?? 0) + 1,
        at: Date.now(),
        expires: ttl > 0 ? Date.now() + ttl : 0,
        history: [
          ...(existing ? [{ text: existing.text, at: existing.at, rev: existing.rev }] : []),
          ...(existing?.history ?? []),
        ].slice(0, HISTORY),
      };
      await s.put(key, record, ttl > 0 ? ttl : undefined);
      return { op, slot, chars: merged.length, rev: record.rev, preview: truncate(merged, 240), expires: record.expires ? new Date(record.expires).toISOString() : null };
    },
  },
];

export type { Json };
