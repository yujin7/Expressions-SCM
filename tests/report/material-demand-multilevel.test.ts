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

  it("间接共用半成品的末级原料按成品根计数，不按直接父 BOM 少算", async () => {
    const [spu] = await db.insert(spus).values({ code: "P-SHARED", nameCn: "间接共用" }).returning();
    const [finishedA, finishedB, semi, raw] = await db.insert(skus).values([
      { code: "FG-SHARED-A", name: "成品A", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "FG-SHARED-B", name: "成品B", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "SF-SHARED", name: "共用半成品", spuId: spu.id, skuType: "semi", baseUom: "个" },
      { code: "RM-SHARED", name: "共用原料", spuId: spu.id, skuType: "raw", baseUom: "克" },
    ]).returning();
    const heads = await db.insert(boms).values([
      { productSkuId: finishedA.id, versionNo: "V1", status: "active" },
      { productSkuId: finishedB.id, versionNo: "V1", status: "active" },
      { productSkuId: semi.id, versionNo: "V1", status: "active" },
    ]).returning();
    await db.insert(bomLines).values([
      { bomId: heads[0].id, materialSkuId: semi.id, qtyPer: "1" },
      { bomId: heads[1].id, materialSkuId: semi.id, qtyPer: "1" },
      { bomId: heads[2].id, materialSkuId: raw.id, qtyPer: "1" },
    ]);
    const [supplier] = await db.insert(suppliers).values({
      code: "SUP-SHARED",
      name: "间接共用工厂",
    }).returning();
    // 只有 A 有当前需求，sharedCount 仍应反映全量 active where-used 的 A+B。
    await db.insert(woDocs).values({
      docNo: "WO-SHARED",
      status: "approved",
      productSkuId: finishedA.id,
      qty: "10",
      supplierId: supplier.id,
      feeRatePlan: "1",
      bomId: heads[0].id,
      dueDate: addDays(todayShanghai(), 10),
      createdBy: 1,
    });
    const result = await getMaterialDemand({ pageSize: 50, horizonDays: 90 }, db);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ code: "RM-SHARED", sharedCount: 2 });
  });

  it("异常深度整根阻断时摘要包含可操作的 SKU 编码路径", async () => {
    const [spu] = await db.insert(spus).values({ code: "P-RDEP", nameCn: "报表深度" }).returning();
    const chain = await db.insert(skus).values(
      Array.from({ length: 35 }, (_, index) => ({
        code: `RDEP-${String(index).padStart(2, "0")}`,
        name: `报表深度节点${index}`,
        spuId: spu.id,
        skuType: index === 0 ? "finished" as const : index === 34 ? "raw" as const : "semi" as const,
        baseUom: "个",
      })),
    ).returning();
    const heads = await db.insert(boms).values(
      chain.slice(0, -1).map((product) => ({
        productSkuId: product.id,
        versionNo: "V1",
        status: "active" as const,
      })),
    ).returning();
    await db.insert(bomLines).values(
      heads.map((head, index) => ({
        bomId: head.id,
        materialSkuId: chain[index + 1].id,
        qtyPer: "1",
      })),
    );
    const [supplier] = await db.insert(suppliers).values({
      code: "SUP-RDEP",
      name: "深度测试工厂",
    }).returning();
    await db.insert(woDocs).values({
      docNo: "WO-RDEP",
      status: "approved",
      productSkuId: chain[0].id,
      qty: "1",
      supplierId: supplier.id,
      feeRatePlan: "1",
      bomId: heads[0].id,
      dueDate: addDays(todayShanghai(), 10),
      createdBy: 1,
    });

    const result = await getMaterialDemand({ pageSize: 50, horizonDays: 90 }, db);
    expect(result.rows).toEqual([]);
    expect(result.summary.bomIssues).toHaveLength(1);
    expect(result.summary.bomIssues[0]).toMatch(
      /RDEP-00：层级超过安全上限 RDEP-00 → RDEP-01.*RDEP-33/,
    );
  });
});
