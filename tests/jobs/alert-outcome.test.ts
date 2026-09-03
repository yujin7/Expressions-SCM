/**
 * 告警结果核验（闭环审计 #3）：关闭 ≥3 天的断货告警回看实时仓流水 → alert_events(verify)；
 * 快照仓 SKU 弃权并说明覆盖；每条只核验一次；精确率汇总按 category × sourceRule。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { INTERVAL_JOBS } from "@/jobs/interval-runner";
import { SCHEDULES } from "@/jobs/scheduler";
import { alertPrecision, runAlertOutcome } from "@/jobs/alert-outcome";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-03T03:00:00.000Z");
const OPENED = new Date("2026-08-20T03:00:00.000Z");
const RESOLVED = new Date("2026-08-28T03:00:00.000Z");

describe("jobs/alert-outcome", () => {
  let db: TestDb;
  let realtimeWh = 0;
  const skuIds: Record<string, number> = {};
  const alertIds: Record<string, number> = {};
  let ledgerSeq = 0;

  async function ledger(skuId: number, warehouseId: number, qtyDelta: string, day: string) {
    ledgerSeq += 1;
    await db.insert(schema.stockLedger).values({
      skuId, warehouseId, qtyDelta, sourceDocType: "test", sourceDocId: ledgerSeq, sourceLineId: 0, action: "post",
      occurredAt: new Date(`${day}T10:00:00+08:00`),
    });
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [rt] = await db.insert(schema.warehouses).values({ code: "AO-RT", name: "实时仓", kind: "finished" }).returning();
    await db.insert(schema.warehouses).values({ code: "AO-SNAP", name: "快照仓", kind: "snapshot", accountingMode: "snapshot" });
    realtimeWh = rt.id;
    const [spu] = await db.insert(schema.spus).values({ code: "AO-SPU", nameCn: "核验品" }).returning();
    for (const k of ["TP", "FP", "SNAP", "AVERT", "FRESH"]) {
      const [s] = await db.insert(schema.skus).values({ code: `AO-${k}`, name: k, spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
      skuIds[k] = s.id;
      const [a] = await db.insert(schema.systemAlerts).values({
        category: "inventory_cover", refKey: `AO-${k}`, dedupeKey: `inventory_cover:${s.id}`, title: `${k} 断货`, severity: "high",
        status: "resolved", autoResolved: true, createdAt: OPENED, resolvedAt: k === "FRESH" ? new Date("2026-09-02T03:00:00.000Z") : RESOLVED,
        sourceRule: "rules/alert-threshold + rules/alert-priority",
      }).returning();
      alertIds[k] = a.id;
    }
    // TP：期初 10，窗口内出 6 + 4 → 归零且有需求
    await ledger(skuIds.TP, realtimeWh, "10", "2026-08-01");
    await ledger(skuIds.TP, realtimeWh, "-6", "2026-08-22");
    await ledger(skuIds.TP, realtimeWh, "-4", "2026-08-25");
    // FP：期初 100，窗口内出 5，无入库 → 从未归零
    await ledger(skuIds.FP, realtimeWh, "100", "2026-08-01");
    await ledger(skuIds.FP, realtimeWh, "-5", "2026-08-22");
    // SNAP：无任何实时仓流水 → 弃权
    // AVERT：期初 10，出 8，窗口内入 50 → 未归零但有入库 → 弃权（可能被规避）
    await ledger(skuIds.AVERT, realtimeWh, "10", "2026-08-01");
    await ledger(skuIds.AVERT, realtimeWh, "-8", "2026-08-22");
    await ledger(skuIds.AVERT, realtimeWh, "50", "2026-08-26");
  });

  it("关闭 ≥3 天的 inventory_cover 告警逐条核验：真 / 误 / 弃权（快照仓、规避）；未满 3 天不扫", async () => {
    const s = await runAlertOutcome(db, { now: NOW });
    expect(s).toMatchObject({ scanned: 4, verified: 4, truePositive: 1, falsePositive: 1, unverifiable: 2, realtimeWarehouses: 1 });
    const evs = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "verify"));
    expect(evs).toHaveLength(4);
    const byAlert = new Map(evs.map((e) => [e.alertId, e.evidenceRef as Record<string, unknown>]));
    expect(byAlert.get(alertIds.TP)).toMatchObject({ result: "true_positive", reason: "zero_stock_with_demand", coverage: "realtime", minBalance: "0.0000", demandOutQty: "10.0000" });
    expect(byAlert.get(alertIds.FP)).toMatchObject({ result: "false_positive", reason: "stock_never_zero", minBalance: "95.0000", inboundQty: "0" });
    expect(byAlert.get(alertIds.SNAP)).toMatchObject({ result: "unverifiable", reason: "snapshot_only_no_realtime_ledger", coverage: "none" });
    expect(byAlert.get(alertIds.AVERT)).toMatchObject({ result: "unverifiable", reason: "averted_by_inbound", inboundQty: "50.0000" });
    expect(byAlert.has(alertIds.FRESH)).toBe(false);
    // 核验事件不带 actor、不带原因码；幂等键 = `${alertId}:verify`
    expect(evs.every((e) => e.actorId === null && e.reasonCode === null && e.idempotencyKey === `${e.alertId}:verify`)).toBe(true);
    // system_alerts 不被回写
    const [tp] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, alertIds.TP));
    expect(tp).toMatchObject({ status: "resolved", autoResolved: true });
  });

  it("再跑一轮：已核验的不再扫；FRESH 满 3 天后才进入", async () => {
    const s2 = await runAlertOutcome(db, { now: NOW });
    expect(s2).toMatchObject({ scanned: 0, verified: 0 });
    const s3 = await runAlertOutcome(db, { now: new Date("2026-09-06T03:00:00.000Z") });
    expect(s3).toMatchObject({ scanned: 1, verified: 1, unverifiable: 1 });
    expect(await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "verify"))).toHaveLength(5);
  });

  it("alertPrecision：按 category × sourceRule 计数，弃权不进分母，不给单一总分", async () => {
    const p = await alertPrecision(db, { days: 30, now: new Date("2026-09-06T04:00:00.000Z") });
    expect(p.verifiedTotal).toBe(5);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]).toMatchObject({
      category: "inventory_cover", sourceRule: "rules/alert-threshold + rules/alert-priority",
      verified: 5, truePositive: 1, falsePositive: 1, unverifiable: 3, precisionPct: 50,
    });
    expect(p.caliber).toContain("弃权");
    expect((p as unknown as Record<string, unknown>).precisionPct).toBeUndefined();
    const empty = await alertPrecision(db, { days: 1, now: new Date("2026-12-01T00:00:00.000Z") });
    expect(empty.groups).toEqual([]);
  });

  it("任务已登记：INTERVAL_JOBS(05 点) 与 SCHEDULES(05:30，rollup 之后)", () => {
    const job = INTERVAL_JOBS.find((j) => j.name === "alert-outcome");
    expect(job?.atHours).toEqual([5]);
    expect(SCHEDULES["alert-outcome"]).toBe("30 5 * * *");
    const hour = (expr: string) => Number(expr.split(/\s+/)[1]);
    expect(hour(SCHEDULES["alert-outcome"])).toBeGreaterThan(hour(SCHEDULES.rollup));
  });
});
