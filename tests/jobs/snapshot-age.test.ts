/** 真实 PGlite 只读快照健康契约；整组共享一个合成数据库，不触碰运行库。 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { runSnapshotAgeAlert, SNAPSHOT_AGE_THRESHOLD_DAYS } from "@/jobs/snapshot-age";
import { readSnapshotAges, type SnapshotAgeOptions } from "@/server/core/snapshot-age";

const TODAY = "2026-07-24";

describe("runSnapshotAgeAlert shared latest-date evidence", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    fixture = await createTestDb();
    const { db } = fixture;
    const [spu] = await db.insert(schema.spus).values({ code: "QA-AGE-SPU", nameCn: "合成快照测试" }).returning();
    const [sku] = await db.insert(schema.skus).values({ code: "QA-AGE-SKU", spuId: spu.id, baseUom: "个", skuType: "finished" }).returning();
    // 故意不按编码插入：相同缺失/陈旧程度不能依赖数据库自然返回顺序。
    const [stale, fresh, missingZ, missingA, boundary, staleZ, staleA, current, future, invalid, off, realtime] = await db
      .insert(schema.warehouses).values([
        { code: "WH-STALE-5", name: "五天", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-FRESH", name: "两天", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-MISSING-Z", name: "缺失Z", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-MISSING-A", name: "缺失A", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-BOUNDARY", name: "三天", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-STALE-4Z", name: "四天Z", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-STALE-4A", name: "四天A", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-CURRENT", name: "今日零量", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-FUTURE", name: "未来日期", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-INVALID", name: "异常日期", kind: "snapshot", accountingMode: "snapshot" },
        { code: "WH-OFF", name: "停用仓", kind: "snapshot", accountingMode: "snapshot", active: false },
        { code: "WH-REALTIME", name: "实时仓", kind: "finished", accountingMode: "realtime" },
      ]).returning();
    expect(missingA.id).toBeGreaterThan(missingZ.id);
    await db.insert(schema.stockSnapshots).values([
      { warehouseId: stale.id, skuId: sku.id, bizDate: "2026-07-10", qty: "1" },
      { warehouseId: stale.id, skuId: sku.id, bizDate: "2026-07-19", qty: "2" },
      { warehouseId: fresh.id, skuId: sku.id, bizDate: "2026-07-22", qty: "3" },
      { warehouseId: boundary.id, skuId: sku.id, bizDate: "2026-07-21", qty: "1" },
      { warehouseId: staleZ.id, skuId: sku.id, bizDate: "2026-07-20", qty: "1" },
      { warehouseId: staleA.id, skuId: sku.id, bizDate: "2026-07-20", qty: "1" },
      { warehouseId: current.id, skuId: sku.id, bizDate: TODAY, qty: "0" },
      { warehouseId: future.id, skuId: sku.id, bizDate: TODAY, qty: "1" },
      { warehouseId: future.id, skuId: sku.id, bizDate: "2026-07-25", qty: "1" },
      // PostgreSQL 的合法特殊 date 值不是有效业务日；MAX 必须保留异常，不回退旧行。
      { warehouseId: invalid.id, skuId: sku.id, bizDate: TODAY, qty: "1" },
      { warehouseId: invalid.id, skuId: sku.id, bizDate: "infinity", qty: "1" },
      { warehouseId: off.id, skuId: sku.id, bizDate: "infinity", qty: "1" },
      { warehouseId: realtime.id, skuId: sku.id, bizDate: "2026-07-01", qty: "1" },
    ]);
  });

  afterAll(async () => { await fixture?.client.close(); });

  it("缺失/异常/未来都告警，陈旧按龄降序，同类同龄按编码稳定排列", async () => {
    const result = await runSnapshotAgeAlert(fixture.db, { today: TODAY });
    expect(result.today).toBe(TODAY);
    expect(result.thresholdDays).toBe(SNAPSHOT_AGE_THRESHOLD_DAYS);
    expect(result.alertCount).toBe(7);
    expect(result.alerts.map(({ code, ageDays, ageState }) => [code, ageDays, ageState])).toEqual([
      ["WH-MISSING-A", null, "missing"],
      ["WH-MISSING-Z", null, "missing"],
      ["WH-INVALID", null, "invalid"],
      ["WH-FUTURE", -1, "future"],
      ["WH-STALE-5", 5, "stale"],
      ["WH-STALE-4A", 4, "stale"],
      ["WH-STALE-4Z", 4, "stale"],
    ]);
    expect(await runSnapshotAgeAlert(fixture.db, { today: TODAY })).toEqual(result);
  });

  it("真正取MAX：未来/特殊日期不被较旧的新鲜行掩盖；缺失不转零", async () => {
    const result = await runSnapshotAgeAlert(fixture.db, { today: TODAY });
    expect(result.alerts.find((row) => row.code === "WH-FUTURE")).toMatchObject({ latestBizDate: "2026-07-25", ageDays: -1, ageState: "future" });
    expect(result.alerts.find((row) => row.code === "WH-INVALID")).toMatchObject({ ageDays: null, ageState: "invalid" });
    expect(result.alerts.find((row) => row.code === "WH-STALE-5")).toMatchObject({ latestBizDate: "2026-07-19", ageDays: 5 });
    expect(result.alerts.find((row) => row.code === "WH-MISSING-A")).toMatchObject({ latestBizDate: null, ageDays: null, ageState: "missing" });
  });

  it("保持默认严格>3：3天与零量今日快照新鲜，4天陈旧；实时/停用仓不参与", async () => {
    const { rows } = await readSnapshotAges(fixture.db, { today: TODAY });
    expect(rows).toHaveLength(10);
    expect(rows.find((row) => row.code === "WH-BOUNDARY")).toMatchObject({ ageDays: 3, ageState: "fresh" });
    expect(rows.find((row) => row.code === "WH-CURRENT")).toMatchObject({ ageDays: 0, ageState: "fresh" });
    expect(rows.find((row) => row.code === "WH-STALE-4A")).toMatchObject({ ageDays: 4, ageState: "stale" });
    expect(rows.some((row) => ["WH-OFF", "WH-REALTIME"].includes(row.code))).toBe(false);
    expect(rows.map((row) => row.code)).toEqual(rows.map((row) => row.code).sort());
  });

  it("自定阈值仍用严格>；放宽阈值不会把缺失/未来/异常洗成正常", async () => {
    const loose = await runSnapshotAgeAlert(fixture.db, { today: TODAY, thresholdDays: 5 });
    expect(loose.alerts.map((row) => row.code)).toEqual(["WH-MISSING-A", "WH-MISSING-Z", "WH-INVALID", "WH-FUTURE"]);
    const strict = await runSnapshotAgeAlert(fixture.db, { today: TODAY, thresholdDays: 1 });
    expect(strict.alerts.find((row) => row.code === "WH-FRESH")).toMatchObject({ ageDays: 2, ageState: "stale" });
    const zero = await runSnapshotAgeAlert(fixture.db, { today: TODAY, thresholdDays: 0 });
    expect(zero.alerts.some((row) => row.code === "WH-CURRENT")).toBe(false);
  });

  it("重复读取不改快照/主档/库存账/告警/审计/作业记录", async () => {
    const { db } = fixture;
    const state = async () => ({
      warehouses: await db.select().from(schema.warehouses),
      snapshots: await db.select().from(schema.stockSnapshots),
      balances: await db.select().from(schema.stockBalances),
      ledger: await db.select().from(schema.stockLedger),
      alerts: await db.select().from(schema.systemAlerts),
      audits: await db.select().from(schema.auditLogs),
      jobs: await db.select().from(schema.jobRuns),
    });
    const before = await state();
    await runSnapshotAgeAlert(db, { today: TODAY });
    await readSnapshotAges(db, { today: TODAY, thresholdDays: 1 });
    expect(await state()).toEqual(before);
  });
});

describe("snapshot age options reject before querying", () => {
  it.each(["2026/7/24", "2026-02-30", "2025-02-29", "2026-13-01", "2026-04-31", "2026-07-24 ", "", "infinity", null, 0])(
    "拒绝非法业务日 %s（包括形状合法但日历无效）", async (today) => {
      const select = vi.fn();
      const opts = { today } as unknown as SnapshotAgeOptions;
      await expect(runSnapshotAgeAlert({ select }, opts)).rejects.toThrow("today 须为有效业务日");
      expect(select).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null])("拒绝非法阈值 %s", async (thresholdDays) => {
    const select = vi.fn();
    const opts = { today: TODAY, thresholdDays } as unknown as SnapshotAgeOptions;
    await expect(runSnapshotAgeAlert({ select }, opts)).rejects.toThrow("thresholdDays 须为非负安全整数");
    expect(select).not.toHaveBeenCalled();
  });
});
