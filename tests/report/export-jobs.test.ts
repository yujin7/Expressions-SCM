/**
 * 异步导出任务（UAT 缺口 #4）：
 * - worker 快乐路径：认领 pending → 生成 CSV 文件 → done + rowCount；
 * - 失败路径：未知 kind → failed + error（不复取）；
 * - 同步闸门：>5000 行自动建异步任务，≤5000 行放行；
 * - createExportJob 校验 kind 并写审计。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import {
  claimNextExportJob, createExportJob, listExportJobs, runExportWorkerOnce, syncExportGate,
} from "@/jobs/export-worker";
import { SYNC_EXPORT_MAX } from "@/server/modules/report/export";

async function seedBase(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [user] = await db
    .insert(schema.users)
    .values({ username: "wh01", name: "仓管丙", roles: ["warehouse"] })
    .returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P00001", nameCn: "产品甲" }).returning();
  const [sku] = await db
    .insert(schema.skus)
    .values({ code: "BC00001", name: "SKU甲", spuId: spu.id, baseUom: "个", skuType: "finished" })
    .returning();
  const [wh] = await db
    .insert(schema.warehouses)
    .values({ code: "WH1", name: "成品仓", kind: "finished" })
    .returning();
  await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "5" });
  return { user, sku, wh };
}

describe("createExportJob / claim", () => {
  it("未知 kind 建任务被拒；合法 kind 入队并写审计", async () => {
    const { db } = await createTestDb();
    const { user } = await seedBase(db);
    await expect(createExportJob(user, "nope", {}, db)).rejects.toThrow("未知导出类型");

    const job = await createExportJob(user, "balance", { q: "" }, db);
    expect(job.status).toBe("pending");
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "export_job"));
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("create");
    expect(logs[0].entityId).toBe(job.id);

    const claimed = await claimNextExportJob(db);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
    expect(await claimNextExportJob(db)).toBeNull(); // 不重复认领
  });
});

describe("runExportWorkerOnce", () => {
  it("快乐路径：balance 导出 → done + rowCount + CSV 文件（BOM/标题/数据行）", async () => {
    const { db } = await createTestDb();
    const { user } = await seedBase(db);
    const dir = mkdtempSync(path.join(tmpdir(), "export-test-"));
    const job = await createExportJob(user, "balance", {}, db);

    const res = await runExportWorkerOnce(db, dir);
    expect(res).toMatchObject({ id: job.id, status: "done", rowCount: 1 });

    const [row] = await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id));
    expect(row.status).toBe("done");
    expect(row.rowCount).toBe(1);
    expect(row.finishedAt).not.toBeNull();
    expect(row.filePath).toContain(`${job.id}-balance.csv`);

    const csv = readFileSync(row.filePath!, "utf8");
    expect(csv.startsWith("﻿")).toBe(true); // Excel 直开不乱码的 BOM
    expect(csv).toContain("SKU编码");
    expect(csv).toContain("BC00001");
    expect(csv).toContain("5");

    expect(await runExportWorkerOnce(db, dir)).toBeNull(); // 队列已空
  });

  it("失败路径：未知 kind（越过服务校验直插）→ failed + error，且不再被认领", async () => {
    const { db } = await createTestDb();
    const { user } = await seedBase(db);
    await db.insert(schema.exportJobs).values({ kind: "nope", params: {}, requestedBy: user.id });

    const res = await runExportWorkerOnce(db);
    expect(res?.status).toBe("failed");
    expect(res?.error).toContain("未知导出类型");

    const [row] = await db.select().from(schema.exportJobs);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("未知导出类型");
    expect(row.finishedAt).not.toBeNull();
    expect(await claimNextExportJob(db)).toBeNull();
  });

  it("申请人已停用 → failed（按当前 DB 身份执行，防越权兜底）", async () => {
    const { db } = await createTestDb();
    const { user } = await seedBase(db);
    const job = await createExportJob(user, "balance", {}, db);
    await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, user.id));
    const res = await runExportWorkerOnce(db);
    expect(res).toMatchObject({ id: job.id, status: "failed" });
  });
});

describe("syncExportGate（>5000 行走异步）", () => {
  it("total=5001 → 自动建任务返回 jobId；total=5000 → null 不建任务", async () => {
    const { db } = await createTestDb();
    const { user } = await seedBase(db);

    const under = await syncExportGate(user, "ledger", {}, SYNC_EXPORT_MAX, db);
    expect(under).toBeNull();

    const over = await syncExportGate(user, "ledger", { skuId: 1 }, SYNC_EXPORT_MAX + 1, db);
    expect(over).not.toBeNull();
    const [row] = await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, over!.jobId));
    expect(row.kind).toBe("ledger");
    expect(row.status).toBe("pending");
    expect(row.params).toEqual({ skuId: 1 });
    expect(row.requestedBy).toBe(user.id);
  });
});

describe("listExportJobs", () => {
  it("普通用户仅见自己的任务；admin 见全部", async () => {
    const { db } = await createTestDb();
    const { user } = await seedBase(db);
    const [other] = await db
      .insert(schema.users)
      .values({ username: "adm", name: "管理员丁", roles: ["admin"] })
      .returning();
    await createExportJob(user, "balance", {}, db);
    await createExportJob(other, "ledger", {}, db);

    const mine = await listExportJobs({ id: user.id, roles: ["warehouse"] }, db);
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe("balance");
    expect(mine[0].requestedByName).toBe("仓管丙");

    const all = await listExportJobs({ id: other.id, roles: ["admin"] }, db);
    expect(all).toHaveLength(2);
    expect(all[0].kind).toBe("ledger"); // 最新在前
  });
});
