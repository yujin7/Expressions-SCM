/** Opt-in synthetic PostgreSQL proof. Retains fixtures and append-only evidence; no .env loading. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env);
  const [{ drizzle }, schema, { updateWarehouse }, { post }] = await Promise.all([
    import("drizzle-orm/node-postgres"), import("@/db/schema"),
    import("@/server/modules/master/warehouse"), import("@/server/posting/post"),
  ]);
  const suffix = randomUUID().slice(0, 8), prefix = `WH-LOCK-${suffix}`;
  const client = (role: string) => new pg.Client({ connectionString,
    application_name: `${prefix}-${role}`, connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000 -c search_path=public" });
  const control = client("control"), a = client("a"), b = client("b");
  const dbA = drizzle(a, { schema }), dbB = drizzle(b, { schema });
  type Tx = Parameters<Parameters<typeof dbA.transaction>[0]>[0];
  const proofs: string[] = [];
  const outcomes: Promise<unknown>[] = [];
  try {
    await Promise.all([control.connect(), a.connect(), b.connect()]);
    const [{ id: actorId }] = (await control.query<{ id: number }>(
      "insert into users(username,name,roles) values($1,$1,array['admin']) returning id", [prefix])).rows;
    const actor = { id: actorId, name: prefix, roles: ["admin"], isApprover: false };
    const [{ id: spuId }] = (await control.query<{ id: number }>(
      "insert into spus(code,name_cn) values($1,$1) returning id", [prefix])).rows;
    const [{ id: skuId }] = (await control.query<{ id: number }>(
      "insert into skus(code,spu_id,sku_type,base_uom) values($1,$2,'raw','kg') returning id", [prefix, spuId])).rows;
    const suppliers = (await control.query<{ id: number }>(
      "insert into suppliers(code,name) values($1,$1),($2,$2) returning id", [`${prefix}-A`, `${prefix}-B`])).rows;
    const warehouses = await dbA.insert(schema.warehouses).values(["snapshot", "negative", "used", "draft"].map(label => ({
      code: `${prefix}-${label}`, name: `${prefix}-${label}`, kind: "outsource" as const, supplierId: suppliers[0].id, active: false,
    }))).returning();
    const docs = await dbA.insert(schema.stockDocs).values(warehouses.map(wh => ({
      docNo: wh.code, subtype: "opening" as const, createdBy: actorId,
    }))).returning();
    assert.equal((await control.query("select 1 from stock_ledger where source_doc_type='opening' and source_doc_id=any($1::int[])", [docs.map(d => d.id)])).rowCount, 0,
      "Synthetic opening document IDs must not collide with existing evidence");
    const event = (index: number, qtyDelta = "1") => ({ sourceDocType: "opening", sourceDocId: docs[index].id, action: "post",
      lines: [{ sourceLineId: 1, skuId, warehouseId: warehouses[index].id, qtyDelta }] });
    const sideEffects = async () => (await control.query<{ alerts: string; notifications: string }>(
      "select (select count(*) from system_alerts)::text alerts, (select count(*) from notifications)::text notifications")).rows[0];
    const before = await sideEffects();
    // A commits only after PostgreSQL itself reports B waiting on a lock, not an arbitrary delay.
    async function race(label: string, first: (tx: Tx) => Promise<unknown>, second: () => Promise<unknown>) {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const firstResult = dbA.transaction(async tx => { await first(tx); entered(); await gate; })
        .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      outcomes.push(firstResult);
      let secondResult: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
      try {
        await Promise.race([ready, firstResult.then(result => { if (!result.ok) throw result.error; })]);
        secondResult = second().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        outcomes.push(secondResult);
        const deadline = Date.now() + 10_000;
        let waiting = false;
        while (Date.now() < deadline) {
          waiting = (await control.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [`${prefix}-b`])).rowCount === 1;
          if (waiting) break;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        assert.ok(waiting, `${label}: actual lock wait required`);
      } finally { release(); }
      const committed = await firstResult;
      assert.ok(committed.ok, `${label}: first transaction must commit`);
      assert.ok(secondResult);
      return secondResult;
    }
    for (const [index, kind, qty, code] of [[0, "snapshot", "1", "SNAPSHOT_WAREHOUSE"], [1, "raw", "-1", "NEGATIVE_STOCK"]] as const) {
      const result = await race(code,
        tx => updateWarehouse(warehouses[index].id, { ...warehouses[index], kind, supplierId: null }, actor, tx),
        () => post(dbB, event(index, qty)));
      assert.equal(result.ok, false, `${code}: waiting post must reject the new warehouse kind`);
      if (!result.ok) assert.equal((result.error as { code?: string }).code, code);
      assert.equal((await control.query("select 1 from stock_ledger where warehouse_id=$1", [warehouses[index].id])).rowCount, 0);
      assert.equal((await control.query("select 1 from stock_balances where warehouse_id=$1", [warehouses[index].id])).rowCount, 0);
      proofs.push(code);
    }
    const afterPost = await race("posting-before-reassignment", tx => post(tx, event(2)),
      () => updateWarehouse(warehouses[2].id, { ...warehouses[2], supplierId: suppliers[1].id }, actor, dbB));
    assert.equal(afterPost.ok, false);
    if (!afterPost.ok) assert.equal((afterPost.error as { status?: number }).status, 409);
    proofs.push("posting-before-reassignment");
    const afterDraft = await race("draft-before-reassignment", async tx => {
      await tx.insert(schema.stockDocLines).values({ stockDocId: docs[3].id, skuId, warehouseId: warehouses[3].id, qty: "1" });
    }, () => updateWarehouse(warehouses[3].id, { ...warehouses[3], supplierId: suppliers[1].id }, actor, dbB));
    assert.equal(afterDraft.ok, false);
    if (!afterDraft.ok) assert.equal((afterDraft.error as { status?: number }).status, 409);
    proofs.push("draft-before-reassignment");
    const retained = (await control.query<{ supplier_id: number; kind: string }>(
      "select supplier_id,kind from warehouses where id=any($1::int[]) order by id", [[warehouses[2].id, warehouses[3].id]])).rows;
    assert.ok(retained.every(row => row.supplier_id === suppliers[0].id && row.kind === "outsource"));
    assert.deepEqual((await control.query("select qty::text from stock_balances where warehouse_id=$1", [warehouses[2].id])).rows, [{ qty: "1.0000" }]);
    assert.equal((await control.query("select 1 from stock_ledger where warehouse_id=any($1::int[])", [warehouses.map(w => w.id)])).rowCount, 1);
    assert.equal((await control.query("select 1 from audit_logs where user_id=$1 and entity='warehouse'", [actorId])).rowCount, 2);
    assert.deepEqual(await sideEffects(), before);
    console.log(JSON.stringify({ result: "PASS", proofs, fixturePrefix: prefix, warehouses: warehouses.map(w => ({ id: w.id, code: w.code })), ledgerRows: 1, warehouseAudits: 2, unrelatedSideEffects: "unchanged", retained: true }, null, 2));
  } finally {
    await Promise.allSettled(outcomes);
    await Promise.allSettled([control.end(), a.end(), b.end()]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
