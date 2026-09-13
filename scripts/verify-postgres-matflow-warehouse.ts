/** Opt-in loopback synthetic PostgreSQL proof; retains fixtures, never loads .env or touches formal runtime. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env);
  const [{ drizzle }, s, { updateWarehouse }, { createFl }, { createSh, confirmInbound }] = await Promise.all([
    import("drizzle-orm/node-postgres"), import("@/db/schema"), import("@/server/modules/master/warehouse"),
    import("@/server/modules/matflow/fl"), import("@/server/modules/matflow/sh"),
  ]);
  const prefix = `MF-WH-${randomUUID().slice(0, 8)}`;
  const client = (role: string) => new pg.Client({ connectionString, application_name: `${prefix}-${role}`,
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000 -c search_path=public" });
  const control = client("control"), a = client("a"), b = client("b");
  const dbA = drizzle(a, { schema: s }), dbB = drizzle(b, { schema: s });
  type Tx = Parameters<Parameters<typeof dbA.transaction>[0]>[0];
  const outcomes: Promise<unknown>[] = [], proofs: string[] = [];
  try {
    await Promise.all([control.connect(), a.connect(), b.connect()]);
    const [actor] = await dbA.insert(s.users).values({ name: prefix, username: prefix, roles: ["admin"], isApprover: true }).returning();
    const [spu] = await dbA.insert(s.spus).values({ code: prefix, nameCn: prefix }).returning();
    const [product, material] = await dbA.insert(s.skus).values([
      { code: `${prefix}-CP`, spuId: spu.id, skuType: "finished", baseUom: "支" },
      { code: `${prefix}-MAT`, spuId: spu.id, skuType: "raw", baseUom: "个" },
    ]).returning();
    const [supplier, other] = await dbA.insert(s.suppliers).values([{ code: prefix, name: prefix }, { code: `${prefix}-OTHER`, name: "other" }]).returning();
    const [own, changed, draft, disabled] = await dbA.insert(s.warehouses).values([
      { code: `${prefix}-OWN`, name: "自有仓", kind: "raw" },
      ...["changed", "draft", "disabled"].map(code => ({ code: `${prefix}-${code}`, name: code, kind: "outsource" as const, supplierId: supplier.id })),
    ]).returning();
    const [bom] = await dbA.insert(s.boms).values({ productSkuId: product.id, versionNo: "1" }).returning();
    const [wo] = await dbA.insert(s.woDocs).values({ docNo: `${prefix}-WO`, productSkuId: product.id, supplierId: supplier.id,
      bomId: bom.id, qty: "100", feeRatePlan: "1", status: "in_progress", createdBy: actor.id }).returning();
    await dbA.insert(s.woLines).values({ woId: wo.id, materialSkuId: material.id, qtyPer: "2", planLossRatePct: "0", grossReq: "200", suggestedQty: "200" });
    const [jg] = await dbA.insert(s.jgDocs).values({ docNo: `${prefix}-JG`, woId: wo.id, supplierId: supplier.id,
      productSkuId: product.id, qty: "100", feeRateCurrent: "1", status: "in_progress", createdBy: actor.id }).returning();
    const [sh] = await dbA.insert(s.shDocs).values({ docNo: `${prefix}-SH`, sourceType: "jg", sourceId: jg.id,
      warehouseId: own.id, status: "approved", createdBy: actor.id }).returning();
    const [line] = await dbA.insert(s.shLines).values({ shId: sh.id, skuId: product.id, actualQty: "1", lineType: "normal" }).returning();
    const [qc] = await dbA.insert(s.qcRecords).values({ shId: sh.id, createdBy: actor.id }).returning();
    await dbA.insert(s.qcLines).values({ qcId: qc.id, shLineId: line.id, passQty: "1", failQty: "0", concessionQty: "0" });
    const flInput = (id: number) => ({ jgId: jg.id, fromWarehouseId: own.id, toWarehouseId: id, lines: [{ skuId: material.id, qty: "1" }] });
    const sideEffects = async () => (await control.query("select (select count(*) from system_alerts)::text alerts, (select count(*) from notifications)::text notifications")).rows;
    const before = await sideEffects();
    async function race(label: string, first: (tx: Tx) => Promise<unknown>, second: () => Promise<unknown>, afterWait?: (tx: Tx) => Promise<unknown>) {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const one = dbA.transaction(async tx => { await first(tx); entered(); await gate; await afterWait?.(tx); })
        .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      outcomes.push(one);
      let two: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
      try {
        await Promise.race([ready, one.then(r => { if (!r.ok) throw r.error; })]);
        two = second().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        outcomes.push(two);
        const deadline = Date.now() + 10_000; let waiting = false;
        while (Date.now() < deadline) {
          waiting = (await control.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [`${prefix}-b`])).rowCount === 1;
          if (waiting) break;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        assert.ok(waiting, `${label}: must observe a real PostgreSQL lock wait`);
      } finally { release(); }
      const result = await one; if (!result.ok) throw result.error;
      assert.ok(two); proofs.push(label); return two;
    }
    const reassignment = await race("create-rechecks-factory-after-lock-wait",
      tx => updateWarehouse(changed.id, { ...changed, supplierId: other.id }, actor, tx), () => createFl(actor, flInput(changed.id), dbB));
    assert.equal(reassignment.ok, false);
    if (!reassignment.ok) assert.equal((reassignment.error as { status: number }).status, 409);
    const draftResult = await race("created-draft-prevents-reassignment",
      tx => createFl(actor, flInput(draft.id), tx), () => updateWarehouse(draft.id, { ...draft, supplierId: other.id }, actor, dbB));
    assert.equal(draftResult.ok, false);
    if (!draftResult.ok) assert.equal((draftResult.error as { status: number }).status, 409);
    const inbound = await race("inbound-rechecks-deactivation-after-lock-wait",
      tx => updateWarehouse(disabled.id, { ...disabled, active: false }, actor, tx),
      () => confirmInbound(actor, sh.id, dbB, { outsourceWarehouseId: disabled.id }));
    assert.equal(inbound.ok, false);
    if (!inbound.ok) assert.equal((inbound.error as { status: number }).status, 409);
    const { sql } = await import("drizzle-orm");
    const ordered = await race("create-does-not-hold-warehouse-while-waiting-for-JG",
      tx => tx.execute(sql`select id from jg_docs where id=${jg.id} for update`),
      () => createSh(actor, { sourceType: "jg", sourceId: jg.id, warehouseId: own.id, lines: [{ skuId: product.id, actualQty: "1" }] }, dbB),
      tx => tx.execute(sql`select id from warehouses where id=${own.id} for update`));
    assert.equal(ordered.ok, true, "source-first ordering must not deadlock");
    assert.equal((await control.query("select 1 from stock_ledger where warehouse_id=any($1::int[])", [[own.id, changed.id, draft.id, disabled.id]])).rowCount, 0);
    assert.equal((await control.query("select 1 from fl_docs where jg_id=$1", [jg.id])).rowCount, 1);
    assert.equal((await control.query("select status from sh_docs where id=$1", [sh.id])).rows[0].status, "approved");
    assert.deepEqual(await sideEffects(), before);
    console.log(JSON.stringify({ result: "PASS", proofs, fixturePrefix: prefix, jgId: jg.id, receiptId: sh.id,
      supplierId: supplier.id, ownWarehouseId: own.id, outsourceWarehouseIds: [draft.id, disabled.id], productSkuId: product.id,
      materialSkuId: material.id, unrelatedSideEffects: "unchanged", retained: true }, null, 2));
  } finally {
    await Promise.allSettled(outcomes);
    await Promise.allSettled([control.end(), a.end(), b.end()]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
