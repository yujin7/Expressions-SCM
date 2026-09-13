import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import * as stock from "@/server/core/stock-view";
import * as supply from "@/server/core/supply";
import * as reference from "@/server/core/material-reference";
import { createBatchJg, previewAutoChain } from "@/server/modules/outsource/auto-chain";
import { createTestDb, type TestDb } from "../helpers/db";
import { todayShanghai } from "@/server/modules/master/common";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], seq = 0;
beforeAll(async () => { ({ db, client } = await createTestDb()); });
afterAll(async () => { await client.close(); });
async function fixture() {
  const code = `KIT-EVID-${++seq}`;
  const [actor] = await db.insert(s.users).values({ name: code, roles: ["pmc"] }).returning();
  const [spu] = await db.insert(s.spus).values({ code, nameCn: code }).returning();
  const [product, material] = await db.insert(s.skus).values([
    { code: `${code}-FG`, name: "合成成品", spuId: spu.id, skuType: "finished", baseUom: "支" },
    { code: `${code}-PK`, name: "合成包装", spuId: spu.id, skuType: "packaging", baseUom: "个" },
  ]).returning();
  const [supplier] = await db.insert(s.suppliers).values({ code, name: "合成加工厂" }).returning();
  const [bom] = await db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1" }).returning();
  const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${code}`, status: "approved", productSkuId: product.id, qty: "100", supplierId: supplier.id, feeRatePlan: "1", bomId: bom.id, createdBy: actor.id }).returning();
  await db.insert(s.woLines).values({ woId: wo.id, materialSkuId: material.id, qtyPer: "1", grossReq: "100", suggestedQty: "100" });
  const [po] = await db.insert(s.poDocs).values({ docNo: `PO-${code}`, status: "in_progress", woId: wo.id, supplierId: supplier.id, createdBy: actor.id }).returning();
  await db.insert(s.poLines).values({ poId: po.id, skuId: material.id, lineType: "packaging", qty: "100", receivedQty: "50", purchaseUom: "个", price: "1" });
  const [warehouse] = await db.insert(s.warehouses).values({ code, name: "合成包材仓", kind: "packaging" }).returning();
  return { actor, spu, product, material, supplier, wo, po, warehouse };
}
async function row(id: number) { return (await previewAutoChain(db)).batches.find(b => b.woId === id)!; }

it("a wholly missing material remains visible with zero capacity and its full shortage", async () => {
  const f = await fixture();
  await db.update(s.poLines).set({ receivedQty: "0" }).where(eq(s.poLines.poId, f.po.id));
  expect(await row(f.wo.id)).toMatchObject({ producible: "0", suggestQty: "0.0000", kitDate: null,
    kitBasis: [{ materialCode: f.material.code, baseUom: "个", required: "100.0000", poReceived: "0.0000", networkOnHand: "0.0000", undatedSupply: "100.0000", shortBy: "100.0000" }] });
});
it("legacy finished-goods references never become system ATP or change batch quantity", async () => {
  const f = await fixture(), before = await row(f.wo.id);
  await db.insert(s.transitRefs).values({ kind: "fg_order", skuId: f.material.id, qty: "100", expectDate: todayShanghai(), externalNo: "LEGACY-EVID", sourceJobId: 1 });
  const after = await row(f.wo.id);
  expect(after.kitDate).toBeNull(); expect(after.suggestQty).toBe(before.suggestQty);
  expect(after.kitBasis[0]).toMatchObject({ excludedReference: "100.0000", undatedSupply: "50.0000", datedSupply: "0.0000" });
});
it("dated system supply and undated supply stay separate from PO received and network stock", async () => {
  const f = await fixture();
  await db.update(s.poDocs).set({ expectedDate: todayShanghai() }).where(eq(s.poDocs.id, f.po.id));
  await db.insert(s.stockBalances).values({ skuId: f.material.id, warehouseId: f.warehouse.id, qty: "50" });
  const result = await row(f.wo.id);
  expect(result.kitDate).toBe(todayShanghai());
  expect(result.kitBasis[0]).toMatchObject({ required: "100.0000", poReceived: "50.0000", networkOnHand: "50.0000", datedSupply: "50.0000", undatedSupply: "0.0000", shortBy: "0.0000" });
  expect(result.producible).toBe("50"); // Forecast readiness never doubles batch waterline.
});
it("paused WO stays visible but cannot create a draft, fee segment or audit", async () => {
  const f = await fixture();
  await db.update(s.woDocs).set({ isPaused: true }).where(eq(s.woDocs.id, f.wo.id));
  expect((await row(f.wo.id)).blockedReason).toContain("暂停");
  const before = await db.select().from(s.auditLogs);
  await expect(createBatchJg(f.actor, f.wo.id, db)).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, f.wo.id))).toHaveLength(0);
  expect(await db.select().from(s.auditLogs)).toEqual(before);
});
it("all eight material constraints are returned, not six basis rows or three blockers", async () => {
  const f = await fixture();
  for (let i = 0; i < 7; i++) {
    const [material] = await db.insert(s.skus).values({ code: `EXTRA-${f.wo.id}-${i}`, name: `附加材料${i}`, spuId: f.spu.id, skuType: "packaging", baseUom: "个" }).returning();
    await db.insert(s.woLines).values({ woId: f.wo.id, materialSkuId: material.id, qtyPer: "1", grossReq: "100", suggestedQty: "100" });
  }
  const result = await row(f.wo.id);
  expect(result.receivedBasis).toHaveLength(8); expect(result.kitBasis).toHaveLength(8); expect(result.kitBlockers).toHaveLength(8);
  expect(new Set(result.kitBasis.map(m => m.materialSkuId)).size).toBe(8);
});
it("shared evidence providers run once for a multi-WO preview; preview writes nothing", async () => {
  await fixture(); await fixture();
  const getStock = vi.spyOn(stock, "getOnHandBySku"), getSupply = vi.spyOn(supply, "getOpenSupplyLines"), getRef = vi.spyOn(reference, "getMaterialReferenceLines");
  const before = await db.select().from(s.auditLogs);
  try {
    const result = await previewAutoChain(db); expect(result.batches.length).toBeGreaterThan(1);
    expect(getStock).toHaveBeenCalledTimes(1); expect(getSupply).toHaveBeenCalledTimes(1); expect(getRef).toHaveBeenCalledTimes(1);
    expect(await db.select().from(s.auditLogs)).toEqual(before);
    expect(await db.select().from(s.stockLedger)).toHaveLength(0);
  } finally { getStock.mockRestore(); getSupply.mockRestore(); getRef.mockRestore(); }
});
it("same material duplicated in the BOM still uses one supply pool and one evidence row", async () => {
  const f = await fixture();
  await db.insert(s.woLines).values({ woId: f.wo.id, materialSkuId: f.material.id, qtyPer: "1", grossReq: "100", suggestedQty: "100" });
  const result = await row(f.wo.id);
  expect(result.kitBasis).toHaveLength(1); expect(result.kitBasis[0].required).toBe("200.0000");
  expect(result.kitBasis[0].poReceived).toBe("50.0000"); expect(result.producible).toBe("25");
  expect(await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "wo"), eq(s.auditLogs.entityId, f.wo.id)))).toHaveLength(0);
});
