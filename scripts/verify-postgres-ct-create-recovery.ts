/** Opt-in disposable loopback proof. Retains synthetic drafts/receipts/audits; never posts inventory. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { post } from "@/server/posting";
import * as schema from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";
import type { SessionUser } from "@/server/core/dto";
import { createCtRequest, getCtCreateResult, cancelCtCreateRequest } from "@/server/modules/matflow/ct-create-request";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), fixture = `ct-create-recovery-${randomUUID().slice(0, 8)}`;
  const clients = ["control", "create", "replay", "lookup"].map(role => new pg.Client({ connectionString, application_name: `${fixture}-${role}`,
    connectionTimeoutMillis: 5000, query_timeout: 20000, options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" }));
  const [control, creator, replay, lookup] = clients;
  const pending: Promise<unknown>[] = [];
  const faultName = `ct_cancel_fault_${fixture.replaceAll("-", "_")}`;
  let faultInstalled = false;
  try {
    await Promise.all(clients.map(c => c.connect()));
    const db = drizzle(creator, { schema }), replayDb = drizzle(replay, { schema }), lookupDb = drizzle(lookup, { schema });
    const pids = await Promise.all(clients.map(async c => (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid));
    const waitBlocked = async (waiter: number, blocker: number) => {
      const deadline = Date.now() + 8000;
      do {
        await control.query("select pg_stat_clear_snapshot()");
        if ((await control.query<{ blocked: boolean }>("select $1::int=any(pg_blocking_pids($2::int)) as blocked", [blocker, waiter])).rows[0].blocked) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      throw Error("Expected real PostgreSQL lock wait was not observed");
    };
    const [u] = await db.insert(schema.users).values({ name: fixture, roles: ["warehouse"] }).returning();
    const actor: SessionUser = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
    const [spu] = await db.insert(schema.spus).values({ code: fixture, nameCn: fixture }).returning();
    const [sku] = await db.insert(schema.skus).values({ code: fixture, name: fixture, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    const [wh] = await db.insert(schema.warehouses).values({ code: fixture, name: fixture, kind: "raw", accountingMode: "realtime" }).returning();
    const [supplier] = await db.insert(schema.suppliers).values({code:fixture,name:fixture}).returning();
    const [po] = await db.insert(schema.poDocs).values({docNo:fixture,supplierId:supplier.id,createdBy:actor.id,status:"completed"}).returning();
    const [line] = await db.insert(schema.poLines).values({poId:po.id,skuId:sku.id,lineType:"raw",purchaseUom:"kg",uomFactor:"1",qty:"10",price:"1",receivedQty:"10"}).returning();
    await post(db,{sourceDocType:"opening",sourceDocId:po.id,action:"post",lines:[{sourceLineId:line.id,skuId:sku.id,warehouseId:wh.id,batchId:null,qtyDelta:"10"}]});
    const body = { requestKey: randomUUID(), poId:po.id, warehouseId: wh.id, lines: [{ poLineId:line.id, skuId: sku.id, qty: "0.0001", batchId:null }] };
    const snapshot = async () => (await control.query(`select
      (select count(*)::int from ct_docs where created_by=$1) as docs,
      (select count(*)::int from ct_create_requests where requested_by=$1) as receipts,
      (select count(*)::int from audit_logs where user_id=$1) as audits,
      (select count(*)::int from stock_ledger where sku_id=$2) as ledger`, [actor.id, sku.id])).rows[0];
    await control.query("begin"); await control.query("select pg_advisory_xact_lock(hashtext($1))", [fixture]);
    const heldDb = new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return (callback: (tx: AnyDb) => Promise<unknown>) => target.transaction(async tx => {
        const result = await callback(tx);
        await creator.query("select pg_advisory_xact_lock(hashtext($1))", [fixture]); return result;
      });
      return Reflect.get(target, property, receiver);
    } });
    const original = createCtRequest(actor, body, heldDb); pending.push(original); void original.catch(() => undefined);
    await waitBlocked(pids[1], pids[0]);
    const duplicate = createCtRequest(actor, body, replayDb), read = getCtCreateResult(actor, body.requestKey, lookupDb);
    pending.push(duplicate, read); void duplicate.catch(() => undefined); void read.catch(() => undefined);
    await Promise.all([waitBlocked(pids[2], pids[1]), waitBlocked(pids[3], pids[1])]);
    assert.deepEqual(await snapshot(), { docs: 0, receipts: 0, audits: 0, ledger: 1 });
    await control.query("commit");
    const results = await Promise.all([original, duplicate, read]);
    assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0], results[2]);
    assert.deepEqual(await snapshot(), { docs: 1, receipts: 1, audits: 1, ledger: 1 });
    await assert.rejects(control.query("update ct_create_requests set request_hash=$1 where requested_by=$2", ["a".repeat(64),actor.id]));
    await assert.rejects(control.query("delete from ct_create_requests where requested_by=$1", [actor.id]));
    await assert.rejects(createCtRequest(actor, { ...body, remark: "changed" }, db), (e: unknown) => (e as { status: number }).status === 409);
    await control.query("update ct_docs set status='void' where id=$1", [results[0].document.id]);
    await control.query("update warehouses set active=false where id=$1", [wh.id]);
    assert.equal((await createCtRequest(actor, body, db)).document.status, "void");
    await control.query("update users set session_version=session_version+1 where id=$1", [actor.id]);
    await assert.rejects(getCtCreateResult(actor, body.requestKey, db));
    assert.deepEqual(await snapshot(), { docs: 1, receipts: 1, audits: 1, ledger: 1 });
    const liveActor = { ...actor, sessionVersion: actor.sessionVersion! + 1 };
    await control.query("update warehouses set active=true where id=$1", [wh.id]);
    const cancelledBody = { ...body, requestKey: randomUUID() };
    await control.query("begin"); await control.query("select pg_advisory_xact_lock(hashtext($1))", [fixture]);
    const cancellation = cancelCtCreateRequest(liveActor, { requestKey: cancelledBody.requestKey }, heldDb); pending.push(cancellation); void cancellation.catch(() => undefined);
    await waitBlocked(pids[1], pids[0]);
    const delayed = createCtRequest(liveActor, cancelledBody, replayDb); pending.push(delayed); void delayed.catch(() => undefined);
    const cancellationLookup = getCtCreateResult(liveActor, cancelledBody.requestKey, lookupDb); pending.push(cancellationLookup); void cancellationLookup.catch(() => undefined);
    await Promise.all([waitBlocked(pids[2], pids[1]), waitBlocked(pids[3], pids[1])]);
    assert.deepEqual(await snapshot(), { docs: 1, receipts: 1, audits: 1, ledger: 1 });
    await control.query("commit");
    const cancelled = await cancellation; assert.equal(cancelled.cancelled, true); assert.equal(cancelled.document, null);
    await assert.rejects(delayed, (e: unknown) => (e as { status: number }).status === 409);
    assert.deepEqual(await cancellationLookup, cancelled);
    assert.deepEqual(await cancelCtCreateRequest(liveActor, { requestKey: cancelledBody.requestKey }, db), cancelled);
    assert.deepEqual(await snapshot(), { docs: 1, receipts: 2, audits: 2, ledger: 1 });

    const createdBody = { ...body, requestKey: randomUUID() };
    await control.query("begin"); await control.query("select pg_advisory_xact_lock(hashtext($1))", [fixture]);
    const beforeCancel = createCtRequest(liveActor, createdBody, heldDb); pending.push(beforeCancel); void beforeCancel.catch(() => undefined);
    await waitBlocked(pids[1], pids[0]);
    const lateCancel = cancelCtCreateRequest(liveActor, { requestKey: createdBody.requestKey }, replayDb); pending.push(lateCancel); void lateCancel.catch(() => undefined);
    await waitBlocked(pids[2], pids[1]);
    await control.query("commit");
    const createdFirst = await beforeCancel; assert.deepEqual(await lateCancel, createdFirst);
    assert.equal(createdFirst.document.status, "draft");
    assert.deepEqual(await snapshot(), { docs: 2, receipts: 3, audits: 3, ledger: 1 });

    await control.query(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id=${actor.id} AND NEW.entity='ct_create_request' THEN RAISE EXCEPTION 'synthetic CT cancellation audit fault'; END IF; RETURN NEW; END $$`);
    faultInstalled = true;
    await control.query(`CREATE TRIGGER ${faultName} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${faultName}()`);
    const retryKey = randomUUID();
    await assert.rejects(cancelCtCreateRequest(liveActor, { requestKey: retryKey }, db));
    assert.deepEqual(await getCtCreateResult(liveActor, retryKey, db), { requestKey: retryKey, document: null });
    assert.deepEqual(await snapshot(), { docs: 2, receipts: 3, audits: 3, ledger: 1 });
    await control.query(`DROP TRIGGER ${faultName} ON audit_logs`); await control.query(`DROP FUNCTION ${faultName}()`); faultInstalled = false;
    assert.equal((await cancelCtCreateRequest(liveActor, { requestKey: retryKey }, db)).cancelled, true);
    await control.query("begin"); await control.query("update users set session_version=session_version+1 where id=$1", [actor.id]);
    const revokedCancel = cancelCtCreateRequest(liveActor, { requestKey: randomUUID() }, replayDb); pending.push(revokedCancel); void revokedCancel.catch(() => undefined);
    await waitBlocked(pids[2], pids[0]); await control.query("commit");
    await assert.rejects(revokedCancel);
    assert.deepEqual(await snapshot(), { docs: 2, receipts: 4, audits: 4, ledger: 1 });
    console.log(JSON.stringify({ fixture, actorId: actor.id, documentId: results[0].document.id, createdBeforeCancelId: createdFirst.document.id,
      checks: ["in-flight replay waits", "lookup waits", "uncommitted facts invisible", "one draft/receipt/audit", "immutable update/delete refused", "different body conflicts", "void replay after warehouse disable", "revoked session rejected", "zero CT ledger writes (opening retained)",
        "cancel-first fences delayed create", "lookup waits for cancellation", "uncommitted cancellation invisible", "repeat cancellation has one audit", "create-first cancellation waits and preserves draft", "real audit fault rolls back cancellation", "failed cancellation can retry", "cancellation waits for identity revocation and refuses"], final: await snapshot() }, null, 2));
  } finally {
    await control.query("rollback").catch(() => undefined); await Promise.allSettled(pending);
    if (faultInstalled) { await control.query(`DROP TRIGGER IF EXISTS ${faultName} ON audit_logs`).catch(() => undefined); await control.query(`DROP FUNCTION IF EXISTS ${faultName}()`).catch(() => undefined); }
    await Promise.allSettled(clients.map(c => c.end()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
