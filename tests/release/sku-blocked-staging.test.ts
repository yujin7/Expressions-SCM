/**
 * releaseSkus 阻塞原因写回 staging 行（红队第五轮）：
 * blocked[] 不再只留在响应里——非 dry 事务内把每个受阻编码的贡献行 errorMsg 落
 * 「SKU 放行受阻：<code>（<reason>）」（多码合并、≤3 码 + 「等」），
 * 复核清单（releaseStatus.blockedReasons）由此可见；dry-run 零写入不变。
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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

function line(over: Partial<Record<string, unknown>>) {
  return {
    materialCode: null, materialName: "", materialSpec: "", texture: "",
    qtyPer: 1, qtyPerRaw: "1", uomGuess: "count", supplierRaw: "", segment: "uncoded",
    ...over,
  };
}
function block(over: Partial<Record<string, unknown>>) {
  return {
    sheet: "S1", brandCode: "NING", productCode: null, productName: "", productSpec: "",
    versionMarker: "none", barcode: null, ambiguous: false, lines: [], feeLines: [],
    ...over,
  };
}

describe("releaseSkus 阻塞原因写回 staging 行", () => {
  it("segment=unknown 物料受阻 → 贡献行 errorMsg 落地；dry-run 不写；未受阻行不触碰", async () => {
    const { db } = await createTestDb();
    const jobId = await newJob(db);
    await writeStagingRows(db, jobId, [
      {
        rowNo: 1,
        targetTable: "spu_suggestion",
        payload: { spuKey: "N010", suggestedName: "N010品", members: ["N010-a", "N011-b"], confidence: "auto", reasons: [] },
      },
      // 行 2：含一个未知段位物料 → 该行应落阻塞消息（产品与好料照常建档）
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({
          productCode: "N010-a",
          productName: "N010品",
          lines: [
            line({ materialCode: "N010-a-0101", materialName: "好料", segment: "raw_bulk" }),
            line({ materialCode: "XYZ-1", materialName: "神秘件", segment: "unknown" }),
          ],
        }),
      },
      // 行 3：全部可建档 → errorMsg 保持空
      {
        rowNo: 3,
        targetTable: "bom_block",
        payload: block({
          productCode: "N011-b",
          productName: "N011品",
          lines: [line({ materialCode: "N011-b-0101", materialName: "净料", segment: "raw_bulk" })],
        }),
      },
    ]);
    await releaseSpus(pmc, { dryRun: false }, db);

    // dry-run：blocked 报告但零写入
    const dry = await releaseSkusLegacy(pmc, { dryRun: true }, db);
    expect(dry.blocked.some((b) => b.code === "XYZ-1")).toBe(true);
    const rowsAfterDry = await db
      .select()
      .from(schema.stagingRows)
      .where(and(eq(schema.stagingRows.importJobId, jobId), eq(schema.stagingRows.targetTable, "bom_block")));
    expect(rowsAfterDry.every((r) => r.errorMsg == null)).toBe(true);

    // 真放行：受阻码的贡献行 errorMsg 落地
    const run = await releaseSkusLegacy(pmc, { dryRun: false }, db);
    expect(run.blocked).toContainEqual({
      code: "XYZ-1",
      kind: "material",
      reason: "物料段位无法判定（segment=unknown）",
    });

    const [row2] = await db
      .select()
      .from(schema.stagingRows)
      .where(and(eq(schema.stagingRows.importJobId, jobId), eq(schema.stagingRows.rowNo, 2)));
    expect(row2.errorMsg).toBe("SKU 放行受阻：XYZ-1（物料段位无法判定（segment=unknown））");
    expect(row2.status).toBe("pending"); // 仍待处置——原因可见、不拒收

    const [row3] = await db
      .select()
      .from(schema.stagingRows)
      .where(and(eq(schema.stagingRows.importJobId, jobId), eq(schema.stagingRows.rowNo, 3)));
    expect(row3.errorMsg).toBeNull(); // 无受阻码的行不触碰

    // 建档不受影响：产品与两个好料均已建
    const skus = await db.select().from(schema.skus);
    expect(skus.map((s) => s.code).sort()).toEqual(["N010-a", "N010-a-0101", "N011-b", "N011-b-0101"]);
  });

  it("同行多码受阻 → 合并一条消息，≤3 码 + 「等」封顶", async () => {
    const { db } = await createTestDb();
    const jobId = await newJob(db);
    await writeStagingRows(db, jobId, [
      {
        rowNo: 1,
        targetTable: "spu_suggestion",
        payload: { spuKey: "M01", suggestedName: "M01品", members: ["M01-a"], confidence: "auto", reasons: [] },
      },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({
          productCode: "M01-a",
          productName: "M01品",
          lines: [
            line({ materialCode: "U-1", materialName: "u1", segment: "unknown" }),
            line({ materialCode: "U-2", materialName: "u2", segment: "unknown" }),
            line({ materialCode: "U-3", materialName: "u3", segment: "unknown" }),
            line({ materialCode: "U-4", materialName: "u4", segment: "unknown" }),
          ],
        }),
      },
    ]);
    await releaseSpus(pmc, { dryRun: false }, db);
    const run = await releaseSkusLegacy(pmc, { dryRun: false }, db);
    expect(run.blocked).toHaveLength(4);

    const [row] = await db
      .select()
      .from(schema.stagingRows)
      .where(and(eq(schema.stagingRows.importJobId, jobId), eq(schema.stagingRows.rowNo, 2)));
    expect(row.errorMsg).toMatch(/^SKU 放行受阻：/);
    expect(row.errorMsg).toMatch(/等$/); // 4 码 → 3 码 + 等
    // 只列 3 个码
    expect((row.errorMsg!.match(/U-\d/g) ?? []).length).toBe(3);
  });
});
