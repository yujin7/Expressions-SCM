/**
 * releaseSkus：成品+物料建档（类型/损耗品类/baseUom 打标不猜测）；
 * SPU 未放行阻塞；无编码物料列人工队列；已存在编码跳过；dry-run 零写入。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import {
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

/** 物料行形状复刻 bom.ts BomLine */
function line(over: Partial<Record<string, unknown>>) {
  return {
    materialCode: null,
    materialName: "",
    materialSpec: "",
    texture: "",
    qtyPer: 1,
    qtyPerRaw: "1",
    uomGuess: "count",
    supplierRaw: "",
    segment: "uncoded",
    ...over,
  };
}

/** 块形状复刻 bom.ts BomBlock */
function block(over: Partial<Record<string, unknown>>) {
  return {
    sheet: "S1",
    brandCode: "NING",
    productCode: null,
    productName: "",
    productSpec: "",
    versionMarker: "none",
    barcode: null,
    ambiguous: false,
    lines: [],
    feeLines: [],
    ...over,
  };
}

describe("releaseSkus", () => {
  it("成品/物料正确建档并打标；SPU 未放行与未知段位阻塞；无编码列队；重放报 existing", async () => {
    const { db } = await createTestDb();
    // 品牌 + 别名认领
    const [brand] = await db.insert(schema.brands).values({ code: "NING", nameCn: "宁" }).returning();
    await db.insert(schema.aliases).values({ aliasType: "brand", rawValue: "NING", targetId: brand.id });

    const jobId = await newJob(db);
    const blockA = block({
      productCode: "N006-a",
      productName: "烟酰胺洁面乳",
      productSpec: "100g",
      barcode: "6971234567890",
      lines: [
        line({ materialCode: "N006-a-0101", materialName: "膏体", qtyPer: 0.1, qtyPerRaw: "0.1", uomGuess: "gram_ml", supplierRaw: "ZYT", segment: "raw_bulk" }),
        line({ materialCode: "N006-a-0201", materialName: "软管", uomGuess: "count", supplierRaw: "XZ", segment: "primary_pack" }),
        line({ materialName: "合格证贴纸", segment: "uncoded" }), // 无编码 → 人工建档队列
        line({ materialCode: "XYZ-123", materialName: "神秘件", segment: "unknown" }), // 未知段位 → 阻塞
      ],
    });
    const blockB = block({
      productCode: "E01-b",
      productName: "净颜棉片",
      brandCode: "EXP",
      lines: [line({ materialCode: "E01-b-0101", materialName: "棉片基材", segment: "raw_bulk" })],
    });
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "bom_block", payload: blockA },
      { rowNo: 2, targetTable: "bom_block", payload: blockB },
      {
        rowNo: 3,
        targetTable: "spu_suggestion",
        payload: { spuKey: "N006", suggestedName: "烟酰胺洁面乳", members: ["N006-a"], confidence: "auto", reasons: [] },
      },
      // 名称交叉核对源（stock_opening_candidate）
      {
        rowNo: 4,
        targetTable: "stock_opening_candidate",
        payload: { warehouseRaw: "1仓", brandRaw: "NING", skuCode: "N006-a", skuName: "烟酰胺洁面乳(新包装)", qty: 10 },
      },
    ]);
    await releaseSpus(pmc, { dryRun: false }, db);

    // dry-run：完整计数，零写入
    const dry = await releaseSkusLegacy(pmc, { dryRun: true }, db);
    expect(dry.dryRun).toBe(true);
    expect(dry.createdFinished).toBe(1);
    expect(dry.createdMaterials).toBe(2);
    expect(await db.select().from(schema.skus)).toHaveLength(0);

    // 真放行
    const run = await releaseSkusLegacy(pmc, { dryRun: false }, db);
    expect(run.createdFinished).toBe(1);
    expect(run.createdMaterials).toBe(2);
    expect(run.blocked).toContainEqual({ code: "E01-b", kind: "finished", reason: "SPU 未放行" });
    expect(run.blocked.some((b) => b.code === "E01-b-0101" && b.reason.includes("SPU 未放行"))).toBe(true);
    expect(run.blocked.some((b) => b.code === "XYZ-123" && b.reason.includes("段位"))).toBe(true);
    expect(run.uncoded).toContainEqual({ name: "合格证贴纸", occurrences: 1 });
    expect(run.nameCrossCheck).toContainEqual({
      code: "N006-a",
      bomName: "烟酰胺洁面乳",
      openingName: "烟酰胺洁面乳(新包装)",
    });

    const skus = await db.select().from(schema.skus);
    expect(skus).toHaveLength(3);
    const finished = skus.find((s) => s.code === "N006-a")!;
    expect(finished.skuType).toBe("finished");
    expect(finished.baseUom).toBe("件"); // BOM 文件无基础单位——占位+打标，不静默猜
    expect((finished.attrs as { needsReview: string[] }).needsReview).toContain("baseUom");
    expect(finished.barcode).toBe("6971234567890");
    expect(finished.brandId).toBe(brand.id);
    expect(finished.lifecycle).toBe("on_sale");
    const spu = (await db.select().from(schema.spus))[0];
    expect(finished.spuId).toBe(spu.id);

    const raw = skus.find((s) => s.code === "N006-a-0101")!;
    expect(raw.skuType).toBe("raw");
    expect(raw.lossCategory).toBe("raw");
    expect(raw.baseUom).toBe("g");
    expect((raw.attrs as { needsReview: string[] }).needsReview).toContain("baseUom");
    expect(raw.spuId).toBe(spu.id); // v1 决策：物料挂父成品 SPU

    const pack = skus.find((s) => s.code === "N006-a-0201")!;
    expect(pack.skuType).toBe("packaging");
    expect(pack.lossCategory).toBe("packaging");
    expect(pack.baseUom).toBe("个");
    expect((pack.attrs as { needsReview: string[] }).needsReview).toHaveLength(0); // 全 count 不打标

    // 幂等重放：全部 existing，不重建
    const rerun = await releaseSkusLegacy(pmc, { dryRun: false }, db);
    expect(rerun.createdFinished).toBe(0);
    expect(rerun.createdMaterials).toBe(0);
    expect(rerun.existing).toBe(3);
    expect(await db.select().from(schema.skus)).toHaveLength(3);
  });
});
