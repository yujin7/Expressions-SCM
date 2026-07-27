import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { stageSkuCost } from "@/server/import/adapters/sku-cost";
import { writeStagingRows } from "@/server/import/staging";
import {
  releaseSkuCosts,
  type ReleaseUser,
} from "@/server/modules/release/engine";
import { createTestDb } from "../helpers/db";

const finance: ReleaseUser = {
  id: 1,
  name: "财务",
  roles: ["finance"],
  isApprover: true,
};
const pmc: ReleaseUser = {
  id: 2,
  name: "计划",
  roles: ["pmc"],
  isApprover: true,
};

async function writeCostWorkbook(rows: (string | number)[][]): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "sku-cost-stage-"));
  const file = path.join(dir, "sku-cost.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("成本");
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(file);
  return file;
}

async function seedSku(db: Awaited<ReturnType<typeof createTestDb>>["db"], code: string) {
  const [spu] = await db
    .insert(schema.spus)
    .values({ code: `P-${code}`, nameCn: `${code} 产品` })
    .returning();
  const [sku] = await db
    .insert(schema.skus)
    .values({
      code,
      name: `${code} 产品`,
      spuId: spu.id,
      skuType: "finished",
      baseUom: "件",
    })
    .returning();
  await db.insert(schema.aliases).values({
    aliasType: "sku_code",
    rawValue: code,
    targetId: sku.id,
  });
  return sku;
}

describe("SKU 成本 staging 与财务放行", () => {
  it("上传只进入 staging；预演零写入，PMC 无权覆盖，财务执行才原子落库并审计", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values([
      { id: finance.id, name: finance.name },
      { id: pmc.id, name: pmc.name },
    ]);
    const sku = await seedSku(db, "EXP-001");
    const file = await writeCostWorkbook([
      ["商家编码", "单位成本"],
      ["EXP-001", 12.34567],
      ["UNKNOWN-001", 9.5],
      ["EXP-001", -1],
    ]);

    const staged = await stageSkuCost(db, file, finance.id);
    expect(staged).toMatchObject({
      staged: 2,
      validated: 1,
      pending: 1,
      rejected: 1,
    });
    expect(await db.select().from(schema.skuCosts)).toHaveLength(0);

    await expect(
      releaseSkuCosts(pmc, { jobIds: [staged.jobId], dryRun: false }, db),
    ).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.skuCosts)).toHaveLength(0);

    const preview = await releaseSkuCosts(
      finance,
      { jobIds: [staged.jobId], dryRun: true },
      db,
    );
    expect(preview).toMatchObject({
      dryRun: true,
      upserted: 1,
      unresolvedSku: 1,
      conflictingSku: 0,
    });
    expect(preview.blocked).toHaveLength(1);
    expect(await db.select().from(schema.skuCosts)).toHaveLength(0);

    const result = await releaseSkuCosts(
      finance,
      { jobIds: [staged.jobId], dryRun: false },
      db,
    );
    expect(result).toMatchObject({ dryRun: false, upserted: 1, unresolvedSku: 1 });
    const costs = await db.select().from(schema.skuCosts);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      skuId: sku.id,
      unitCost: "12.3457",
      updatedBy: finance.id,
      currency: "CNY",
    });

    const rows = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, staged.jobId));
    expect(rows.filter((row) => row.status === "committed")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "error")).toHaveLength(1);
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entity, "release_sku_cost"));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toEqual(
      expect.objectContaining({ upserted: 1, unresolvedSku: 1 }),
    );
  });

  it("同一 SKU 在单个文件内出现不同成本时整项阻塞，不采用最后一行", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({ id: finance.id, name: finance.name });
    await seedSku(db, "EXP-002");
    const [job] = await db
      .insert(schema.importJobs)
      .values({
        template: "sku_cost",
        filename: "conflict.xlsx",
        status: "done",
        controlRows: 3,
        createdBy: finance.id,
        scope: { mode: "full", targetKinds: ["sku_cost"] },
      })
      .returning({ id: schema.importJobs.id });
    await writeStagingRows(db, job.id, [
      {
        rowNo: 1,
        targetTable: "sku_cost",
        payload: { skuCode: "EXP-002", unitCost: "10.0000" },
        status: "validated",
      },
      {
        rowNo: 2,
        targetTable: "sku_cost",
        payload: { skuCode: "EXP-002", unitCost: "12.0000" },
        status: "validated",
      },
      {
        rowNo: 3,
        targetTable: "sku_cost",
        payload: { skuCode: "EXP-002", unitCost: "10.0000" },
        status: "validated",
      },
    ]);

    const preview = await releaseSkuCosts(
      finance,
      { jobIds: [job.id], dryRun: true },
      db,
    );
    expect(preview).toMatchObject({
      upserted: 0,
      conflictingSku: 1,
      unresolvedSku: 0,
    });
    expect(preview.blocked).toHaveLength(3);
    expect(new Set(preview.blocked.map((row) => row.stagingRowId))).toHaveProperty(
      "size",
      3,
    );

    await releaseSkuCosts(finance, { jobIds: [job.id], dryRun: false }, db);
    expect(await db.select().from(schema.skuCosts)).toHaveLength(0);
    const rows = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, job.id));
    expect(rows.every((row) => row.status === "validated")).toBe(true);
    expect(rows.every((row) => row.errorMsg?.includes("互相矛盾"))).toBe(true);
  });
});
