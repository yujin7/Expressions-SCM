/**
 * releaseSpus（§4.1）：auto 簇自动建档；review 簇必须人工 override；
 * dry-run 零写入；重放行幂等（committed 行不再入选，跨 job 同簇报 existing）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import { releaseSpus, type ReleaseUser } from "@/server/modules/release/engine";

const pmc: ReleaseUser = { id: 1, name: "放行员", roles: ["pmc"], isApprover: false };

async function newJob(db: TestDb): Promise<number> {
  const [j] = await db
    .insert(schema.importJobs)
    .values({ template: "bom", filename: "t.xlsx", status: "done", createdBy: 1 })
    .returning({ id: schema.importJobs.id });
  return j.id;
}

/** payload 形状复刻 bom-spu.ts SpuCluster */
const autoCluster = {
  spuKey: "N006",
  suggestedName: "烟酰胺焕亮洁面乳",
  members: ["N006-a", "N006-b"],
  confidence: "auto",
  reasons: [],
};
const reviewCluster = {
  spuKey: "E01",
  suggestedName: "水杨酸棉片",
  members: ["E01", "E01-a"],
  confidence: "review",
  reasons: ["同族异名：水杨酸棉片 / 净颜棉片"],
};

describe("releaseSpus", () => {
  it("auto 建档 / review 阻塞 / override 放行 / dry-run 零写入 / 幂等重放", async () => {
    const { db } = await createTestDb();
    const jobId = await newJob(db);
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "spu_suggestion", payload: autoCluster },
      { rowNo: 2, targetTable: "spu_suggestion", payload: reviewCluster },
    ]);

    // dry-run：计数完整，零写入
    const dry = await releaseSpus(pmc, { dryRun: true }, db);
    expect(dry.dryRun).toBe(true);
    expect(dry.created).toHaveLength(1);
    expect(dry.created[0].spuKey).toBe("N006");
    expect(dry.created[0].spuId).toBeNull();
    expect(dry.needsReview).toHaveLength(1);
    expect(dry.needsReview[0].reason).toContain("同族异名");
    expect(await db.select().from(schema.spus)).toHaveLength(0);
    const afterDry = await db.select().from(schema.stagingRows);
    expect(afterDry.every((r) => r.status === "pending")).toBe(true);
    expect(await db.select().from(schema.auditLogs)).toHaveLength(0);

    // 真放行：auto 建档 P00001，review 留待人工
    const run1 = await releaseSpus(pmc, { dryRun: false }, db);
    expect(run1.created).toHaveLength(1);
    expect(run1.created[0].code).toBe("P00001");
    expect(run1.needsReview).toHaveLength(1);
    const spus = await db.select().from(schema.spus);
    expect(spus).toHaveLength(1);
    expect(spus[0].nameCn).toBe("烟酰胺焕亮洁面乳");
    const rows = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.rowNo, 1));
    expect(rows[0].status).toBe("committed");
    expect(rows[0].targetId).toBe(spus[0].id);
    // 审计：1 行/放行批（计数摘要，不逐行）
    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "release_spu"));
    expect(audits).toHaveLength(1);
    expect((audits[0].after as { created: number }).created).toBe(1);

    // 幂等重放：committed 不再入选，review 仍在
    const run2 = await releaseSpus(pmc, { dryRun: false }, db);
    expect(run2.created).toHaveLength(0);
    expect(run2.existing).toBe(0); // review 行非 committed，不算 existing
    expect(run2.needsReview).toHaveLength(1);
    expect(await db.select().from(schema.spus)).toHaveLength(1);

    // review 簇 override accept + 改名
    const run3 = await releaseSpus(
      pmc,
      { overrides: { E01: { action: "accept", nameOverride: "水杨酸净颜棉片" } }, dryRun: false },
      db,
    );
    expect(run3.created).toHaveLength(1);
    expect(run3.created[0].code).toBe("P00002");
    expect(run3.needsReview).toHaveLength(0);
    const all = await db.select().from(schema.spus);
    expect(all.map((s) => s.nameCn)).toContain("水杨酸净颜棉片");
  });

  it("跨 job 同簇报 existing 并指向同一 SPU；mergeInto 并簇；目标未放行则退回", async () => {
    const { db } = await createTestDb();
    const job1 = await newJob(db);
    await writeStagingRows(db, job1, [{ rowNo: 1, targetTable: "spu_suggestion", payload: autoCluster }]);
    const r1 = await releaseSpus(pmc, { dryRun: false }, db);
    const spuId = r1.created[0].spuId!;

    // 新 job 再暂存同簇 → existing，行 committed 指向既有 SPU
    const job2 = await newJob(db);
    await writeStagingRows(db, job2, [{ rowNo: 1, targetTable: "spu_suggestion", payload: autoCluster }]);
    const r2 = await releaseSpus(pmc, { jobIds: [job2], dryRun: false }, db);
    expect(r2.created).toHaveLength(0);
    expect(r2.existing).toBe(1);
    const rows2 = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, job2));
    expect(rows2[0].status).toBe("committed");
    expect(rows2[0].targetId).toBe(spuId);
    expect(await db.select().from(schema.spus)).toHaveLength(1);

    // mergeInto：并入 N006；目标不存在的 merge 退回 needsReview
    const job3 = await newJob(db);
    const mergeCluster = { ...reviewCluster, spuKey: "N006A", members: ["N006A-x"] };
    const orphanCluster = { ...reviewCluster, spuKey: "ZZZ", members: ["ZZZ-1"] };
    await writeStagingRows(db, job3, [
      { rowNo: 1, targetTable: "spu_suggestion", payload: mergeCluster },
      { rowNo: 2, targetTable: "spu_suggestion", payload: orphanCluster },
    ]);
    const r3 = await releaseSpus(
      pmc,
      {
        jobIds: [job3],
        overrides: {
          N006A: { action: "mergeInto", targetSpuKey: "N006" },
          ZZZ: { action: "mergeInto", targetSpuKey: "不存在" },
        },
        dryRun: false,
      },
      db,
    );
    expect(r3.merged).toBe(1);
    expect(r3.created).toHaveLength(0);
    expect(r3.needsReview).toHaveLength(1);
    expect(r3.needsReview[0].reason).toContain("合并目标 SPU 未放行");
    const merged = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, job3));
    const mergedRow = merged.find((r) => r.rowNo === 1)!;
    expect(mergedRow.status).toBe("committed");
    expect(mergedRow.targetId).toBe(spuId);
    expect(merged.find((r) => r.rowNo === 2)!.status).toBe("pending");
    expect(await db.select().from(schema.spus)).toHaveLength(1); // merge 不建新 SPU
  });
});
