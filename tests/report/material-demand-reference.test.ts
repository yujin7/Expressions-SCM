import { beforeAll, describe, expect, it } from "vitest";
import {
  bomLines,
  boms,
  poDocs,
  poLines,
  skus,
  spus,
  stockBalances,
  suppliers,
  transitRefs,
  warehouses,
  woDocs,
} from "@/db/schema";
import { getMaterialDemand } from "@/server/modules/report/material-demand";
import { todayShanghai } from "@/server/modules/master/common";
import { createTestDb, type TestDb } from "../helpers/db";

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("物料需求中的旧包材旁证", () => {
  let db: TestDb;
  let referenceEta = "";

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const today = todayShanghai();
    referenceEta = addDays(today, 10);
    const [spu] = await db.insert(spus).values({ code: "P-MDREF", nameCn: "物料需求参考" }).returning();
    const [product, otherProduct, material] = await db
      .insert(skus)
      .values([
        { code: "FG-MDREF", name: "需求成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
        { code: "FG-OTHER", name: "其他成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
        { code: "PK-MDREF", name: "共用包材", spuId: spu.id, skuType: "packaging", baseUom: "个" },
      ])
      .returning();
    const [supplier] = await db.insert(suppliers).values({ code: "SUP-MDREF", name: "测试供应商" }).returning();
    const [warehouse] = await db
      .insert(warehouses)
      .values({ code: "WH-MDREF", name: "包材仓", kind: "packaging" })
      .returning();
    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: product.id, versionNo: "V1", status: "active" })
      .returning();
    await db.insert(bomLines).values({
      bomId: bom.id,
      materialSkuId: material.id,
      qtyPer: "1",
      incomingLossPct: "0",
      productionLossPct: "0",
    });
    await db.insert(woDocs).values({
      docNo: "WO-MDREF",
      status: "approved",
      productSkuId: product.id,
      qty: "100",
      supplierId: supplier.id,
      feeRatePlan: "1",
      bomId: bom.id,
      dueDate: addDays(today, 20),
      createdBy: 1,
    });
    await db.insert(stockBalances).values({
      skuId: material.id,
      warehouseId: warehouse.id,
      qty: "10",
    });
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-MDREF",
      status: "approved",
      supplierId: supplier.id,
      expectedDate: addDays(today, 5),
      createdBy: 1,
    }).returning();
    await db.insert(poLines).values({
      poId: po.id,
      skuId: material.id,
      lineType: "packaging",
      purchaseUom: "个",
      uomFactor: "1",
      qty: "20",
      price: "1",
    });
    await db.insert(transitRefs).values([
      {
        kind: "pkg_order",
        skuId: product.id,
        materialSkuId: material.id,
        qty: "80",
        replyDate: referenceEta,
        externalNo: "LEGACY-MATCH",
        sourceJobId: 1,
      },
      {
        kind: "pkg_stock",
        skuId: product.id,
        materialSkuId: material.id,
        remainQty: "5",
        approvalNo: "LEGACY-STOCK",
        sourceJobId: 1,
      },
      {
        kind: "pkg_order",
        skuId: otherProduct.id,
        materialSkuId: material.id,
        qty: "40",
        replyDate: addDays(today, 3),
        externalNo: "LEGACY-OTHER",
        sourceJobId: 1,
      },
    ]);
  });

  it("系统净需求只扣实时账和系统 PO，旧台账另列且不改变建议采购量", async () => {
    const result = await getMaterialDemand({ pageSize: 50, horizonDays: 90 }, db);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row).toMatchObject({
      code: "PK-MDREF",
      grossReq: "100.0000",
      onHand: "10.0000",
      inTransit: "20.0000",
      netReq: "70.0000",
      suggestQty: "70.0000",
      referenceInTransit: "80.0000",
      referenceReserved: "5.0000",
      referenceUnallocated: "40.0000",
      referenceAwareGap: "0.0000",
      systemEta: null,
      referenceEta,
      referenceEvidenceCount: 2,
    });
  });

  it("只把成品归属匹配的参考行计入旁证，并报告覆盖与时点", async () => {
    const result = await getMaterialDemand({ pageSize: 50, horizonDays: 90 }, db);
    expect(result.summary.referenceMatchedLines).toBe(2);
    expect(result.summary.referenceMaterialCount).toBe(1);
    expect(result.summary.referenceAsOf).toMatch(/T/);
    expect(result.summary.shortageCount).toBe(1);
  });
});
