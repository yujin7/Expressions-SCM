import { beforeAll, expect, it } from "vitest";
import { approvalConfigs, skus, spus, stockDocs, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { approveStockDoc, createStockDoc, getStockDoc, submitStockDoc } from "@/server/modules/inventory/stock-doc";
import { approveCountTask, createCountTask, getCountTask, submitCountTask, updateCounts } from "@/server/modules/inventory/count";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, maker: SessionUser, finance: SessionUser, otherFinance: SessionUser;
let openingId: number, adjustmentId: number, salesId: number, sourcePdId: number, sourcePdNo: string;
beforeAll(async () => {
  ({ db } = await createTestDb());
  const makeUser = async (name: string, roles: string[]) => { const [u] = await db.insert(users).values({ name, roles, isApprover: true }).returning(); return { id: u.id, name, roles, isApprover: true }; };
  maker = await makeUser("制单仓管", ["warehouse"]); finance = await makeUser("财务复核", ["finance"]);
  otherFinance = await makeUser("另一财务", ["finance"]);
  const warehouseApprover = await makeUser("另一仓管", ["warehouse"]);
  await db.insert(approvalConfigs).values([{ docType: "opening", approverRole: "finance" }, { docType: "stock_doc", approverRole: "warehouse" }, { docType: "count", approverRole: "finance" }]);
  const [spu] = await db.insert(spus).values({ code: "HISTORY", nameCn: "审批身份验证" }).returning();
  const [sku] = await db.insert(skus).values({ code: "HISTORY", spuId: spu.id, name: "合成精华", skuType: "finished", baseUom: "瓶" }).returning();
  const [wh] = await db.insert(warehouses).values({ code: "HISTORY", name: "合成仓", kind: "finished" }).returning();
  const opening = await createStockDoc(maker, { subtype: "opening", warehouseId: wh.id, lines: [{ skuId: sku.id, qty: "10" }] }, db);
  const openPending = await submitStockDoc(maker, opening.id, opening.version, db);
  await approveStockDoc(finance, opening.id, { version: openPending.version, action: "approve", comment: "仅期初审批" }, db); openingId = opening.id;
  const pd = await createCountTask(maker, { warehouseId: wh.id, mode: "partial", filters: { skuIds: [sku.id] } }, db);
  sourcePdId = pd.id; sourcePdNo = pd.docNo;
  const detail = await getCountTask(pd.id, db);
  const updated = await updateCounts(maker, pd.id, { version: pd.version, lines: [{ lineId: detail.lines[0].id, countedQty: "9" }] }, db);
  const pending = await submitCountTask(maker, pd.id, updated.version, db);
  const approved = await approveCountTask(finance, pd.id, { version: pending.version, action: "approve", comment: "来源盘点批准" }, db);
  adjustmentId = approved.adjustDocId!;
  const rejectCount = async (comment: string) => {
    const p = await createCountTask(maker, { warehouseId: wh.id, mode: "partial", filters: { skuIds: [sku.id] } }, db);
    const waiting = await submitCountTask(maker, p.id, p.version, db);
    await approveCountTask(finance, p.id, { version: waiting.version, action: "reject", comment }, db); return p;
  };
  const pd2 = await rejectCount("其他盘点二驳回"); expect(pd2.id).toBe(adjustmentId);
  const sale = await createStockDoc(maker, { subtype: "sales_out", warehouseId: wh.id, lines: [{ skuId: sku.id, qty: "1" }] }, db);
  const salePending = await submitStockDoc(maker, sale.id, sale.version, db);
  await approveStockDoc(warehouseApprover, sale.id, { version: salePending.version, action: "approve", comment: "仅销售单审批" }, db); salesId = sale.id;
  const pd3 = await rejectCount("其他盘点三驳回"); expect(pd3.id).toBe(salesId);
  expect(openingId).toBe(sourcePdId); // Separate serial sequences naturally collide; no raw fixture approval inserts.
});

it("opening details do not borrow an unrelated count task's same-ID approval", async () => {
  expect((await getStockDoc(openingId, db)).approvals.map(a => a.comment)).toEqual(["仅期初审批"]);
});
it("sales details show only their own stock-document approval domain", async () => {
  expect((await getStockDoc(salesId, db)).approvals.map(a => a.comment)).toEqual(["仅销售单审批"]);
});
it("generated adjustment follows its source PD identity, not adjustment ID", async () => {
  const result = await getStockDoc(adjustmentId, db);
  expect(result.approvals.map(a => a.comment)).toEqual(["来源盘点批准"]);
  expect(result.approvalBasis).toMatchObject({ label: "来源盘点审批", href: `/inventory/count?docId=${sourcePdId}`, sourceDocNo: sourcePdNo, verified: true });
});
it("count task history remains scoped to the original count identity", async () => {
  expect((await getCountTask(sourcePdId, db)).approvals.map(a => a.comment)).toEqual(["来源盘点批准"]);
});
it("adjustment cannot borrow count-task idempotency or be separately re-approved", async () => {
  await expect(approveStockDoc(otherFinance, adjustmentId, { version: 2, action: "reject" }, db)).rejects.toThrow(/来源盘点/);
});
it("a missing source is explicitly unresolved, never replaced by a same-ID approval", async () => {
  const [doc] = await db.insert(stockDocs).values({ docNo: "CA-MISSING", subtype: "count_adjust", createdBy: maker.id, sourceDocType: "pd", sourceDocId: 999999, status: "completed" }).returning();
  const result = await getStockDoc(doc.id, db); expect(result.approvals).toEqual([]);
  expect(result.approvalBasis).toMatchObject({ verified: false, href: null, note: expect.stringContaining("核对") });
});
it("a source pointer without the PD-line back-reference cannot lend its approval", async () => {
  const [doc] = await db.insert(stockDocs).values({ docNo: "CA-WRONG-LINK", subtype: "count_adjust", createdBy: maker.id, sourceDocType: "pd", sourceDocId: sourcePdId, status: "completed" }).returning();
  const result = await getStockDoc(doc.id, db); expect(result.approvals).toEqual([]); expect(result.approvalBasis.verified).toBe(false);
});
