/**
 * 「导出 → 线下填 → 导回」整条回路（2026-09-04 审计 #2）。
 *
 * 事故形态：`/master/supply-params` 没有导出按钮，唯一的交期适配器 `leadtime.ts`
 * 又绑死两份供应商工作簿的页名与列名。业务既拿不到一张能填的表，
 * 也造不出任何一种系统认的文件——4,856 个缺周期的 SKU 在系统里没有出口。
 *
 * 本测试用**页面导出函数产出的那份 CSV**（`serializeCsv` + 共享表头常量）
 * 当作导入的输入：导出的表原样填完必须能导回来。表头一旦两边分叉，本测试即红。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { serializeCsv } from "@/components/exportCsv";
import {
  SKU_LEADTIME_SIMPLE_TEMPLATE,
  SUPPLY_PARAMS_CSV_HEADERS,
  SUPPLY_PARAMS_CSV_SAMPLE_ROW,
} from "@/lib/supply-params-csv";
import { parseCsv } from "@/server/import/parse/csv";
import { skuLeadtimeSimpleAdapter, stageSkuLeadtimeSimple } from "@/server/import/adapters/sku-leadtime-simple";
import { assertWorkbookMatchesTemplate, IMPORT_TEMPLATES } from "@/server/import/template-contract";
import { releaseSkuLeadtimeSimple } from "@/server/modules/release/engine/sku-leadtime-simple";
import { listSupplyParams } from "@/server/modules/master/sku-supply-params-fill";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

const dir = mkdtempSync(path.join(tmpdir(), "leadtime-simple-"));
let seq = 0;

/** 写一份「页面导出的 CSV」到临时文件——**用的就是页面那支序列化函数** */
function writeExportedCsv(rows: (string | number | null)[][]): string {
  const file = path.join(dir, `周期补录-${++seq}.csv`);
  writeFileSync(file, serializeCsv([...SUPPLY_PARAMS_CSV_HEADERS], rows), "utf8");
  return file;
}

describe("sku_leadtime_simple：导出 → 填写 → 导回", () => {
  it("模板已登记，且导出的 CSV 通过模板指纹校验", async () => {
    expect([...IMPORT_TEMPLATES]).toContain(SKU_LEADTIME_SIMPLE_TEMPLATE);
    const file = writeExportedCsv([["TIER-A", "主力品 A", "A", "", 20, 10, "", "S/A/B 缺加工周期"]]);
    const { readCsvWorkbook } = await import("@/server/import/parse/csv");
    const wb = readCsvWorkbook(file, "周期补录");
    expect(() => assertWorkbookMatchesTemplate(wb, SKU_LEADTIME_SIMPLE_TEMPLATE)).not.toThrow();
  });

  it("CSV 解析：引号、内嵌逗号与换行、BOM、CRLF 都不错位", () => {
    const rows = parseCsv('﻿a,"b,1","x\ny",\r\n1,2,3,4\r\n');
    expect(rows).toEqual([
      ["a", "b,1", "x\ny", null],
      ["1", "2", "3", "4"],
    ]);
  });

  it("适配器按列名取列：调列序、加自定义列都仍能解析", async () => {
    const file = path.join(dir, "reordered.csv");
    writeFileSync(
      file,
      serializeCsv(["备注", "在途周期", "SKU编码", "加工周期"], [["随便写", 10, "TIER-A", 20]]),
      "utf8",
    );
    const res = await skuLeadtimeSimpleAdapter(file);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].payload).toMatchObject({ skuCode: "TIER-A", normalLeadDays: 20, logisticsLeadDays: 10 });
  });

  it("空周期行不产出、缺编码拒收、越界值拒收（不产 NaN、不静默吞）", async () => {
    const file = writeExportedCsv([
      ["TIER-A", "", "", "", 20, "", "", ""],
      ["TIER-B", "", "", "", "", "", "", ""], // 三个周期全空：只是还没填
      ["", "", "", "", 5, "", "", ""], // 缺编码
      ["TIER-C", "", "", "", 999, "", "", ""], // 越界
      ["TIER-NEW", "", "", "", "待确认", "", "", ""], // 脏值 → 视为未填
    ]);
    const res = await skuLeadtimeSimpleAdapter(file);
    expect(res.rows.map((r) => r.payload.skuCode)).toEqual(["TIER-A"]);
    expect(res.stats.blankRows).toBe(2);
    expect(res.rejects.map((r) => r.reason)).toEqual([
      expect.stringContaining("缺少SKU编码"),
      expect.stringContaining("0–365"),
    ]);
  });

  it("往返：导出的行原样填完 → 上传入 staging → 放行写进 sku_params，阻塞清零", async () => {
    const { db } = await createTestDb() as { db: TestDb };
    const w: TierWorld = await seedTierWorld(db);

    // 页面导出的形状（第 5/6/7 列是三个周期），业务把 A、B 的空格填上
    const file = writeExportedCsv([
      ["TIER-A", "主力品 A", "A", "", 20, 10, "", "S/A/B 缺加工周期、在途周期"],
      ["TIER-B", "常规品 B", "B", "", 30, 12, "", "S/A/B 缺在途周期"],
      ["NO-SUCH-CODE", "文件里有、主档没有", "", "", 9, 9, "", ""],
    ]);
    const staged = await stageSkuLeadtimeSimple(db, file, w.pmc.id);
    expect(staged.staged).toBe(3);

    const preview = await releaseSkuLeadtimeSimple(w.pmc, { dryRun: true }, db);
    expect(preview).toMatchObject({ dryRun: true, upserted: 2, filled: 3, overridden: 0, unresolvedSku: 1 });
    // 预演零写入
    const [bBefore] = await db.select().from(schema.skuParams).where(eq(schema.skuParams.skuId, w.sku.B));
    expect(bBefore.logisticsLeadDays).toBeNull();

    const done = await releaseSkuLeadtimeSimple(w.pmc, { dryRun: false }, db);
    expect(done).toMatchObject({ upserted: 2, filled: 3, unresolvedSku: 1 });

    const rows = await db.select().from(schema.skuParams);
    const byId = new Map(rows.map((r) => [r.skuId, r]));
    expect(byId.get(w.sku.A)).toMatchObject({ normalLeadDays: 20, logisticsLeadDays: 10 });
    // B 原有加工 30 未被覆盖（缺省只填空），在途补上 12
    expect(byId.get(w.sku.B)).toMatchObject({ normalLeadDays: 30, logisticsLeadDays: 12 });

    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "release_sku_leadtime_simple"));
    expect(audits, "放行按批次留一条审计").toHaveLength(1);

    // 未解析的行留在 staging 并写明原因，不静默丢
    const stagingRows = await db.select().from(schema.stagingRows);
    const unresolved = stagingRows.find((r) => (r.payload as { skuCode?: string }).skuCode === "NO-SUCH-CODE");
    expect(unresolved?.status).not.toBe("committed");
    expect(unresolved?.errorMsg).toContain("NO-SUCH-CODE");

    const list = await listSupplyParams({}, db);
    expect(list.summary.byDimension.logistics, "在途缺口从 4 降到 2（S 本就有，A/B 已补）").toBe(2);
  });

  it("缺省不覆盖已有值；overwrite=true 才覆盖并单独报数", async () => {
    const { db } = await createTestDb() as { db: TestDb };
    const w: TierWorld = await seedTierWorld(db);
    const file = writeExportedCsv([["TIER-S", "核心品 S", "S", "", 44, 22, "", ""]]);
    await stageSkuLeadtimeSimple(db, file, w.pmc.id);

    const keep = await releaseSkuLeadtimeSimple(w.pmc, { dryRun: true }, db);
    expect(keep).toMatchObject({ upserted: 0, filled: 0, overridden: 0, unchanged: 1 });

    const over = await releaseSkuLeadtimeSimple(w.pmc, { dryRun: false, overwrite: true }, db);
    expect(over).toMatchObject({ upserted: 1, overridden: 2 });
    const [row] = await db.select().from(schema.skuParams).where(eq(schema.skuParams.skuId, w.sku.S));
    expect(row).toMatchObject({ normalLeadDays: 44, logisticsLeadDays: 22 });
  });

  it("同编码值不一致 → 整项阻塞，不猜哪一行是对的", async () => {
    const { db } = await createTestDb() as { db: TestDb };
    const w: TierWorld = await seedTierWorld(db);
    const file = writeExportedCsv([
      ["TIER-A", "", "", "", 20, "", "", ""],
      ["TIER-A", "", "", "", 25, "", "", ""],
    ]);
    await stageSkuLeadtimeSimple(db, file, w.pmc.id);
    const res = await releaseSkuLeadtimeSimple(w.pmc, { dryRun: false }, db);
    expect(res).toMatchObject({ upserted: 0, blocked: 1 });
    expect(await db.select().from(schema.skuParams).where(eq(schema.skuParams.skuId, w.sku.A))).toHaveLength(0);
    const stagingRows = await db.select().from(schema.stagingRows);
    expect(stagingRows.every((r) => r.errorMsg?.includes("值不一致"))).toBe(true);
  });

  it("空白模板的表头与页面导出的表头是同一份（分叉即红）", () => {
    const template = serializeCsv([...SUPPLY_PARAMS_CSV_HEADERS], [[...SUPPLY_PARAMS_CSV_SAMPLE_ROW]]);
    const parsed = parseCsv(template);
    expect(parsed[0]).toEqual([...SUPPLY_PARAMS_CSV_HEADERS]);
    expect(parsed[1]).toHaveLength(SUPPLY_PARAMS_CSV_HEADERS.length);
  });
});
