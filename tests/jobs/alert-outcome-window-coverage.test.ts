import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { runAlertOutcome } from "@/jobs/alert-outcome";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-08-20T00:00:00Z");
const OPENED = new Date("2026-08-01T00:00:00Z");
const RESOLVED = new Date("2026-08-02T00:00:00Z");

interface Fixture {
  db: TestDb;
  spuId: number;
  skuId: number;
  realtimeId: number;
  snapshotId: number;
  alertId: number;
}

async function withFixture<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const { db, client } = await createTestDb();
  try {
    const [rt] = await db.insert(schema.warehouses).values({ code: "WINDOW-RT", name: "合成实时仓", kind: "finished" }).returning();
    const [snap] = await db.insert(schema.warehouses).values({
      code: "WINDOW-SNAP", name: "合成快照仓", kind: "snapshot", accountingMode: "snapshot",
    }).returning();
    const [spu] = await db.insert(schema.spus).values({ code: "WINDOW-SPU", nameCn: "合成窗口品" }).returning();
    const [sku] = await db.insert(schema.skus).values({
      code: "WINDOW-A", name: "合成 A", spuId: spu.id, baseUom: "件", skuType: "finished",
    }).returning();
    const [alert] = await db.insert(schema.systemAlerts).values({
      category: "inventory_cover", refKey: sku.code, dedupeKey: `inventory_cover:${sku.id}`,
      title: "合成 A 断货", severity: "high", status: "resolved", createdAt: OPENED, resolvedAt: RESOLVED,
    }).returning();
    return await run({ db, spuId: spu.id, skuId: sku.id, realtimeId: rt.id, snapshotId: snap.id, alertId: alert.id });
  } finally {
    await client.close();
  }
}

async function realtimeStockout(f: Fixture) {
  await f.db.insert(schema.stockLedger).values([
    { skuId: f.skuId, warehouseId: f.realtimeId, qtyDelta: "10", sourceDocType: "window-test", sourceDocId: 1, action: "post", occurredAt: new Date("2026-07-30T00:00:00Z") },
    { skuId: f.skuId, warehouseId: f.realtimeId, qtyDelta: "-10", sourceDocType: "sales_out", sourceDocId: 2, action: "post", occurredAt: new Date("2026-08-03T00:00:00Z") },
  ]);
}

async function snapshots(f: Fixture, rows: { bizDate: string; qty: string }[]) {
  await f.db.insert(schema.stockSnapshots).values(rows.map((row) => ({
    skuId: f.skuId, warehouseId: f.snapshotId, ...row,
  })));
}

async function verifyA(f: Fixture) {
  await runAlertOutcome(f.db, { now: NOW });
  const [event] = await f.db.select().from(schema.alertEvents).where(eq(schema.alertEvents.alertId, f.alertId));
  expect(event?.event).toBe("verify");
  return event.evidenceRef as Record<string, unknown>;
}

describe("告警核验：历史覆盖必须按每条告警窗口判定", () => {
  it("加入较晚窗口的其他 SKU，不能把 A 从快照混合弃权变成真阳性", async () => {
    const run = (includeB: boolean) => withFixture(async (f) => {
      await realtimeStockout(f);
      await snapshots(f, [{ bizDate: "2026-07-31", qty: "100" }, { bizDate: "2026-08-10", qty: "0" }]);
      if (includeB) {
        const [b] = await f.db.insert(schema.skus).values({ code: "WINDOW-B", name: "合成 B", spuId: f.spuId, baseUom: "件", skuType: "finished" }).returning();
        await f.db.insert(schema.systemAlerts).values({
          category: "inventory_cover", refKey: b.code, dedupeKey: `inventory_cover:${b.id}`,
          title: "合成 B", severity: "high", status: "resolved",
          createdAt: new Date("2026-08-11T00:00:00Z"), resolvedAt: new Date("2026-08-12T00:00:00Z"),
        });
      }
      return verifyA(f);
    });
    const onlyA = await run(false);
    const withB = await run(true);
    expect(onlyA).toMatchObject({ result: "unverifiable", coverage: "snapshot_mixed", reason: "snapshot_stock_outside_ledger" });
    expect(withB).toMatchObject({ result: "unverifiable", coverage: "snapshot_mixed", reason: "snapshot_stock_outside_ledger" });
    expect(withB.windowStart).toBe(onlyA.windowStart);
    expect(withB.windowEnd).toBe(onlyA.windowEnd);
  });

  it.each([
    { name: "窗口起点有效库存 100，窗口内清零", rows: [{ bizDate: "2026-07-31", qty: "100" }, { bizDate: "2026-08-04", qty: "0" }] },
    { name: "窗口起点为零，中途有货，再清零", rows: [{ bizDate: "2026-07-31", qty: "0" }, { bizDate: "2026-08-02", qty: "100" }, { bizDate: "2026-08-04", qty: "0" }] },
  ])("$name：不能只凭窗口末零快照证明全窗口实时覆盖", async ({ rows }) => withFixture(async (f) => {
    await realtimeStockout(f);
    await snapshots(f, rows);
    expect(await verifyA(f)).toMatchObject({
      result: "unverifiable", coverage: "snapshot_mixed", reason: "snapshot_stock_outside_ledger", minBalance: null,
    });
  }));

  it("同 SKU 的早窗有快照货、晚窗已清零，各按自己的覆盖事实核验", async () => withFixture(async (f) => {
    await realtimeStockout(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "100" }, { bizDate: "2026-08-10", qty: "0" }]);
    const [later] = await f.db.insert(schema.systemAlerts).values({
      category: "inventory_cover", refKey: "WINDOW-A", dedupeKey: `inventory_cover:${f.skuId}`,
      title: "同 SKU 晚窗", severity: "high", status: "resolved",
      createdAt: new Date("2026-08-11T00:00:00Z"), resolvedAt: new Date("2026-08-12T00:00:00Z"),
    }).returning();
    expect(await verifyA(f)).toMatchObject({ result: "unverifiable", coverage: "snapshot_mixed" });
    const [laterEvent] = await f.db.select().from(schema.alertEvents).where(eq(schema.alertEvents.alertId, later.id));
    expect(laterEvent.evidenceRef).toMatchObject({ result: "true_positive", coverage: "realtime" });
  }));

  it("快照仓一正一负不能轧成零并进入精确率", async () => withFixture(async (f) => {
    await realtimeStockout(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "100" }]);
    const [secondSnapshot] = await f.db.insert(schema.warehouses).values({
      code: "WINDOW-SNAP-NEG", name: "合成负数快照仓", kind: "snapshot", accountingMode: "snapshot",
    }).returning();
    await f.db.insert(schema.stockSnapshots).values({ skuId: f.skuId, warehouseId: secondSnapshot.id, bizDate: "2026-07-31", qty: "-100" });
    expect(await verifyA(f)).toMatchObject({ result: "unverifiable", coverage: "snapshot_mixed" });
  }));

  it("首次实时流水在窗口之后，不得补出历史实时覆盖资格", async () => withFixture(async (f) => {
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    await f.db.insert(schema.stockLedger).values({
      skuId: f.skuId, warehouseId: f.realtimeId, qtyDelta: "10", sourceDocType: "window-test", sourceDocId: 1,
      action: "post", occurredAt: new Date("2026-08-10T00:00:00Z"),
    });
    expect(await verifyA(f)).toMatchObject({ result: "unverifiable", coverage: "none" });
  }));

  it("首次实时流水在窗口内，不能用缺省零作为可证明的期初库存", async () => withFixture(async (f) => {
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    await f.db.insert(schema.stockLedger).values({
      skuId: f.skuId, warehouseId: f.realtimeId, qtyDelta: "-10", sourceDocType: "window-test", sourceDocId: 1,
      action: "post", occurredAt: new Date("2026-08-03T00:00:00Z"),
    });
    expect(await verifyA(f)).toMatchObject({
      result: "unverifiable", coverage: "none", reason: "realtime_ledger_starts_after_window_start", minBalance: null,
    });
  }));

  it("已知快照仓 SKU 的首份零快照在窗口内，不能补出缺失的起点历史", async () => withFixture(async (f) => {
    await realtimeStockout(f);
    await snapshots(f, [{ bizDate: "2026-08-02", qty: "0" }]);
    expect(await verifyA(f)).toMatchObject({
      result: "unverifiable", coverage: "none", reason: "snapshot_history_incomplete", minBalance: null,
    });
  }));

  it("窗口之前已经清零的历史快照，不应永久阻止纯实时证据核验", async () => withFixture(async (f) => {
    await realtimeStockout(f);
    await snapshots(f, [{ bizDate: "2026-07-20", qty: "100" }, { bizDate: "2026-07-31", qty: "0" }]);
    expect(await verifyA(f)).toMatchObject({ result: "true_positive", coverage: "realtime", minBalance: "0.0000" });
  }));

  it("首笔正向流水恰在窗口起点，不能把窗前未知零库存带入最小余额", async () => withFixture(async (f) => {
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    await f.db.insert(schema.stockLedger).values([
      { skuId: f.skuId, warehouseId: f.realtimeId, qtyDelta: "10", sourceDocType: "window-test", sourceDocId: 1, action: "post", occurredAt: OPENED },
      { skuId: f.skuId, warehouseId: f.realtimeId, qtyDelta: "-5", sourceDocType: "sales_out", sourceDocId: 2, action: "post", occurredAt: new Date("2026-08-02T00:00:00Z") },
    ]);
    expect(await verifyA(f)).toMatchObject({
      result: "unverifiable", reason: "averted_by_inbound", openingBalance: null,
      minBalance: "5.0000", inboundQty: "10.0000",
    });
  }));
});
