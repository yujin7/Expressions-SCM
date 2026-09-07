/** Real row-lock proof, restricted to disposable local contract databases. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { eq } from "drizzle-orm";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

export const supplyParamsContractConnectionString = reviewContractConnectionString;

async function main() {
  const url = new URL(supplyParamsContractConnectionString(process.env));
  const [{ drizzle }, s, { patchSupplyParams }, { bulkFillSupplyParams }] = await Promise.all([
    import("drizzle-orm/node-postgres"), import("@/db/schema"),
    import("@/server/modules/master/sku-supply-params-fill"), import("@/server/modules/master/sku-supply-params-bulk"),
  ]);
  const key = randomUUID().replace(/-/g, "").slice(0, 16);
  const client = (role: string) => new pg.Client({ connectionString: url.href, application_name: `supply-${role}-${key}`,
    connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000 -c search_path=public" });
  const control = client("control"), a = client("a"), b = client("b");
  const dbA = drizzle(a, { schema: s }), dbB = drizzle(b, { schema: s });
  let cases = 0;
  const pass = (name: string) => { cases++; console.log(`PASS ${name}`); };
  try {
    await Promise.all([control.connect(), a.connect(), b.connect()]);
    const [person] = await dbA.insert(s.users).values({ name: `Supply QA ${key}`, roles: ["pmc"] }).returning();
    const pmc = { id: person.id, name: person.name, roles: ["pmc"], isApprover: false };
    const purchasing = { ...pmc, roles: ["purchasing"] };
    const [spu] = await dbA.insert(s.spus).values({ code: `SUPQA-${key}`, nameCn: "周期契约" }).returning();
    let seq = 0;
    const sku = async () => (await dbA.insert(s.skus).values({ code: `SUPQA-${key}-${++seq}`, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning())[0];
    const [{ pid }] = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows;
    const waitForLock = async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await control.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error("Competing request did not reach an actual PostgreSQL lock");
    };
    type Tx = Parameters<Parameters<typeof dbA.transaction>[0]>[0];
    const race = async <A, B>(first: (tx: Tx) => Promise<A>, second: () => Promise<B>) => {
      let ready!: () => void, release!: () => void;
      const arrived = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
      const firstWrite = dbA.transaction(async tx => { const result = await first(tx); ready(); await gate; return result; });
      await Promise.race([arrived, firstWrite.then(() => { throw Error("First write left its commit barrier early"); })]);
      const secondWrite = second().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      try { await waitForLock(); } finally { release(); }
      return { first: await firstWrite, second: await secondWrite };
    };
    const firstFill = await sku();
    const fill = await race(tx => patchSupplyParams(purchasing, firstFill.id, { normalLeadDays: 20 }, tx),
      () => patchSupplyParams(purchasing, firstFill.id, { normalLeadDays: 30 }, dbB));
    assert(!fill.second.ok); assert.equal(fill.second.error.status, 403);
    pass("two fill-only requests on absent sku_params serialize; loser cannot overwrite");

    const stale = await sku();
    const conflict = await race(tx => patchSupplyParams(pmc, stale.id, { normalLeadDays: 20, expected: { normalLeadDays: null } }, tx),
      () => patchSupplyParams(pmc, stale.id, { normalLeadDays: 30, expected: { normalLeadDays: null } }, dbB));
    assert(!conflict.second.ok); assert.equal(conflict.second.error.status, 409);
    pass("concurrent privileged edit rejects stale expected value after lock");

    const same = await sku(), input = { normalLeadDays: 25, expected: { normalLeadDays: null } };
    const replay = await race(tx => patchSupplyParams(purchasing, same.id, input, tx), () => patchSupplyParams(purchasing, same.id, input, dbB));
    assert(replay.second.ok); assert.equal(replay.second.value.normalLeadDays, 25);
    assert.equal((await dbA.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, same.id))).filter(r => r.entity === "sku_params").length, 1);
    pass("same-value retry waits then reconciles without duplicate audit");

    const left = await sku(), right = await sku();
    const batch = { scope: { kind: "ids", ids: [right.id, left.id] }, values: { normalLeadDays: 30 }, overwrite: true };
    const preview = await bulkFillSupplyParams(pmc, { ...batch, dryRun: true }, dbA);
    const changed = await race(tx => patchSupplyParams(pmc, left.id, { normalLeadDays: 10 }, tx),
      () => bulkFillSupplyParams(pmc, { ...batch, expectedPreview: preview.previewKey }, dbB));
    assert(!changed.second.ok); assert.equal(changed.second.error.status, 409);
    assert.equal((await dbA.select().from(s.skuParams).where(eq(s.skuParams.skuId, right.id))).length, 0);
    pass("bulk re-reads after contention and rejects the whole stale preview");

    const untouched = await sku();
    const onlyFill = { scope: { kind: "ids", ids: [untouched.id] }, values: { normalLeadDays: 35 } };
    const retained = await race(tx => patchSupplyParams(pmc, untouched.id, { normalLeadDays: 15 }, tx),
      () => bulkFillSupplyParams(purchasing, onlyFill, dbB));
    assert(retained.second.ok); assert.equal(retained.second.value.changedSkus, 0);
    assert.equal((await dbA.select().from(s.skuParams).where(eq(s.skuParams.skuId, untouched.id)))[0].normalLeadDays, 15);
    pass("legacy fill-only batch also preserves a concurrent first fill");
    console.log(JSON.stringify({ passed: true, cases, fixture: key, database: url.pathname.slice(1) }));
  } finally { await Promise.allSettled([control.end(), a.end(), b.end()]); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), "scripts/verify-postgres-supply-params.ts")) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
