/** Opt-in multi-connection proof. Synthetic loopback scm_contract_* only; fixtures retained. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { approveJs, createJs, getJsBasis, refreshJsBasis, submitJs } from "@/server/modules/settlement/js";
import { approveTl, createTl, submitTl } from "@/server/modules/matflow/tl";
import { approveFl, createFl, submitFl } from "@/server/modules/matflow/fl";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), key = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), other = drizzle(b, { schema: s });
    const actor = async (roles: string[]) => {
      const [u] = await db.insert(s.users).values({ name: `BASIS-${key}-${roles[0]}`, roles, isApprover: true }).returning();
      return { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
    };
    const pmc = await actor(["pmc"]), finance = await actor(["finance"]), maker = await actor(["warehouse"]), checker = await actor(["warehouse"]);
    await db.insert(s.approvalConfigs).values([{ docType: "js", approverRole: "finance" }, { docType: "tl", approverRole: "warehouse" }, { docType: "fl", approverRole: "warehouse" }]).onConflictDoNothing();
    const [spu] = await db.insert(s.spus).values({ code: `BASIS-${key}`, nameCn: "结算依据合成验证" }).returning();
    const [product, material] = await db.insert(s.skus).values([
      { code: `BASIS-CP-${key}`, name: "合成成品", spuId: spu.id, skuType: "finished", baseUom: "支" },
      { code: `BASIS-YL-${key}`, name: "合成物料", spuId: spu.id, skuType: "raw", baseUom: "个", lossCategory: `basis-${key}` },
    ]).returning();
    const [sup] = await db.insert(s.suppliers).values({ code: `BASIS-${key}`, name: "结算依据合成加工厂" }).returning();
    await db.insert(s.priceLists).values({ supplierId: sup.id, skuId: material.id, price: "2", effectiveDate: "2020-01-01" });
    await db.insert(s.sysParams).values({ scope: `category:basis-${key}`, key: "loss_rate_pct", value: "0" });
    const [own, outside] = await db.insert(s.warehouses).values([
      { code: `BASIS-OWN-${key}`, name: "合成自有仓", kind: "raw" },
      { code: `BASIS-OUT-${key}`, name: "合成委外仓", kind: "outsource", supplierId: sup.id },
    ]).returning();
    await db.insert(s.stockBalances).values([{ skuId: material.id, warehouseId: own.id, qty: "1000" }, { skuId: material.id, warehouseId: outside.id, qty: "1000" }]);
    const [bom] = await db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1" }).returning();
    let seq = 0;
    const setup = async () => {
      const no = `BASIS-${key}-${++seq}`;
      const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${no}`, productSkuId: product.id, supplierId: sup.id, bomId: bom.id, qty: "100", feeRatePlan: "2", createdBy: pmc.id }).returning();
      await db.insert(s.woLines).values({ woId: wo.id, materialSkuId: material.id, qtyPer: "1", grossReq: "100", suggestedQty: "100" });
      const [jg] = await db.insert(s.jgDocs).values({ docNo: `JG-${no}`, woId: wo.id, productSkuId: product.id, supplierId: sup.id, qty: "100", feeRateCurrent: "2", status: "completed", createdBy: pmc.id }).returning();
      const [fl] = await db.insert(s.flDocs).values({ docNo: `FL-${no}`, jgId: jg.id, fromWarehouseId: own.id, toWarehouseId: outside.id, status: "completed", createdBy: maker.id }).returning();
      await db.insert(s.flLines).values({ flId: fl.id, skuId: material.id, qty: "120" });
      const [sh] = await db.insert(s.shDocs).values({ docNo: `SH-${no}`, sourceType: "jg", sourceId: jg.id, warehouseId: own.id, status: "completed", createdBy: maker.id }).returning();
      const [sl] = await db.insert(s.shLines).values({ shId: sh.id, skuId: product.id, lineType: "normal", actualQty: "100" }).returning();
      const [qc] = await db.insert(s.qcRecords).values({ shId: sh.id, createdBy: maker.id, conclusion: "合格" }).returning();
      await db.insert(s.qcLines).values({ qcId: qc.id, shLineId: sl.id, passQty: "100", concessionQty: "0" });
      return jg;
    };
    const returnDoc = async (jgId: number, qty: string) => {
      const tl = await createTl(maker, { jgId, toWarehouseId: own.id, lines: [{ skuId: material.id, qty, reason: "surplus_return" }] }, db);
      return submitTl(maker, tl.id, tl.version, db);
    };
    const [{ pid }] = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows;
    type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
    const race = async <A, B>(first: (tx: Tx) => Promise<A>, second: () => Promise<B>) => {
      const ready = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      const firstWrite = db.transaction(async tx => { const value = await first(tx); ready.resolve(); await gate.promise; return value; });
      await Promise.race([ready.promise, firstWrite.then(() => { throw Error("Commit barrier left early"); })]);
      const secondWrite = second().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      let waited = false;
      try {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if ((await control.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") { waited = true; break; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      } finally { gate.resolve(); }
      const result = { first: await firstWrite, second: await secondWrite }; assert(waited, "Second connection must reach an actual PostgreSQL lock"); return result;
    };
    const jg = await setup(), js = await createJs(pmc, { jgId: jg.id }, db), pending = await submitJs(pmc, js.id, { version: js.version }, db);
    const tl = await returnDoc(jg.id, "5");
    const approvalRace = await race(tx => approveTl(checker, tl.id, { action: "approve", version: tl.version }, tx),
      () => approveJs(finance, js.id, { action: "approve", version: pending.version }, other));
    assert(!approvalRace.second.ok); assert.equal(approvalRace.second.error.status, 409);
    assert.equal((await db.select().from(s.approvals).where(and(eq(s.approvals.docType, "js"), eq(s.approvals.docId, js.id)))).length, 0);
    console.log("PASS JS approval waits for committed TL, rejects stale deductions, no approval/writeoff");
    await approveJs(finance, js.id, { action: "reject", version: pending.version }, db);
    const review = await getJsBasis(pmc, js.id, db), tl2 = await returnDoc(jg.id, "5");
    const refreshRace = await race(tx => approveTl(checker, tl2.id, { action: "approve", version: tl2.version }, tx),
      () => refreshJsBasis(pmc, js.id, { version: review.version, basisToken: review.basisToken, note: "stale review" }, other));
    assert(!refreshRace.second.ok); assert.equal(refreshRace.second.error.status, 409);
    assert.equal((await db.select().from(s.jsDocs).where(eq(s.jsDocs.id, js.id)))[0].deductionTotal, "40.00");
    console.log("PASS reviewed refresh waits for TL and refuses changed fingerprint without overwriting draft");
    const secondJg = await setup(), left = await returnDoc(secondJg.id, "80"), right = await returnDoc(secondJg.id, "80");
    const overReturn = await race(tx => approveTl(checker, left.id, { action: "approve", version: left.version }, tx),
      () => approveTl(checker, right.id, { action: "approve", version: right.version }, other));
    assert(!overReturn.second.ok); assert.equal(overReturn.second.error.status, 409);
    console.log("PASS concurrent TL cumulative quantity cannot exceed this JG's issued quantity despite pooled stock");
    const thirdJg = await setup();
    await db.update(s.jgDocs).set({ status: "in_progress" }).where(eq(s.jgDocs.id, thirdJg.id));
    // Existing synthetic FL is 120; increase gross to 200 so first extra60 fits and second extra60 exceeds.
    await db.update(s.woLines).set({ grossReq: "200" }).where(eq(s.woLines.woId, thirdJg.woId));
    const issueDoc = async () => { const fl = await createFl(maker, { jgId: thirdJg.id, fromWarehouseId: own.id, lines: [{ skuId: material.id, qty: "60" }] }, db); return submitFl(maker, fl.id, fl.version, db); };
    const issueA = await issueDoc(), issueB = await issueDoc();
    const overIssue = await race(tx => approveFl(checker, issueA.id, { action: "approve", version: issueA.version }, tx),
      () => approveFl(checker, issueB.id, { action: "approve", version: issueB.version }, other));
    assert(!overIssue.second.ok); assert.equal(overIssue.second.error.status, 403);
    console.log("PASS concurrent FL cannot both bypass cumulative over-issue approval");
    const draftSource = await setup();
    await db.update(s.jgDocs).set({ status: "in_progress" }).where(eq(s.jgDocs.id, draftSource.id));
    const draftInput = { jgId: draftSource.id, fromWarehouseId: own.id, lines: [{ skuId: material.id, qty: "1.2345" }] };
    const beforeDocs = await db.select().from(s.flDocs).where(eq(s.flDocs.jgId, draftSource.id));
    const createAfterClosure = await race(tx => tx.update(s.jgDocs).set({ status: "closed" }).where(eq(s.jgDocs.id, draftSource.id)),
      () => createFl(maker, draftInput, other));
    assert(!createAfterClosure.second.ok); assert.equal(createAfterClosure.second.error.status, 409);
    assert.deepEqual(await db.select().from(s.flDocs).where(eq(s.flDocs.jgId, draftSource.id)), beforeDocs);
    console.log("PASS FL creation waits for concurrent JG state change and refuses a closed source");
    const submitSource = await setup();
    await db.update(s.jgDocs).set({ status: "in_progress" }).where(eq(s.jgDocs.id, submitSource.id));
    const waitingFl = await createFl(maker, { ...draftInput, jgId: submitSource.id }, db);
    const submitAfterClosure = await race(tx => tx.update(s.jgDocs).set({ status: "completed" }).where(eq(s.jgDocs.id, submitSource.id)),
      () => submitFl(maker, waitingFl.id, waitingFl.version, other));
    assert(!submitAfterClosure.second.ok); assert.equal(submitAfterClosure.second.error.status, 409);
    assert.equal((await db.select().from(s.flDocs).where(eq(s.flDocs.id, waitingFl.id)))[0].status, "draft");
    console.log("PASS FL submission waits for concurrent JG state change and preserves the draft");
    const retrySource = await setup();
    await db.update(s.jgDocs).set({ status: "in_progress" }).where(eq(s.jgDocs.id, retrySource.id));
    const retryFl = await createFl(maker, { ...draftInput, jgId: retrySource.id }, db);
    const doubleSubmit = await race(tx => submitFl(maker, retryFl.id, retryFl.version, tx),
      () => submitFl(maker, retryFl.id, retryFl.version, other));
    assert(!doubleSubmit.second.ok); assert.equal(doubleSubmit.second.error.status, 409);
    const submitted = (await db.select().from(s.flDocs).where(eq(s.flDocs.id, retryFl.id)))[0];
    assert.equal(submitted.status, "pending"); assert.equal(submitted.version, retryFl.version + 1);
    assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "fl"), eq(s.auditLogs.entityId, retryFl.id), eq(s.auditLogs.action, "submit")))).length, 1);
    console.log("PASS duplicate FL submission waits and cannot duplicate status, version or audit");
    console.log(JSON.stringify({ passed: true, cases: 7, fixture: key, browserDraft: js.id, browserJg: jg.id,
      browserFl: retryFl.id, issueJg: retrySource.id, database: new URL(connectionString).pathname.slice(1) }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
