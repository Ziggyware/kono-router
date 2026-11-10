import { app } from "./main.ts";
import { assert } from "@std/assert";

Deno.test("app fetch handler responds", async () => {
  const req = new Request("http://localhost/");
  const res = await app.fetch(req);
  assert(res.status);
});