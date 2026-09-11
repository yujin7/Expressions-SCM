/** Real lock proof. Only an explicitly opted-in, disposable loopback contract database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { confirmJg, submitJg, reviseJgDueDate, updateJgPlan } from "@/server/modules/outsource/jg";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env);
  const key = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const dbA = drizzle(a, { schema: s }), dbB = drizzle(b, { schema: s });
    const [u] = await dbA.insert(s.users).values({ name: `TF-QA-${key}`, roles: ["pmc"] }).returning();
    const user = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover };
    const [spu] = await dbA.insert(s.spus).values({ code: `JG-${key}`, nameCn: "测试" }).returning();
    const [sku] = await dbA.insert(s.skus).values({ code: `JG-${key}`, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
    const [supplier] = await dbA.insert(s.suppliers).values({ code: `JG-${key}`, name: "测试加工厂" }).returning();
    const [bom] = await dbA.insert(s.boms).values({ productSkuId: sku.id, versionNo: "1" }).returning();
    const [wo] = await dbA.insert(s.woDocs).values({ docNo: `JG-${key}`, createdBy: u.id, productSkuId: sku.id, supplierId: supplier.id, bomId: bom.id, qty: "10", feeRatePlan: "1" }).returning();
    const [doc] = await dbA.insert(s.jgDocs).values({ docNo: `JG-${key}`, createdBy: u.id, woId: wo.id, productSkuId: sku.id, supplierId: supplier.id, qty: "10", feeRateCurrent: "1", status: "approved", dueDate: "2026-09-20" }).returning();
    const [{ pid }] = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows;
    const waitForLock = async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await control.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error("Competing request never reached an actual PostgreSQL lock");
    };
    type Tx = Parameters<Parameters<typeof dbA.transaction>[0]>[0];
    const race = async <A, B>(first: (tx: Tx) => Promise<A>, second: () => Promise<B>) => {
      const ready = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      const firstWrite = dbA.transaction(async tx => { const value = await first(tx); ready.resolve(); await gate.promise; return value; });
      await Promise.race([ready.promise, firstWrite.then(() => { throw Error("Commit barrier left early"); })]);
      const secondWrite = second().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      try { await waitForLock(); } finally { gate.resolve(); }
      return { first: await firstWrite, second: await secondWrite };
    };
    const revised = await race(tx => reviseJgDueDate(user, doc.id, { newDate: "2026-09-22", reason: "首次" }, tx),
      () => reviseJgDueDate(user, doc.id, { newDate: "2026-09-24", reason: "其次" }, dbB));
    assert(revised.second.ok);
    const [after] = await dbA.select().from(s.jgDocs).where(eq(s.jgDocs.id, doc.id));
    const history = after.revisedDates as { from: string; to: string }[];
    assert.deepEqual(history.map(r => [r.from, r.to]), [["2026-09-20", "2026-09-22"], ["2026-09-22", "2026-09-24"]]);
    console.log("PASS concurrent due revisions retain both history entries in committed order");
    const closed = await race(tx => tx.update(s.jgDocs).set({ status: "closed" }).where(eq(s.jgDocs.id, doc.id)),
      () => updateJgPlan(user, doc.id, { urgentFlag: true }, dbB));
    assert(!closed.second.ok); assert.equal(closed.second.error.status, 409);
    assert.equal((await dbA.select().from(s.jgDocs).where(eq(s.jgDocs.id, doc.id)))[0].urgentFlag, false);
    console.log("PASS packaging-plan edit waits for close and refuses terminal mutation");
    let sequence = 1;
    const freshDoc = async (status: "draft" | "approved") => (await dbA.insert(s.jgDocs).values({
      docNo: `JG-${key}-${++sequence}`, batchSeq: sequence, createdBy: u.id, woId: wo.id, productSkuId: sku.id,
      supplierId: supplier.id, qty: "10", feeRateCurrent: "1", status,
    }).returning())[0];
    for (const kind of ["submit", "confirm"] as const) {
      const target = await freshDoc(kind === "submit" ? "draft" : "approved");
      const run = (db: typeof dbA | Tx) => kind === "submit" ? submitJg(user, target.id, 1, db)
        : confirmJg(user, target.id, { version: 1 }, db);
      const duplicate = await race(tx => run(tx), () => run(dbB));
      assert(!duplicate.second.ok); assert.equal(duplicate.second.error.status, 409);
      const rows = await control.query("select action from audit_logs where entity='jg' and entity_id=$1", [target.id]);
      assert.deepEqual(rows.rows.map(r => r.action), [kind]);
      const [result] = await dbA.select().from(s.jgDocs).where(eq(s.jgDocs.id, target.id));
      assert.equal(result.version, 2); assert.equal(result.status, kind === "submit" ? "pending" : "in_progress");
      console.log(`PASS concurrent JG ${kind} commits exactly one version and audit`);
    }
    const terminal = await freshDoc("approved");
    const closeConfirm = await race(tx => tx.update(s.jgDocs).set({ status: "closed" }).where(eq(s.jgDocs.id, terminal.id)),
      () => confirmJg(user, terminal.id, { version: 1 }, dbB));
    assert(!closeConfirm.second.ok); assert.equal(closeConfirm.second.error.status, 409);
    assert.equal((await dbA.select().from(s.jgDocs).where(eq(s.jgDocs.id, terminal.id)))[0].inProduction, false);
    console.log("PASS confirmation waits for close and cannot resurrect terminal JG");
    const disabled = await freshDoc("draft");
    const revoke = await race(tx => tx.update(s.users).set({ active: false }).where(eq(s.users.id, user.id)),
      () => submitJg(user, disabled.id, 1, dbB));
    assert(!revoke.second.ok); assert.equal(revoke.second.error.status, 403);
    assert.equal((await dbA.select().from(s.jgDocs).where(eq(s.jgDocs.id, disabled.id)))[0].status, "draft");
    console.log("PASS submit waits for account disable and refuses revoked actor");
    console.log(JSON.stringify({ passed: true, cases: 6, fixture: key, database: new URL(connectionString).pathname.slice(1) }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
