/**
 * Operator surfaces are public static pages; the spec they load must stay in
 * lockstep with the Hono route table.
 */
import { app } from "../main.ts";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

Deno.test({ name: "admin, docs, openapi are served without auth", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const legacy = await app.fetch(new Request("http://x/admin"));
  assert(legacy.status === 301 && legacy.headers.get("location") === "/#lanes", "/admin must redirect to the workspace lanes view");
  for (const [path, type] of [["/", "text/html"], ["/docs", "text/html"], ["/openapi.json", "application/json"]]) {
    const res = await app.fetch(new Request("http://x" + path));
    assert(res.status === 200, `${path} -> ${res.status}`);
    assert(res.headers.get("content-type")?.startsWith(type), `${path} content-type`);
    await res.body?.cancel();
  }
} });

Deno.test("openapi paths match registered routes", async () => {
  const spec = JSON.parse(await Deno.readTextFile("openapi.json"));
  const registered = new Set(
    (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
      .filter((r) => r.method !== "ALL" && r.path !== "/" && !["/admin", "/docs", "/openapi.json"].includes(r.path))
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`),
  );
  const documented = new Set(
    Object.entries(spec.paths as Record<string, Record<string, unknown>>)
      .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)),
  );
  for (const r of registered) assert(documented.has(r), `undocumented route ${r}`);
  for (const d of documented) assert(registered.has(d), `documented route not registered ${d}`);
});
