/**
 * snapshot-age（UAT 缺口 #3）：快照仓最新快照数据龄 > 阈值（默认 3 天）告警；
 * 从未导入的快照仓恒告警；实时仓/停用仓不参与。
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { runSnapshotAgeAlert, SNAPSHOT_AGE_THRESHOLD_DAYS } from "@/jobs/snapshot-age";

const TODAY = "2026-07-24";

async function seed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [spu] = await db.insert(schema.spus).values({ code: "P00001", nameCn: "产品甲" }).returning();
  const [sku] = await db
    .insert(schema.skus)
    .values({ code: "BC00001", name: "SKU甲", spuId: spu.id, baseUom: "个", skuType: "finished" })
    .returning();
  const whs = await db
    .insert(schema.warehouses)
    .values([
      { code: "WH-STALE", name: "保税仓（陈旧）", kind: "snapshot", accountingMode: "snapshot" },
      { code: "WH-FRESH", name: "云仓（新鲜）", kind: "snapshot", accountingMode: "snapshot" },
      { code: "WH-NEVER", name: "E仓（从未导入）", kind: "snapshot", accountingMode: "snapshot" },
      { code: "WH-OFF", name: "停用快照仓", kind: "snapshot", accountingMode: "snapshot", active: false },
      { code: "WH-RT", name: "成品仓（实时）", kind: "finished", accountingMode: "realtime" },
    ])
    .returning();
  const [stale, fresh] = whs;
  await db.insert(schema.stockSnapshots).values([
    // 陈旧仓：最新 2026-07-19 → 数据龄 5 天 > 3 → 告警（另有更旧行验证取 max）
    { warehouseId: stale.id, skuId: sku.id, bizDate: "2026-07-10", qty: "1" },
    { warehouseId: stale.id, skuId: sku.id, bizDate: "2026-07-19", qty: "2" },
    // 新鲜仓：2026-07-22 → 数据龄 2 天 ≤ 3 → 不告警
    { warehouseId: fresh.id, skuId: sku.id, bizDate: "2026-07-22", qty: "3" },
  ]);
  return whs;
}

describe("runSnapshotAgeAlert", () => {
  it("陈旧+从未导入告警；新鲜/实时/停用不告警；never 置顶", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const res = await runSnapshotAgeAlert(db, { today: TODAY });
    expect(res.today).toBe(TODAY);
    expect(res.thresholdDays).toBe(SNAPSHOT_AGE_THRESHOLD_DAYS);
    expect(res.alertCount).toBe(2);
    expect(res.alerts.map((a) => [a.code, a.latestBizDate, a.ageDays])).toEqual([
      ["WH-NEVER", null, null],
      ["WH-STALE", "2026-07-19", 5],
    ]);
  });

  it("阈值参数生效：threshold=1 时新鲜仓（2 天）也告警；threshold=5 时陈旧仓不告警", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const loose = await runSnapshotAgeAlert(db, { today: TODAY, thresholdDays: 5 });
    expect(loose.alerts.map((a) => a.code)).toEqual(["WH-NEVER"]);
    const strict = await runSnapshotAgeAlert(db, { today: TODAY, thresholdDays: 1 });
    expect(strict.alerts.map((a) => a.code).sort()).toEqual(["WH-FRESH", "WH-NEVER", "WH-STALE"].sort());
  });

  it("边界：数据龄恰等于阈值不告警（>而非≥）", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(schema.spus).values({ code: "P00002", nameCn: "产品乙" }).returning();
    const [sku] = await db
      .insert(schema.skus)
      .values({ code: "BC00002", name: "SKU乙", spuId: spu.id, baseUom: "个", skuType: "finished" })
      .returning();
    const [wh] = await db
      .insert(schema.warehouses)
      .values({ code: "WH-EQ", name: "恰等阈值仓", kind: "snapshot", accountingMode: "snapshot" })
      .returning();
    await db.insert(schema.stockSnapshots).values({ warehouseId: wh.id, skuId: sku.id, bizDate: "2026-07-21", qty: "1" }); // 3 天
    const res = await runSnapshotAgeAlert(db, { today: TODAY });
    expect(res.alertCount).toBe(0);
  });

  it("入参校验：today 非法/阈值负数抛错", async () => {
    const { db } = await createTestDb();
    await expect(runSnapshotAgeAlert(db, { today: "2026/7/24" })).rejects.toThrow();
    await expect(runSnapshotAgeAlert(db, { today: TODAY, thresholdDays: -1 })).rejects.toThrow();
  });
});
