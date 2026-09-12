import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { checkBatchAfterPoReceipt } from "@/server/modules/outsource/auto-chain";
import { confirmInbound } from "@/server/modules/matflow/sh";
import { getSh, listShs } from "@/server/modules/matflow/sh-read";
import { getReceiptBatchReview } from "@/server/modules/matflow/receipt-batch-status";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], actor: SessionUser, warehouse: SessionUser, seq = 0;
beforeAll(async () => {
  ({ db, client } = await createTestDb());
  [actor, warehouse] = await db.insert(s.users).values([{ name: "合成PMC", roles: ["pmc"] }, { name: "合成仓管", roles: ["warehouse"] }]).returning();
  await db.insert(s.sysParams).values({ scope: "global", key: "auto_jg_on_ready", value: "1" });
});
afterAll(async () => { await client.close(); });
async function fixture() {
  const no = `RECEIPT-BATCH-${++seq}`;
  const [spu] = await db.insert(s.spus).values({ code: no, nameCn: no }).returning();
  const [product, material] = await db.insert(s.skus).values([
    { code: `${no}-FG`, name: "合成成品", spuId: spu.id, skuType: "finished" as const, baseUom: "支" },
    { code: `${no}-MAT`, name: "合成物料", spuId: spu.id, skuType: "packaging" as const, baseUom: "个" },
  ]).returning();
  const [sup] = await db.insert(s.suppliers).values({ code: no, name: "合成加工厂" }).returning();
  const [wh] = await db.insert(s.warehouses).values({ code: no, name: "合成实时仓", kind: "packaging", accountingMode: "realtime" }).returning();
  const [bom] = await db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1", status: "active" }).returning();
  const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${no}`, status: "approved", productSkuId: product.id, qty: "100", supplierId: sup.id, feeRatePlan: "1", bomId: bom.id, createdBy: actor.id }).returning();
  await db.insert(s.woLines).values({ woId: wo.id, materialSkuId: material.id, qtyPer: "1", grossReq: "100", suggestedQty: "100" });
  const [po] = await db.insert(s.poDocs).values({ docNo: `PO-${no}`, woId: wo.id, supplierId: sup.id, status: "in_progress", createdBy: actor.id }).returning();
  const [line] = await db.insert(s.poLines).values({ poId: po.id, skuId: material.id, lineType: "packaging", qty: "100", receivedQty: "0", purchaseUom: "个", uomFactor: "1", price: "1" }).returning();
  const [sh] = await db.insert(s.shDocs).values({ docNo: `SH-${no}`, sourceType: "po", sourceId: po.id, warehouseId: wh.id, status: "approved", createdBy: warehouse.id }).returning();
  const [shLine] = await db.insert(s.shLines).values({ shId: sh.id, poLineId: line.id, skuId: material.id, lineType: "normal", expectedQty: "50", actualQty: "50" }).returning();
  const [qc] = await db.insert(s.qcRecords).values({ shId: sh.id, createdBy: warehouse.id }).returning();
  await db.insert(s.qcLines).values({ qcId: qc.id, shLineId: shLine.id, passQty: "50", failQty: "0", concessionQty: "0", failHandling: "pending" });
  return { wo, product, sup, po, sh, wh };
}
const batches = (woId: number) => db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, woId));
const review = (id: number) => getReceiptBatchReview(db, id);
const flag = (value: string) => db.update(s.sysParams).set({ value }).where(and(eq(s.sysParams.scope, "global"), eq(s.sysParams.key, "auto_jg_on_ready")));

it("warehouse inbound commits stock and durable handoff without impersonating PMC; recovery creates exactly one draft", async () => {
  const f = await fixture();
  expect(await confirmInbound(warehouse, f.sh.id, db)).toEqual({ status: "completed", batchCheck: "pending" });
  expect(await getSh(f.sh.id, db)).toMatchObject({ inbound: true, batchReview: { state: "pending", woId: f.wo.id } });
  const stock = await db.select().from(s.stockLedger);
  expect(stock.some(row => row.skuId === f.product.id)).toBe(false);
  await expect(checkBatchAfterPoReceipt(warehouse, f.sh.id, db)).rejects.toMatchObject({ status: 403 });
  await flag("0"); // disabling future requests must not erase the committed handoff
  const result = await checkBatchAfterPoReceipt(actor, f.sh.id, db);
  expect(result).toMatchObject({ state: "created", woId: f.wo.id, checkedAt: expect.any(Date) });
  expect(await checkBatchAfterPoReceipt(actor, f.sh.id, db)).toEqual(result);
  expect(await batches(f.wo.id)).toMatchObject([{ id: result.jgId, qty: "50.0000", status: "draft" }]);
  expect(await db.select().from(s.jgFeeSegments).where(eq(s.jgFeeSegments.jgId, result.jgId!))).toHaveLength(1);
  await expect(confirmInbound(warehouse, f.sh.id, db)).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(s.stockLedger)).toEqual(stock);
  await flag("1");
});
it("no intent for disabled flag, unlinked PO or historical absence; never invents an old hook failure", async () => {
  const f = await fixture(); await flag("0");
  expect(await confirmInbound(warehouse, f.sh.id, db)).toEqual({ status: "completed" });
  await flag("1"); expect(await review(f.sh.id)).toBeNull();
  await expect(checkBatchAfterPoReceipt(actor, f.sh.id, db)).rejects.toMatchObject({ status: 409 });
  const unlinked = await fixture(); await db.update(s.poDocs).set({ woId: null }).where(eq(s.poDocs.id, unlinked.po.id));
  expect(await confirmInbound(warehouse, unlinked.sh.id, db)).toEqual({ status: "completed" });
  expect(await review(unlinked.sh.id)).toBeNull();
  const historical = await fixture(); await db.update(s.shDocs).set({ status: "completed" }).where(eq(s.shDocs.id, historical.sh.id));
  expect(await review(historical.sh.id)).toBeNull();
});
it("PMC plus warehouse can complete the post-commit check immediately, still only a draft", async () => {
  const f = await fixture();
  const [both] = await db.insert(s.users).values({ name: "合成双角色", roles: ["warehouse", "pmc"] }).returning();
  expect(await confirmInbound(both, f.sh.id, db)).toEqual({ status: "completed", batchCheck: "checked" });
  expect(await review(f.sh.id)).toMatchObject({ state: "created" });
  expect(await batches(f.wo.id)).toMatchObject([{ status: "draft" }]);
});
it("expected refusal is recorded as not generated, not fake success or infrastructure failure", async () => {
  const f = await fixture(); await confirmInbound(warehouse, f.sh.id, db);
  await db.update(s.suppliers).set({ status: "paused" }).where(eq(s.suppliers.id, f.sup.id));
  const result = await checkBatchAfterPoReceipt(actor, f.sh.id, db);
  expect(result).toMatchObject({ state: "not_generated", reason: expect.stringContaining("禁止新单"), jgId: null });
  await db.update(s.suppliers).set({ status: "qualified" }).where(eq(s.suppliers.id, f.sup.id));
  expect(await checkBatchAfterPoReceipt(actor, f.sh.id, db)).toEqual(result);
  expect(await batches(f.wo.id)).toHaveLength(0);
});
it("acknowledgement failure rolls back draft, fee, numbering and batch audit while keeping completed inbound intact", async () => {
  const f = await fixture(); await confirmInbound(warehouse, f.sh.id, db);
  const stock = await db.select().from(s.stockLedger), counters = await db.select().from(s.docCounters), fees = await db.select().from(s.jgFeeSegments), audits = await db.select().from(s.auditLogs);
  const original = audit.writeAudit;
  const fail = vi.spyOn(audit, "writeAudit").mockImplementation(async (tx, event) => {
    if (event.action === "receipt_batch_checked") throw Error("synthetic acknowledgement failure");
    return original(tx, event);
  });
  try { await expect(checkBatchAfterPoReceipt(actor, f.sh.id, db)).rejects.toThrow("acknowledgement failure"); } finally { fail.mockRestore(); }
  expect(await batches(f.wo.id)).toHaveLength(0);
  expect(await db.select().from(s.docCounters)).toEqual(counters);
  expect(await db.select().from(s.jgFeeSegments)).toEqual(fees);
  expect(await db.select().from(s.auditLogs)).toEqual(audits);
  expect(await db.select().from(s.stockLedger)).toEqual(stock);
  expect(await getSh(f.sh.id, db)).toMatchObject({ inbound: true, batchReview: { state: "pending" } });
  expect(await checkBatchAfterPoReceipt(actor, f.sh.id, db)).toMatchObject({ state: "created" });
});
it("inbound audit failure rolls back stock and request together", async () => {
  const f = await fixture(), stock = await db.select().from(s.stockLedger);
  const original = audit.writeAudit;
  const fail = vi.spyOn(audit, "writeAudit").mockImplementation(async (tx, event) => {
    if (event.action === "inbound") throw Error("synthetic inbound audit failure");
    return original(tx, event);
  });
  try { await expect(confirmInbound(warehouse, f.sh.id, db)).rejects.toThrow("inbound audit failure"); } finally { fail.mockRestore(); }
  expect(await review(f.sh.id)).toBeNull();
  expect(await getSh(f.sh.id, db)).toMatchObject({ status: "approved", inbound: false });
  expect(await db.select().from(s.stockLedger)).toEqual(stock);
});
it("queue and detail agree on malformed acknowledgements; filter applies before pagination", async () => {
  const f = await fixture(); await confirmInbound(warehouse, f.sh.id, db);
  const pending = (await review(f.sh.id))!;
  for (const after of [{ state: "created", woId: f.wo.id, jgId: 1, docNo: "" }, { state: "created", woId: f.wo.id, jgId: "1", docNo: "JG-X" }, { state: "not_generated", woId: f.wo.id + 1 }]) {
    await audit.writeAudit(db, { userId: actor.id, entity: "sh", entityId: f.sh.id, action: "receipt_batch_checked", after: { ...after, requestId: pending.requestId } });
    expect(await review(f.sh.id)).toMatchObject({ state: "pending" });
    expect(await listShs(f.sh.docNo, { batchCheckPending: true, page: 1, pageSize: 1 }, db)).toMatchObject({ total: 1, rows: [{ id: f.sh.id, batchCheckPending: true }] });
  }
  expect(await listShs(f.sh.docNo, { batchCheckPending: true, page: 2, pageSize: 1 }, db)).toMatchObject({ total: 1, rows: [] });
  await checkBatchAfterPoReceipt(actor, f.sh.id, db);
  expect(await listShs(f.sh.docNo, { batchCheckPending: true, page: 1, pageSize: 1 }, db)).toEqual({ rows: [], total: 0 });
});
it("fresh role, active account and session version are checked on recovery and replay", async () => {
  const f = await fixture(); await confirmInbound(warehouse, f.sh.id, db);
  await expect(checkBatchAfterPoReceipt({ ...warehouse, roles: ["pmc"] }, f.sh.id, db)).rejects.toMatchObject({ status: 403 });
  const [inactive] = await db.insert(s.users).values({ name: "合成停用", roles: ["pmc"], active: false }).returning();
  await expect(checkBatchAfterPoReceipt(inactive, f.sh.id, db)).rejects.toMatchObject({ status: 403 });
  await expect(checkBatchAfterPoReceipt({ ...actor, sessionVersion: 999 }, f.sh.id, db)).rejects.toMatchObject({ status: 401 });
  expect(await batches(f.wo.id)).toHaveLength(0);
});
it("rejects invalid or uncommitted source identities and never silently rebinds intent", async () => {
  const f = await fixture();
  for (const id of [0, -1, 0.5, 2147483648]) await expect(checkBatchAfterPoReceipt(actor, id, db)).rejects.toMatchObject({ status: 400 });
  await expect(checkBatchAfterPoReceipt(actor, 2147483647, db)).rejects.toMatchObject({ status: 404 });
  await expect(checkBatchAfterPoReceipt(actor, f.sh.id, db)).rejects.toMatchObject({ status: 409 });
  await confirmInbound(warehouse, f.sh.id, db);
  const other = await fixture(); await db.update(s.poDocs).set({ woId: other.wo.id }).where(eq(s.poDocs.id, f.po.id));
  await expect(checkBatchAfterPoReceipt(actor, f.sh.id, db)).rejects.toMatchObject({ status: 409 });
  expect(await review(f.sh.id)).toMatchObject({ state: "pending", woId: f.wo.id });
  expect(await listShs(f.sh.docNo, { batchCheckPending: true, page: 1, pageSize: 10 }, db)).toMatchObject({ total: 1 });
  expect(await batches(other.wo.id)).toHaveLength(0); expect(await batches(f.wo.id)).toHaveLength(0);
});
