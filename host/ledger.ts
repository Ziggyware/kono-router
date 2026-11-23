// host/ledger.ts — the visibility layer. Every stage writes here and nowhere
// else, so "what is the model doing and when" has exactly one answer: the event
// stream. Events are appended, never mutated, and carry a monotonic seq plus
// two clocks (relative ms for humans, epoch ms for joining with upstream logs).

import type {
  EventSink,
  HostEvent,
  Json,
  Note,
  Phase,
  StageName,
  StageSummary,
} from "./contracts.ts";
import { errText } from "./support.ts";

export interface LedgerInit {
  requestId: string;
  startedAt: number;
  clock?: () => number;
  sinks?: EventSink[];
}

/** An open stage measurement. `end` is idempotent, so a `finally` block and an
 *  error path can both close it without double-counting. */
export interface SpanHandle {
  end(ok: boolean, data?: Json): HostEvent;
  fail(e: unknown, data?: Json): HostEvent;
}

/** Hard cap on retained events. Beyond it, events still reach sinks and are
 *  still counted; only the in-memory copy stops growing. */
const MAX_EVENTS = 4_000;

export type CounterName = "model_calls" | "tool_calls" | "retries" | "errors";

export class Ledger {
  readonly requestId: string;
  readonly events: HostEvent[] = [];
  readonly notes: Note[] = [];
  readonly startedAt: number;
  private readonly clock: () => number;
  private readonly sinks: EventSink[];
  private seq = 0;
  private dropped = 0;
  private readonly counts: Record<CounterName, number> = {
    model_calls: 0,
    tool_calls: 0,
    retries: 0,
    errors: 0,
  };

  constructor(init: LedgerInit) {
    this.requestId = init.requestId;
    this.startedAt = init.startedAt;
    this.clock = init.clock ?? (() => Date.now());
    this.sinks = init.sinks ?? [];
  }

  /** ms since request start. */
  elapsed(): number {
    return Math.max(0, this.clock() - this.startedAt);
  }

  emit(e: {
    stage: StageName;
    phase: Phase;
    chunkId?: string;
    attempt?: number;
    model?: string;
    tupleId?: string;
    ok?: boolean;
    ms?: number;
    data?: Json;
  }): HostEvent {
    const ev: HostEvent = {
      seq: ++this.seq,
      requestId: this.requestId,
      at: this.elapsed(),
      wall: this.clock(),
      stage: e.stage,
      phase: e.phase,
      ...(e.chunkId !== undefined ? { chunkId: e.chunkId } : {}),
      ...(e.attempt !== undefined ? { attempt: e.attempt } : {}),
      ...(e.model !== undefined ? { model: e.model } : {}),
      ...(e.tupleId !== undefined ? { tupleId: e.tupleId } : {}),
      ...(e.ok !== undefined ? { ok: e.ok } : {}),
      ...(e.ms !== undefined ? { ms: e.ms } : {}),
      ...(e.data !== undefined ? { data: e.data } : {}),
    };
    if (this.events.length < MAX_EVENTS) this.events.push(ev);
    else this.dropped++;
    if (ev.ok === false) this.counts.errors++;
    for (const sink of this.sinks) {
      // A broken sink must never break routing.
      try {
        sink(ev);
      } catch {
        /* ignore */
      }
    }
    return ev;
  }

  span(stage: StageName, data?: Json): SpanHandle {
    const t0 = this.clock();
    let last: HostEvent = this.emit({ stage, phase: "start", data });
    let closed = false;
    const close = (ok: boolean, extra?: Json): HostEvent => {
      if (closed) return last;
      closed = true;
      const ms = this.clock() - t0;
      last = this.emit({
        stage,
        phase: ok ? "end" : "error",
        ok,
        ms,
        data: extra === undefined ? data : { ...(data ?? {}), ...extra },
      });
      return last;
    };
    return {
      end: (ok: boolean, extra?: Json) => close(ok, extra),
      fail: (e: unknown, extra?: Json) =>
        close(false, { error: errText(e).slice(0, 300), ...(extra ?? {}) }),
    };
  }

  bump(name: CounterName, by = 1): void {
    this.counts[name] += by;
  }

  counters(): Record<CounterName, number> {
    return { ...this.counts };
  }

  droppedEvents(): number {
    return this.dropped;
  }

  addNote(n: Note): Note {
    this.notes.push(n);
    return n;
  }

  summarize(): StageSummary[] {
    const byStage = new Map<StageName, StageSummary>();
    for (const ev of this.events) {
      const row = byStage.get(ev.stage) ?? { stage: ev.stage, events: 0, ms: 0, errors: 0 };
      row.events++;
      if (ev.phase === "end" || ev.phase === "error") row.ms += ev.ms ?? 0;
      if (ev.ok === false) row.errors++;
      byStage.set(ev.stage, row);
    }
    return [...byStage.values()].sort((a, b) => {
      const first = this.events.find((e) => e.stage === a.stage)?.seq ?? 0;
      const second = this.events.find((e) => e.stage === b.stage)?.seq ?? 0;
      return first - second;
    });
  }
}
