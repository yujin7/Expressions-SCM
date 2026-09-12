/** Actual multi-connection PC fee races; explicitly opted-in disposable loopback DB only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createPcForJgFee } from "@/server/modules/outsource/jg";
import { approvePc } from "@/server/modules/outsource/po";
import { approveJs, createJs, refreshJsFee, submitJs } from "@/server/modules/settlement/js";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), key = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const dbA = drizzle(a, { schema: s }), dbB = drizzle(b, { schema: s });
    const actor = async (name: string) => {
      const [u] = await dbA.insert(s.users).values({ name: `PC-${key}-${name}`, roles: ["purchasing"], isApprover: true }).returning();
      return { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
    };
    const maker = await actor("maker"), checker = await actor("checker");
    await dbA.insert(s.approvalConfigs).values({ docType: "pc", approverRole: "purchasing" }).onConflictDoNothing();
    const [spu] = await dbA.insert(s.spus).values({ code: `PC-${key}`, nameCn: "改价并发合成测试" }).returning();
    const [sku] = await dbA.insert(s.skus).values({ code: `PC-${key}`, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
    const [supplier] = await dbA.insert(s.suppliers).values({ code: `PC-${key}`, name: "合成加工厂" }).returning();
    const [bom] = await dbA.insert(s.boms).values({ productSkuId: sku.id, versionNo: "1" }).returning();
    const [wo] = await dbA.insert(s.woDocs).values({ docNo: `PC-${key}`, createdBy: maker.id, productSkuId: sku.id, supplierId: supplier.id, bomId: bom.id, qty: "10", feeRatePlan: "2.50" }).returning();
    let seq = 0;
    const freshJg = async () => (await dbA.insert(s.jgDocs).values({ docNo: `PC-JG-${key}-${++seq}`, batchSeq: seq,
      createdBy: maker.id, woId: wo.id, productSkuId: sku.id, supplierId: supplier.id, qty: "10.1250", feeRateCurrent: "2.50", status: "in_progress" }).returning())[0];
    const input = (jgId: number, newPrice = "2.80") => ({ jgId, newPrice, scope: "unreceived_only" });
    const [{ pid }] = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows;
    const waitForLock = async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await control.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error("Competing PC request never reached an actual PostgreSQL lock");
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
    const target = await freshJg();
    const duplicate = await race(tx => createPcForJgFee(maker, input(target.id), tx), () => createPcForJgFee(maker, input(target.id, "3.00"), dbB));
    assert(!duplicate.second.ok); assert.equal(duplicate.second.error.status, 409);
    assert.equal((await dbA.select().from(s.pcDocs).where(eq(s.pcDocs.jgId, target.id))).length, 1);
    console.log("PASS concurrent creation admits one pending PC per JG");

    const afterApproval = await race(tx => approvePc(checker, duplicate.first.id, { action: "approve", version: 1 }, tx),
      () => createPcForJgFee(maker, input(target.id, "3.00"), dbB));
    assert(afterApproval.second.ok); assert.equal(afterApproval.second.value.oldPrice, "2.80");
    assert.equal(afterApproval.second.value.deviationPct, "7.14");
    console.log("PASS creation waits for approval and snapshots the committed current price");

    const pc = afterApproval.second.value;
    const approvedTwice = await race(tx => approvePc(checker, pc.id, { action: "approve", version: 1 }, tx),
      () => approvePc(checker, pc.id, { action: "approve", version: 1 }, dbB));
    assert(approvedTwice.second.ok); assert.equal(approvedTwice.second.value.idempotent, true);
    assert.equal((await dbA.select().from(s.jgFeeSegments).where(eq(s.jgFeeSegments.jgId, target.id))).length, 2);
    const events = await control.query("select action from audit_logs where entity='pc' and entity_id=$1 order by id", [pc.id]);
    assert.deepEqual(events.rows.map(r => r.action), ["create", "approve"]);
    console.log("PASS concurrent approval replays once without a duplicate segment or audit");

    const legacy = await freshJg();
    const valid = await createPcForJgFee(maker, input(legacy.id), dbA);
    // Synthetic pre-fix duplicate: do not repair/delete historical production records.
    const [stale] = await dbA.insert(s.pcDocs).values({ docNo: `PC-LEGACY-${key}`, createdBy: maker.id, target: "jg_fee", jgId: legacy.id,
      status: "pending", oldPrice: "2.50", newPrice: "3.20", deviationPct: "28.00", scope: "unreceived_only" }).returning();
    const legacyRace = await race(tx => approvePc(checker, valid.id, { action: "approve", version: 1 }, tx),
      () => approvePc(checker, stale.id, { action: "approve", version: 1 }, dbB));
    assert(!legacyRace.second.ok); assert.equal(legacyRace.second.error.status, 409);
    assert.equal((await dbA.select().from(s.jgDocs).where(eq(s.jgDocs.id, legacy.id)))[0].feeRateCurrent, "2.80");
    assert.equal((await dbA.select().from(s.pcDocs).where(eq(s.pcDocs.id, stale.id)))[0].status, "pending");
    const rejectedEffects = await control.query("select count(*)::int n from approvals where doc_type='pc' and doc_id=$1", [stale.id]);
    assert.equal(rejectedEffects.rows[0].n, 0);
    console.log("PASS legacy parallel application cannot overwrite a newly approved fee");

    const [plannerRow] = await dbA.insert(s.users).values({ name: `PC-${key}-planner`, roles: ["pmc"], isApprover: true }).returning();
    const [financeRow] = await dbA.insert(s.users).values({ name: `PC-${key}-finance`, roles: ["finance"], isApprover: true }).returning();
    const planner = { id: plannerRow.id, name: plannerRow.name, roles: plannerRow.roles, isApprover: true };
    const finance = { id: financeRow.id, name: financeRow.name, roles: financeRow.roles, isApprover: true };
    await dbA.insert(s.approvalConfigs).values({ docType: "js", approverRole: "finance" }).onConflictDoNothing();
    const [wh] = await dbA.insert(s.warehouses).values({ code: `PC-${key}`, name: "合成委外仓", kind: "outsource", supplierId: supplier.id }).returning();
    const receivedJg = async () => {
      const jg = await freshJg();
      await dbA.update(s.jgDocs).set({ status: "completed" }).where(eq(s.jgDocs.id, jg.id));
      await dbA.insert(s.jgFeeSegments).values({ jgId: jg.id, rate: "2.50", effectiveFrom: new Date("2020-01-01T00:00:00Z") });
      const [sh] = await dbA.insert(s.shDocs).values({ docNo: `SH-${key}-${seq}`, sourceType: "jg", sourceId: jg.id, warehouseId: wh.id,
        createdBy: planner.id, status: "completed", createdAt: new Date("2020-02-01T00:00:00Z") }).returning();
      const [line] = await dbA.insert(s.shLines).values({ shId: sh.id, skuId: sku.id, lineType: "normal", actualQty: "10" }).returning();
      const [qc] = await dbA.insert(s.qcRecords).values({ shId: sh.id, conclusion: "合格", createdBy: planner.id }).returning();
      await dbA.insert(s.qcLines).values({ qcId: qc.id, shLineId: line.id, passQty: "10", concessionQty: "0" });
      return jg;
    };
    const forCreate = await receivedJg();
    const retro = await createPcForJgFee(maker, { ...input(forCreate.id, "3.50"), scope: "retroactive" }, dbA);
    const createRace = await race(tx => approvePc(checker, retro.id, { action: "approve", version: 1 }, tx),
      () => createJs(planner, { jgId: forCreate.id }, dbB));
    assert(createRace.second.ok); assert.equal(createRace.second.value.feePayable, "35.00");
    console.log("PASS JS creation waits for retrospective approval and saves its committed fee");

    const forSubmit = await receivedJg();
    const oldDraft = await createJs(planner, { jgId: forSubmit.id }, dbA);
    const retro2 = await createPcForJgFee(maker, { ...input(forSubmit.id, "3.50"), scope: "retroactive" }, dbA);
    const submitRace = await race(tx => approvePc(checker, retro2.id, { action: "approve", version: 1 }, tx),
      () => submitJs(planner, oldDraft.id, { version: 1 }, dbB));
    assert(!submitRace.second.ok); assert.equal(submitRace.second.error.status, 409);
    assert.equal((await dbA.select().from(s.jsDocs).where(eq(s.jsDocs.id, oldDraft.id)))[0].status, "draft");
    const refreshed = await refreshJsFee(planner, oldDraft.id, { version: 1 }, dbA);
    assert.equal(refreshed.feePayable, "35.00");
    console.log("PASS stale settlement submission waits, refuses and recovers via explicit fee refresh");

    const ready = await submitJs(planner, oldDraft.id, { version: refreshed.version }, dbA);
    const afterFreeze = await createPcForJgFee(maker, { ...input(forSubmit.id, "4.00"), scope: "retroactive" }, dbA);
    const freezeRace = await race(tx => approveJs(finance, ready.id, { action: "approve", version: ready.version }, tx),
      () => approvePc(checker, afterFreeze.id, { action: "approve", version: 1 }, dbB));
    assert(!freezeRace.second.ok); assert.equal(freezeRace.second.error.status, 409);
    assert.equal((await dbA.select().from(s.jsDocs).where(eq(s.jsDocs.id, ready.id)))[0].settleAmount, "35.00");
    assert.equal((await dbA.select().from(s.jgDocs).where(eq(s.jgDocs.id, forSubmit.id)))[0].feeRateCurrent, "3.50");
    console.log("PASS concurrent financial approval freezes settlement before the waiting fee change");

    const disabledTarget = await freshJg();
    const revoke = await race(tx => tx.update(s.users).set({ active: false }).where(eq(s.users.id, maker.id)),
      () => createPcForJgFee(maker, input(disabledTarget.id), dbB));
    assert(!revoke.second.ok); assert.equal(revoke.second.error.status, 403);
    assert.equal((await dbA.select().from(s.pcDocs).where(eq(s.pcDocs.jgId, disabledTarget.id))).length, 0);
    console.log("PASS creation waits for account disable and refuses the stale actor");
    console.log(JSON.stringify({ passed: true, cases: 8, fixture: key, database: new URL(connectionString).pathname.slice(1) }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
