// routes/catalog.ts — Catalog route registrations extracted from main.ts.
// main.ts calls registerCatalog() at the position of this area's first route, preserving registration order.

import { honoApp, SOURCE_FILE_SET, SOURCE_FILES } from "../state.ts";
import { endpointCoverage, loadTextFile } from "../engine/providers.ts";
import { buildModelList } from "../engine/mesh.ts";
import { requireAdmin } from "../engine/core.ts";
import { errText } from "../util.ts";

export function registerCatalog() {


// Live, dependency-free view of exactly what the exhaustive sweep will try.
honoApp.get("/v1/endpoints", async (c) => {
  try {
    const coverage = await endpointCoverage();
    return c.json({
      object: "list",
      policy: "every configured endpoint is attempted before a request can degrade",
      configured_endpoints: coverage.configured_endpoints,
      registry_endpoints: coverage.registry_endpoints,
      catalog_tuples: coverage.catalog_tuples,
      sweep_candidates: coverage.sweep_candidates,
      data: coverage.endpoints,
    });
  } catch (err) {
    return c.json({ object: "list", data: [], error: errText(err) }, 200);
  }
});


honoApp.get("/v1/models", async (c) => c.json(await buildModelList()));

honoApp.get("/v1/source", requireAdmin, (c) => {
  const file = c.req.query("file") || "";
  const ALLOWED = SOURCE_FILE_SET;
  if (!ALLOWED.has(file)) {
    return c.json({ error: { message: "File is not in the readable allowlist" } }, 400);
  }
  const content = loadTextFile(file);
  if (content === null) {
    return c.json({ error: { message: `File not readable in this deployment: ${file}` } }, 404);
  }
  return c.json({ file, bytes: content.length, lines: content.split("\n").length, content });
});


// Full-text search across every allowlisted source file at once — one
// query, line-anchored matches the dashboard can jump straight to.
honoApp.get("/v1/source/search", requireAdmin, (c) => {
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) {
    return c.json({ error: { message: "Query must be at least 2 characters" } }, 400);
  }
  const needle = q.toLowerCase();
  const MAX = 200;
  const results: { file: string; line: number; text: string }[] = [];
  for (const file of SOURCE_FILES) {
    if (results.length >= MAX) break;
    const content = loadTextFile(file);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && results.length < MAX; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        results.push({ file, line: i + 1, text: lines[i].trim().slice(0, 240) });
      }
    }
  }
  return c.json({ q, count: results.length, truncated: results.length >= MAX, results });
});
}
