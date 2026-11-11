// routes/traces.ts — Traces route registrations extracted from main.ts.
// main.ts calls registerTraces() at the position of this area's first route, preserving registration order.

import { clamp as clampNum } from "../math.ts";
import { listTraces, subscribe, getTrace } from "../trace.ts";
import { honoApp, SSE_HEADERS } from "../state.ts";
import { requireAdmin } from "../engine/core.ts";

export function registerTraces() {


// Isolate-local trace ring (Deno Deploy's OTel view aggregates all isolates).
honoApp.get("/v1/traces", requireAdmin, (c) => {
  const limit = Math.round(clampNum(Number(c.req.query("limit")) || 100, 1, 256));
  return c.json({ object: "list", data: listTraces(limit) });
});


// Live tail: every span start/event/end as SSE. fetch()-readable (EventSource cannot send auth headers).
honoApp.get("/v1/traces/live", requireAdmin, (c) => {
  const enc = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (s: string) => {
        try {
          ctrl.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      send(": live\n\n");
      const unsubscribe = subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`));
      const hb = setInterval(() => send(": hb\n\n"), 15_000);
      stop = () => {
        clearInterval(hb);
        unsubscribe();
      };
      c.req.raw.signal.addEventListener("abort", () => {
        stop();
        try {
          ctrl.close();
        } catch { /* already closed */ }
      }, { once: true });
    },
    cancel: () => stop(),
  });
  return new Response(body, { headers: SSE_HEADERS });
});


honoApp.get("/v1/traces/:id", requireAdmin, (c) => {
  const t = getTrace(c.req.param("id"));
  return t ? c.json(t) : c.json({ error: { message: "Trace not in this isolate's ring" } }, 404);
});
}
