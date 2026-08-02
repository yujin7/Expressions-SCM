/**
 * RT4-F5/F6 回归保护：
 * ② 同一编码同时以成品与物料身份出现时按行阻塞，不让 UNIQUE 冲突终止整批放行。
 * ③ sku_code 别名已认领既有主档时复用裁决结果，不另建重复主档。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import {
  releaseBatchStocks,
  releaseSkusForLegacyLocalMigration as releaseSkusLegacy,
  releaseSpus,
  type ReleaseUser,
} from "@/server/modules/release/engine";

const pmc: ReleaseUser = { id: 1, name: "放行员", roles: ["pmc"], isApprover: false };

async function newJob(db: TestDb): Promise<number> {
  const [j] = await db
    .insert(schema.importJobs)
    .values({ template: "bom", filename: "t.xlsx", status: "done", createdBy: 1 })
    .returning({ id: schema.importJobs.id });
  return j.id;
}

function line(over: Partial<Record<string, unknown>>) {
  return {
    materialCode: null, materialName: "", materialSpec: "", texture: "",
    qtyPer: 1, qtyPerRaw: "1", uomGuess: "count", supplierRaw: "", segment: "raw_bulk",
    ...over,
  };
}
function block(over: Partial<Record<string, unknown>>) {
  return {
    sheet: "S1", brandCode: "", productCode: null, productName: "品", productSpec: "",
    versionMarker: "none", barcode: null, ambiguous: false, lines: [], feeLines: [],
    ...over,
  };
}
const cluster = (key: string, members: string[]) => ({
  spuKey: key, suggestedName: `${key}品`, members, confidence: "auto", reasons: [],
});

describe("rt4: releaseSkus 编码冲突", () => {
  it("② 同码既是成品又是物料：dry-run 与真放行均按行阻塞，其他编码继续处理", async () => {
    const { db } = await createTestDb();
    const jobId = await newJob(db);
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "spu_suggestion", payload: cluster("X01", ["X01-a"]) },
      { rowNo: 2, targetTable: "spu_suggestion", payload: cluster("Y01", ["Y01-a"]) },
      // X01-a 是成品……
      {
        rowNo: 3,
        targetTable: "bom_block",
        payload: block({
          productCode: "X01-a", productName: "半成品X",
          lines: [line({ materialCode: "X01-a-0101", materialName: "料体" })],
        }),
      },
      // ……同时又是 Y01-a 的物料（半成品作为下级物料——真实 BOM 常见）
      {
        rowNo: 4,
        targetTable: "bom_block",
        payload: block({
          productCode: "Y01-a", productName: "成品Y",
          lines: [line({ materialCode: "X01-a", materialName: "半成品X" })],
        }),
      },
    ]);
    await releaseSpus(pmc, { dryRun: false }, db);

    const dry = await releaseSkusLegacy(pmc, { dryRun: true }, db);
    // RT4-F5：同码成品∩物料转行级阻塞，两侧撤出计划。
    expect(dry.createdCodes.filter((c) => c === "X01-a")).toHaveLength(0);
    expect(dry.blocked.some((b) => b.code === "X01-a")).toBe(true);

    const real = await releaseSkusLegacy(pmc, { dryRun: false }, db);
    expect(real.blocked.some((b) => b.code === "X01-a")).toBe(true);
    // 冲突码之外的建档正常落库，事务不再整批崩溃
    const skus = await db.select().from(schema.skus);
    expect(skus.every((k: { code: string }) => k.code !== "X01-a")).toBe(true);
  });

  it("③ 别名已认领到主档 A：放行复用 A，批次与 BOM 链路不分叉", async () => {
    const { db } = await createTestDb();
    // 人工已裁决：原始编码 N1-x 是既有主档 A（code=OLD-X）的别名
    const [spuA] = await db.insert(schema.spus).values({ code: "P00001", nameCn: "既有品" }).returning();
    const [skuA] = await db
      .insert(schema.skus)
      .values({ code: "OLD-X", name: "既有品", spuId: spuA.id, skuType: "finished", baseUom: "件" })
      .returning();
    await db.insert(schema.aliases).values({ aliasType: "sku_code", rawValue: "N1-x", targetId: skuA.id });
    const [wh] = await db
      .insert(schema.warehouses)
      .values({ code: "W1", name: "保税仓", kind: "finished" })
      .returning();
    await db.insert(schema.aliases).values({ aliasType: "warehouse", rawValue: "保税仓", targetId: wh.id });

    const jobId = await newJob(db);
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "spu_suggestion", payload: cluster("N1", ["N1-x"]) },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({
          productCode: "N1-x", productName: "新品x",
          lines: [line({ materialCode: "N1-x-0101", materialName: "料体" })],
        }),
      },
      {
        rowNo: 3,
        targetTable: "batch_stock",
        payload: {
          sheetWarehouse: "保税仓", skuCode: "N1-x", prodDate: "2026-01-01",
          expiryDate: "2029-01-01", qty: 7, stocktakeDate: "2026-07-01",
        },
      },
    ]);
    await releaseSpus(pmc, { dryRun: false }, db);
    const skuRes = await releaseSkusLegacy(pmc, { dryRun: false }, db);
    expect(skuRes.createdFinished).toBe(0); // RT4-F6 修复后：别名裁决优先，不再分叉建档
    expect(skuRes.existing).toBeGreaterThanOrEqual(1);

    const [skuB] = await db.select().from(schema.skus).where(eq(schema.skus.code, "N1-x"));
    expect(skuB).toBeUndefined(); // 不再另建 N1-x 主档

    const batchRes = await releaseBatchStocks(pmc, { dryRun: false }, db);
    expect(batchRes.created).toBe(1);
    const [bs] = await db.select().from(schema.batchStocks);
    expect(bs.skuId).toBe(skuA.id); // 批次与 BOM/费用同指裁决主档 A。
  });
});
