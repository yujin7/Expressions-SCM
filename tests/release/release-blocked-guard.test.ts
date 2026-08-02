import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import {
  releaseFinishedMoq,
  releaseSkuParams,
} from "@/server/modules/release/engine";
import { commitRows, loadStagedRows } from "@/server/modules/release/engine/common";
import { createTestDb } from "../helpers/db";

describe("releaseBlocked 中央放行闸", () => {
  it("候选行所属任务被标记 releaseBlocked 时大声拒绝，不返回任何行", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "放行闸测试人" }).returning();
    const [normalJob, blockedJob] = await db
      .insert(schema.importJobs)
      .values([
        {
          template: "guard_test",
          filename: "normal.json",
          status: "done",
          scope: { source: "internal", releaseBlocked: false },
          createdBy: actor.id,
        },
        {
          template: "guard_test",
          filename: "jdy-observation.json",
          status: "done",
          scope: { connector: "jdy", mode: "observation-only", releaseBlocked: true },
          createdBy: actor.id,
        },
      ])
      .returning();
    await db.insert(schema.stagingRows).values([
      {
        importJobId: normalJob.id,
        rowNo: 1,
        targetTable: "guard_target",
        payload: { code: "SAFE" },
        status: "validated",
      },
      {
        importJobId: blockedJob.id,
        rowNo: 1,
        targetTable: "guard_target",
        payload: { code: "OBSERVATION-ONLY" },
        status: "validated",
      },
    ]);

    const blockedAttempt = loadStagedRows(db, "guard_target", [normalJob.id, blockedJob.id]);
    await expect(blockedAttempt).rejects.toBeInstanceOf(ApiError);
    await expect(loadStagedRows(db, "guard_target", [blockedJob.id])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("releaseBlocked"),
    });
    await expect(loadStagedRows(db, "guard_target")).rejects.toMatchObject({ status: 409 });

    const safeRows = await loadStagedRows(db, "guard_target", [normalJob.id]);
    expect(safeRows).toHaveLength(1);
    expect(safeRows[0]).toMatchObject({ importJobId: normalJob.id, payload: { code: "SAFE" } });
    expect(safeRows[0]).not.toHaveProperty("importScope");
  });

  it("已拒收或已提交的 releaseBlocked 行不是放行候选，不会误阻其他任务", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "放行状态测试人" }).returning();
    const [normalJob, blockedJob] = await db
      .insert(schema.importJobs)
      .values([
        { template: "guard_test", filename: "normal.json", status: "done", createdBy: actor.id },
        {
          template: "guard_test",
          filename: "blocked-history.json",
          status: "done",
          scope: { releaseBlocked: true },
          createdBy: actor.id,
        },
      ])
      .returning();
    await db.insert(schema.stagingRows).values([
      {
        importJobId: normalJob.id,
        rowNo: 1,
        targetTable: "guard_target",
        payload: { code: "SAFE" },
        status: "pending",
      },
      {
        importJobId: blockedJob.id,
        rowNo: 1,
        targetTable: "guard_target",
        payload: { code: "HISTORY" },
        status: "error",
      },
    ]);

    const rows = await loadStagedRows(db, "guard_target");
    expect(rows).toHaveLength(1);
    expect(rows[0].importJobId).toBe(normalJob.id);
  });

  it("计划读取后任务才被封锁时，commitRows 在写入事务中重新检查并拒绝", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "提交时闸测试人" }).returning();
    const [job] = await db.insert(schema.importJobs).values({
      template: "guard_test",
      filename: "toggle.json",
      status: "done",
      scope: { releaseBlocked: false },
      createdBy: actor.id,
    }).returning();
    const [row] = await db.insert(schema.stagingRows).values({
      importJobId: job.id,
      rowNo: 1,
      targetTable: "guard_target",
      payload: { code: "TOGGLE" },
      status: "validated",
    }).returning();

    expect(await loadStagedRows(db, "guard_target", [job.id])).toHaveLength(1);
    await db.update(schema.importJobs).set({ scope: { releaseBlocked: true } });

    await expect(db.transaction(async (tx) => commitRows(tx, [row.id], null)))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("releaseBlocked") });
    expect((await db.select().from(schema.stagingRows))[0].status).toBe("validated");
  });

  it("sku_leadtime 的两个辅助写引擎也走同一中央闸", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "辅助引擎闸测试人" }).returning();
    const [job] = await db.insert(schema.importJobs).values({
      template: "leadtime",
      filename: "blocked.xlsx",
      status: "done",
      scope: { releaseBlocked: true },
      createdBy: actor.id,
    }).returning();
    await db.insert(schema.stagingRows).values({
      importJobId: job.id,
      rowNo: 1,
      targetTable: "sku_leadtime",
      payload: { skuCode: "SKU-1", normalLeadDays: 30, moq: 100 },
      status: "validated",
    });
    const user = { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false };

    await expect(releaseSkuParams(user, { dryRun: false }, db)).rejects.toMatchObject({ status: 409 });
    await expect(releaseFinishedMoq(user, { dryRun: false }, db)).rejects.toMatchObject({ status: 409 });
  });
});
