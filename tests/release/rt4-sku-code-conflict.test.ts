/**
 * rt4 审计验证②③：releaseSkus 编码冲突两案。
 * ② 同一编码同时以成品与物料身份出现（半成品场景）：dry-run 报「可创建」，
 *    真放行却在事务内撞 skus.code UNIQUE → 整批 500 崩溃（非按行阻塞）——dry-run 与提交结果背离。
 * ③ sku_code 别名已认领到既有主档 A 时，releaseSkus 按 skus.code 精确匹配（不查别名）
 *    另建新主档 B：同一原始编码在 BOM/费用链路绑 B、在批次/月销/快照链路绑 A——双主档分叉。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import {
  releaseBatchStocks,
  releaseSkus,
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
  it("② 同码既是成品又是物料：dry-run 报成功，真放行整批崩溃（unique violation，无行级阻塞）", async () => {
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

    // dry-run：同一编码 X01-a 同时进入成品与物料计划，createdCodes 出现两次——无任何冲突提示
    const dry = await releaseSkus(pmc, { dryRun: true }, db);
    // RT4-F5 修复后：同码成品∩物料转行级阻塞，两侧撤出计划
    expect(dry.createdCodes.filter((c) => c === "X01-a")).toHaveLength(0);
    expect(dry.blocked.some((b) => b.code === "X01-a")).toBe(true);

    // 真放行：事务内撞 skus.code UNIQUE → 整个放行批次异常终止（零行落库）
    const real = await releaseSkus(pmc, { dryRun: false }, db);
    expect(real.blocked.some((b) => b.code === "X01-a")).toBe(true);
    // 冲突码之外的建档正常落库，事务不再整批崩溃
    const skus = await db.select().from(schema.skus);
    expect(skus.every((k: { code: string }) => k.code !== "X01-a")).toBe(true);
  });

  it("③ 别名已认领到主档 A，releaseSkus 仍按码另建主档 B：批次效期绑 A、BOM 链路绑 B（双主档分叉）", async () => {
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
    const skuRes = await releaseSkus(pmc, { dryRun: false }, db);
    expect(skuRes.createdFinished).toBe(0); // RT4-F6 修复后：别名裁决优先，不再分叉建档
    expect(skuRes.existing).toBeGreaterThanOrEqual(1);

    const [skuB] = await db.select().from(schema.skus).where(eq(schema.skus.code, "N1-x"));
    expect(skuB).toBeUndefined(); // 不再另建 N1-x 主档

    const batchRes = await releaseBatchStocks(pmc, { dryRun: false }, db);
    expect(batchRes.created).toBe(1);
    const [bs] = await db.select().from(schema.batchStocks);
    // 分叉证明：批次效期按别名绑到 A，而 BOM/费用链路（loadSkuIdByCode）将绑到 B
    expect(bs.skuId).toBe(skuA.id); // 批次与 BOM/费用同指裁决主档 A
  });
});
