import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { approveCt, createCt, getCt, submitCt, updateCt } from "@/server/modules/matflow/ct";
import { post, getBalance } from "@/server/posting";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  await f.db.insert(s.approvalConfigs).values({ docType: "ct", approverRole: "warehouse" });
  await f.db.insert(s.sysParams).values({ scope: "global", key: "batch_posting_enabled", value: "1" });
});
afterAll(async () => f?.client.close());
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const db = f.db, code = `CT-REPAIR-${++seq}`;
  const [maker, checker, other] = await db.insert(s.users).values([
    { name: code, roles: ["warehouse"] }, { name: code + "-复核", roles: ["admin"], isApprover: true }, { name: code + "-其他", roles: ["warehouse"], isApprover: true },
  ]).returning();
  const [spu] = await db.insert(s.spus).values({ code, nameCn: code }).returning();
  const [sku] = await db.insert(s.skus).values({ code, name: code, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
  const [sup] = await db.insert(s.suppliers).values({ code, name: code }).returning();
  const [wh] = await db.insert(s.warehouses).values({ code, name: code, kind: "raw", accountingMode: "realtime" }).returning();
  const [po] = await db.insert(s.poDocs).values({ docNo: code, supplierId: sup.id, status: "completed", createdBy: maker.id }).returning();
  const [source] = await db.insert(s.poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty: "10", uomFactor: "1", price: "1", receivedQty: "10" }).returning();
  const [batch] = await db.insert(s.batches).values({ skuId: sku.id, batchNo: code, expiryDate: "2000-01-01" }).returning();
  await post(db, { sourceDocType: "opening", sourceDocId: seq, action: "post", lines: [
    { sourceLineId: 1, skuId: sku.id, warehouseId: wh.id, batchId: batch.id, qtyDelta: "10" },
  ] });
  const doc = await createCt(maker, { poId: po.id, warehouseId: wh.id, lines: [
    { poLineId: source.id, skuId: sku.id, batchId: batch.id, qty: "6", reason: "初填" },
    { poLineId: source.id, skuId: sku.id, batchId: batch.id, qty: "1", reason: "待核" },
  ] }, db);
  const detail = await getCt(doc.id, db, maker);
  const input = { version: doc.version, remark: "实际退回", lines: [{ id: detail.lines[0].id, qty: "4.1234", reason: "实物核对" }] };
  return { db, maker, checker, other, sku, wh, po, source, batch, doc, detail, input };
}
const snapshot = async () => ({ docs: await f.db.select().from(s.ctDocs), lines: await f.db.select().from(s.ctLines),
  approvals: await f.db.select().from(s.approvals), audit: await f.db.select().from(s.auditLogs),
  ledger: await f.db.select().from(s.stockLedger), balances: await f.db.select().from(s.stockBalances), poLines: await f.db.select().from(s.poLines) });

it("over-return rejection → repair original expired lot → approve once preserves source and approval history", async () => {
  const x = await fixture(), pending = await submitCt(x.maker, x.doc.id, x.doc.version, x.db);
  await x.db.update(s.poLines).set({ receivedQty: "5" }).where(eq(s.poLines.id, x.source.id));
  const before = await snapshot();
  await expect(approveCt(x.checker, x.doc.id, { action: "approve", version: pending.version }, x.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
  const hints = (await getCt(x.doc.id, x.db, x.other)).actions;
  expect(hints).toMatchObject({ approve: false, reject: true, edit: false });
  expect(hints?.reason).toContain("超过已收数");
  await approveCt(x.checker, x.doc.id, { action: "reject", comment: "核对实际退回", version: pending.version }, x.db);
  const rejected = await getCt(x.doc.id, x.db, x.maker);
  expect(rejected.actions?.edit).toBe(true);
  const saved = await updateCt(x.maker, x.doc.id, { ...x.input, version: rejected.version }, x.db);
  const detail = await getCt(x.doc.id, x.db);
  expect(detail).toMatchObject({ id: x.doc.id, docNo: x.doc.docNo, poId: x.po.id, warehouseId: x.wh.id, createdBy: x.maker.id, status: "draft" });
  expect(detail.lines).toMatchObject([{ id: x.detail.lines[0].id, poLineId: x.source.id, skuId: x.sku.id, batchId: x.batch.id, qty: "4.1234", reason: "实物核对" }]);
  expect(detail.lines).toHaveLength(1); expect(detail.approvals).toEqual(rejected.approvals);
  expect(await getBalance(x.db, x.sku.id, x.wh.id, x.batch.id)).toBe("10.0000");
  expect((await x.db.select().from(s.poLines).where(eq(s.poLines.id, x.source.id)))[0].receivedQty).toBe("5.0000");
  const sent = await submitCt(x.maker, saved.id, saved.version, x.db);
  expect(await approveCt(x.checker, saved.id, { action: "approve", version: sent.version }, x.db)).toMatchObject({ status: "completed" });
  expect(await getBalance(x.db, x.sku.id, x.wh.id, x.batch.id)).toBe("5.8766");
  expect((await x.db.select().from(s.poLines).where(eq(s.poLines.id, x.source.id)))[0].receivedQty).toBe("0.8766");
  const final = await snapshot();
  expect(await approveCt(x.checker, saved.id, { action: "approve", version: sent.version }, x.db)).toMatchObject({ idempotent: true });
  expect(await snapshot()).toEqual(final);
});
it("audit failure rolls back header, retained lines and removed lines; stale retry never overwrites", async () => {
  const x = await fixture(), before = await snapshot();
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("audit down"));
  await expect(updateCt(x.maker, x.doc.id, x.input, x.db)).rejects.toThrow("audit down"); expect(await snapshot()).toEqual(before);
  const saved = await updateCt(x.maker, x.doc.id, x.input, x.db); expect(saved.version).toBe(2);
  const after = await snapshot(); await expect(updateCt(x.maker, x.doc.id, x.input, x.db)).rejects.toMatchObject({ status: 409 }); expect(await snapshot()).toEqual(after);
});
it.each(["poId", "warehouseId", "skuId", "batchId", "poLineId"])("cannot replace immutable %s through unknown fields", async field => {
  const x = await fixture(), before = await snapshot();
  const input = ["poId", "warehouseId"].includes(field) ? { ...x.input, [field]: 999 } : { ...x.input, lines: [{ ...x.input.lines[0], [field]: 999 }] };
  await expect(updateCt(x.maker, x.doc.id, input, x.db)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it.each(["0", "1.12345", "10000000000", "banana", "-1"])("invalid qty %s has no side effects", async qty => {
  const x = await fixture(), before = await snapshot();
  await expect(updateCt(x.maker, x.doc.id, { ...x.input, lines: [{ ...x.input.lines[0], qty }] }, x.db)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it("foreign IDs, duplicate IDs, empty lines and aggregate PO excess are refused atomically", async () => {
  const x = await fixture(), y = await fixture(), before = await snapshot();
  for (const lines of [[{ ...x.input.lines[0], id: y.detail.lines[0].id }], [x.input.lines[0], x.input.lines[0]], [],
    x.detail.lines.map(line => ({ id: line.id, qty: "6" }))]) {
    await expect(updateCt(x.maker, x.doc.id, { ...x.input, lines }, x.db)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  }
});
it.each(["other-maker", "disabled", "role-loss", "session-loss"])("current authority rejects %s", async mode => {
  const x = await fixture();
  if (mode === "disabled") await x.db.update(s.users).set({ active: false }).where(eq(s.users.id, x.maker.id));
  if (mode === "role-loss") await x.db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, x.maker.id));
  if (mode === "session-loss") await x.db.update(s.users).set({ sessionVersion: x.maker.sessionVersion + 1 }).where(eq(s.users.id, x.maker.id));
  const before = await snapshot(); await expect(updateCt(mode === "other-maker" ? x.other : x.maker, x.doc.id, x.input, x.db)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it("source or warehouse disqualification blocks repair; an independent checker can still reject", async () => {
  const x = await fixture(), pending = await submitCt(x.maker, x.doc.id, 1, x.db);
  await x.db.update(s.poDocs).set({ status: "closed" }).where(eq(s.poDocs.id, x.po.id));
  expect((await getCt(x.doc.id, x.db, x.other)).actions).toMatchObject({ approve: false, reject: true, edit: false });
  await approveCt(x.checker, x.doc.id, { action: "reject", version: pending.version }, x.db);
  const doc = await getCt(x.doc.id, x.db, x.maker), before = await snapshot();
  expect(doc.actions?.edit).toBe(false);
  await expect(updateCt(x.maker, doc.id, { ...x.input, version: doc.version }, x.db)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it("pending and historically posted documents cannot be edited even with a corrupt draft status", async () => {
  const x = await fixture(), pending = await submitCt(x.maker, x.doc.id, 1, x.db);
  await expect(updateCt(x.maker, x.doc.id, { ...x.input, version: pending.version }, x.db)).rejects.toMatchObject({ status: 409 });
  await approveCt(x.checker, x.doc.id, { action: "approve", version: pending.version }, x.db);
  await x.db.update(s.ctDocs).set({ status: "draft" }).where(eq(s.ctDocs.id, x.doc.id));
  const doc = await getCt(x.doc.id, x.db, x.maker), before = await snapshot(); expect(doc.actions?.edit).toBe(false);
  await expect(updateCt(x.maker, doc.id, { ...x.input, version: doc.version }, x.db)).rejects.toMatchObject({ status: 409 }); expect(await snapshot()).toEqual(before);
});
it("action hints follow configured approval role and maker separation, not a hard-coded warehouse role", async () => {
  const x = await fixture(), pending = await submitCt(x.maker, x.doc.id, 1, x.db);
  await x.db.update(s.approvalConfigs).set({ approverRole: "finance" }).where(eq(s.approvalConfigs.docType, "ct"));
  try {
    expect((await getCt(pending.id, x.db, x.other)).actions).toMatchObject({ approve: false, reject: false });
    expect((await getCt(pending.id, x.db, x.maker)).actions).toMatchObject({ approve: false, reject: false });
    expect((await getCt(pending.id, x.db, { ...x.other, roles: ["finance"] })).actions).toMatchObject({ approve: true, reject: true });
  } finally { await x.db.update(s.approvalConfigs).set({ approverRole: "warehouse" }).where(eq(s.approvalConfigs.docType, "ct")); }
});
