import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { poDocs, poLines, poPromiseRevisions, qcLines, qcRecords, shDocs, shLines, skus, spus, suppliers, warehouses } from "@/db/schema";
import { loadPromiseReliability } from "@/server/modules/report/supply-commitment";
import { getSupplierScorecard } from "@/server/modules/report/supplier-scorecard";
import { createTestDb, type TestDb } from "../helpers/db";

describe("采购收货身份贯穿承诺报表和供应商评分", () => {
  let db: TestDb;
  let lateShLineId: number;
  let supplierId: number;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [supplier] = await db.insert(suppliers).values({ code: "SUP-LINE-BI", name: "逐行履约供应商" }).returning();
    supplierId = supplier.id;
    const [spu] = await db.insert(spus).values({ code: "SPU-LINE-BI", nameCn: "逐行测试" }).returning();
    const [sku] = await db.insert(skus).values({ code: "YL-LINE-BI", name: "同码原料", spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    const [warehouse] = await db.insert(warehouses).values({ code: "WH-LINE-BI", name: "逐行仓", kind: "raw" }).returning();
    const [po] = await db.insert(poDocs).values({ docNo: "PO-LINE-BI", supplierId, createdBy: 1, status: "completed", createdAt: new Date("2026-08-01T00:00:00Z") }).returning();
    for (const [index, receivedDay] of ["2026-08-02", "2026-08-08"].entries()) {
      const [line] = await db.insert(poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", uomFactor: "1", qty: "10", price: "1", receivedQty: "10", expectedDate: "2026-08-05" }).returning();
      await db.insert(poPromiseRevisions).values({ poId: po.id, poLineId: line.id, sequence: 1, previousDate: null, promisedDate: "2026-08-05", source: "supplier_confirm", actorType: "supplier_token", idempotencyKey: `line-bi:${line.id}` });
      const [sh] = await db.insert(shDocs).values({ docNo: `SH-LINE-BI-${index}`, sourceType: "po", sourceId: po.id, status: "completed", warehouseId: warehouse.id, createdBy: 1, createdAt: new Date(`${receivedDay}T00:00:00Z`) }).returning();
      const [shLine] = await db.insert(shLines).values({ shId: sh.id, poLineId: line.id, skuId: sku.id, actualQty: "10" }).returning();
      if (index === 1) lateShLineId = shLine.id;
      const [qc] = await db.insert(qcRecords).values({ shId: sh.id, conclusion: "pass", createdBy: 1, createdAt: new Date(`${receivedDay}T00:00:00Z`) }).returning();
      await db.insert(qcLines).values({ qcId: qc.id, shLineId: shLine.id, passQty: "10", failQty: "0", concessionQty: "0" });
    }
  });

  it("显式第二行的迟到不能被第一行的早到覆盖", async () => {
    const report = await loadPromiseReliability({ asOf: "2026-08-10" }, db);
    expect(report.totals).toMatchObject({ eligibleLines: 2, ambiguous: 0, onTimeInFull: 1, lateFull: 1 });
    expect(report.originalRate).toBe(50);
    const card = await getSupplierScorecard({ windowDays: 1095 }, db);
    const row = card.rows.find(r => r.supplierId === supplierId)!;
    expect(row).toMatchObject({ onTimeSampleN: 2, onTimeHitN: 1, onTimeRate: 0.5, onTimeRateCurrent: 0.5 });
  });

  it("混入旧歧义收货时两行均排除，评分明确披露而不猜归属", async () => {
    await db.update(shLines).set({ poLineId: null }).where(eq(shLines.id, lateShLineId));
    const report = await loadPromiseReliability({ asOf: "2026-08-10" }, db);
    expect(report.totals).toMatchObject({ eligibleLines: 0, ambiguous: 2 });
    expect(report.originalRate).toBeNull();
    const card = await getSupplierScorecard({ windowDays: 1095 }, db);
    const row = card.rows.find(r => r.supplierId === supplierId)!;
    expect(row).toMatchObject({ onTimeSampleN: 0, onTimeRate: null, onTimeRateCurrent: null });
    expect(row.reason).toContain("采购行归属");
  });
});
