/** Disposable loopback proof; retains synthetic documents, one opening posting and audits. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";
import type { SessionUser } from "@/server/core/dto";
import { approveStockDoc, createStockDoc, getStockDoc, shortCloseStockDoc, submitStockDoc, voidStockDoc, withdrawStockDoc } from "@/server/modules/inventory/stock-doc";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), fixture = `stock-exit-${randomUUID().slice(0, 8)}`;
  const clients = ["control", "first", "second"].map(role => new pg.Client({ connectionString, application_name: `${fixture}-${role}`,
    connectionTimeoutMillis: 5000, query_timeout: 20000, options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" }));
  const [control, first, second] = clients, pending: Promise<unknown>[] = [];
  const fault = `stock_exit_fault_${randomUUID().replaceAll("-", "")}`; let faultInstalled = false;
  try {
    await Promise.all(clients.map(c => c.connect()));
    const db = drizzle(first, { schema }), otherDb = drizzle(second, { schema });
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
    const actorOf = (u: typeof schema.users.$inferSelect): SessionUser => ({ id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion });
    const [maker] = await db.insert(schema.users).values({ name: `${fixture}-maker`, roles: ["warehouse"] }).returning();
    const [checker] = await db.insert(schema.users).values({ name: `${fixture}-checker`, roles: ["admin", "finance"], isApprover: true }).returning();
    const actor = actorOf(maker), approver = actorOf(checker);
    const [spu] = await db.insert(schema.spus).values({ code: fixture, nameCn: fixture }).returning();
    const [sku] = await db.insert(schema.skus).values({ code: fixture, name: fixture, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    const [wh] = await db.insert(schema.warehouses).values({ code: fixture, name: fixture, kind: "raw", accountingMode: "realtime" }).returning();
    const body = { subtype: "opening", warehouseId: wh.id, lines: [{ skuId: sku.id, qty: "0.0001", price: "1.23" }] };
    const snapshot = async () => (await control.query(`select
      (select count(*)::int from stock_docs where created_by=$1) as docs,
      (select count(*)::int from audit_logs where user_id in ($1,$2)) as audits,
      (select count(*)::int from stock_ledger where sku_id=$3) as ledger,
      (select coalesce(sum(qty),0)::text from stock_balances where sku_id=$3) as qty`, [maker.id, checker.id, sku.id])).rows[0];
    const hold = async () => { await control.query("begin"); await control.query("select pg_advisory_xact_lock(hashtext($1))", [fixture]); };
    const heldDb = new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return (callback: (tx: AnyDb) => Promise<unknown>) => target.transaction(async tx => {
        const result = await callback(tx); await first.query("select pg_advisory_xact_lock(hashtext($1))", [fixture]); return result;
      });
      return Reflect.get(target, property, receiver);
    } });
    const track = <T,>(promise: Promise<T>) => { pending.push(promise); void promise.catch(() => undefined); return promise; };
    const conflict = (e: unknown) => (e as { status: number }).status === 409;
    const cancelled = await createStockDoc(actor, body, db), beforeVoid = await snapshot();
    await hold();
    const cancel = track(voidStockDoc(actor, cancelled.id, { version: cancelled.version, reason: "合成错仓退出" }, heldDb));
    await waitBlocked(pids[1], pids[0]);
    const lateSubmit = track(submitStockDoc(actor, cancelled.id, cancelled.version, otherDb));
    await waitBlocked(pids[2], pids[1]); assert.deepEqual(await snapshot(), beforeVoid);
    await control.query("commit"); await cancel; await assert.rejects(lateSubmit, conflict);
    assert.equal((await getStockDoc(cancelled.id, db, actor)).closedReason, "合成错仓退出");
    assert.deepEqual(await snapshot(), { ...beforeVoid, audits: beforeVoid.audits + 1 });
    const posted = await createStockDoc(actor, body, db), submitted = await submitStockDoc(actor, posted.id, posted.version, db);
    const beforeApproval = await snapshot(); await hold();
    const approval = track(approveStockDoc(approver, posted.id, { version: submitted.version, action: "approve" }, heldDb));
    await waitBlocked(pids[1], pids[0]);
    const withdrawal = track(withdrawStockDoc(actor, posted.id, { version: submitted.version }, otherDb));
    await waitBlocked(pids[2], pids[1]); assert.deepEqual(await snapshot(), beforeApproval);
    await control.query("commit"); assert.equal((await approval).status, "completed"); await assert.rejects(withdrawal, conflict);
    assert.deepEqual(await snapshot(), { ...beforeApproval, audits: beforeApproval.audits + 2, ledger: 1, qty: "0.0001" });
    assert.equal((await approveStockDoc(approver, posted.id, { version: submitted.version, action: "approve" }, db)).idempotent, true);
    const retry = await createStockDoc(actor, body, db), beforeFault = await snapshot();
    await control.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id=${maker.id} AND NEW.entity='stock_doc' AND NEW.action='void' THEN RAISE EXCEPTION 'synthetic stock exit audit fault'; END IF; RETURN NEW; END $$`);
    faultInstalled = true;
    await control.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${fault}()`);
    await assert.rejects(voidStockDoc(actor, retry.id, { version: retry.version, reason: "合成审计回滚" }, db));
    assert.deepEqual(await snapshot(), beforeFault);
    const unchanged = await getStockDoc(retry.id, db, actor); assert.equal(unchanged.status, "draft"); assert.equal(unchanged.closedReason, null);
    await control.query(`DROP TRIGGER ${fault} ON audit_logs`); await control.query(`DROP FUNCTION ${fault}()`); faultInstalled = false;
    await voidStockDoc(actor, retry.id, { version: retry.version, reason: "合成审计恢复" }, db);
    const caIds: number[] = [];
    for (const [status, action] of [["draft", voidStockDoc], ["pending", withdrawStockDoc], ["approved", shortCloseStockDoc]] as const) {
      const [ca] = await db.insert(schema.stockDocs).values({ docNo: `${fixture}-CA-${status}`, subtype: "count_adjust", status, createdBy: maker.id, sourceDocType: "pd", sourceDocId: 987654 }).returning();
      caIds.push(ca.id); const before = await snapshot();
      await assert.rejects(action(actor, ca.id, { version: ca.version, reason: "合成来源保护" }, db), conflict);
      assert.deepEqual(await snapshot(), before); assert.equal((await getStockDoc(ca.id, db, actor)).status, status);
    }
    const revoked = await createStockDoc(actor, body, db), beforeRevoke = await snapshot();
    await control.query("begin"); await control.query("update users set session_version=session_version+1 where id=$1", [maker.id]);
    const revokedVoid = track(voidStockDoc(actor, revoked.id, { version: revoked.version, reason: "合成身份撤销" }, otherDb));
    await waitBlocked(pids[2], pids[0]); await control.query("commit");
    await assert.rejects(revokedVoid, (e: unknown) => (e as { status: number }).status === 401); assert.deepEqual(await snapshot(), beforeRevoke);
    console.log(JSON.stringify({ fixture, makerId: maker.id, approverId: checker.id, skuId: sku.id, warehouseId: wh.id,
      documents: { cancelled: cancelled.id, posted: posted.id, retry: retry.id, caIds, revoked: revoked.id },
      checks: ["void wins delayed submit", "uncommitted void invisible", "reason retained", "approval wins withdrawal", "uncommitted posting invisible", "one exact posting", "approval replay unchanged", "audit fault rolls back exit", "retry after audit recovery", "CA draft void rejected", "CA pending withdrawal rejected", "CA short close rejected", "exit waits then rejects revoked session"], final: await snapshot() }, null, 2));
  } finally {
    await control.query("rollback").catch(() => undefined); await Promise.allSettled(pending);
    if (faultInstalled) { await control.query(`DROP TRIGGER IF EXISTS ${fault} ON audit_logs`).catch(() => undefined); await control.query(`DROP FUNCTION IF EXISTS ${fault}()`).catch(() => undefined); }
    await Promise.allSettled(clients.map(c => c.end()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
