// Request tracing: one span tree per request, kept in an isolate-local ring
// for the admin panel and mirrored to OpenTelemetry, which Deno Deploy
// collects natively (no-op API when OTel is off, e.g. in tests).
import { context, type Span as OSpan, SpanStatusCode, trace as otel } from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";

export type Attr = string | number | boolean;
export type Attrs = Record<string, Attr | undefined>;
export type SpanStatus = "unset" | "ok" | "error";

export interface SpanRec {
  id: string;
  parent: string | null;
  name: string;
  start: number;
  end: number | null;
  status: SpanStatus;
  attrs: Record<string, Attr>;
  events: Array<{ t: number; name: string; attrs?: Record<string, Attr> }>;
  /** Request/response bodies (JSON, capped), for the admin panel only: never exported to OTel. */
  io?: { request?: string; response?: string };
}

export interface TraceRec {
  id: string;
  spans: SpanRec[];
}

export type TraceEvent = { type: "start" | "end" | "event"; trace: string; span: SpanRec };

const RING_MAX = 256;
const IO_MAX = 32_000;
const ring = new Map<string, TraceRec>(); // insertion-ordered: oldest first
const subscribers = new Set<(e: TraceEvent) => void>();
const tracer = otel.getTracer("nokey-router");
const als = new AsyncLocalStorage<Span>();
const now = () => performance.timeOrigin + performance.now();
const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const INVALID = /^0+$/;

function clean(a: Attrs): Record<string, Attr> {
  const out: Record<string, Attr> = {};
  for (const [k, v] of Object.entries(a)) if (v !== undefined && !(typeof v === "number" && !Number.isFinite(v))) out[k] = v;
  return out;
}

function publish(type: TraceEvent["type"], trace: string, span: SpanRec) {
  for (const fn of subscribers) {
    try {
      fn({ type, trace, span });
    } catch { /* a broken subscriber must not break the request */ }
  }
}

export class Span {
  readonly rec: SpanRec;
  constructor(readonly traceId: string, readonly otelSpan: OSpan, name: string, parent: string | null, attrs: Attrs) {
    const sc = otelSpan.spanContext();
    this.rec = {
      id: INVALID.test(sc.spanId) ? hex(8) : sc.spanId,
      parent,
      name,
      start: now(),
      end: null,
      status: "unset",
      attrs: clean(attrs),
      events: [],
    };
    ring.get(traceId)?.spans.push(this.rec);
    publish("start", traceId, this.rec);
  }

  child(name: string, attrs: Attrs = {}): Span {
    const ctx = otel.setSpan(context.active(), this.otelSpan);
    return new Span(this.traceId, tracer.startSpan(name, { attributes: clean(attrs) }, ctx), name, this.rec.id, attrs);
  }

  set(attrs: Attrs): this {
    const a = clean(attrs);
    Object.assign(this.rec.attrs, a);
    this.otelSpan.setAttributes(a);
    return this;
  }

  /** Keeps a capped JSON copy of the request or response body on this span. */
  io(kind: "request" | "response", value: unknown): void {
    let text: string;
    try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
    if (text.length > IO_MAX) text = text.slice(0, IO_MAX) + `\n… truncated (${text.length} chars)`;
    (this.rec.io ??= {})[kind] = text;
    publish("event", this.traceId, this.rec);
  }

  event(name: string, attrs: Attrs = {}): void {
    const a = clean(attrs);
    this.rec.events.push({ t: now(), name, attrs: a });
    this.otelSpan.addEvent(name, a);
    publish("event", this.traceId, this.rec);
  }

  end(status: SpanStatus = "ok", attrs: Attrs = {}): void {
    if (this.rec.end !== null) return;
    this.set(attrs);
    this.rec.end = now();
    this.rec.status = status;
    if (status !== "unset") {
      this.otelSpan.setStatus({ code: status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR, message: String(attrs.error ?? "") });
    }
    this.otelSpan.end();
    publish("end", this.traceId, this.rec);
  }

  /** Runs fn with this span active for OTel auto-instrumentation (fetch) and currentSpan(). */
  run<T>(fn: () => T): T {
    return context.with(otel.setSpan(context.active(), this.otelSpan), () => als.run(this, fn));
  }

  get traceparent(): string {
    return `00-${this.traceId}-${this.rec.id}-01`;
  }

  get ms(): number {
    return (this.rec.end ?? now()) - this.rec.start;
  }
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Opens a root span. Joins the caller's W3C trace when OTel is off; OTel's own context wins otherwise. */
export function startTrace(name: string, attrs: Attrs = {}, traceparent?: string | null): Span {
  const o = tracer.startSpan(name, { attributes: clean(attrs) }, context.active());
  const sc = o.spanContext();
  const inbound = traceparent ? TRACEPARENT.exec(traceparent.trim().toLowerCase()) : null;
  const traceId = !INVALID.test(sc.traceId) ? sc.traceId : inbound && !INVALID.test(inbound[1]) ? inbound[1] : hex(16);
  // A joined trace already in the ring keeps its spans (in-process sub-requests nest under their parent).
  if (!ring.has(traceId)) ring.set(traceId, { id: traceId, spans: [] });
  while (ring.size > RING_MAX) ring.delete(ring.keys().next().value!);
  const span = new Span(traceId, o, name, inbound?.[2] ?? null, attrs);
  return span;
}

export const currentSpan = (): Span | undefined => als.getStore();

export function getTrace(id: string): TraceRec | undefined {
  return ring.get(id);
}

export function listTraces(limit = 100): Array<{ id: string; root: SpanRec; spans: number; errors: number }> {
  const out = [];
  for (const t of [...ring.values()].reverse()) {
    if (out.length >= limit) break;
    const root = t.spans[0];
    if (root) out.push({ id: t.id, root, spans: t.spans.length, errors: t.spans.filter((s) => s.status === "error").length });
  }
  return out;
}

export function subscribe(fn: (e: TraceEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
