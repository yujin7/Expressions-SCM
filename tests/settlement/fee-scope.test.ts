import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { createPcForJgFee } from "@/server/modules/outsource/jg";
import { approvePc } from "@/server/modules/outsource/po";
import { getPc } from "@/server/modules/outsource/pc-detail";
import { maskSensitive } from "@/server/core/dto";
import { approveJs, closeJgReceiving, createJs, getJs, previewJs, refreshJsBasis, refreshJsFee, submitJs } from "@/server/modules/settlement/js";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, seq = 0;
const actor = async (roles: string[]) => {
  const [u] = await f.db.insert(s.users).values({ name: `FS-${++seq}`, roles, isApprover: true }).returning();
  return { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
};
beforeAll(async () => {
  f = await createTestDb();
  await f.db.insert(s.approvalConfigs).values([{ docType: "pc", approverRole: "purchasing" }, { docType: "js", approverRole: "finance" }]);
});
afterAll(async () => f?.client.close());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it.each(["create", "refresh", "basis", "submit", "approve", "reject"])("%s rechecks stored channel restrictions without trusting caller scope", async operation => {
  const a = await setup();
  const js = operation === "create" ? null : await createJs(a.pmc, { jgId: a.jg.id }, f.db);
  if (operation === "approve" || operation === "reject") await submitJs(a.pmc, js!.id, { version: 1 }, f.db);
  const user = operation === "approve" || operation === "reject" ? a.finance : a.pmc;
  const [channel] = await f.db.insert(s.channels).values({ code: `FS-SCOPE-${++seq}`, name: "范围限制测试", kind: "platform" }).returning();
  await f.db.insert(s.userDataScopes).values({ userId: user.id, scopeKind: "channel", targetId: channel.id, createdBy: user.id });
  const snapshot = async () => ({ docs: await f.db.select().from(s.jsDocs), lines: await f.db.select().from(s.jsLines),
    approvals: await f.db.select().from(s.approvals), audits: await f.db.select().from(s.auditLogs),
    ledger: await f.db.select().from(s.stockLedger), counters: await f.db.select().from(s.docCounters) });
  const before = await snapshot();
  const caller = { ...user, channelScope: null }; // Stored scope must win over stale/forged input.
  const run = operation === "create" ? createJs(caller, { jgId: a.jg.id }, f.db)
    : operation === "refresh" ? refreshJsFee(caller, js!.id, { version: 1 }, f.db)
    : operation === "basis" ? refreshJsBasis(caller, js!.id, { version: 1, basisToken: "0".repeat(64), note: "范围" }, f.db)
    : operation === "submit" ? submitJs(caller, js!.id, { version: 1 }, f.db)
    : approveJs(caller, js!.id, { action: operation, version: 2 }, f.db);
  await expect(run).rejects.toMatchObject({ status: 403, message: expect.stringContaining("渠道范围") });
  expect(await snapshot()).toEqual(before);
});
async function setup() {
  const pmc = await actor(["pmc"]), purchasing = await actor(["purchasing"]), checker = await actor(["purchasing"]), finance = await actor(["finance"]);
  const key = `FS-${seq}`;
  const [spu] = await f.db.insert(s.spus).values({ code: key, nameCn: key }).returning();
  const [sku] = await f.db.insert(s.skus).values({ code: key, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [supplier] = await f.db.insert(s.suppliers).values({ code: key, name: key }).returning();
  const [warehouse] = await f.db.insert(s.warehouses).values({ code: key, name: key, kind: "outsource", supplierId: supplier.id }).returning();
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: sku.id, versionNo: "1" }).returning();
  const [wo] = await f.db.insert(s.woDocs).values({ docNo: key, createdBy: pmc.id, productSkuId: sku.id, supplierId: supplier.id, bomId: bom.id, qty: "10", feeRatePlan: "2" }).returning();
  const [jg] = await f.db.insert(s.jgDocs).values({ docNo: key, createdBy: pmc.id, woId: wo.id, productSkuId: sku.id, supplierId: supplier.id,
    qty: "10", feeRateCurrent: "2", status: "completed" }).returning();
  await f.db.insert(s.jgFeeSegments).values({ jgId: jg.id, rate: "2", effectiveFrom: new Date("2020-01-01T00:00:00Z") });
  const [sh] = await f.db.insert(s.shDocs).values({ docNo: key, sourceType: "jg", sourceId: jg.id, warehouseId: warehouse.id, createdBy: pmc.id,
    status: "completed", createdAt: new Date("2020-02-01T00:00:00Z") }).returning();
  const [line] = await f.db.insert(s.shLines).values({ shId: sh.id, skuId: sku.id, lineType: "normal", actualQty: "10" }).returning();
  const [qc] = await f.db.insert(s.qcRecords).values({ shId: sh.id, conclusion: "合格", createdBy: pmc.id }).returning();
  await f.db.insert(s.qcLines).values({ qcId: qc.id, shLineId: line.id, passQty: "10", concessionQty: "0" });
  return { pmc, purchasing, checker, finance, jg };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function change(a: Fixture, scope: "retroactive" | "unreceived_only", newPrice = "3.50") {
  const pc = await createPcForJgFee(a.purchasing, { jgId: a.jg.id, newPrice, scope }, f.db);
  await approvePc(a.checker, pc.id, { action: "approve", version: 1 }, f.db);
  return pc;
}
it("prospective fee leaves received quantities at their historical rate", async () => {
  const a = await setup(); await change(a, "unreceived_only");
  expect(await previewJs(a.jg.id, "0", f.db)).toMatchObject({ feePayable: "20.00", retrospectivePc: null });
});
it("approved retrospective scope flows into preview and newly created JS without rewriting segments", async () => {
  const a = await setup(), before = await f.db.select().from(s.jgFeeSegments).where(eq(s.jgFeeSegments.jgId, a.jg.id));
  const pc = await change(a, "retroactive");
  expect(await previewJs(a.jg.id, "0", f.db)).toMatchObject({ feePayable: "35.00", retrospectivePc: { id: pc.id }, feeSegments: [{ qty: "10.0000", feeRate: "3.50" }] });
  expect((await f.db.select().from(s.jgFeeSegments).where(eq(s.jgFeeSegments.id, before[0].id)))[0]).toEqual(before[0]);
  expect(await createJs(a.pmc, { jgId: a.jg.id }, f.db)).toMatchObject({ feePayable: "35.00", settleAmount: "35.00" });
});
it.each([true, false])("same-millisecond fee approvals preserve service ordering (retrospective first: %s)", async retroFirst => {
  const a = await setup(), effect = new Date("2026-09-13T02:00:00.123Z");
  // Freeze Date only; real database I/O and timeout timers keep running.
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(effect);
  await change(a, retroFirst ? "retroactive" : "unreceived_only", "3.50");
  await change(a, retroFirst ? "unreceived_only" : "retroactive", "4.00");
  const feeRows = await f.db.select().from(s.jgFeeSegments).where(eq(s.jgFeeSegments.jgId, a.jg.id));
  expect(feeRows.filter(row => row.effectiveFrom.getTime() === effect.getTime())).toHaveLength(2);
  // Old receipts use the retrospective baseline, but receipts at/after both approvals use the last segment.
  expect((await previewJs(a.jg.id, "0", f.db)).feePayable).toBe(retroFirst ? "35.00" : "40.00");
  await f.db.update(s.shDocs).set({ createdAt: effect }).where(and(eq(s.shDocs.sourceType, "jg"), eq(s.shDocs.sourceId, a.jg.id)));
  expect((await previewJs(a.jg.id, "0", f.db)).feePayable).toBe("40.00");
  expect(await createJs(a.pmc, { jgId: a.jg.id }, f.db)).toMatchObject({ feePayable: "40.00", settleAmount: "40.00" });
});
it("pending/rejected retrospective PC never affects pricing; missing approval evidence is not guessed", async () => {
  const a = await setup();
  const pc = await createPcForJgFee(a.purchasing, { jgId: a.jg.id, newPrice: "3", scope: "retroactive" }, f.db);
  expect((await previewJs(a.jg.id, "0", f.db)).feePayable).toBe("20.00");
  await approvePc(a.checker, pc.id, { action: "reject", version: 1 }, f.db);
  expect((await previewJs(a.jg.id, "0", f.db)).feePayable).toBe("20.00");
  await f.db.update(s.pcDocs).set({ status: "approved", version: 4 }).where(eq(s.pcDocs.id, pc.id));
  await expect(previewJs(a.jg.id, "0", f.db)).rejects.toMatchObject({ status: 409 });
});
it("stale draft cannot submit; explicit fee refresh preserves adjustment and enables financial approval", async () => {
  const a = await setup(), js = await createJs(a.pmc, { jgId: a.jg.id, manualAdj: "1.23", manualAdjNote: "合成调整" }, f.db);
  await change(a, "retroactive");
  await expect(submitJs(a.pmc, js.id, { version: 1 }, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("加工费依据") });
  const updated = await refreshJsFee(a.pmc, js.id, { version: 1 }, f.db);
  expect(updated).toMatchObject({ version: 2, feePayable: "35.00", manualAdj: "1.23", deductionTotal: "0.00", settleAmount: "36.23" });
  await expect(refreshJsFee(a.pmc, js.id, { version: 1 }, f.db)).rejects.toMatchObject({ status: 409 });
  const pending = await submitJs(a.pmc, js.id, { version: 2 }, f.db);
  const pc = await createPcForJgFee(a.purchasing, { jgId: a.jg.id, newPrice: "4", scope: "retroactive" }, f.db);
  expect(await approveJs(a.finance, js.id, { version: pending.version, action: "approve" }, f.db)).toMatchObject({ status: "completed" });
  await expect(approvePc(a.checker, pc.id, { version: 1, action: "approve" }, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已冻结") });
  await expect(createPcForJgFee(a.purchasing, { jgId: a.jg.id, newPrice: "4", scope: "retroactive" }, f.db)).rejects.toMatchObject({ status: 409 });
  expect((await f.db.select().from(s.jsDocs).where(eq(s.jsDocs.id, js.id)))[0].settleAmount).toBe("36.23");
});
it("pending settlement must be rejected before fee refresh, then can return for approval", async () => {
  const a = await setup(), js = await createJs(a.pmc, { jgId: a.jg.id }, f.db);
  await submitJs(a.pmc, js.id, { version: 1 }, f.db); await change(a, "retroactive");
  await expect(approveJs(a.finance, js.id, { version: 2, action: "approve" }, f.db)).rejects.toMatchObject({ status: 409 });
  expect(await f.db.select().from(s.approvals).where(and(eq(s.approvals.docType, "js"), eq(s.approvals.docId, js.id)))).toHaveLength(0);
  await approveJs(a.finance, js.id, { version: 2, action: "reject" }, f.db);
  expect(await refreshJsFee(a.pmc, js.id, { version: 3 }, f.db)).toMatchObject({ status: "draft", version: 4, feePayable: "35.00" });
});
it("refresh audit failure rolls back money and version", async () => {
  const a = await setup(), js = await createJs(a.pmc, { jgId: a.jg.id }, f.db); await change(a, "retroactive");
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("fee refresh audit failure"));
  await expect(refreshJsFee(a.pmc, js.id, { version: 1 }, f.db)).rejects.toThrow("fee refresh audit failure");
  expect((await f.db.select().from(s.jsDocs).where(eq(s.jsDocs.id, js.id)))[0]).toMatchObject({ version: 1, feePayable: "20.00" });
});
it.each(["disabled", "session", "role"])("refresh rejects current %s authority", async reason => {
  const a = await setup(), js = await createJs(a.pmc, { jgId: a.jg.id }, f.db);
  await f.db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "session" ? { sessionVersion: a.pmc.sessionVersion + 1 } : { roles: ["ops"] }).where(eq(s.users.id, a.pmc.id));
  await expect(refreshJsFee(a.pmc, js.id, { version: 1 }, f.db)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
});
it("closing receipts and submitting settlement roll back their transition on audit failure", async () => {
  const a = await setup();
  await f.db.update(s.jgDocs).set({ status: "in_progress", inProduction: true }).where(eq(s.jgDocs.id, a.jg.id));
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("close audit failed"));
  await expect(closeJgReceiving(a.pmc, a.jg.id, 1, f.db)).rejects.toThrow("close audit failed");
  expect((await f.db.select().from(s.jgDocs).where(eq(s.jgDocs.id, a.jg.id)))[0]).toMatchObject({ status: "in_progress", version: 1, inProduction: true });
  await closeJgReceiving(a.pmc, a.jg.id, 1, f.db);
  const js = await createJs(a.pmc, { jgId: a.jg.id }, f.db);
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("submit audit failed"));
  await expect(submitJs(a.pmc, js.id, { version: 1 }, f.db)).rejects.toThrow("submit audit failed");
  expect((await f.db.select().from(s.jsDocs).where(eq(s.jsDocs.id, js.id)))[0]).toMatchObject({ status: "draft", version: 1 });
});
it("PC detail disables stale/frozen approval but preserves rejection and does not change facts", async () => {
  const a = await setup();
  const pc = await createPcForJgFee(a.purchasing, { jgId: a.jg.id, newPrice: "3", scope: "retroactive" }, f.db);
  expect((await getPc(pc.id, a.purchasing, f.db)).actions).toMatchObject({ approve: false, reject: false });
  expect((await getPc(pc.id, a.checker, f.db)).actions).toMatchObject({ approve: true, reject: true });
  await f.db.update(s.jgDocs).set({ feeRateCurrent: "2.50" }).where(eq(s.jgDocs.id, a.jg.id));
  expect((await getPc(pc.id, a.checker, f.db)).actions).toMatchObject({ approve: false, reject: true, reason: expect.stringContaining("原价不一致") });
  const js = await createJs(a.pmc, { jgId: a.jg.id }, f.db);
  await submitJs(a.pmc, js.id, { version: 1 }, f.db);
  await approveJs(a.finance, js.id, { version: 2, action: "approve" }, f.db);
  expect((await getPc(pc.id, a.checker, f.db)).actions).toMatchObject({ approve: false, reject: true, reason: expect.stringContaining("已冻结") });
  expect((await f.db.select().from(s.pcDocs).where(eq(s.pcDocs.id, pc.id)))[0]).toMatchObject({ status: "pending", version: 1 });
  const masked = maskSensitive(await getPc(pc.id, { ...a.checker, roles: ["warehouse"] }, f.db), ["warehouse"]);
  expect(masked).not.toHaveProperty("newPrice"); expect(masked).not.toHaveProperty("oldPrice");
  expect(masked.actions).toMatchObject({ approve: false, reject: false });
  await approvePc(a.checker, pc.id, { action: "reject", version: 1 }, f.db);
  expect((await getPc(pc.id, a.checker, f.db)).actions).toMatchObject({ approve: false, reject: false });
});
it("JS detail follows current approval configuration and retains monetary masking", async () => {
  const a = await setup(), js = await createJs(a.pmc, { jgId: a.jg.id }, f.db);
  expect((await getJs(js.id, f.db, a.pmc)).actions).toMatchObject({ submit: true, refreshFee: true, approve: false });
  await submitJs(a.pmc, js.id, { version: 1 }, f.db);
  expect((await getJs(js.id, f.db, a.finance)).actions).toMatchObject({ approve: true, reject: true });
  await f.db.update(s.approvalConfigs).set({ approverRole: "purchasing" }).where(eq(s.approvalConfigs.docType, "js"));
  try {
    expect((await getJs(js.id, f.db, a.finance)).actions).toMatchObject({ approve: false, reject: false });
    expect((await getJs(js.id, f.db, a.checker)).actions).toMatchObject({ approve: true, reject: true });
    await expect(getJs(js.id, f.db, { ...a.checker, roles: ["warehouse"] })).rejects.toMatchObject({ status: 403 });
  } finally {
    await f.db.update(s.approvalConfigs).set({ approverRole: "finance" }).where(eq(s.approvalConfigs.docType, "js"));
  }
});
it.each(["ops", "warehouse", "quality"])("JS configured %s checker cannot approve hidden amounts; rejection stays atomic", async role => {
  const a = await setup(), checker = await actor([role]);
  const js = await createJs(a.pmc, { jgId: a.jg.id }, f.db);
  await submitJs(a.pmc, js.id, { version: 1 }, f.db);
  await f.db.update(s.approvalConfigs).set({ approverRole: role }).where(eq(s.approvalConfigs.docType, "js"));
  try {
    const detail = maskSensitive(await getJs(js.id, f.db, checker), checker.roles);
    expect(detail.actions).toMatchObject({ approve: false, reject: true });
    expect(detail).not.toHaveProperty("feePayable");
    await expect(approveJs(checker, js.id, { action: "approve", version: 2 }, f.db))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("不可查看结算金额") });
    // A stale caller-supplied finance role cannot bypass the current database identity.
    await expect(approveJs({ ...checker, roles: [role, "finance"] }, js.id, { action: "approve", version: 2 }, f.db))
      .rejects.toMatchObject({ status: 403 });
    expect((await getJs(js.id, f.db)).status).toBe("pending");
    expect((await getJs(js.id, f.db)).approvals).toEqual([]);
    expect((await getJs(js.id, f.db)).version).toBe(2);
    await approveJs(checker, js.id, { action: "reject", version: 2, comment: "请配置金额可见审批人" }, f.db);
    const rejected = await getJs(js.id, f.db);
    expect(rejected).toMatchObject({ status: "draft", version: 3, feePayable: "20.00" });
    expect(rejected.approvals).toHaveLength(1);
    await submitJs(a.pmc, js.id, { version: 3 }, f.db);
    await f.db.update(s.users).set({ roles: [role, "finance"] }).where(eq(s.users.id, checker.id));
    await approveJs(checker, js.id, { action: "approve", version: 4 }, f.db);
    await f.db.update(s.users).set({ roles: [role] }).where(eq(s.users.id, checker.id));
    const completed = await getJs(js.id, f.db);
    const audits = await f.db.select().from(s.auditLogs);
    const ledger = await f.db.select().from(s.stockLedger);
    expect(await approveJs(checker, js.id, { action: "approve", version: 4 }, f.db))
      .toMatchObject({ status: "completed", idempotent: true });
    expect(await getJs(js.id, f.db)).toEqual(completed);
    expect(await f.db.select().from(s.auditLogs)).toEqual(audits);
    expect(await f.db.select().from(s.stockLedger)).toEqual(ledger);
    await expect(approveJs(checker, js.id, { action: "approve", version: 999 }, f.db)).rejects.toMatchObject({ status: 409 });
  } finally {
    await f.db.update(s.approvalConfigs).set({ approverRole: "finance" }).where(eq(s.approvalConfigs.docType, "js"));
  }
});
