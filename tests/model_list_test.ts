/**
 * The model datalist is rendered from GET /v1/models, which lists one row per
 * routable tuple. The page must collapse those repeats and group the result by
 * provider, or the picker shows "anthropic/claude-opus-5.5" once per endpoint
 * next to bare leaf names. This pulls the renderer straight out of index.html
 * so the markup and the behaviour cannot drift apart.
 */
const page = await Deno.readTextFile(new URL("../index.html", import.meta.url));

const start = page.indexOf("const LANE_IDS");
const end = page.indexOf("async function loadCatalog");
if (start < 0 || end < 0 || end <= start) throw new Error("model-list renderer not found in index.html");
const source = page.slice(start, end);

type Renderer = {
  groupedModels: (models: unknown[]) => Array<{ vendor: string; items: Array<{ id: string; name: string }> }>;
  renderModelList: (models: unknown[]) => void;
};

const list = { innerHTML: "" };
const mount = (): Renderer =>
  new Function("$", "esc", `${source}; return { groupedModels, renderModelList };`)(
    () => list,
    (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c as string] as string)),
  ) as Renderer;

// A slice of production /v1/models: the same slug advertised by three
// endpoints, a bare variant of it, plus lanes and image models.
const catalog = [
  { id: "free:reasoning", owned_by: "vajra-mesh-router" },
  { id: "free:auto", owned_by: "vajra-mesh-router" },
  { id: "free:smart", owned_by: "vajra-mesh-router" },
  { id: "nokey-image", owned_by: "nokey-image" },
  { id: "claude-opus-5.5", owned_by: "anthropic" },
  { id: "anthropic/claude-opus-5.5", owned_by: "anthropic" },
  { id: "anthropic/claude-opus-5.5", owned_by: "openrouter" },
  { id: "anthropic/claude-opus-5.5", owned_by: "kilo" },
  { id: "anthropic/claude-opus-4.5", owned_by: "openrouter" },
  { id: "google/gemini-3.0-pro", owned_by: "openrouter" },
  { id: "openai/gpt-5.2", owned_by: "openrouter" },
  { id: "openai/gpt-5.2:extended", owned_by: "openrouter" },
];

Deno.test("model list: repeats collapse and slugs stay provider-qualified", () => {
  const { groupedModels } = mount();
  const groups = groupedModels(catalog);
  const flat = groups.flatMap((g) => g.items.map((i) => i.id));
  if (flat.length !== new Set(flat).size) throw new Error(`duplicate options: ${flat.join(", ")}`);
  const anthropic = groups.find((g) => g.vendor === "anthropic");
  if (!anthropic) throw new Error("anthropic models must group together");
  const opus = anthropic.items.filter((i) => i.name === "claude-opus-5.5");
  if (opus.length !== 1) throw new Error(`claude-opus-5.5 must collapse to one option, got ${opus.length}`);
  if (opus[0].id !== "anthropic/claude-opus-5.5") throw new Error("qualified slug must win over the bare leaf name");
});

Deno.test("model list: registry provider ids group with their native vendor", () => {
  const { groupedModels } = mount();
  const groups = groupedModels([
    { id: "claude-opus-5.5", owned_by: "services_json_anthropic" },
    { id: "anthropic/claude-opus-5.5", owned_by: "openrouter" },
    { id: "gpt-oss-120b", owned_by: "services_json_ovhcloud_ai_endpoints" },
  ]);
  const vendors = groups.map((g) => g.vendor);
  if (vendors.join(",") !== "anthropic,ovhcloud ai endpoints") throw new Error(`vendors ${vendors.join(",")}`);
  if (groups[0].items.length !== 1) throw new Error("services_json_anthropic and openrouter slugs must share one group");
});

Deno.test("model list: one option per routable id, whatever provider serves it", () => {
  const { groupedModels } = mount();
  const groups = groupedModels([
    { id: "gpt-oss-120b", owned_by: "kilo" },
    { id: "gpt-oss-120b", owned_by: "llm7" },
    { id: "gpt-oss-120b", owned_by: "services_json_pollinations" },
  ]);
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  if (ids.join(",") !== "gpt-oss-120b") throw new Error(`expected a single option, got ${ids.join(",")}`);
});

Deno.test("model list: lanes and image lead, providers follow alphabetically", () => {
  const { groupedModels } = mount();
  const vendors = groupedModels(catalog).map((g) => g.vendor);
  const expected = ["lanes", "image", "anthropic", "google", "openai"];
  if (vendors.join(",") !== expected.join(",")) throw new Error(`group order ${vendors.join(",")} != ${expected.join(",")}`);
  const lanes = groupedModels(catalog)[0].items.map((i) => i.id);
  if (lanes.join(",") !== "free:auto,free:smart,free:reasoning") throw new Error(`lane order ${lanes.join(",")}`);
});

Deno.test("model list: rendered options carry a grouped label", () => {
  const { renderModelList } = mount();
  renderModelList(catalog);
  const values = [...list.innerHTML.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  if (values.length !== new Set(values).size) throw new Error(`rendered duplicates: ${values.join(", ")}`);
  if (!list.innerHTML.includes('value="anthropic/claude-opus-5.5" label="anthropic · claude-opus-5.5"')) {
    throw new Error(`qualified option missing from ${list.innerHTML}`);
  }
  if (!list.innerHTML.includes('value="free:smart" label="free:smart"')) throw new Error("lane option missing");
  if (!list.innerHTML.includes('value="openai/gpt-5.2" label="openai · gpt-5.2"')) {
    throw new Error(`modifier variant must collapse into the plain slug: ${list.innerHTML}`);
  }
  if (list.innerHTML.includes("gpt-5.2:extended")) throw new Error("a routing modifier leaked into its own option");
});

Deno.test("model list: provider/subprovider/model:modifier groups on the bare model name", () => {
  const { groupedModels } = mount();
  const groups = groupedModels([
    { id: "community/MarcosFRG/qwen3.8-flash:paid", owned_by: "kilo" },
    { id: "community/MarcosFRG/qwen3.8-flash:free", owned_by: "llm7" },
    { id: "community/chigwell/qwen3.8-flash", owned_by: "services_json_kilo" },
  ]);
  if (groups.length !== 1) throw new Error(`expected one group, got ${groups.map((g) => g.vendor).join(",")}`);
  const [group] = groups;
  if (group.vendor !== "community") throw new Error(`vendor ${group.vendor}`);
  if (group.items.length !== 1) {
    throw new Error(`every modifier variant must collapse to one option, got ${group.items.map((i) => i.id).join(", ")}`);
  }
  if (group.items[0].name !== "qwen3.8-flash") throw new Error(`label name ${group.items[0].name}`);
  if (group.items[0].id !== "community/chigwell/qwen3.8-flash") {
    throw new Error(`the unmodified slug must win over :paid/:free, got ${group.items[0].id}`);
  }
});

Deno.test("model list: a bare model:modifier id groups with its base name", () => {
  const { groupedModels } = mount();
  const groups = groupedModels([
    { id: "gpt-oss-120b:free", owned_by: "kilo" },
    { id: "gpt-oss-120b", owned_by: "kilo" },
  ]);
  const items = groups.flatMap((g) => g.items);
  if (items.length !== 1) throw new Error(`expected one option, got ${items.map((i) => i.id).join(", ")}`);
  if (items[0].id !== "gpt-oss-120b") throw new Error(`unmodified id must win, got ${items[0].id}`);
});

Deno.test("model list: the modifier strip never collapses the free lanes", () => {
  const { groupedModels } = mount();
  const lanes = groupedModels(catalog).find((g) => g.vendor === "lanes");
  if (!lanes) throw new Error("lane group missing");
  const ids = lanes.items.map((i) => i.id);
  if (ids.join(",") !== "free:auto,free:smart,free:reasoning") {
    throw new Error(`lanes must keep their colon-suffixed names, got ${ids.join(",")}`);
  }
});
