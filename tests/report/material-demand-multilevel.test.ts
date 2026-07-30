import { beforeEach, describe, expect, it } from "vitest";
import {
  bomLines,
  boms,
  skus,
  spus,
  suppliers,
  woDocs,
} from "@/db/schema";
import { getMaterialDemand } from "@/server/modules/report/material-demand";
import { todayShanghai } from "@/server/modules/master/common";
import { createTestDb, type TestDb } from "../helpers/db";

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("物料需求：多层 BOM 展开", () => {
  let db: TestDb;

  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it("成品 → 半成品 → 原料只返回末级原料，并逐层计损耗", async () => {
    const [spu] = await db.insert(spus).values({ code: "P-MULTI", nameCn: "多层需求" }).returning();
    const [finished, semi, raw] = await db.insert(skus).values([
      { code: "FG-MULTI", name: "多层成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "SF-MULTI", name: "半成品", spuId: spu.id, skuType: "semi", baseUom: "个" },
      { code: "RM-MULTI", name: "末级原料", spuId: spu.id, skuType: "raw", baseUom: "克" },
    ]).returning();
    const [supplier] = await db.insert(suppliers).values({
      code: "SUP-MULTI",
      name: "多层测试工厂",
    }).returning();
    const [finishedBom, semiBom] = await db.insert(boms).values([
      { productSkuId: finished.id, versionNo: "V1", status: "active" },
      { productSkuId: semi.id, versionNo: "V1", status: "active" },
    ]).returning();
    await db.insert(bomLines).values([
      {
        bomId: finishedBom.id,
        materialSkuId: semi.id,
        qtyPer: "2",
        incomingLossPct: "10",
        productionLossPct: "0",
      },
      {
        bomId: semiBom.id,
        materialSkuId: raw.id,
        qtyPer: "3",
        incomingLossPct: "5",
        productionLossPct: "0",
      },
    ]);
    await db.insert(woDocs).values({
      docNo: "WO-MULTI",
      status: "approved",
      productSkuId: finished.id,
      qty: "100",
      supplierId: supplier.id,
      feeRatePlan: "1",
      bomId: finishedBom.id,
      dueDate: addDays(todayShanghai(), 10),
      createdBy: 1,
    });

    const result = await getMaterialDemand({ pageSize: 50, horizonDays: 90 }, db);
    expect(result.summary.bomIssues).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      code: "RM-MULTI",
      grossReq: "693.0000",
      fromWip: "693.0000",
      fromPlan: "0.0000",
    });
    expect(result.rows.some((row) => row.code === "SF-MULTI")).toBe(false);
  });

  it("存量循环整根阻断并列入摘要，不返回部分末级需求", async () => {
    const [spu] = await db.insert(spus).values({ code: "P-CYCLE", nameCn: "循环需求" }).returning();
    const [finished, semi, raw] = await db.insert(skus).values([
      { code: "FG-CYCLE", name: "循环成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "SF-CYCLE", name: "循环半成品", spuId: spu.id, skuType: "semi", baseUom: "个" },
      { code: "RM-PARTIAL", name: "不应返回的部分原料", spuId: spu.id, skuType: "raw", baseUom: "克" },
    ]).returning();
    const [supplier] = await db.insert(suppliers).values({
      code: "SUP-CYCLE",
      name: "循环测试工厂",
    }).returning();
    const [finishedBom, semiBom] = await db.insert(boms).values([
      { productSkuId: finished.id, versionNo: "V1", status: "active" },
      { productSkuId: semi.id, versionNo: "V1", status: "active" },
    ]).returning();
    await db.insert(bomLines).values([
      { bomId: finishedBom.id, materialSkuId: raw.id, qtyPer: "1" },
      { bomId: finishedBom.id, materialSkuId: semi.id, qtyPer: "1" },
      { bomId: semiBom.id, materialSkuId: finished.id, qtyPer: "1" },
    ]);
    await db.insert(woDocs).values({
      docNo: "WO-CYCLE",
      status: "approved",
      productSkuId: finished.id,
      qty: "100",
      supplierId: supplier.id,
      feeRatePlan: "1",
      bomId: finishedBom.id,
      dueDate: addDays(todayShanghai(), 10),
      createdBy: 1,
    });

    const result = await getMaterialDemand({ pageSize: 50, horizonDays: 90 }, db);
    expect(result.rows).toEqual([]);
    expect(result.summary.bomIssues).toHaveLength(1);
    expect(result.summary.bomIssues[0]).toMatch(/FG-CYCLE.*循环.*FG-CYCLE → SF-CYCLE → FG-CYCLE/);
  });
});
