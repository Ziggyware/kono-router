// deno-lint-ignore-file no-explicit-any
/**
 * External KV backend tests (kv-store.ts): the libSQL/Turso implementation of
 * the six-operation store surface state.ts exposes (get/getMany/set/delete/
 * list/atomic), exercised against its behavioural contract — the same
 * semantics the in-memory fallback and Deno KV provide: CAS on versionstamps,
 * lazy TTL expiry, element-wise prefix listing with limit/reverse, blind
 * atomic commits, and multi-key atomicity.
 *
 * Requires a libSQL server: set KONO_TEST_TURSO_URL (e.g. a local
 * `turso dev` / sqld instance at http://127.0.0.1:8901). Without it every
 * test here skips, so the suite stays green on machines with no server.
 *
 * Run: deno test --unstable-kv -A tests/
 */
import { createTursoKv, encodeKey, keyPrefixRange } from "../kv-store.ts";

const TEST_URL = (Deno.env.get("KONO_TEST_TURSO_URL") ?? Deno.env.get("NOKEY_TEST_TURSO_URL"));
const skip = !TEST_URL;
const RUN = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const assertEq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freshKv(): Promise<Deno.Kv> {
  return await createTursoKv(TEST_URL!);
}

Deno.test({ name: "kv-store: key encoding keeps tuple-prefix == string-prefix", ignore: skip, fn: () => {
  const enc = encodeKey(["t", "a"]);
  assert(encodeKey(["t", "a", "x"]).startsWith(enc), "extension encoding extends the prefix encoding");
  assert(!encodeKey(["t2"]).startsWith(enc.slice(0, encodeKey(["t"]).length)) || encodeKey(["t2"]) < keyPrefixRange(["t"]).lo || encodeKey(["t2"]) >= keyPrefixRange(["t"]).hi, "sibling part t2 falls outside the [t] range");
  const { lo, hi } = keyPrefixRange(["t"]);
  assert(encodeKey(["t", "zz"]) >= lo && encodeKey(["t", "zz"]) < hi, "child key inside prefix range");
  assert(encodeKey(["u"]) >= hi, "next sibling prefix starts at/after hi");
}});

Deno.test({ name: "kv-store: set/get round trip, stamps rotate, missing reads null", ignore: skip, fn: async () => {
  const kv = await freshKv();
  const k = [RUN, "basic"];
  const miss = await kv.get(k);
  assertEq(miss.value, null, "missing key value");
  assertEq(miss.versionstamp, null, "missing key stamp");
  const s1 = await kv.set(k, { n: 1 });
  const g1 = await kv.get(k);
  assertEq(g1.value, { n: 1 }, "round trip value");
  assertEq(g1.versionstamp, s1.versionstamp, "get stamp matches set stamp");
  const s2 = await kv.set(k, { n: 2 });
  assert(s2.versionstamp !== s1.versionstamp, "stamp rotates on rewrite");
  assertEq((await kv.get(k)).value, { n: 2 }, "rewritten value");
  kv.close();
}});

Deno.test({ name: "kv-store: getMany preserves order and absence", ignore: skip, fn: async () => {
  const kv = await freshKv();
  await kv.set([RUN, "gm", "a"], "A");
  await kv.set([RUN, "gm", "c"], "C");
  const rows = await kv.getMany([[RUN, "gm", "a"], [RUN, "gm", "b"], [RUN, "gm", "c"]]);
  assertEq(rows.map((r) => r.value), ["A", null, "C"], "getMany values in request order");
  assertEq(rows[1].versionstamp, null, "absent row stamp null");
  kv.close();
}});

Deno.test({ name: "kv-store: CAS check semantics (match, stale, absent)", ignore: skip, fn: async () => {
  const kv = await freshKv();
  const k = [RUN, "cas"];
  await kv.set(k, 1);
  const cur = await kv.get(k);
  const okRes: any = await kv.atomic().check(cur).set(k, 2).commit();
  assert(okRes.ok, "CAS with current stamp commits");
  assertEq((await kv.get(k)).value, 2, "CAS wrote the value");
  const stale: any = await kv.atomic().check(cur).set(k, 3).commit();
  assert(!stale.ok, "CAS with stale stamp rejected");
  assertEq((await kv.get(k)).value, 2, "rejected CAS changed nothing");
  const absentKey = [RUN, "cas-absent"];
  const create: any = await kv.atomic().check({ key: absentKey, versionstamp: null }).set(absentKey, "new").commit();
  assert(create.ok, "check-absent on missing key commits");
  const createAgain: any = await kv.atomic().check({ key: absentKey, versionstamp: null }).set(absentKey, "nope").commit();
  assert(!createAgain.ok, "check-absent on existing key rejected");
  kv.close();
}});

Deno.test({ name: "kv-store: multi-key atomic applies all or nothing", ignore: skip, fn: async () => {
  const kv = await freshKv();
  const a = [RUN, "multi", "a"], b = [RUN, "multi", "b"], c = [RUN, "multi", "c"];
  await kv.set(a, "a0"); await kv.set(b, "b0"); await kv.set(c, "c0");
  const ea = await kv.get(a), eb = await kv.get(b);
  const res: any = await kv.atomic().check(ea).check(eb).set(a, "a1").delete(b).set(c, "c1").commit();
  assert(res.ok, "multi-key commit ok");
  assertEq((await kv.get(a)).value, "a1", "set applied");
  assertEq((await kv.get(b)).value, null, "delete applied");
  assertEq((await kv.get(c)).value, "c1", "unchecked set applied");
  const ea2 = await kv.get(a);
  const bad: any = await kv.atomic().check(ea).check(ea2).set(a, "aX").set(c, "cX").commit();
  assert(!bad.ok, "one stale check fails the whole commit");
  assertEq((await kv.get(a)).value, "a1", "failed commit: a untouched");
  assertEq((await kv.get(c)).value, "c1", "failed commit: c untouched");
  const blind: any = await kv.atomic().set(a, "blind").commit();
  assert(blind.ok, "blind atomic (no checks) commits");
  kv.close();
}});

Deno.test({ name: "kv-store: prefix list order, limit, reverse, isolation", ignore: skip, fn: async () => {
  const kv = await freshKv();
  await kv.set([RUN, "lst", "b"], 2);
  await kv.set([RUN, "lst", "a"], 1);
  await kv.set([RUN, "lst", "a", "x"], 3);
  await kv.set([RUN, "lst2", "a"], 99);
  const keys: string[] = [];
  for await (const e of kv.list({ prefix: [RUN, "lst"] })) keys.push(JSON.stringify(e.key));
  assertEq(keys, [JSON.stringify([RUN, "lst", "a"]), JSON.stringify([RUN, "lst", "a", "x"]), JSON.stringify([RUN, "lst", "b"])], "element-wise sorted, sibling prefix lst2 excluded");
  const limited: string[] = [];
  for await (const e of kv.list({ prefix: [RUN, "lst"] }, { limit: 2 })) limited.push(JSON.stringify(e.key));
  assertEq(limited.length, 2, "limit honored");
  const reversed: string[] = [];
  for await (const e of kv.list({ prefix: [RUN, "lst"] }, { reverse: true })) reversed.push(JSON.stringify(e.key));
  assertEq(reversed[0], JSON.stringify([RUN, "lst", "b"]), "reverse starts at the tail");
  kv.close();
}});

Deno.test({ name: "kv-store: TTL expiry reads as absent and frees the key for CAS-create", ignore: skip, fn: async () => {
  const kv = await freshKv();
  const k = [RUN, "ttl"];
  await kv.set(k, "short", { expireIn: 60 });
  assertEq((await kv.get(k)).value, "short", "value live before expiry");
  await sleep(120);
  const gone = await kv.get(k);
  assertEq(gone.value, null, "expired value reads null");
  assertEq(gone.versionstamp, null, "expired stamp reads null");
  const recreate: any = await kv.atomic().check({ key: k, versionstamp: null }).set(k, "again").commit();
  assert(recreate.ok, "expired key can be CAS-created");
  assertEq((await kv.get(k)).value, "again", "recreated value present");
  kv.close();
}});

Deno.test({ name: "kv-store: delete removes the key", ignore: skip, fn: async () => {
  const kv = await freshKv();
  const k = [RUN, "del"];
  await kv.set(k, 1);
  await kv.delete(k);
  assertEq((await kv.get(k)).value, null, "deleted key reads null");
  kv.close();
}});
