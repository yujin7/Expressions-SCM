/**
 * stageBom 集成测试（PGlite）：createImportJob → 解析 → 维度别名排队 → staging 写入 → finalize。
 * 用真实 DEVIANCE（最小 41 sheets）+ EXPRESSIONS（含拒收行，验证 error 车道）。
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { stageBom } from "@/server/import/adapters/bom";
import type { DimDb } from "@/server/modules/dimension/resolver";

const DEV = "/Users/yj/Desktop/SCM/【DEVIANCE】产品bom表.xlsx";
const EXP = "/Users/yj/Desktop/SCM/【EXPRESSIONS】产品bom表.xlsx";

describe.runIf(existsSync(DEV))("stageBom：DEVIANCE 全量入 staging", () => {
  it("块/加工费候选/SPU 建议入 staging，品牌+供应商 OEM 入异常队列，job 收口", async () => {
    const { db } = await createTestDb();
    const dimDb = db as unknown as DimDb;
    const { jobId, result, stagedRows } = await stageBom(dimDb, DEV, "DEV", 1);

    const [job] = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, jobId));
    expect(job.template).toBe("bom");
    expect(job.status).toBe("done");
    expect(job.fileHash).toBeTruthy();
    expect(job.scope).toMatchObject({ identityMode: "historical_preserve" });
    expect(job.failRows).toBe(result.rejects.length);
    expect(job.okRows + job.failRows).toBe(stagedRows);

    const rows = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, jobId));
    expect(rows).toHaveLength(stagedRows);
    const byTable = new Map<string, number>();
    for (const r of rows) byTable.set(r.targetTable ?? "?", (byTable.get(r.targetTable ?? "?") ?? 0) + 1);
    expect(byTable.get("bom_block")).toBe(result.blocks.length + result.rejects.length);
    expect(byTable.get("spu_suggestion")).toBeGreaterThan(0);
    expect(byTable.get("processing_fee_candidate")).toBeGreaterThan(0);
    // 加工费候选 ≤ 加工费行数（按 产品编码×供应商 聚合去重）
    expect(byTable.get("processing_fee_candidate")!).toBeLessThanOrEqual(result.stats.feeLines);

    // 块 payload 完整性抽查
    const blockRow = rows.find((r) => r.targetTable === "bom_block" && r.status === "pending");
    const payload = blockRow!.payload as { brandCode: string; lines: unknown[] };
    expect(payload.brandCode).toBe("DEV");
    expect(Array.isArray(payload.lines)).toBe(true);

    // 维度：品牌未认领 → 异常队列；供应商 OEM（美丽链接等）排队且去重
    const exceptions = await db.select().from(schema.aliasExceptions);
    expect(exceptions.some((e) => e.aliasType === "brand" && e.rawValue === "DEV")).toBe(true);
    const oem = exceptions.filter((e) => e.aliasType === "supplier_oem");
    expect(oem.length).toBeGreaterThan(0);
    expect(oem.some((e) => e.rawValue.includes("美丽链接"))).toBe(true);
    expect(oem.every((e) => e.rawValue !== "/" && e.rawValue !== "")).toBe(true);
    expect(new Set(oem.map((e) => e.rawValue)).size).toBe(oem.length);
  }, 60000);
});

describe.runIf(existsSync(EXP))("stageBom：EXPRESSIONS 拒收车道", () => {
  it("拒收行以 status=error 入 staging，errorMsg=分类原因", async () => {
    const { db } = await createTestDb();
    const dimDb = db as unknown as DimDb;
    const { jobId, result } = await stageBom(dimDb, EXP, "EXP", 1, "new_master");
    expect(result.rejects.length).toBeGreaterThan(0);

    const rows = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, jobId));
    const errors = rows.filter((r) => r.status === "error");
    expect(errors).toHaveLength(result.rejects.length);
    expect(errors.map((e) => e.errorMsg)).toContain("工艺未确认");
    expect(errors.map((e) => e.errorMsg)).toContain("裸短数字");

    const [job] = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, jobId));
    expect(job.failRows).toBe(result.rejects.length);
    expect(job.scope).toMatchObject({ identityMode: "new_master" });
  }, 60000);
});
