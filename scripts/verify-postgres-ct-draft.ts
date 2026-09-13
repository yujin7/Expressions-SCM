/** Opt-in loopback synthetic CT correction proof. Retains fixtures and immutable evidence. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";
import { createCt, getCt, submitCt, updateCt, voidCt } from "@/server/modules/matflow/ct";
import { post } from "@/server/posting";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), key = randomUUID().replaceAll("-", "").slice(0, 12);
  const fixture = `ct-repair-${key}`;
  const clients = ["control", "first", "second"].map(role => new pg.Client({ connectionString, application_name: `${fixture}-${role}`,
    connectionTimeoutMillis: 5000, query_timeout: 20000, options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" }));
  const [control, a, b] = clients;
  const pending: Promise<unknown>[] = [];
  const fn = `ct_edit_fault_${key}`, trigger = `ct_edit_gate_${key}`;
  let installed = false;
  try {
    await Promise.all(clients.map(c => c.connect()));
    const db = drizzle(a, { schema: s }), secondDb = drizzle(b, { schema: s });
    const pids = await Promise.all(clients.map(async c => (await c.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0].pid));
    const [maker] = await db.insert(s.users).values({ name: fixture, roles: ["warehouse"] }).returning();
    const [spu] = await db.insert(s.spus).values({ code: fixture, nameCn: fixture }).returning();
    const [sku] = await db.insert(s.skus).values({ code: fixture, name: fixture, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    const [wh] = await db.insert(s.warehouses).values({ code: fixture, name: fixture, kind: "raw", accountingMode: "realtime" }).returning();
    const [supplier] = await db.insert(s.suppliers).values({ code: fixture, name: fixture }).returning();
    const [po] = await db.insert(s.poDocs).values({ docNo: fixture, supplierId: supplier.id, status: "completed", createdBy: maker.id }).returning();
    const [source] = await db.insert(s.poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty: "10", uomFactor: "1", price: "1", receivedQty: "10" }).returning();
    const [batch] = await db.insert(s.batches).values({ skuId: sku.id, batchNo: fixture, expiryDate: "2000-01-01" }).returning();
    await post(db, { sourceDocType: "opening", sourceDocId: po.id, action: "post", lines: [{ sourceLineId: source.id, skuId: sku.id, warehouseId: wh.id, batchId: batch.id, qtyDelta: "10" }] });
    const stock = async () => ({ ledger: await db.select().from(s.stockLedger).where(eq(s.stockLedger.skuId, sku.id)),
      balances: await db.select().from(s.stockBalances).where(eq(s.stockBalances.skuId, sku.id)) });
    const originalStock = await stock();
    const draft = async () => {
      const doc = await createCt(maker, { poId: po.id, warehouseId: wh.id, lines: [
        { poLineId: source.id, skuId: sku.id, batchId: batch.id, qty: "6" },
        { poLineId: source.id, skuId: sku.id, batchId: batch.id, qty: "1" },
      ] }, db);
      const detail = await getCt(doc.id, db);
      return { doc, detail, input: { version: doc.version, remark: "PG精确纠正", lines: [{ id: detail.lines[0].id, qty: "4.1234", reason: "实物已核对" }] } };
    };
    const waitBlocked = async () => {
      const deadline = Date.now() + 8000;
      do {
        await control.query("select pg_stat_clear_snapshot()");
        if ((await control.query<{ blocked: boolean }>("select $1::int=any(pg_blocking_pids($2::int)) blocked", [pids[1], pids[2]])).rows[0].blocked) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      throw Error("Expected PostgreSQL row lock wait was not observed");
    };
    const race = async (first: (tx: AnyDb) => Promise<unknown>, second: () => Promise<unknown>) => {
      const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const firstWrite = db.transaction(async tx => { const result = await first(tx); reached.resolve(); await release.promise; return result; });
      pending.push(firstWrite); void firstWrite.catch(() => undefined);
      await Promise.race([reached.promise, firstWrite.then(() => { throw Error("First write exited before barrier"); })]);
      const secondWrite = second().then(value => ({ ok: true, value }), error => ({ ok: false, error })); pending.push(secondWrite);
      try { await waitBlocked(); } finally { release.resolve(); }
      await firstWrite; return secondWrite;
    };
    for (const mode of ["edit-edit", "edit-submit", "submit-edit"] as const) {
      const x = await draft();
      const result = await race(tx => mode === "submit-edit" ? submitCt(maker, x.doc.id, 1, tx) : updateCt(maker, x.doc.id, x.input, tx),
        () => mode === "edit-submit" ? submitCt(maker, x.doc.id, 1, secondDb) : updateCt(maker, x.doc.id, x.input, secondDb));
      assert.equal(result.ok, false); if ("error" in result) assert.equal(result.error.status, 409);
      const after = await getCt(x.doc.id, db);
      assert.equal(after.version, 2); assert.equal(after.status, mode === "submit-edit" ? "pending" : "draft");
      assert.equal(after.lines[0].id, x.detail.lines[0].id); assert.equal(after.lines[0].qty, mode === "submit-edit" ? "6.0000" : "4.1234");
      assert.equal(after.lines.length, mode === "submit-edit" ? 2 : 1); assert.equal(after.lines[0].batchId, batch.id);
      const audit = await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "ct"), eq(s.auditLogs.entityId, x.doc.id)));
      assert.deepEqual(audit.map(row => row.action).sort(), ["create", mode === "submit-edit" ? "submit" : "update_draft"].sort());
      console.log(`PASS ${mode}: real wait, one version transition, original line/batch, atomic audit`);
    }
    for (const mode of ["void-void", "void-edit", "edit-void", "void-submit", "submit-void"] as const) {
      const x = await draft(), input = { version: 1, reason: "PG原来源核错" };
      const operation = (kind: string, target: AnyDb) => kind === "void" ? voidCt(maker, x.doc.id, input, target)
        : kind === "edit" ? updateCt(maker, x.doc.id, x.input, target) : submitCt(maker, x.doc.id, 1, target);
      const [first, second] = mode.split("-");
      const result = await race(tx => operation(first, tx), () => operation(second, secondDb));
      assert.equal(result.ok, false); if ("error" in result) assert.equal(result.error.status, 409);
      const after = await getCt(x.doc.id, db);
      assert.equal(after.version, 2); assert.equal(after.status, first === "void" ? "void" : first === "edit" ? "draft" : "pending");
      assert.equal(after.closedReason, first === "void" ? input.reason : null);
      assert.equal(after.lines.length, first === "edit" ? 1 : 2);
      assert.equal(after.lines[0].batchId, batch.id);
      const audit = await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "ct"), eq(s.auditLogs.entityId, x.doc.id)));
      assert.deepEqual(audit.map(row => row.action).sort(), ["create", first === "edit" ? "update_draft" : first].sort());
      console.log(`PASS ${mode}: real lock wait, one transition/audit, no replacement or stock movement`);
    }
    const limited = await draft();
    const reduced = await race(tx => tx.update(s.poLines).set({ receivedQty: "3" }).where(eq(s.poLines.id, source.id)),
      () => updateCt(maker, limited.doc.id, limited.input, secondDb));
    assert.equal(reduced.ok, false); if ("error" in reduced) assert.equal(reduced.error.status, 409);
    assert.deepEqual(await getCt(limited.doc.id, db), limited.detail);
    await db.update(s.poLines).set({ receivedQty: "10" }).where(eq(s.poLines.id, source.id));
    console.log("PASS PO receipt reduction commits first: repair rereads ceiling after lock, zero partial edit");
    const revoked = await draft();
    const denial = await race(tx => tx.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, maker.id)),
      () => updateCt(maker, revoked.doc.id, revoked.input, secondDb));
    assert.equal(denial.ok, false); if ("error" in denial) assert.equal(denial.error.status, 403);
    assert.deepEqual(await getCt(revoked.doc.id, db), revoked.detail);
    await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, maker.id));
    console.log("PASS revoked role commits first: repair rereads current actor after lock");
    const voidRevoked = await draft();
    const voidDenial = await race(tx => tx.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, maker.id)),
      () => voidCt(maker, voidRevoked.doc.id, { version: 1, reason: "核对" }, secondDb));
    assert.equal(voidDenial.ok, false); if ("error" in voidDenial) assert.equal(voidDenial.error.status, 403);
    assert.deepEqual(await getCt(voidRevoked.doc.id, db), voidRevoked.detail);
    await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, maker.id));
    console.log("PASS revoked role commits first: void waits and refuses with no document mutation");
    const failed = await draft();
    await control.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if NEW.user_id=${maker.id} and NEW.entity='ct' and NEW.action in ('update_draft', 'void') then raise exception 'CT deliberate audit failure'; end if; return NEW; end $$`);
    await control.query(`create trigger ${trigger} before insert on audit_logs for each row execute function ${fn}()`); installed = true;
    await assert.rejects(updateCt(maker, failed.doc.id, failed.input, db));
    assert.deepEqual(await getCt(failed.doc.id, db), failed.detail);
    await assert.rejects(voidCt(maker, failed.doc.id, { version: 1, reason: "原来源错误" }, db));
    assert.deepEqual(await getCt(failed.doc.id, db), failed.detail);
    assert.deepEqual(await stock(), originalStock);
    assert.equal((await db.select().from(s.poLines).where(eq(s.poLines.id, source.id)))[0].receivedQty, "10.0000");
    console.log(JSON.stringify({ fixture, cases: 13, makerId: maker.id, skuId: sku.id, warehouseId: wh.id, batchId: batch.id,
      auditFailureRollback: true, correctionLedgerWrites: 0, receiptUnchangedByRepair: true }, null, 2));
  } finally {
    await Promise.allSettled(pending);
    if (installed) await control.query(`drop trigger ${trigger} on audit_logs`);
    await control.query(`drop function if exists ${fn}()`);
    await Promise.allSettled(clients.map(c => c.end()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
