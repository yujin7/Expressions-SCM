import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { getWarehouse, updateWarehouse } from "@/server/modules/master/warehouse";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, sku: number, owner: number, supplier: number, otherSupplier: number, jg: number, po: number, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  const [u] = await f.db.insert(s.users).values({ name: "仓库身份测试", roles: ["admin"] }).returning(); owner = u.id;
  const [spu] = await f.db.insert(s.spus).values({ code: "WH-ID", nameCn: "仓库身份" }).returning();
  const [item] = await f.db.insert(s.skus).values({ code: "WH-ID", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning(); sku = item.id;
  const suppliers = await f.db.insert(s.suppliers).values([{ code: "WH-ID-A", name: "甲厂" }, { code: "WH-ID-B", name: "乙厂" }]).returning();
  supplier = suppliers[0].id; otherSupplier = suppliers[1].id;
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: sku, versionNo: "1" }).returning();
  const [wo] = await f.db.insert(s.woDocs).values({ docNo: "WH-ID-WO", productSkuId: sku, supplierId: supplier, bomId: bom.id, qty: "1", feeRatePlan: "1", createdBy: owner }).returning();
  const [processing] = await f.db.insert(s.jgDocs).values({ docNo: "WH-ID-JG", woId: wo.id, supplierId: supplier, productSkuId: sku, qty: "1", feeRateCurrent: "1", createdBy: owner }).returning(); jg = processing.id;
  const [purchase] = await f.db.insert(s.poDocs).values({ docNo: "WH-ID-PO", woId: wo.id, supplierId: supplier, createdBy: owner }).returning(); po = purchase.id;
});
afterAll(async () => f?.client.close());
afterEach(() => vi.restoreAllMocks());
const actor = () => ({ id: owner, name: "仓库身份测试", roles: ["admin"], isApprover: false });
async function warehouse() {
  const [wh] = await f.db.insert(s.warehouses).values({ code: `WH-ID-${++seq}`, name: "甲厂仓", kind: "outsource", supplierId: supplier }).returning();
  return wh;
}
const uses = {
  "零余额仍有历史身份": async (id: number) => { await f.db.insert(s.stockBalances).values({ warehouseId: id, skuId: sku, qty: "0" }); },
  "负余额不能转移厂归属": async (id: number) => { await f.db.insert(s.stockBalances).values({ warehouseId: id, skuId: sku, qty: "-1" }); },
  "仅流水": async (id: number) => { await f.db.insert(s.stockLedger).values({ warehouseId: id, skuId: sku, qtyDelta: "1", sourceDocType: "fixture", sourceDocId: id, action: "post" }); },
  "仅快照": async (id: number) => { await f.db.insert(s.stockSnapshots).values({ warehouseId: id, skuId: sku, qty: "1", bizDate: "2026-09-13" }); },
  "仅效期参考": async (id: number) => { await f.db.insert(s.batchStocks).values({ warehouseId: id, skuId: sku, qty: "1", stocktakeDate: "2026-09-13" }); },
  "仅库位": async (id: number) => { await f.db.insert(s.bins).values({ warehouseId: id, code: "A" }); },
  "发料草稿": async (id: number) => { await f.db.insert(s.flDocs).values({ docNo: `WH-ID-FL-${id}`, jgId: jg, fromWarehouseId: id, toWarehouseId: id, createdBy: owner }); },
  "退料草稿": async (id: number) => { await f.db.insert(s.tlDocs).values({ docNo: `WH-ID-TL-${id}`, jgId: jg, fromWarehouseId: id, toWarehouseId: id, createdBy: owner }); },
  "收货草稿": async (id: number) => { await f.db.insert(s.shDocs).values({ docNo: `WH-ID-SH-${id}`, sourceType: "jg", sourceId: jg, warehouseId: id, createdBy: owner }); },
  "采购退货": async (id: number) => { await f.db.insert(s.ctDocs).values({ docNo: `WH-ID-CT-${id}`, poId: po, warehouseId: id, createdBy: owner }); },
  "调拨目标仓": async (id: number) => {
    const [doc] = await f.db.insert(s.stockDocs).values({ docNo: `WH-ID-DB-${id}`, subtype: "transfer", createdBy: owner }).returning();
    const from = await warehouse();
    await f.db.insert(s.stockDocLines).values({ stockDocId: doc.id, skuId: sku, warehouseId: from.id, toWarehouseId: id, qty: "1" });
  },
  "盘点草稿": async (id: number) => { await f.db.insert(s.pdDocs).values({ docNo: `WH-ID-PD-${id}`, warehouseId: id, createdBy: owner }); },
  "质量案件": async (id: number) => { await f.db.insert(s.qualityCases).values({ caseNo: `WH-ID-QI-${id}`, idempotencyKey: `WH-ID-QI-${id}`, createdBy: owner, kind: "complaint", title: "测试", summary: "测试", warehouseId: id, ownerId: owner, receivedDate: "2026-09-13" }); },
};
it.each(Object.entries(uses))("%s：禁止改厂/改类型/改记账，拒绝不留半笔审计", async (_label, use) => {
  const wh = await warehouse(); await use(wh.id);
  const before = await f.db.select().from(s.auditLogs);
  for (const change of [{ supplierId: otherSupplier }, { kind: "raw", supplierId: null }, { kind: "snapshot", supplierId: null }]) {
    await expect(updateWarehouse(wh.id, { ...wh, ...change }, actor(), f.db)).rejects.toMatchObject({ status: 409 });
    expect((await f.db.select().from(s.warehouses).where(eq(s.warehouses.id, wh.id)))[0]).toEqual(wh);
    expect(await f.db.select().from(s.auditLogs)).toEqual(before);
  }
  const detail = await getWarehouse(wh.id, f.db);
  expect(detail.identityUsage.length).toBeGreaterThan(0);
});
it("已使用仓仍可改名、层级、区域、停用；不改变原库存与加工厂", async () => {
  const wh = await warehouse(), parent = await warehouse();
  await uses["负余额不能转移厂归属"](wh.id);
  const saved = await updateWarehouse(wh.id, { ...wh, name: "甲厂仓（停用）", parentId: parent.id, regionCode: "HK", active: false }, actor(), f.db);
  expect(saved).toMatchObject({ supplierId: supplier, kind: "outsource", name: "甲厂仓（停用）", active: false, parentId: parent.id, regionCode: "HK" });
  expect((await f.db.select().from(s.stockBalances).where(eq(s.stockBalances.warehouseId, wh.id)))[0].qty).toBe("-1.0000");
});
it("未使用空仓可纠正身份；审计失败时原子回滚，显式重试才保存", async () => {
  const wh = await warehouse();
  expect((await getWarehouse(wh.id, f.db)).identityUsage).toEqual([]);
  const input = { ...wh, supplierId: otherSupplier };
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("audit unavailable"));
  await expect(updateWarehouse(wh.id, input, actor(), f.db)).rejects.toThrow("audit unavailable");
  expect((await f.db.select().from(s.warehouses).where(eq(s.warehouses.id, wh.id)))[0]).toEqual(wh);
  expect(await updateWarehouse(wh.id, input, actor(), f.db)).toMatchObject({ supplierId: otherSupplier });
});
