import { beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, boms, jgDocs, shDocs, shLines, skus, spus, suppliers, users, warehouses, woDocs } from "@/db/schema";
import { listProcessingCycles } from "@/server/modules/report/processing-cycle";
import { post, reverse } from "@/server/posting/post";
import { wipExport } from "@/server/modules/report/wip-export";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, sku: number, supplier: number, warehouse: number, bom: number, user: number, seq = 0;
const date = (day: number) => new Date(`2026-08-${String(day).padStart(2, "0")}T10:00:00+08:00`);
async function order(type: string | null = "repeat", status: "approved" | "closed" | "draft" = "approved", withApproval = true) {
  const [wo] = await db.insert(woDocs).values({ docNo: `WO-CYCLE-${++seq}`, status, orderType: type, productSkuId: sku,
    qty: "100", supplierId: supplier, feeRatePlan: "1", bomId: bom, createdBy: user }).returning();
  if (withApproval) await db.insert(approvals).values({ docType: "wo", docId: wo.id, cycle: 2, node: 1, approverId: user, action: "approve", createdAt: date(1) });
  const [jg] = await db.insert(jgDocs).values({ docNo: `JG-CYCLE-${++seq}`, status: "approved", woId: wo.id,
    supplierId: supplier, productSkuId: sku, qty: "100", feeRateCurrent: "1", orderType: type, createdBy: user }).returning();
  return { wo, jg };
}
async function receipt(jgId: number, qty: string, day: number, opts: { type?: "normal" | "rework" | "spare"; postQty?: string; status?: "completed" | "draft"; postDay?: number } = {}) {
  const [sh] = await db.insert(shDocs).values({ docNo: `SH-CYCLE-${++seq}`, sourceType: "jg", sourceId: jgId,
    status: opts.status ?? "completed", warehouseId: warehouse, createdBy: user, createdAt: date(day) }).returning();
  const [line] = await db.insert(shLines).values({ shId: sh.id, skuId: sku, lineType: opts.type ?? "normal", actualQty: qty }).returning();
  const event = { sourceDocType: opts.type === "spare" ? "spare_in" : "sh_outsource_in", sourceDocId: sh.id, action: "post", occurredAt: date(opts.postDay ?? day),
    lines: [{ sourceLineId: line.id, skuId: sku, warehouseId: warehouse, qtyDelta: opts.postQty ?? qty }] };
  if (opts.postQty !== "0") await post(db, event);
  return { sh, line, event };
}
beforeAll(async () => {
  ({ db } = await createTestDb());
  const [u] = await db.insert(users).values({ name: "周期证据测试", roles: ["admin"] }).returning(); user = u.id;
  const [s] = await db.insert(spus).values({ code: "CYCLE", nameCn: "周期测试" }).returning();
  const [k] = await db.insert(skus).values({ code: "CYCLE-FG", name: "面霜", spuId: s.id, skuType: "finished", baseUom: "盒" }).returning(); sku = k.id;
  const [p] = await db.insert(suppliers).values({ code: "CYCLE-P", name: "加工厂", kinds: ["processor"] }).returning(); supplier = p.id;
  const [w] = await db.insert(warehouses).values({ code: "CYCLE-WH", name: "周期成品仓", kind: "finished" }).returning(); warehouse = w.id;
  const [b] = await db.insert(boms).values({ productSkuId: sku, versionNo: "1", status: "active", effectiveDate: "2026-01-01" }).returning(); bom = b.id;
});
it("one WO split over two JGs is one sample; full quantity uses threshold, not last receipt", async () => {
  const { wo, jg } = await order();
  const [second] = await db.insert(jgDocs).values({ docNo: `JG-CYCLE-${++seq}`, status: "approved", woId: wo.id,
    batchSeq: 2, supplierId: supplier, productSkuId: sku, qty: "40", feeRateCurrent: "1", orderType: "repeat", createdBy: user }).returning();
  await receipt(jg.id, "60", 5); const full = await receipt(second.id, "40", 15); await receipt(second.id, "10", 25);
  const result = await listProcessingCycles({}, db);
  expect(result.rows).toHaveLength(1); expect(result.summary).toMatchObject({ repeats: 1, validRepeats: 1, within20: 1 });
  expect(result.rows[0]).toMatchObject({ firstReceiptDays: 4, acceptedDays: 14, acceptedQty: "110.0000", eligible: true,
    acceptedFullAt: date(15).toISOString(), fullShNos: [full.sh.docNo] });
});
it("fast repeat below ten days qualifies; regular and unclassified never enter repeat denominator", async () => {
  for (const type of ["repeat", "regular", null]) {
    const { wo, jg } = await order(type); await receipt(jg.id, "100", 5);
    const result = await listProcessingCycles({}, db), row = result.rows.find(r => r.woId === wo.id)!;
    expect(row.acceptedDays).toBe(4); expect(row.within20Days).toBe(type === "repeat" ? true : null);
  }
  const result = await listProcessingCycles({}, db);
  expect(result.summary).toMatchObject({ orders: 4, repeats: 2, validRepeats: 2, unclassified: 1 });
});
it("SH created time is not stock posting time; spare/draft never fill normal or accepted quantities", async () => {
  const { wo, jg } = await order(); await receipt(jg.id, "100", 3, { postQty: "90", postDay: 10 });
  await receipt(jg.id, "500", 4, { type: "spare" });
  await receipt(jg.id, "500", 4, { status: "draft", postQty: "0" });
  let row = (await listProcessingCycles({}, db)).rows.find(r => r.woId === wo.id)!;
  expect(row).toMatchObject({ firstReceiptDays: 2, normalFullAt: date(3).toISOString(), acceptedQty: "90.0000", acceptedDays: null });
  await receipt(jg.id, "10", 12, { type: "rework" });
  row = (await listProcessingCycles({}, db)).rows.find(r => r.woId === wo.id)!;
  expect(row).toMatchObject({ acceptedDays: 11, acceptedQty: "100.0000", normalFullAt: date(3).toISOString() });
});
it("red posting revokes a full sample and later receipt establishes a new full timestamp", async () => {
  const { wo, jg } = await order(); const original = await receipt(jg.id, "100", 3);
  await reverse(db, { ...original.event, occurredAt: date(6) }, 987654);
  let row = (await listProcessingCycles({}, db)).rows.find(r => r.woId === wo.id)!;
  expect(row).toMatchObject({ acceptedQty: "0.0000", acceptedDays: null, eligible: false });
  await receipt(jg.id, "100", 22, { type: "rework" });
  row = (await listProcessingCycles({}, db)).rows.find(r => r.woId === wo.id)!;
  expect(row).toMatchObject({ acceptedDays: 21, within20Days: false, acceptedFullAt: date(22).toISOString() });
});
it("missing approval, short-close, wrong identity and backwards dates abstain; drafts excluded", async () => {
  const missing = await order("repeat", "approved", false); await receipt(missing.jg.id, "100", 3);
  const closed = await order("repeat", "closed"); await receipt(closed.jg.id, "100", 3);
  const wrong = await order(); await receipt(wrong.jg.id, "100", 3); await db.update(jgDocs).set({ orderType: "regular" }).where(eq(jgDocs.id, wrong.jg.id));
  const backwards = await order(); await receipt(backwards.jg.id, "100", 3); await db.update(approvals).set({ createdAt: date(5) }).where(eq(approvals.docId, backwards.wo.id));
  const draft = await order("repeat", "draft");
  const result = await listProcessingCycles({}, db);
  for (const sample of [missing, closed, wrong, backwards]) expect(result.rows.find(r => r.woId === sample.wo.id)).toMatchObject({ acceptedDays: null, eligible: false, within20Days: null });
  expect(result.rows.some(r => r.woId === draft.wo.id)).toBe(false);
  expect((await listProcessingCycles({ supplierId: 2147483647 }, db)).rows).toEqual([]);
});
it("export keeps identity, unknowns, full result count and shared filters without financial columns", async () => {
  const actor = { id: user, name: "仓管", roles: ["warehouse"], isApprover: false, sessionVersion: 1 };
  const result = await listProcessingCycles({ supplierId: supplier }, db);
  const csv = await wipExport.produce(actor, { supplierId: supplier, mode: "cycles" }, 2, db);
  expect(csv.rows).toHaveLength(2); expect(csv.total).toBe(result.rows.length);
  expect(csv.columns.some(c => c.title.includes("审批到全量净入库天数"))).toBe(true);
  expect(csv.columns.some(c => /金额|加工费|价格/.test(c.title))).toBe(false);
  expect(csv.rows[0].c15).toBeNull();
  expect(() => wipExport.paramsFromSearch(new URLSearchParams("supplierId=NaN"))).toThrow();
  await expect(wipExport.produce(actor, { mode: "cycles", overdueOnly: true }, 50, db)).rejects.toThrow();
  await expect(wipExport.produce(actor, { supplierId: "bad" }, 50, db)).rejects.toThrow();
});
