/** Exercise the same budget helpers used by the workspace, not a copy. */
const page = await Deno.readTextFile(new URL("../ui/catalog.js", import.meta.url));
const start = page.indexOf("function modelContext(");
const end = page.indexOf("function chatTokenBudget(", start);
if (start < 0 || end < 0) throw new Error("UI budget helpers not found");
const helpers = new Function("wire", "textOf", `${page.slice(start, end)}; return { modelContext, estimatePromptTokens, automaticBudget };`)(
  (m: unknown) => m,
  (content: unknown) => typeof content === "string" ? content : "",
) as {
  modelContext: (models: unknown[], id: string) => number | null;
  estimatePromptTokens: (messages: unknown[], system: string, tools?: string) => number;
  automaticBudget: (context: number | null, input: number) => number | undefined;
};
const assert = (v: unknown, message: string) => { if (!v) throw new Error(message); };

Deno.test("model budgets use the smallest exact context and never invent one", () => {
  const rows = [{ id: "model", context_window: 128000 }, { id: "model", context_window: 8192 }, { id: "other", context_window: 512 }];
  assert(helpers.modelContext(rows, "model") === 8192, "smallest tuple context");
  assert(helpers.modelContext(rows, "free:auto") === null, "unknown lane context");
  assert(helpers.automaticBudget(null, 100) === undefined, "unknown leaves provider default");
  assert(helpers.automaticBudget(8192, 7000) === 680, "reserve room for input and safety margin");
  assert(helpers.automaticBudget(128000, 100) === 4096, "cap automatic output");
  assert(helpers.automaticBudget(8192, 9000) === 1, "output stays positive if input is too long");
});
Deno.test("token estimate accounts for conversation and tool schema", () => {
  const baseline = helpers.estimatePromptTokens([], "");
  assert(helpers.estimatePromptTokens([{ role: "user", content: "hello" }], "") > baseline, "message cost");
  assert(helpers.estimatePromptTokens([], "", "schema text") > baseline, "tool cost");
});
Deno.test("mobile chat opens without persisted desktop parameters or an invisible blur", async () => {
  const chatJs = await Deno.readTextFile(new URL("../ui/chat.js", import.meta.url));
  const css = await Deno.readTextFile(new URL("../ui/dashboard.css", import.meta.url));
  assert(chatJs.includes('if (innerWidth <= 860 || store.get("side") === false)'), "mobile parameters must start closed");
  assert(css.includes('#scrim:not(.open) { visibility: hidden; backdrop-filter: none;'), "closed scrim must not blur");
});
