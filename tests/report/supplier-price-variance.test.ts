import { beforeAll, describe, expect, it } from "vitest";

import { poDocs, poLines, skus, spus, suppliers, users } from "@/db/schema";
import {
  calculateSupplierPriceVariance,
  getSupplierPriceVariance,
  type PurchasePriceObservation,
} from "@/server/modules/report/supplier-price-variance";
import { createTestDb, type TestDb } from "../helpers/db";

function observation(
  lineId: number,
  supplierId: number,
  skuId: number,
  price: string,
  overrides: Partial<PurchasePriceObservation> = {},
): PurchasePriceObservation {
  return {
    lineId,
    supplierId,
    supplierCode: `SUP-${supplierId}`,
    supplierName: `供应商${supplierId}`,
    skuId,
    skuCode: `SKU-${skuId}`,
    skuName: `物料${skuId}`,
    baseUom: "支",
    qty: "10",
    uomFactor: "10",
    price,
    taxIncluded: true,
    taxRatePct: "13",
    ...overrides,
  };
}

describe("supplier price variance calculator", () => {
  it("normalizes tax and UOM, quantity-weights each supplier, and never nets quantities across SKUs", () => {
    const result = calculateSupplierPriceVariance([
      // SKU 1: supplier 1 base-net prices 10 and 12 -> weighted average 11.
      observation(1, 1, 1, "113.00"),
      observation(2, 1, 1, "135.60"),
      observation(3, 2, 1, "113.00"), // supplier 2 benchmark 10
      // SKU 2: premiums 30% and 0%; supplier 1 cross-SKU median = (10 + 30) / 2 = 20.
      observation(4, 1, 2, "146.90"),
      observation(5, 2, 2, "113.00"),
    ]);

    expect(result.rows).toHaveLength(4);
    expect(result.rows.find((row) => row.key === "1:1")).toMatchObject({
      averageBaseNetPrice: "11.00",
      benchmarkBaseNetPrice: "10.00",
      variancePct: "10.00",
      orderedBaseQty: "200.0000",
      lineCount: 2,
      isBenchmark: false,
    });
    expect(result.supplierSummary.find((row) => row.supplierId === 1)).toMatchObject({
      comparableSkuCount: 2,
      aboveBenchmarkSkuCount: 2,
      medianVariancePct: "20.00",
    });
  });

  it("excludes invalid and single-supplier samples and discloses coverage", () => {
    const result = calculateSupplierPriceVariance([
      observation(1, 1, 1, "113.00"),
      observation(2, 2, 1, "113.00"),
      observation(3, 1, 2, "113.00"), // only one supplier for SKU 2
      observation(4, 1, 3, "0"),
      observation(5, 1, 4, "113.00", { uomFactor: "0" }),
    ]);
    expect(result.counts).toEqual({
      inputLineCount: 5,
      validLineCount: 3,
      comparableLineCount: 2,
      excludedInvalidLineCount: 2,
      singleSupplierLineCount: 1,
      comparableSkuCount: 1,
      comparableSupplierCount: 2,
      coveragePct: "40.00",
    });
  });
});

describe("supplier price variance read model", () => {
  let db: TestDb;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({ name: "采购", roles: ["purchasing"] }).returning();
    const [supplierA, supplierB] = await db.insert(suppliers).values([
      { code: "PV-A", name: "价格供应商A", kinds: ["raw"], status: "qualified" },
      { code: "PV-B", name: "价格供应商B", kinds: ["raw"], status: "qualified" },
    ]).returning();
    const [spu] = await db.insert(spus).values({ code: "PV-SPU", nameCn: "价格偏差测试" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "PV-SKU",
      name: "同口径原料",
      spuId: spu.id,
      baseUom: "支",
      skuType: "raw",
    }).returning();
    const [poA, poB] = await db.insert(poDocs).values([
      { docNo: "PO-PV-A", status: "approved", supplierId: supplierA.id, createdBy: user.id, createdAt: new Date("2026-08-01T04:00:00.000Z") },
      { docNo: "PO-PV-B", status: "completed", supplierId: supplierB.id, createdBy: user.id, createdAt: new Date("2026-08-02T04:00:00.000Z") },
    ]).returning();
    await db.insert(poLines).values([
      { poId: poA.id, skuId: sku.id, lineType: "raw", purchaseUom: "箱", qty: "10", uomFactor: "10", price: "124.30", taxIncluded: true, taxRatePct: "13" },
      { poId: poB.id, skuId: sku.id, lineType: "raw", purchaseUom: "箱", qty: "10", uomFactor: "10", price: "113.00", taxIncluded: true, taxRatePct: "13" },
    ]);
  });

  it("returns only effective in-window PO lines and keeps authority gates fail-closed", async () => {
    const result = await getSupplierPriceVariance({
      q: "价格供应商A",
      page: 1,
      pageSize: 20,
      windowDays: 30,
      asOf: new Date("2026-08-14T04:00:00.000Z"),
    }, db);
    expect(result.total).toBe(1);
    expect(result.supplierSummary).toEqual([
      expect.objectContaining({
        supplierCode: "PV-A",
        comparableSkuCount: 1,
        medianVariancePct: "10.00",
      }),
    ]);
    expect(result.rows[0]).toMatchObject({
      supplierCode: "PV-A",
      skuCode: "PV-SKU",
      averageBaseNetPrice: "11.00",
      benchmarkBaseNetPrice: "10.00",
      variancePct: "10.00",
    });
    expect(result.summary).toMatchObject({
      inputLineCount: 2,
      comparableLineCount: 2,
      comparableSkuCount: 1,
      comparableSupplierCount: 2,
      coveragePct: "100.00",
      asOf: "2026-08-14",
    });
    expect(result.readiness).toMatchObject({
      level: "observation",
      decisionReady: false,
      currencyState: "system_default_not_line_level",
      yonyouSupplierIdentityState: "uat_required",
    });
    expect(result.readiness.blockers).toHaveLength(2);
  });
});
