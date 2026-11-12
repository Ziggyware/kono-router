// routes/images.ts — Images route registrations extracted from main.ts.
// main.ts calls registerImages() at the position of this area's first route, preserving registration order.

import { clamp as clampNum } from "../math.ts";
import { startTrace } from "../trace.ts";
import { IMAGE_STATS } from "../main.ts";
import type { Json } from "../main.ts";
import { errText, logErr, buildRotatedHeaders } from "../util.ts";
import { IMAGE_BLOCKED, kv, honoApp, IMAGE_MODELS } from "../state.ts";
import { IMAGE_BLOCK_KV, requireAdmin } from "../engine/core.ts";
import { openAIImageBackends } from "../engine/mesh.ts";


export const IMAGE_BLOCK_MS = 24 * 3600 * 1000;


export async function noteImageOutcome(id: string, err?: unknown): Promise<void> {
  const st = IMAGE_STATS.get(id) ?? { ok: 0, fail: 0 };
  if (err === undefined) { st.ok++; IMAGE_STATS.set(id, st); return; }
  st.fail++; IMAGE_STATS.set(id, st);
  if (/HTTP (401|402|403)\b/.test(errText(err))) {
    IMAGE_BLOCKED.add(id);
    await kv.set([IMAGE_BLOCK_KV, id], Date.now(), { expireIn: IMAGE_BLOCK_MS }).catch(logErr);
  }
}


export async function generateViaOpenAIImages(url: string, headers: Record<string, string>, model: string, prompt: string, size: string): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...buildRotatedHeaders(headers), "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, n: 1, size }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`images HTTP ${res.status}`);
  const j = await res.json().catch(() => null) as Json | null;
  const first = Array.isArray(j?.data) ? (j!.data as Json[])[0] : null;
  if (typeof first?.url === "string" && /^(https?:|data:image\/)/.test(first.url)) return first.url;
  if (typeof first?.b64_json === "string" && first.b64_json.length > 512) return `data:image/png;base64,${first.b64_json}`;
  throw new Error("images response carried no image");
}



export function parseImageSize(size: unknown): { width: number; height: number } {
  switch (String(size || "1024x1024")) {
    case "512x512": return { width: 512, height: 512 };
    case "1024x1024": return { width: 1024, height: 1024 };
    case "1024x576": return { width: 1024, height: 576 };
    case "576x1024": return { width: 576, height: 1024 };
    case "1792x1024": return { width: 1792, height: 1024 };
    case "1024x1792": return { width: 1024, height: 1792 };
    default: return { width: 1024, height: 1024 };
  }
}



export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}



export async function generateViaPollinations(
  prompt: string,
  width: number,
  height: number,
  upstreamModel: string,
  seed: number,
): Promise<string> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&seed=${seed}&model=${upstreamModel}&nologo=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Pollinations image HTTP ${res.status}`);
  // Drain the body so the generation completes server-side; the returned URL
  // is seed-stable, so the client fetch renders the same image. A JSON/text
  // error page or a tiny body is NOT an image and must fall through to the
  // next backend rather than being reported as a successful generation.
  const buf = await res.arrayBuffer();
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("json") || contentType.includes("text/html") || buf.byteLength < 512) {
    throw new Error(`Pollinations returned a non-image body (${contentType || "no content-type"}, ${buf.byteLength} bytes)`);
  }
  return url;
}



export async function generateViaHorde(prompt: string, width: number, height: number, budgetMs = 45000): Promise<string> {
  const submit = await fetch("https://stablehorde.net/api/v2/generate/async", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: "0000000000" },
    body: JSON.stringify({
      prompt,
      params: { width, height, steps: 20, sampler_name: "k_euler", cfg_scale: 7, n: 1 },
      models: ["stable_diffusion"],
      slow_workers: true,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!submit.ok) throw new Error(`AI Horde submit HTTP ${submit.status}`);
  const job = await submit.json();
  const jobId = String(job.id || "");
  if (!jobId) throw new Error("AI Horde submit returned no job id");
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const chkRes = await fetch(`https://stablehorde.net/api/v2/generate/check/${jobId}`, {
      signal: AbortSignal.timeout(15000),
    });
    const chk = await chkRes.json();
    if (chk.faulted) throw new Error("AI Horde job faulted");
    if (chk.done) {
      const stRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${jobId}`, {
        signal: AbortSignal.timeout(15000),
      });
      const st = await stRes.json();
      const img = st?.generations?.[0]?.img;
      if (img) return String(img);
      throw new Error("AI Horde finished without an image");
    }
  }
  throw new Error("AI Horde generation timed out");
}

export function registerImages() {


// NOTE: there is deliberately NO locally generated "providers unavailable"
// placeholder image. A generation that no backend produced is reported as
// still processing (HTTP 503, kono.still_processing) — never as a fake image.

// Classify every discovered OpenAI-standard image backend with one small
// generation each (16 at a time): keyless-working, needs key/payment
// (blocked for a day), or failing. Admin, because it spends upstream quota.
honoApp.post("/v1/images/probe", requireAdmin, async (c) => {
  const backends = await openAIImageBackends();
  const results: Array<{ id: string; ok: boolean; blocked: boolean; error?: string }> = [];
  for (let i = 0; i < backends.length; i += 16) {
    await Promise.all(backends.slice(i, i + 16).map(async (b) => {
      try {
        await generateViaOpenAIImages(b.url, b.headers, b.model, "a small red circle", "256x256");
        await noteImageOutcome(b.id);
        results.push({ id: b.id, ok: true, blocked: false });
      } catch (e) {
        await noteImageOutcome(b.id, e);
        results.push({ id: b.id, ok: false, blocked: IMAGE_BLOCKED.has(b.id), error: errText(e).slice(0, 160) });
      }
    }));
  }
  return c.json({
    probed: results.length,
    working: results.filter((r) => r.ok).map((r) => r.id),
    blocked: results.filter((r) => r.blocked).length,
    failing: results.filter((r) => !r.ok && !r.blocked).map((r) => ({ id: r.id, error: r.error })),
  });
});


honoApp.post("/v1/images/generations", async (c) => {
  const body = await c.req.json().catch(() => ({} as Json)) as Json;
  const prompt = String(body.prompt || "").trim() || "abstract geometric composition";
  const requestedModel = String(body.model || "kono-image");
  const spec = IMAGE_MODELS.find((img) => img.id === requestedModel) || IMAGE_MODELS[0];
  const sizeText = `${parseImageSize(body.size).width}x${parseImageSize(body.size).height}`;
  const standard = await openAIImageBackends().catch(() => []);
  const pinned = standard.find((b) => b.id === requestedModel);
  const { width, height } = parseImageSize(body.size);
  const n = Math.round(clampNum(Number(body.n || 1) || 1, 1, 4));
  const wantB64 = String(body.response_format || "url") === "b64_json";
  const root = startTrace("images.generations", { "model.requested": requestedModel, n, width, height, b64: wantB64 }, c.req.header("traceparent"));
  root.io("request", body);

  // There is no placeholder image: a generation that no backend produced is
  // never answered with a fabricated "unavailable" picture. Instead the server
  // keeps sweeping EVERY candidate provider — built-ins plus the full
  // discovered OpenAI-standard catalog — in multiple rounds until a deadline,
  // and only then reports the request as still processing (HTTP 503).
  type Variant = { id: string; provider: string; upstreamModel: string; url?: string; headers?: Record<string, string> };
  const asVariant = (b: typeof standard[number]): Variant => ({ id: b.id, provider: "openai-images", upstreamModel: b.model, url: b.url, headers: b.headers });
  // A specific backend chosen by name runs alone: falling back would silently
  // answer from a different model. Only "kono-image" (the default), an unknown
  // id, or fallback: true walks the whole chain.
  const named = pinned ? asVariant(pinned) : IMAGE_MODELS.find((m) => m.id === requestedModel && m.id !== "kono-image");
  const builtin: Variant[] = [spec, ...IMAGE_MODELS.filter((m) => m.id !== spec.id)];
  const chain: Variant[] = named && body.fallback !== true ? [named] : [
    ...builtin.filter((v) => v.provider !== "horde"),
    ...standard.map(asVariant), // the ENTIRE discovered catalog, not a prefix
    ...builtin.filter((v) => v.provider === "horde"),
  ];
  // Full-chain sweep rounds: a transient upstream failure is retried after the
  // whole chain was reviewed once, so one bad provider never ends the request.
  const ROUNDS = 3;
  const DEADLINE_MS = 150_000;
  const deadline = Date.now() + DEADLINE_MS;
  const errors: string[] = [];
  const data: Array<{ url?: string; b64_json?: string }> = [];
  const winners: string[] = [];
  let pending = 0;

  for (let i = 0; i < n; i++) {
    let url: string | null = null;
    for (let round = 0; round < ROUNDS && !url; round++) {
      for (const variant of chain) {
        if (url || Date.now() >= deadline) break;
        const attempt = root.child("attempt", { backend: variant.id, provider: variant.provider, image: i, round: round + 1 });
        try {
          if (variant.provider === "horde") {
            url = await attempt.run(() => generateViaHorde(prompt, width, height));
          } else if (variant.provider === "openai-images") {
            try {
              url = await attempt.run(() => generateViaOpenAIImages(variant.url!, variant.headers ?? {}, variant.upstreamModel, prompt, sizeText));
              await noteImageOutcome(variant.id);
            } catch (e) { await noteImageOutcome(variant.id, e); throw e; }
          } else {
            const seed = Math.floor(Math.random() * 1000000) + i;
            url = await attempt.run(() => generateViaPollinations(prompt, width, height, variant.upstreamModel, seed));
          }
          attempt.end("ok", { outcome: "won" });
          winners.push(variant.id);
        } catch (err) {
          attempt.end("error", { outcome: "failed", error: errText(err).slice(0, 200) });
          errors.push(`${variant.id}: ${errText(err)}`);
          console.warn(`[image] ${variant.id} failed (round ${round + 1}): ${errText(err)}`);
        }
      }
      if (!url && round < ROUNDS - 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500)); // brief pause, then review every provider again
      }
    }
    if (!url) {
      // No backend produced an image yet: the generation is STILL PROCESSING.
      // Do not emit any image payload — the client keeps a "processing" card.
      pending++;
      continue;
    }
    if (wantB64) {
      try {
        if (url.startsWith("data:")) {
          data.push({ b64_json: url.split(",")[1] ?? "" });
        } else {
          const imgRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (!imgRes.ok) throw new Error(`Image fetch HTTP ${imgRes.status}`);
          data.push({ b64_json: bytesToBase64(await imgRes.arrayBuffer()) });
        }
      } catch (err) {
        errors.push(`image-fetch: ${errText(err)}`);
        pending++;
      }
    } else {
      data.push({ url });
    }
  }

  const stillProcessing = pending > 0;
  root.io("response", { backends: winners, pending, still_processing: stillProcessing, errors, data: data.map((d) => d.url ? { url: d.url.length > 300 ? d.url.slice(0, 300) + "…" : d.url } : { b64_json: `(${d.b64_json?.length ?? 0} base64 chars)` }) });
  root.end(pending ? "error" : "ok", { pending, images: data.length, backend_errors: errors.length, providers_reviewed: chain.length * ROUNDS });
  if (data.length === 0) {
    // Every provider was reviewed (all rounds); nothing produced an image yet.
    // Answer 503 + still_processing — never an "image providers unavailable" image.
    return c.json({
      error: {
        message: `All ${chain.length} image provider(s) were reviewed across ${ROUNDS} sweep(s) and none returned an image yet; generation is still processing — retry shortly. ${errors[0] ?? ""}`,
        type: "server_error",
        code: "image_providers_busy",
      },
      kono: {
        still_processing: true,
        requested_model: requestedModel,
        backends: winners,
        providers_reviewed: chain.length,
        sweeps: ROUNDS,
        errors: errors.slice(0, 8),
        trace_id: root.traceId,
      },
    }, 503, {
      traceparent: root.traceparent,
      "Server-Timing": `total;dur=${Math.round(root.ms)}`,
      "X-Kono-Still-Processing": "1",
    });
  }
  return c.json({
    created: Math.floor(Date.now() / 1000),
    data,
    kono: {
      degraded: stillProcessing,
      still_processing: stillProcessing,
      pending,
      requested_model: requestedModel,
      backends: winners,
      backends_tried: errors.length + data.length,
      errors: errors.slice(0, 8),
      trace_id: root.traceId,
    },
  }, 200, {
    traceparent: root.traceparent,
    "Server-Timing": `total;dur=${Math.round(root.ms)}`,
    ...(stillProcessing ? { "X-Kono-Still-Processing": "1" } : {}),
  });
});
}
