/** Opt-in disposable loopback proof. Retains synthetic drafts, lineage, receipts and audits; no posting. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";
import type { SessionUser } from "@/server/core/dto";
import { createStockDoc, getStockDoc, voidStockDoc } from "@/server/modules/inventory/stock-doc";
import { createStockRequest, getStockCreateResult } from "@/server/modules/inventory/stock-create-request";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), fixture = `stock-replace-${randomUUID().slice(0, 8)}`;
  const clients = ["control", "first", "competitor", "replay"].map(role => new pg.Client({ connectionString, application_name: `${fixture}-${role}`,
    connectionTimeoutMillis: 5000, query_timeout: 20000, options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" }));
  const [control, first, competitor, replay] = clients, pending: Promise<unknown>[] = [];
  const fault = `stock_replace_fault_${randomUUID().replaceAll("-", "")}`; let faultInstalled = false;
  try {
    await Promise.all(clients.map(c => c.connect()));
    const db = drizzle(first, { schema }), otherDb = drizzle(competitor, { schema }), replayDb = drizzle(replay, { schema });
    const pids = await Promise.all(clients.map(async c => (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid));
    const waitBlocked = async (waiter: number, blocker: number) => {
      const deadline = Date.now() + 8000;
      do {
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
    const body = { subtype: "opening", warehouseId: wh.id, lines: [{ skuId: sku.id, qty: "0.0001", price: "1.23" }] };
    const original = await createStockDoc(actor, body, db);
    await voidStockDoc(actor, original.id, { version: original.version, reason: "合成错仓，需独立重新填写" }, db);
    const originalBefore = (await control.query("select row_to_json(d) as doc from stock_docs d where id=$1", [original.id])).rows[0];
    const snapshot = async () => (await control.query(`select
      (select count(*)::int from stock_docs where created_by=$1) as docs,
      (select count(*)::int from stock_create_requests where requested_by=$1) as receipts,
      (select count(*)::int from audit_logs where user_id=$1) as audits,
      (select count(*)::int from stock_ledger where sku_id=$2) as ledger`, [actor.id, sku.id])).rows[0];
    const before = await snapshot();
    const heldDb = new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return (callback: (tx: AnyDb) => Promise<unknown>) => target.transaction(async tx => {
        const result = await callback(tx); await first.query("select pg_advisory_xact_lock(hashtext($1))", [fixture]); return result;
      });
      return Reflect.get(target, property, receiver);
    } });
    const track = <T,>(promise: Promise<T>) => { pending.push(promise); void promise.catch(() => undefined); return promise; };
    const conflict = (e: unknown) => (e as { status: number }).status === 409;
    const input = { ...body, replacementOfId: original.id, requestKey: randomUUID() };
    await control.query("begin"); await control.query("select pg_advisory_xact_lock(hashtext($1))", [fixture]);
    const create = track(createStockRequest(actor, input, heldDb)); await waitBlocked(pids[1], pids[0]);
    const compete = track(createStockRequest(actor, { ...input, requestKey: randomUUID() }, otherDb));
    const repeat = track(createStockRequest(actor, input, replayDb));
    await Promise.all([waitBlocked(pids[2], pids[1]), waitBlocked(pids[3], pids[1])]);
    assert.deepEqual(await snapshot(), before); await control.query("commit");
    const created = await create; assert.deepEqual(await repeat, created); await assert.rejects(compete, conflict);
    assert.deepEqual(await getStockCreateResult(actor, input.requestKey, db), created);
    assert.deepEqual(await snapshot(), { ...before, docs: before.docs + 1, receipts: 1, audits: before.audits + 1 });
    assert.deepEqual((await control.query("select row_to_json(d) as doc from stock_docs d where id=$1", [original.id])).rows[0], originalBefore);
    assert.equal((await getStockDoc(original.id, db, actor)).replacement.successor?.id, created.document.id);
    assert.equal((await getStockDoc(created.document.id, db, actor)).replacement.predecessor?.id, original.id);
    await assert.rejects(createStockRequest(actor, { ...input, replacementOfId: undefined }, db), conflict);
    const child = await getStockDoc(created.document.id, db, actor);
    await voidStockDoc(actor, child.id, { version: child.version, reason: "合成后继错单" }, db);
    await assert.rejects(createStockRequest(actor, { ...input, requestKey: randomUUID() }, db), conflict);
    const next = { ...body, replacementOfId: child.id, requestKey: randomUUID() }, beforeFault = await snapshot();
    const countersBefore = (await control.query("select * from doc_counters order by prefix, biz_date")).rows;
    await control.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id=${actor.id} AND NEW.entity='stock_doc' AND NEW.action='create' THEN RAISE EXCEPTION 'synthetic replacement audit fault'; END IF; RETURN NEW; END $$`);
    faultInstalled = true; await control.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${fault}()`);
    await assert.rejects(createStockRequest(actor, next, db)); assert.deepEqual(await snapshot(), beforeFault);
    assert.deepEqual((await control.query("select * from doc_counters order by prefix, biz_date")).rows, countersBefore);
    assert.equal((await getStockDoc(child.id, db, actor)).replacement.successor, null);
    await control.query(`DROP TRIGGER ${fault} ON audit_logs`); await control.query(`DROP FUNCTION ${fault}()`); faultInstalled = false;
    const grandchild = await createStockRequest(actor, next, db);
    assert.equal((await getStockDoc(child.id, db, actor)).replacement.successor?.id, grandchild.document.id);
    const constraintError = (code: string) => (e: unknown) => (e as { code: string }).code === code;
    await assert.rejects(control.query("update stock_docs set replacement_of_id=$1 where id=$2", [original.id, grandchild.document.id]), constraintError("23505"));
    await assert.rejects(control.query("update stock_docs set replacement_of_id=id where id=$1", [grandchild.document.id]), constraintError("23514"));
    await assert.rejects(control.query("update stock_docs set replacement_of_id=-123456 where id=$1", [grandchild.document.id]), constraintError("23503"));
    const browserOriginal = await createStockDoc(actor, body, db);
    await voidStockDoc(actor, browserOriginal.id, { version: browserOriginal.version, reason: "合成浏览器替代验收，重新填写正确数据" }, db);
    const beforeRevocation = await snapshot();
    await control.query("begin"); await control.query("update users set session_version=session_version+1 where id=$1", [actor.id]);
    const revoked = track(createStockRequest(actor, { ...body, replacementOfId: browserOriginal.id, requestKey: randomUUID() }, otherDb));
    await waitBlocked(pids[2], pids[0]); await control.query("commit");
    await assert.rejects(revoked, (e: unknown) => (e as { status: number }).status === 401);
    assert.deepEqual(await snapshot(), beforeRevocation);
    console.log(JSON.stringify({ fixture, makerId: actor.id, skuId: sku.id, warehouseId: wh.id,
      documents: { original: original.id, child: child.id, grandchild: grandchild.document.id, browserOriginal: browserOriginal.id },
      checks: ["different keys wait on original", "same key waits on receipt", "uncommitted effects invisible", "one successor and receipt", "original unchanged", "both-way links", "changed lineage conflicts", "void successor cannot fork", "audit failure rolls back all including number", "same-key retry after fault", "unique successor constraint", "acyclic order constraint", "predecessor FK", "creation waits then rejects revoked session"], final: await snapshot() }, null, 2));
  } finally {
    await control.query("rollback").catch(() => undefined); await Promise.allSettled(pending);
    if (faultInstalled) { await control.query(`DROP TRIGGER IF EXISTS ${fault} ON audit_logs`).catch(() => undefined); await control.query(`DROP FUNCTION IF EXISTS ${fault}()`).catch(() => undefined); }
    await Promise.allSettled(clients.map(c => c.end()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
