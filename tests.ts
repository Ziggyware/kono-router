// tests or main_test.ts fix
import app from "./main.ts";

Deno.test("app fetch handler responds", async () => {
  const req = new Request("http://localhost/");
  const res = await app.fetch(req);
  assert(res.status);
});