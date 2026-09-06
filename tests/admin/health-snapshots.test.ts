import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { getOpsHealth, getSnapshotAges, snapshotAgeEvidence, SNAPSHOT_AGE_RED_DAYS } from "@/server/modules/admin/health";
import { readSnapshotAges, snapshotAgeEvidence as sharedSnapshotAgeEvidence, SNAPSHOT_AGE_THRESHOLD_DAYS } from "@/server/core/snapshot-age";
import { runSnapshotAgeAlert } from "@/jobs/snapshot-age";
import { createTestDb } from "../helpers/db";

const TODAY = "2026-09-06";

describe("operational snapshot latest-date evidence", () => {
  it("保持3天严格大于阈值，零天不是缺失，未来日不是新鲜", () => {
    expect(SNAPSHOT_AGE_RED_DAYS).toBe(3);
    expect(SNAPSHOT_AGE_RED_DAYS).toBe(SNAPSHOT_AGE_THRESHOLD_DAYS);
    expect(snapshotAgeEvidence).toBe(sharedSnapshotAgeEvidence);
    expect(snapshotAgeEvidence(TODAY, TODAY)).toEqual({ latestBizDate: TODAY, ageDays: 0, ageState: "fresh" });
    expect(snapshotAgeEvidence("2026-09-03", TODAY)).toMatchObject({ ageDays: 3, ageState: "fresh" });
    expect(snapshotAgeEvidence("2026-09-02", TODAY)).toMatchObject({ ageDays: 4, ageState: "stale" });
    expect(snapshotAgeEvidence("2026-09-07", TODAY)).toMatchObject({ ageDays: -1, ageState: "future" });
    expect(snapshotAgeEvidence(null, TODAY)).toEqual({ latestBizDate: null, ageDays: null, ageState: "missing" });
  });

  it.each([undefined, "", " ", "2026-02-30", "2026-13-01", "2026/09/06", "2026-09-06T00:00:00Z", "infinity", "-infinity", 0, NaN])(
    "异常日期 %s 保留未知年龄，不转零或负数绿灯", (latest) => {
      const result = snapshotAgeEvidence(latest, TODAY);
      expect(result).toMatchObject({ ageDays: null, ageState: "invalid" });
      expect(JSON.stringify(result)).not.toContain("NaN");
    },
  );

  it.each(["2026-02-30", "bad", "2026-09-06T00:00:00Z"])("非法参照日 %s 不能得出新鲜结论", (today) => {
    expect(snapshotAgeEvidence(TODAY, today)).toMatchObject({ ageDays: null, ageState: "invalid" });
  });

  it.each(["2026-02-30", "2026-13-01", "2025-02-29", "", "2026-09-06 "])("运维读取拒绝非法参照日 %s 且不查询", async (today) => {
    const select = vi.fn();
    await expect(getSnapshotAges({ select }, today)).rejects.toThrow("today 须为有效业务日");
    expect(select).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("底层证据不把非法阈值 %s 当作新鲜", (thresholdDays) => {
    expect(snapshotAgeEvidence(TODAY, TODAY, thresholdDays)).toMatchObject({ ageDays: null, ageState: "invalid" });
  });

  it("日历差跨月和闰日准确，不按运行机器本地时区重算业务日", () => {
    expect(snapshotAgeEvidence("2024-02-29", "2024-03-01")).toMatchObject({ ageDays: 1, ageState: "fresh" });
    expect(snapshotAgeEvidence("2026-08-31", "2026-09-01")).toMatchObject({ ageDays: 1, ageState: "fresh" });
  });

  it("真实查询只读启用中的snapshot记账仓，缺数据仍保留行，MAX未来日不会回退到旧新鲜日", async () => {
    const { db, client } = await createTestDb();
    try {
      expect(await getSnapshotAges(db, TODAY)).toEqual([]);
      const [spu] = await db.insert(schema.spus).values({ code: "QA-SNAP-SPU", nameCn: "合成快照测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "QA-SNAP-SKU", spuId: spu.id, skuType: "finished", baseUom: "个" }).returning();
      const [fresh, boundary, stale, future, missing, invalid, disabled, realtime] = await db.insert(schema.warehouses).values([
        { code: "QA-SNAP-FRESH", name: "今日快照", kind: "snapshot", accountingMode: "snapshot" },
        { code: "QA-SNAP-BOUNDARY", name: "三天边界", kind: "snapshot", accountingMode: "snapshot" },
        { code: "QA-SNAP-STALE", name: "陈旧快照", kind: "snapshot", accountingMode: "snapshot" },
        { code: "QA-SNAP-FUTURE", name: "未来日期", kind: "snapshot", accountingMode: "snapshot" },
        { code: "QA-SNAP-MISSING", name: "没有快照", kind: "snapshot", accountingMode: "snapshot" },
        { code: "QA-SNAP-INVALID", name: "特殊日期", kind: "snapshot", accountingMode: "snapshot" },
        { code: "QA-SNAP-DISABLED", name: "停用快照仓", kind: "snapshot", accountingMode: "snapshot", active: false },
        { code: "QA-SNAP-REALTIME", name: "实时记账仓", kind: "finished", accountingMode: "realtime" },
      ]).returning();
      await db.insert(schema.stockSnapshots).values([
        { warehouseId: fresh.id, skuId: sku.id, bizDate: TODAY, qty: "0" },
        { warehouseId: fresh.id, skuId: sku.id, bizDate: "2026-08-01", qty: "100" },
        { warehouseId: boundary.id, skuId: sku.id, bizDate: "2026-09-03", qty: "1" },
        { warehouseId: stale.id, skuId: sku.id, bizDate: "2026-09-02", qty: "1" },
        { warehouseId: future.id, skuId: sku.id, bizDate: TODAY, qty: "1" },
        { warehouseId: future.id, skuId: sku.id, bizDate: "2026-09-07", qty: "1" },
        { warehouseId: invalid.id, skuId: sku.id, bizDate: TODAY, qty: "1" },
        { warehouseId: invalid.id, skuId: sku.id, bizDate: "infinity", qty: "1" },
        { warehouseId: disabled.id, skuId: sku.id, bizDate: "2026-08-01", qty: "1" },
        { warehouseId: realtime.id, skuId: sku.id, bizDate: "2026-08-01", qty: "1" },
      ]);
      const before = await db.select().from(schema.stockSnapshots);
      const rows = await getSnapshotAges(db, TODAY);
      expect(rows).toHaveLength(6);
      expect(rows.find((row) => row.warehouseId === fresh.id)).toMatchObject({ latestBizDate: TODAY, ageDays: 0, ageState: "fresh" });
      expect(rows.find((row) => row.warehouseId === boundary.id)).toMatchObject({ ageDays: 3, ageState: "fresh" });
      expect(rows.find((row) => row.warehouseId === stale.id)).toMatchObject({ ageDays: 4, ageState: "stale" });
      expect(rows.find((row) => row.warehouseId === future.id)).toMatchObject({ latestBizDate: "2026-09-07", ageDays: -1, ageState: "future" });
      expect(rows.find((row) => row.warehouseId === missing.id)).toMatchObject({ latestBizDate: null, ageDays: null, ageState: "missing" });
      expect(rows.find((row) => row.warehouseId === invalid.id)).toMatchObject({ ageDays: null, ageState: "invalid" });
      expect(rows.some((row) => [disabled.id, realtime.id].includes(row.warehouseId))).toBe(false);
      expect(rows.map((row) => row.code)).toEqual(rows.map((row) => row.code).sort());
      const shared = await readSnapshotAges(db, { today: TODAY });
      expect(rows).toEqual(shared.rows);
      const job = await runSnapshotAgeAlert(db, { today: TODAY });
      expect(job.thresholdDays).toBe(shared.thresholdDays);
      expect(job.alerts.slice().sort((a, b) => a.code.localeCompare(b.code))).toEqual(rows.filter((row) => row.ageState !== "fresh"));
      const health = await getOpsHealth(db);
      expect(health.snapshotAgeThresholdDays).toBe(3);
      expect(health.snapshotAges).toHaveLength(6);
      expect(health.snapshotAges.find((row) => row.warehouseId === missing.id)).toMatchObject({ ageState: "missing", ageDays: null });
      expect(health.snapshotAges.find((row) => row.warehouseId === invalid.id)).toMatchObject({ ageState: "invalid", ageDays: null });
      expect(await db.select().from(schema.stockSnapshots)).toEqual(before);
    } finally { await client.close(); }
  });
});
