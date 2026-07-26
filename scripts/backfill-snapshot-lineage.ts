/**
 * 将旧版 populate 生成、但缺 importJobId 的库存快照绑定回唯一库存导入任务。
 *
 * 默认 dry-run；--apply 只回填可由现有证据唯一证明的血缘：
 * - 唯一 done + okRows>0 的 inventory_long_721 job；
 * - 唯一 bizDate 的 legacy stock_snapshots；
 * - 该 job 的 staging 全部 committed。
 *
 * 不重算数量、不改仓库/SKU、不触碰账本。
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { dAdd, dQty } from "../src/server/core/decimal";

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const apply = process.argv.includes("--apply");
  const db = await getDbAsync();

  const jobs = await db
    .select()
    .from(schema.importJobs)
    .where(and(
      eq(schema.importJobs.template, "inventory_long_721"),
      eq(schema.importJobs.status, "done"),
      gt(schema.importJobs.okRows, 0),
    ));
  if (jobs.length !== 1) {
    throw new Error(`无法唯一确定库存导入任务：命中 ${jobs.length} 个`);
  }
  const job = jobs[0];

  const legacy = await db
    .select({
      bizDate: schema.stockSnapshots.bizDate,
      rows: sql<number>`count(*)::int`,
      qty: sql<string>`sum(${schema.stockSnapshots.qty})`,
    })
    .from(schema.stockSnapshots)
    .where(isNull(schema.stockSnapshots.importJobId))
    .groupBy(schema.stockSnapshots.bizDate);
  if (legacy.length !== 1) {
    throw new Error(`无法唯一确定 legacy 快照批次：命中 ${legacy.length} 个业务日期`);
  }

  const staging = await db
    .select({ status: schema.stagingRows.status, payload: schema.stagingRows.payload })
    .from(schema.stagingRows)
    .where(eq(schema.stagingRows.importJobId, job.id));
  if (staging.length !== job.okRows || staging.some((row) => row.status !== "committed")) {
    throw new Error(
      `导入任务 #${job.id} staging 证据不完整：committed ${staging.filter((row) => row.status === "committed").length}/${job.okRows}`,
    );
  }
  const controlQty = staging.reduce((sum, row) => {
    const qty = (row.payload as { qty?: unknown }).qty;
    return typeof qty === "number" && Number.isFinite(qty) ? dAdd(sum, qty, 4) : sum;
  }, "0.0000");

  let updatedSnapshots = 0;
  if (apply) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.stockSnapshots)
        .set({ importJobId: job.id })
        .where(and(
          isNull(schema.stockSnapshots.importJobId),
          eq(schema.stockSnapshots.bizDate, legacy[0].bizDate),
        ))
        .returning({ id: schema.stockSnapshots.id });
      updatedSnapshots = updated.length;
      await tx
        .update(schema.importJobs)
        .set({
          sourceAsOf: legacy[0].bizDate,
          schemaVersion: "inventory-long-v2",
          scope: {
            mode: "full",
            target: "stock_snapshots",
            bizDate: legacy[0].bizDate,
            legacyReleaseEvidence: {
              committedStagingRows: staging.length,
              snapshotRows: legacy[0].rows,
            },
          },
          controlRows: staging.length,
          controlQty: dQty(controlQty),
        })
        .where(eq(schema.importJobs.id, job.id));
    });
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    target: {
      importJobId: job.id,
      filename: job.filename,
      fileHash: job.fileHash,
      snapshotBizDate: legacy[0].bizDate,
      legacySnapshotRows: legacy[0].rows,
    },
    controls: {
      committedStagingRows: staging.length,
      sourceControlQty: dQty(controlQty),
      snapshotQty: dQty(legacy[0].qty),
    },
    updatedSnapshots,
    recovery:
      `Set stock_snapshots.import_job_id back to NULL for biz_date ${legacy[0].bizDate} and restore job #${job.id} legacy metadata if reversal is required.`,
  }, null, 2));
}

void main();
