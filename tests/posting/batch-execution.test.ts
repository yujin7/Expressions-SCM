import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { post, getBalance, reverse } from "@/server/posting";
import { createTestDb } from "../helpers/db";
import { approveStockDoc, createStockDoc, submitStockDoc } from "@/server/modules/inventory/stock-doc";

let f: Awaited<ReturnType<typeof createTestDb>>, skuId: number, otherSku: number, warehouseId: number, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  const [spu] = await f.db.insert(s.spus).values({ code: "EXEC-BATCH", nameCn: "执行批次" }).returning();
  const rows = await f.db.insert(s.skus).values(["A", "B"].map(code => ({ code: `EXEC-${code}`, spuId: spu.id, skuType: "raw" as const, baseUom: "kg" }))).returning();
  [skuId, otherSku] = rows.map(r => r.id);
  [warehouseId] = (await f.db.insert(s.warehouses).values({ code: "EXEC-WH", name: "执行仓", kind: "raw" }).returning()).map(r => r.id);
});
afterAll(async () => f?.client.close());
afterEach(() => vi.useRealTimers());
async function fixture(expiryDate: string | null = "2026-09-14") {
  const key = ++seq;
  const [batch] = await f.db.insert(s.batches).values({ skuId, batchNo: `EXEC-${key}`, expiryDate }).returning();
  await post(f.db, { sourceDocType: "opening", sourceDocId: key, action: "post", lines: [
    { sourceLineId: 1, skuId, warehouseId, batchId: batch.id, qtyDelta: "10" },
  ] });
  return { batchId: batch.id, event: (sourceDocType: string) => ({ sourceDocType, sourceDocId: key, action: "post", lines: [
    { sourceLineId: 1, skuId, warehouseId, batchId: batch.id, qtyDelta: "-1" },
  ] }) };
}
async function snapshot() { return { ledger: await f.db.select().from(s.stockLedger), balances: await f.db.select().from(s.stockBalances) }; }

it.each(["fl_issue", "issue_out", "sales_out", "transfer", "sh_outsource_in"])("%s rechecks expiry on execution day, not occurredAt; refusal has no effects", async source => {
  const x = await fixture(), before = await snapshot();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T16:00:00Z"));
  await expect(post(f.db, { ...x.event(source), occurredAt: new Date("2026-09-13T01:00:00Z") })).rejects.toMatchObject({ code: "EXPIRED_BATCH" });
  expect(await snapshot()).toEqual(before);
});

it("a valid committed issue remains idempotent after expiry and its historical reversal remains possible", async () => {
  const x = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T15:59:59Z"));
  const event = x.event("sales_out"); expect(await post(f.db, event)).toEqual({ posted: true });
  vi.setSystemTime(new Date("2026-09-13T16:00:00Z"));
  const before = await snapshot(); expect(await post(f.db, event)).toEqual({ posted: false }); expect(await snapshot()).toEqual(before);
  expect(await reverse(f.db, event, 9001)).toEqual({ posted: true });
  expect(await getBalance(f.db, skuId, warehouseId, x.batchId)).toBe("10.0000");
});

it.each(["tl_return", "ct_return"])("%s can return an explicitly identified expired lot but cannot borrow another SKU's identity", async source => {
  const x = await fixture("2000-01-01");
  expect(await post(f.db, x.event(source))).toEqual({ posted: true });
  const before = await snapshot();
  await expect(post(f.db, { ...x.event(source), sourceDocId: 9000 + seq, lines: [{ ...x.event(source).lines[0], skuId: otherSku }] })).rejects.toMatchObject({ code: "BATCH_IDENTITY" });
  expect(await snapshot()).toEqual(before);
});

it("newly backfilled expiry is enforced; unknown expiry remains distinct from known expired", async () => {
  const x = await fixture(null);
  expect(await post(f.db, x.event("sales_out"))).toEqual({ posted: true });
  await f.db.update(s.batches).set({ expiryDate: "2000-01-01" }).where(eq(s.batches.id, x.batchId));
  await expect(post(f.db, { ...x.event("sales_out"), sourceDocId: 9000 + seq })).rejects.toMatchObject({ code: "EXPIRED_BATCH" });
});

it("actual stock approval rolls back document, audit and approval when a saved lot expires; reject remains usable", async () => {
  const [maker, checker] = await f.db.insert(s.users).values([
    { name: "期末制单", roles: ["warehouse"], isApprover: false },
    { name: "期末审批", roles: ["warehouse"], isApprover: true },
  ]).returning();
  await f.db.insert(s.approvalConfigs).values({ docType: "stock_doc", approverRole: "warehouse" });
  const x = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T15:59:59Z"));
  const draft = await createStockDoc(maker, { subtype: "sales_out", warehouseId, lines: [{ skuId, batchId: x.batchId, qty: "1" }] }, f.db);
  const pending = await submitStockDoc(maker, draft.id, draft.version, f.db);
  const state = async () => ({ ...await snapshot(), docs: await f.db.select().from(s.stockDocs), audits: await f.db.select().from(s.auditLogs), approvals: await f.db.select().from(s.approvals) });
  const before = await state();
  vi.setSystemTime(new Date("2026-09-13T16:00:00Z"));
  await expect(approveStockDoc(checker, pending.id, { action: "approve", version: pending.version }, f.db)).rejects.toMatchObject({ code: "EXPIRED_BATCH", message: expect.stringContaining("执行日 2026-09-14") });
  expect(await state()).toEqual(before);
  expect(await approveStockDoc(checker, pending.id, { action: "reject", version: pending.version }, f.db)).toMatchObject({ status: "draft" });
  expect(await getBalance(f.db, skuId, warehouseId, x.batchId)).toBe("10.0000");
});

it("actual SKU-bound scrap approval accepts an explicit expired lot and closes only its review", async () => {
  const [maker, checker] = await f.db.insert(s.users).values([
    { name: "报废制单", roles: ["warehouse"], isApprover: false },
    { name: "报废审批", roles: ["warehouse"], isApprover: true },
  ]).returning();
  await f.db.insert(s.sysParams).values({ scope: "global", key: "batch_posting_enabled", value: "1" });
  const x = await fixture("2000-01-01");
  const [review] = await f.db.insert(s.reviewItems).values({ category: "risk_disposal", refType: "sku", refKey: "EXEC-A", title: "处置决定：报废评审 EXEC-A" }).returning();
  const input = { subtype: "issue_out", warehouseId, lines: [{ skuId, batchId: x.batchId, qty: "1" }] };
  await expect(createStockDoc(maker, input, f.db)).rejects.toMatchObject({ status: 409 });
  const draft = await createStockDoc(maker, { ...input, riskDisposalId: review.id }, f.db);
  const pending = await submitStockDoc(maker, draft.id, draft.version, f.db);
  const duplicate = await createStockDoc(maker, { ...input, riskDisposalId: review.id }, f.db);
  const secondPending = await submitStockDoc(maker, duplicate.id, duplicate.version, f.db);
  expect(await approveStockDoc(checker, pending.id, { action: "approve", version: pending.version }, f.db)).toMatchObject({ status: "completed" });
  expect(await getBalance(f.db, skuId, warehouseId, x.batchId)).toBe("9.0000");
  const [after] = await f.db.select().from(s.reviewItems).where(eq(s.reviewItems.id, review.id));
  expect(after.status).toBe("done");
  await expect(approveStockDoc(checker, secondPending.id, { action: "approve", version: secondPending.version }, f.db)).rejects.toMatchObject({ code: "EXPIRED_BATCH" });
  expect(await getBalance(f.db, skuId, warehouseId, x.batchId)).toBe("9.0000");
});
