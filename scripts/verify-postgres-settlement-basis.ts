/** Opt-in multi-connection proof. Synthetic loopback scm_contract_* only; fixtures retained. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { approveJs, createJs, getJsBasis, refreshJsBasis, submitJs } from "@/server/modules/settlement/js";
import { approveTl, createTl, submitTl } from "@/server/modules/matflow/tl";
import { approveFl, createFl, submitFl } from "@/server/modules/matflow/fl";
import { confirmInbound } from "@/server/modules/matflow/sh";
import { checkBatchAfterPoReceipt, createBatchJg } from "@/server/modules/outsource/auto-chain";
import { approveWo, createWo, generateDocs, getWoCreateResult, submitWo, transitionWO, withdrawWO } from "@/server/modules/outsource/wo";
import { getReceiptBatchReview } from "@/server/modules/matflow/receipt-batch-status";
import { refreshInboundMaterialReview, suggestLeftoverAfterInbound } from "@/server/modules/outsource/leftover";
import { decideReviewItem } from "@/server/modules/review/checklist";
import type { DB } from "@/db";
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
    let frozenJg = 0;
    for (const operation of ["create", "submit", "approve"] as const) {
      const settledJg = await setup(); frozenJg = settledJg.id;
      const input = { jgId: settledJg.id, toWarehouseId: own.id, lines: [{ skuId: material.id, qty: "1", reason: "surplus_return" }] };
      const draft = await createTl(maker, input, db);
      const target = operation === "approve" ? await submitTl(maker, draft.id, draft.version, db) : draft;
      const settlement = await createJs(pmc, { jgId: settledJg.id }, db);
      const waiting = await submitJs(pmc, settlement.id, { version: settlement.version }, db);
      const lateReturn = await race(tx => approveJs(finance, settlement.id, { action: "approve", version: waiting.version }, tx),
        (): Promise<unknown> => operation === "create" ? createTl(maker, input, other) : operation === "submit"
          ? submitTl(maker, target.id, target.version, other)
          : approveTl(checker, target.id, { action: "approve", version: target.version }, other));
      assert(!lateReturn.second.ok); assert.equal(lateReturn.second.error.status, 409);
      assert.match(lateReturn.second.error.message, /结算单.*已冻结/);
      assert.equal((await db.select().from(s.tlDocs).where(eq(s.tlDocs.jgId, settledJg.id))).length, 1);
      assert.equal((await db.select().from(s.tlDocs).where(eq(s.tlDocs.id, target.id)))[0].version, target.version);
      assert.equal((await db.select().from(s.stockLedger).where(and(eq(s.stockLedger.sourceDocType, "tl_return"), eq(s.stockLedger.sourceDocId, target.id)))).length, 0);
      assert.equal((await db.select().from(s.approvals).where(and(eq(s.approvals.docType, "tl"), eq(s.approvals.docId, target.id)))).length, 0);
      console.log(`PASS TL ${operation} waits for actual JS approval/writeoff and refuses pooled stock reuse`);
    }
    const reviewJg = await setup();
    const duplicateReview = await race(tx => suggestLeftoverAfterInbound(maker, reviewJg.id, tx),
      () => suggestLeftoverAfterInbound(checker, reviewJg.id, other));
    assert(duplicateReview.second.ok);
    const reviewRows = await db.select().from(s.reviewItems).where(and(eq(s.reviewItems.category, "material_leftover"), eq(s.reviewItems.refKey, String(reviewJg.id))));
    assert.equal(reviewRows.length, 1);
    assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "review_item"), eq(s.auditLogs.entityId, reviewRows[0].id)))).length, 1);
    console.log("PASS concurrent inbound review hooks wait on JG and create one item/audit");
    const [reviewFl] = await db.select().from(s.flDocs).where(eq(s.flDocs.jgId, reviewJg.id));
    await db.update(s.flLines).set({ qty: "130" }).where(eq(s.flLines.flId, reviewFl.id));
    const decisionRace = await race(tx => decideReviewItem(pmc, reviewRows[0].id, { status: "done", note: "合成关闭：旧依据已核对" }, tx as unknown as DB),
      () => suggestLeftoverAfterInbound(checker, reviewJg.id, other));
    assert(decisionRace.second.ok);
    const afterDecision = await db.select().from(s.reviewItems).where(and(eq(s.reviewItems.category, "material_leftover"), eq(s.reviewItems.refKey, String(reviewJg.id))));
    assert.equal(afterDecision.length, 2);
    assert.equal(afterDecision.find(row => row.id === reviewRows[0].id)?.status, "done");
    assert.match(afterDecision.find(row => row.status === "open")?.detail ?? "", /差额 30.0000/);
    console.log("PASS changed estimate waits for human decision and does not overwrite or reopen the decided item");
    const inboundJg = await setup();
    const [triggerSh] = await db.select().from(s.shDocs).where(and(eq(s.shDocs.sourceType, "jg"), eq(s.shDocs.sourceId, inboundJg.id)));
    await db.update(s.shDocs).set({ status: "approved" }).where(eq(s.shDocs.id, triggerSh.id));
    assert.equal((await confirmInbound(maker, triggerSh.id, db)).status, "completed");
    const [triggeredReview] = await db.select().from(s.reviewItems).where(and(eq(s.reviewItems.category, "material_leftover"), eq(s.reviewItems.refKey, String(inboundJg.id))));
    assert(triggeredReview); assert.match(triggeredReview.detail ?? "", /差额 20.0000/);
    assert((await db.select().from(s.stockLedger).where(and(eq(s.stockLedger.sourceDocType, "sh_outsource_in"), eq(s.stockLedger.sourceDocId, triggerSh.id)))).length > 0);
    console.log("PASS actual SH inbound posts inventory and its committed receipt triggers the material review");
    const recoveryJg = await setup();
    const [recoverySh] = await db.select().from(s.shDocs).where(and(eq(s.shDocs.sourceType, "jg"), eq(s.shDocs.sourceId, recoveryJg.id)));
    await db.update(s.shDocs).set({ status: "approved" }).where(eq(s.shDocs.id, recoverySh.id));
    await db.execute(sql`CREATE FUNCTION scm_review_recovery_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='material_review_checked' THEN RAISE EXCEPTION 'synthetic recovery acknowledgement fail'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER scm_review_recovery_test_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION scm_review_recovery_test_fail()`);
    try { assert.deepEqual(await confirmInbound(maker, recoverySh.id, db), { status: "completed", materialReview: "pending" }); }
    finally {
      await db.execute(sql`DROP TRIGGER scm_review_recovery_test_fail ON audit_logs`);
      await db.execute(sql`DROP FUNCTION scm_review_recovery_test_fail()`);
    }
    const recoveryLedger = () => db.select().from(s.stockLedger).where(and(eq(s.stockLedger.sourceDocType, "sh_outsource_in"), eq(s.stockLedger.sourceDocId, recoverySh.id))).orderBy(s.stockLedger.id);
    const committedLedger = await recoveryLedger(); assert(committedLedger.length > 0);
    assert.equal((await db.select().from(s.reviewItems).where(eq(s.reviewItems.refKey, String(recoveryJg.id)))).length, 0);
    console.log("PASS failed material acknowledgement rolls back the review but preserves completed stock posting");
    const recoveryRace = await race(tx => refreshInboundMaterialReview(maker, recoverySh.id, tx),
      () => refreshInboundMaterialReview(checker, recoverySh.id, other));
    assert(recoveryRace.second.ok);
    assert.deepEqual(await recoveryLedger(), committedLedger);
    assert.equal((await db.select().from(s.reviewItems).where(eq(s.reviewItems.refKey, String(recoveryJg.id)))).length, 1);
    assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "sh"), eq(s.auditLogs.entityId, recoverySh.id), eq(s.auditLogs.action, "material_review_checked")))).length, 2);
    console.log("PASS concurrent recovery attempts produce one review, two attempt acknowledgements and no duplicate stock");
    const batchSource = async () => {
      const no = `BATCH-${key}-${++seq}`;
      const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${no}`, status: "approved", productSkuId: product.id, supplierId: sup.id, bomId: bom.id, qty: "100", feeRatePlan: "2", createdBy: pmc.id }).returning();
      await db.insert(s.woLines).values({ woId: wo.id, materialSkuId: material.id, qtyPer: "1", grossReq: "100", suggestedQty: "100" });
      const [po] = await db.insert(s.poDocs).values({ docNo: `PO-${no}`, woId: wo.id, supplierId: sup.id, status: "in_progress", createdBy: pmc.id }).returning();
      await db.insert(s.poLines).values({ poId: po.id, skuId: material.id, lineType: "raw", purchaseUom: "个", uomFactor: "1", qty: "100", receivedQty: "50", price: "2" });
      return { wo, po };
    };
    const sameBatch = await batchSource();
    const initialInput = { poGroups: [{ supplierId: sup.id, lines: [{ materialSkuId: material.id, qty: "10", price: "2" }] }] };
    const initial = await batchSource();
    const sameInitial = await race(tx => generateDocs(pmc, initial.wo.id, initialInput, tx), () => generateDocs(pmc, initial.wo.id, initialInput, other));
    assert(!sameInitial.second.ok); assert.equal(sameInitial.second.error.status, 409);
    assert.equal((await db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, initial.wo.id))).length, 1);
    assert.equal((await db.select().from(s.poDocs).where(eq(s.poDocs.woId, initial.wo.id))).length, 2); // one source fixture + one generated PO
    console.log("PASS initial generation serializes duplicates: one PO set and JG, conflict not 500");
    const initialFirst = await batchSource();
    const automaticAfterInitial = await race(tx => generateDocs(pmc, initialFirst.wo.id, {}, tx), () => createBatchJg(pmc, initialFirst.wo.id, other));
    assert(!automaticAfterInitial.second.ok); assert.equal(automaticAfterInitial.second.error.status, 409);
    assert.equal((await db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, initialFirst.wo.id))).length, 1);
    console.log("PASS automatic batch waits for initial JG and cannot over-generate");
    const automaticFirst = await batchSource();
    const initialAfterAutomatic = await race(tx => createBatchJg(pmc, automaticFirst.wo.id, tx), () => generateDocs(pmc, automaticFirst.wo.id, initialInput, other));
    assert(!initialAfterAutomatic.second.ok); assert.equal(initialAfterAutomatic.second.error.status, 409);
    assert.equal((await db.select().from(s.poDocs).where(eq(s.poDocs.woId, automaticFirst.wo.id))).length, 1);
    console.log("PASS initial generator waits for automatic JG and refuses extra PO creation");
    const initialPaused = await batchSource();
    const initialAfterPause = await race(tx => tx.update(s.suppliers).set({ status: "paused" }).where(eq(s.suppliers.id, sup.id)), () => generateDocs(pmc, initialPaused.wo.id, {}, other));
    assert(!initialAfterPause.second.ok); assert.equal(initialAfterPause.second.error.status, 400);
    assert.equal((await db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, initialPaused.wo.id))).length, 0);
    await db.update(s.suppliers).set({ status: "qualified" }).where(eq(s.suppliers.id, sup.id));
    console.log("PASS initial generator waits for factory suspension even with no PO group");
    const initialClosed = await batchSource();
    const initialAfterClose = await race(tx => tx.update(s.woDocs).set({ status: "closed" }).where(eq(s.woDocs.id, initialClosed.wo.id)), () => generateDocs(pmc, initialClosed.wo.id, initialInput, other));
    assert(!initialAfterClose.second.ok); assert.equal(initialAfterClose.second.error.status, 409);
    assert.equal((await db.select().from(s.poDocs).where(eq(s.poDocs.woId, initialClosed.wo.id))).length, 1);
    console.log("PASS initial generator waits for WO closure without creating orphan PO drafts");
    const batchRace = await race(tx => createBatchJg(pmc, sameBatch.wo.id, tx), () => createBatchJg(pmc, sameBatch.wo.id, other));
    assert(!batchRace.second.ok); assert.equal(batchRace.second.error.status, 409);
    assert.equal((await db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, sameBatch.wo.id))).length, 1);
    console.log("PASS concurrent batch generation waits on WO and refuses a second draft without unique-violation 500");
    const closingWo = await batchSource();
    const closedBatch = await race(tx => tx.update(s.woDocs).set({ status: "closed" }).where(eq(s.woDocs.id, closingWo.wo.id)),
      () => createBatchJg(pmc, closingWo.wo.id, other));
    assert(!closedBatch.second.ok); assert.equal(closedBatch.second.error.status, 409);
    console.log("PASS batch generation waits for WO closure and refuses the closed source");
    const returningPo = await batchSource();
    const changedReceipt = await race(async tx => {
      await tx.select().from(s.poDocs).where(eq(s.poDocs.id, returningPo.po.id)).for("update");
      await tx.update(s.poLines).set({ receivedQty: "20" }).where(eq(s.poLines.poId, returningPo.po.id));
    }, () => createBatchJg(pmc, returningPo.wo.id, other));
    assert(changedReceipt.second.ok); assert.equal(changedReceipt.second.value.qty, "20.0000");
    console.log("PASS batch generation waits for PO aggregate writer and calculates the committed receipt waterline");
    const pausingSupplier = await batchSource();
    const pausedBatch = await race(tx => tx.update(s.suppliers).set({ status: "paused" }).where(eq(s.suppliers.id, sup.id)),
      () => createBatchJg(pmc, pausingSupplier.wo.id, other));
    assert(!pausedBatch.second.ok); assert.equal(pausedBatch.second.error.status, 409);
    await db.update(s.suppliers).set({ status: "qualified" }).where(eq(s.suppliers.id, sup.id));
    console.log("PASS batch generation waits for supplier suspension and refuses a new draft");
    const revokingActor = await batchSource(), revoked = await actor(["pmc"]);
    const revokedBatch = await race(tx => tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, revoked.id)),
      () => createBatchJg(revoked, revokingActor.wo.id, other));
    assert(!revokedBatch.second.ok); assert.equal(revokedBatch.second.error.status, 403);
    console.log("PASS batch generation waits for actor revocation and cannot use stale PMC claims");
    const [originalFlag] = await db.select().from(s.sysParams).where(and(eq(s.sysParams.scope, "global"), eq(s.sysParams.key, "auto_jg_on_ready")));
    const autoFlag = originalFlag ?? (await db.insert(s.sysParams).values({ scope: "global", key: "auto_jg_on_ready", value: "0" }).returning())[0];
    let browserReceipt = 0;
    try {
      await db.update(s.sysParams).set({ value: "1" }).where(eq(s.sysParams.id, autoFlag.id));
      const receipt = async (source: Awaited<ReturnType<typeof batchSource>>) => {
        const [line] = await db.select().from(s.poLines).where(eq(s.poLines.poId, source.po.id));
        const [sh] = await db.insert(s.shDocs).values({ docNo: `SH-RECOVERY-${key}-${++seq}`, sourceType: "po", sourceId: source.po.id, warehouseId: own.id, status: "approved", createdBy: maker.id }).returning();
        const [sl] = await db.insert(s.shLines).values({ shId: sh.id, poLineId: line.id, skuId: material.id, lineType: "normal", actualQty: "10" }).returning();
        const [qc] = await db.insert(s.qcRecords).values({ shId: sh.id, createdBy: maker.id }).returning();
        await db.insert(s.qcLines).values({ qcId: qc.id, shLineId: sl.id, passQty: "10", failQty: "0", concessionQty: "0" });
        assert.deepEqual(await confirmInbound(maker, sh.id, db), { status: "completed", batchCheck: "pending" });
        return sh;
      };
      const sameSource = await batchSource(), sameReceipt = await receipt(sameSource);
      const ledgerBeforeRecovery = await db.select().from(s.stockLedger).orderBy(s.stockLedger.id);
      const sameReceiptRace = await race(tx => checkBatchAfterPoReceipt(pmc, sameReceipt.id, tx), () => checkBatchAfterPoReceipt(pmc, sameReceipt.id, other));
      assert(sameReceiptRace.second.ok); assert.deepEqual(sameReceiptRace.second.value, sameReceiptRace.first);
      assert.equal(sameReceiptRace.first.state, "created");
      assert.equal((await db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, sameSource.wo.id))).length, 1);
      assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "sh"), eq(s.auditLogs.entityId, sameReceipt.id), eq(s.auditLogs.action, "receipt_batch_checked")))).length, 1);
      assert.deepEqual(await db.select().from(s.stockLedger).orderBy(s.stockLedger.id), ledgerBeforeRecovery);
      console.log("PASS same receipt recovery waits on SH, returns the exact saved draft and adds no stock or second acknowledgement");
      const sharedSource = await batchSource(), firstReceipt = await receipt(sharedSource), secondReceipt = await receipt(sharedSource);
      const differentReceiptRace = await race(tx => checkBatchAfterPoReceipt(pmc, firstReceipt.id, tx), () => checkBatchAfterPoReceipt(pmc, secondReceipt.id, other));
      assert(differentReceiptRace.second.ok); assert.equal(differentReceiptRace.first.state, "created");
      assert.equal(differentReceiptRace.second.value.state, "not_generated");
      assert.equal((await db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, sharedSource.wo.id))).length, 1);
      console.log("PASS different receipts share the WO lock, second check sees the first draft and records no new eligible quantity");
      const movingSource = await batchSource(), movedTo = await batchSource(), movingReceipt = await receipt(movingSource);
      const rebindRace = await race(tx => tx.update(s.poDocs).set({ woId: movedTo.wo.id }).where(eq(s.poDocs.id, movingSource.po.id)),
        () => checkBatchAfterPoReceipt(pmc, movingReceipt.id, other));
      assert(!rebindRace.second.ok); assert.equal(rebindRace.second.error.status, 409);
      assert.equal((await getReceiptBatchReview(db, movingReceipt.id))?.state, "pending");
      assert.equal((await db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, movingSource.wo.id))).length, 0);
      console.log("PASS concurrent PO rebind is rejected after the source lock; durable handoff remains visible");
      browserReceipt = (await receipt(await batchSource())).id;
    } finally {
      if (originalFlag) await db.update(s.sysParams).set({ value: originalFlag.value }).where(eq(s.sysParams.id, autoFlag.id));
      else await db.delete(s.sysParams).where(eq(s.sysParams.id, autoFlag.id));
    }
    await db.update(s.boms).set({ status: "active" }).where(eq(s.boms.id, bom.id));
    await db.insert(s.bomLines).values({ bomId: bom.id, materialSkuId: material.id, qtyPer: "1" });
    await db.insert(s.approvalConfigs).values({ docType: "wo", approverRole: "pmc" }).onConflictDoNothing();
    const upstreamInput = { productSkuId: product.id, supplierId: sup.id, qty: "3.0001", feeRatePlan: "1.25" };
    const upPaused = await race(tx => tx.update(s.suppliers).set({ status: "paused" }).where(eq(s.suppliers.id, sup.id)), () => createWo(pmc, upstreamInput, other));
    assert(!upPaused.second.ok); assert.equal(upPaused.second.error.status, 400);
    await db.update(s.suppliers).set({ status: "qualified" }).where(eq(s.suppliers.id, sup.id));
    console.log("PASS WO creation waits for factory suspension and rejects without a draft");
    const upProduct = await race(tx => tx.update(s.skus).set({ active: false }).where(eq(s.skus.id, product.id)), () => createWo(pmc, upstreamInput, other));
    assert(!upProduct.second.ok); assert.equal(upProduct.second.error.status, 400);
    await db.update(s.skus).set({ active: true }).where(eq(s.skus.id, product.id));
    console.log("PASS WO creation waits for product disabling and rechecks current eligibility");
    const upBom = await race(tx => tx.update(s.boms).set({ status: "retired" }).where(eq(s.boms.id, bom.id)), () => createWo(pmc, upstreamInput, other));
    assert(!upBom.second.ok); assert.equal(upBom.second.error.status, 404);
    await db.update(s.boms).set({ status: "active" }).where(eq(s.boms.id, bom.id));
    console.log("PASS WO creation waits for BOM retirement instead of binding stale active status");
    const upstreamActor = await actor(["pmc"]);
    const upRole = await race(tx => tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, upstreamActor.id)), () => createWo(upstreamActor, upstreamInput, other));
    assert(!upRole.second.ok); assert.equal(upRole.second.error.status, 403);
    console.log("PASS WO creation waits for PMC revocation and does not trust stale caller role");
    const upWo = await createWo(pmc, upstreamInput, db);
    const upSubmit = await race(tx => submitWo(pmc, upWo.id, upWo.version, tx), () => submitWo(pmc, upWo.id, upWo.version, other));
    assert(!upSubmit.second.ok); assert.equal(upSubmit.second.error.status, 409);
    assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "wo"), eq(s.auditLogs.entityId, upWo.id), eq(s.auditLogs.action, "submit")))).length, 1);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.id, upWo.id)))[0].version, upWo.version + 1);
    console.log("PASS simultaneous WO submits serialize to one version increment and one audit");
    const disabledOwner = await actor(["pmc"]), disabledWo = await createWo(disabledOwner, upstreamInput, db);
    const upDisabled = await race(tx => tx.update(s.users).set({ active: false }).where(eq(s.users.id, disabledOwner.id)), () => submitWo(disabledOwner, disabledWo.id, disabledWo.version, other));
    assert(!upDisabled.second.ok); assert.equal(upDisabled.second.error.status, 403);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.id, disabledWo.id)))[0].status, "draft");
    console.log("PASS WO submission waits for account disabling and leaves the draft unchanged");
    const upChecker = await actor(["pmc"]);
    const upRevokedApproval = await race(tx => tx.update(s.users).set({ isApprover: false }).where(eq(s.users.id, upChecker.id)), () => approveWo(upChecker, upWo.id, { action: "approve", version: upSubmit.first.version }, other));
    assert(!upRevokedApproval.second.ok); assert.equal(upRevokedApproval.second.error.status, 403);
    await db.update(s.users).set({ isApprover: true }).where(eq(s.users.id, upChecker.id));
    console.log("PASS WO approval waits for approver revocation and leaves pending status");
    const upApprove = await race(tx => approveWo(upChecker, upWo.id, { action: "approve", version: upSubmit.first.version }, tx), () => approveWo(upChecker, upWo.id, { action: "approve", version: upSubmit.first.version }, other));
    assert(upApprove.second.ok); assert.equal(upApprove.second.value.idempotent, true);
    assert.equal((await db.select().from(s.woLines).where(eq(s.woLines.woId, upWo.id))).length, 1);
    assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "wo"), eq(s.auditLogs.entityId, upWo.id), eq(s.auditLogs.action, "snapshot")))).length, 1);
    console.log("PASS simultaneous WO approval returns the committed replay with exactly one snapshot");
    const withdrawing = await createWo(pmc, upstreamInput, db);
    const withdrawalPending = await submitWo(pmc, withdrawing.id, withdrawing.version, db);
    const withdrawRace = await race(tx => withdrawWO(pmc, withdrawing.id, { version: withdrawalPending.version }, tx),
      () => approveWo(upChecker, withdrawing.id, { action: "approve", version: withdrawalPending.version }, other));
    assert(!withdrawRace.second.ok); assert.equal(withdrawRace.second.error.status, 409);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.id, withdrawing.id)))[0].status, "draft");
    assert.equal((await db.select().from(s.woLines).where(eq(s.woLines.woId, withdrawing.id))).length, 0);
    console.log("PASS WO approval waits for withdrawal and cannot freeze a withdrawn draft");
    const disabledWithdrawalOwner = await actor(["pmc"]);
    const disabledWithdrawal = await createWo(disabledWithdrawalOwner, upstreamInput, db);
    const disabledPending = await submitWo(disabledWithdrawalOwner, disabledWithdrawal.id, disabledWithdrawal.version, db);
    const withdrawDisabled = await race(tx => tx.update(s.users).set({ active: false }).where(eq(s.users.id, disabledWithdrawalOwner.id)),
      () => withdrawWO(disabledWithdrawalOwner, disabledWithdrawal.id, { version: disabledPending.version }, other));
    assert(!withdrawDisabled.second.ok); assert.equal(withdrawDisabled.second.error.status, 403);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.id, disabledWithdrawal.id)))[0].status, "pending");
    console.log("PASS WO withdrawal waits for account disabling and rejects stale ownership credentials");
    const closureManager = await actor(["pmc"]);
    const approvedWo = (await db.select().from(s.woDocs).where(eq(s.woDocs.id, upWo.id)))[0];
    const closeRevoked = await race(tx => tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, closureManager.id)),
      () => transitionWO(closureManager, upWo.id, { action: "short_close", version: approvedWo.version, reason: "合成并发资格核验" }, other));
    assert(!closeRevoked.second.ok); assert.equal(closeRevoked.second.error.status, 403);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.id, upWo.id)))[0].status, "approved");
    console.log("PASS WO closure waits for management-role revocation and preserves approved state");
    const createKey = randomUUID();
    const sameCreate = await race(tx => createWo(pmc, { ...upstreamInput, requestKey: createKey }, tx),
      () => createWo(pmc, { ...upstreamInput, qty: "03.0001", feeRatePlan: "01.25", requestKey: createKey }, other));
    assert(sameCreate.second.ok); assert.equal(sameCreate.second.value.id, sameCreate.first.id);
    assert.equal((await db.select().from(s.woCreateRequests).where(and(eq(s.woCreateRequests.requestedBy, pmc.id), eq(s.woCreateRequests.requestKey, createKey)))).length, 1);
    assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "wo"), eq(s.auditLogs.entityId, sameCreate.first.id), eq(s.auditLogs.action, "create")))).length, 1);
    assert.equal((await getWoCreateResult(pmc, createKey, db)).document?.id, sameCreate.first.id);
    console.log("PASS simultaneous equivalent WO creates wait and return one immutable receipt, one document and one create audit");
    const conflictKey = randomUUID();
    const conflictCreate = await race(tx => createWo(pmc, { ...upstreamInput, requestKey: conflictKey }, tx),
      () => createWo(pmc, { ...upstreamInput, qty: "4", requestKey: conflictKey }, other));
    assert(!conflictCreate.second.ok); assert.equal(conflictCreate.second.error.status, 409);
    assert.equal((await getWoCreateResult(pmc, conflictKey, db)).document?.id, conflictCreate.first.id);
    console.log("PASS concurrent changed intent with the same WO request key waits then rejects without a second document");
    const receiptOwner = await actor(["pmc"]), ownerKey = randomUUID();
    const ownerDoc = await createWo(receiptOwner, { ...upstreamInput, requestKey: ownerKey }, db);
    const revokedReceipt = await race(tx => tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, receiptOwner.id)),
      () => getWoCreateResult(receiptOwner, ownerKey, other));
    assert(!revokedReceipt.second.ok); assert.equal(revokedReceipt.second.error.status, 403);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.id, ownerDoc.id)))[0].status, "draft");
    console.log("PASS WO receipt lookup waits for role revocation and refuses stale authority without changing the original draft");
    const browserBatch = await batchSource();
    console.log(JSON.stringify({ passed: true, cases: 42, fixture: key, browserProduct: product.id, browserSupplier: sup.id, browserReceipt, browserBatchWo: browserBatch.wo.id, browserDraft: js.id, browserJg: jg.id, reviewJg: reviewJg.id,
      recoveryJg: recoveryJg.id, recoverySh: recoverySh.id,
      inboundJg: inboundJg.id, inboundReview: triggeredReview.id,
      browserFl: retryFl.id, issueJg: retrySource.id, frozenJg, database: new URL(connectionString).pathname.slice(1) }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
