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
  woLines,
} from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";
import { previewAutoChain } from "@/server/modules/outsource/auto-chain";
import { createTestDb, type TestDb } from "../helpers/db";

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("D33 自动链的旧包材旁证", () => {
  let db: TestDb;
  let woId = 0;
  let referenceDate = "";

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const today = todayShanghai();
    referenceDate = addDays(today, 8);
    const [spu] = await db.insert(spus).values({ code: "P-ACREF", nameCn: "自动链参考" }).returning();
    const [product, material] = await db
      .insert(skus)
      .values([
        { code: "FG-ACREF", name: "自动链成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
        { code: "PK-ACREF", name: "自动链包材", spuId: spu.id, skuType: "packaging", baseUom: "个" },
      ])
      .returning();
    const [supplier] = await db.insert(suppliers).values({ code: "SUP-ACREF", name: "自动链供应商" }).returning();
    const [warehouse] = await db
      .insert(warehouses)
      .values({ code: "WH-ACREF", name: "自动链包材仓", kind: "packaging" })
      .returning();
    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: product.id, versionNo: "V1", status: "active" })
      .returning();
    await db.insert(bomLines).values({ bomId: bom.id, materialSkuId: material.id, qtyPer: "1" });
    const [wo] = await db.insert(woDocs).values({
      docNo: "WO-ACREF",
      status: "approved",
      productSkuId: product.id,
      qty: "100",
      supplierId: supplier.id,
      feeRatePlan: "1",
      bomId: bom.id,
      createdBy: 1,
    }).returning();
    woId = wo.id;
    await db.insert(woLines).values({
      woId: wo.id,
      materialSkuId: material.id,
      qtyPer: "1",
      grossReq: "100",
      suggestedQty: "100",
    });
    await db.insert(stockBalances).values({ skuId: material.id, warehouseId: warehouse.id, qty: "10" });
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-ACREF",
      status: "in_progress",
      woId: wo.id,
      supplierId: supplier.id,
      createdBy: 1,
    }).returning();
    await db.insert(poLines).values({
      poId: po.id,
      skuId: material.id,
      lineType: "packaging",
      purchaseUom: "个",
      uomFactor: "1",
      qty: "50",
      receivedQty: "50",
      price: "1",
    });
    await db.insert(transitRefs).values({
      kind: "pkg_order",
      skuId: product.id,
      materialSkuId: material.id,
      qty: "90",
      replyDate: referenceDate,
      externalNo: "LEGACY-ACREF",
      sourceJobId: 1,
    });
  });

  it("展示参考齐套日，但系统齐套、可产与建议仍只由系统事实决定", async () => {
    const result = await previewAutoChain(db);
    const batch = result.batches.find((row) => row.woId === woId);
    expect(batch).toBeDefined();
    expect(batch).toMatchObject({
      producible: 50,
      suggestQty: 50,
      kitDate: null,
      referenceKitDate: referenceDate,
      referenceEvidenceCount: 1,
      referenceReservedQty: "0.0000",
    });
    expect(batch?.referenceKitNote).toContain("不驱动自动批次");
  });
});
