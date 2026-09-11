import { describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import {
  classifyLedgerCoverage,
  loadStockUniverseCoverage,
  type StockCoverageWindow,
} from "@/server/core/stockout-evidence";
import { createTestDb, type TestDb } from "../helpers/db";

interface Fixture {
  db: TestDb;
  client: Awaited<ReturnType<typeof createTestDb>>["client"];
  skuId: number;
  realtimeId: number;
  snapshotId: number;
}

async function withFixture<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const { db, client } = await createTestDb();
  try {
    const [rt] = await db.insert(schema.warehouses).values({ code: "COV-RT", name: "合成实时仓", kind: "finished" }).returning();
    const [snap] = await db.insert(schema.warehouses).values({
      code: "COV-SNAP", name: "合成快照仓", kind: "snapshot", accountingMode: "snapshot",
    }).returning();
    const [spu] = await db.insert(schema.spus).values({ code: "COV-SPU", nameCn: "合成覆盖品" }).returning();
    const [sku] = await db.insert(schema.skus).values({ code: "COV-A", name: "合成 A", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    return await run({ db, client, skuId: sku.id, realtimeId: rt.id, snapshotId: snap.id });
  } finally {
    await client.close();
  }
}

function windowOf(f: Fixture, extra: Partial<StockCoverageWindow> = {}): StockCoverageWindow {
  return { key: "A", skuId: f.skuId, from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-05T00:00:00Z"), ...extra };
}

async function ledger(f: Fixture, at = "2026-07-30T00:00:00Z") {
  await f.db.insert(schema.stockLedger).values({
    skuId: f.skuId, warehouseId: f.realtimeId, qtyDelta: "10", sourceDocType: "coverage-test", sourceDocId: 1,
    action: "post", occurredAt: new Date(at),
  });
}

async function snapshots(f: Fixture, rows: { bizDate: string; qty: string; warehouseId?: number }[]) {
  await f.db.insert(schema.stockSnapshots).values(rows.map((row) => ({
    skuId: f.skuId, warehouseId: f.snapshotId, ...row,
  })));
}

describe("stockout-evidence：逐样本历史窗口覆盖", () => {
  it("同 SKU 两个窗口独立，不让晚窗零快照抹掉早窗非零证据", async () => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "100" }, { bizDate: "2026-08-10", qty: "0" }]);
    const early = windowOf(f);
    const late = windowOf(f, { key: "B", from: new Date("2026-08-11T00:00:00Z"), to: new Date("2026-08-15T00:00:00Z") });
    const single = await loadStockUniverseCoverage(f.db, { windows: [early] });
    const combined = await loadStockUniverseCoverage(f.db, { windows: [early, late] });
    expect(classifyLedgerCoverage("A", single)).toMatchObject({ covered: false, coverage: "snapshot_mixed" });
    expect(classifyLedgerCoverage("A", combined)).toEqual(classifyLedgerCoverage("A", single));
    expect(classifyLedgerCoverage("B", combined)).toMatchObject({ covered: true, coverage: "realtime" });
  }));

  it.each([
    { name: "起点非零后清零", rows: [{ bizDate: "2026-07-31", qty: "100" }, { bizDate: "2026-08-04", qty: "0" }] },
    { name: "零到非零再清零", rows: [{ bizDate: "2026-07-31", qty: "0" }, { bizDate: "2026-08-02", qty: "100" }, { bizDate: "2026-08-04", qty: "0" }] },
  ])("$name 均留在快照混合弃权档", async ({ rows }) => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, rows);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "snapshot_mixed", reason: "snapshot_stock_outside_ledger" });
  }));

  it("每仓分别检查，正负库存不能跨仓相抵洗成实时覆盖", async () => withFixture(async (f) => {
    await ledger(f);
    const [other] = await f.db.insert(schema.warehouses).values({ code: "COV-SNAP-2", name: "合成快照仓 2", kind: "snapshot", accountingMode: "snapshot" }).returning();
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "100" }, { bizDate: "2026-07-31", qty: "-100", warehouseId: other.id }]);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "snapshot_mixed" });
  }));

  it.each([
    { name: "首次流水在起点后一毫秒", at: "2026-08-01T00:00:00.001Z" },
    { name: "首次流水在窗口内", at: "2026-08-03T00:00:00Z" },
    { name: "首次流水在窗口末", at: "2026-08-05T00:00:00Z" },
    { name: "首次流水在窗口之后", at: "2026-08-10T00:00:00Z" },
  ])("$name，不具有可证明的期初实时覆盖", async ({ at }) => withFixture(async (f) => {
    await ledger(f, at);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "none", reason: "realtime_ledger_starts_after_window_start" });
  }));

  it("首次实时证据恰在窗口起点，允许覆盖；边界不擅自减一毫秒", async () => withFixture(async (f) => {
    await ledger(f, "2026-08-01T00:00:00Z");
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: true, coverage: "realtime", reason: null });
  }));

  it("未来首次实时流水的弃权原因也独立于同批其他样本，不能只保证 covered 相同", async () => withFixture(async (f) => {
    await ledger(f, "2026-08-10T00:00:00Z");
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    const early = windowOf(f);
    const late = windowOf(f, { key: "B", from: new Date("2026-08-11T00:00:00Z"), to: new Date("2026-08-15T00:00:00Z") });
    const single = await loadStockUniverseCoverage(f.db, { windows: [early] });
    const combined = await loadStockUniverseCoverage(f.db, { windows: [late, early] });
    expect(classifyLedgerCoverage("A", single)).toMatchObject({ covered: false, coverage: "none", reason: "realtime_ledger_starts_after_window_start" });
    expect(classifyLedgerCoverage("A", combined)).toEqual(classifyLedgerCoverage("A", single));
    expect(classifyLedgerCoverage("B", combined)).toMatchObject({ covered: true, coverage: "realtime" });
  }));

  it("已知快照仓 SKU 缺起点基线，中段首次零值不是覆盖证明", async () => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, [{ bizDate: "2026-08-02", qty: "0" }]);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "none", reason: "snapshot_history_incomplete" });
  }));

  it.each([
    { name: "起点数量 NaN", rows: [{ bizDate: "2026-07-31", qty: "NaN" }] },
    { name: "期间 NaN 后清零", rows: [{ bizDate: "2026-07-31", qty: "0" }, { bizDate: "2026-08-02", qty: "NaN" }, { bizDate: "2026-08-04", qty: "0" }] },
    { name: "非有限历史业务日", rows: [{ bizDate: "-infinity", qty: "0" }] },
  ])("$name：数据库可存的异常快照不能冒充显式零基线", async ({ rows }) => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, rows);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "none", reason: "snapshot_history_incomplete" });
  }));

  it("取起点有效的最新一期，而不是将窗口前任意非零永远带入", async () => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, [{ bizDate: "2026-07-20", qty: "100" }, { bizDate: "2026-07-31", qty: "0" }]);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: true, coverage: "realtime" });
  }));

  it("上海日界：闭窗口包含结束日，结束于上海零点的半开窗口不包含该日", async () => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }, { bizDate: "2026-08-06", qty: "100" }]);
    const to = new Date("2026-08-05T16:00:00Z"); // 上海 8 月 6 日 00:00
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [
      windowOf(f, { key: "closed", to }),
      windowOf(f, { key: "exclusive", to, endExclusive: true }),
    ] });
    expect(classifyLedgerCoverage("closed", coverage)).toMatchObject({ covered: false, coverage: "snapshot_mixed" });
    expect(classifyLedgerCoverage("exclusive", coverage)).toMatchObject({ covered: true, coverage: "realtime" });
  }));

  it("半开窗口结束于日内时刻时仍覆盖该上海业务日，不整日减掉", async () => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }, { bizDate: "2026-08-05", qty: "100" }]);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f, { endExclusive: true })] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "snapshot_mixed" });
  }));

  it("当前存在快照仓但没有该 SKU 起点记录，不能把缺失当作零", async () => withFixture(async (f) => {
    await ledger(f);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "none", reason: "snapshot_history_incomplete" });
  }));

  it("停用快照仓仍缺起点记录时不豁免，不借当前启用状态抹掉历史覆盖", async () => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    await f.db.insert(schema.warehouses).values({
      code: "COV-INACTIVE", name: "合成停用快照仓", kind: "snapshot", accountingMode: "snapshot", active: false,
    });
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "none", reason: "snapshot_history_incomplete" });
  }));

  it("没有任何快照仓或历史快照对，且起点已有实时证据，才是纯实时正向", async () => {
    const { db, client } = await createTestDb();
    try {
      const [rt] = await db.insert(schema.warehouses).values({ code: "PURE-RT", name: "纯实时仓", kind: "finished" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "PURE-SPU", nameCn: "合成纯实时品" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "PURE-A", name: "合成纯实时 A", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
      await db.insert(schema.stockLedger).values({
        skuId: sku.id, warehouseId: rt.id, qtyDelta: "10", sourceDocType: "coverage-test", sourceDocId: 1,
        action: "post", occurredAt: new Date("2026-07-30T00:00:00Z"),
      });
      const coverage = await loadStockUniverseCoverage(db, { windows: [{
        key: "pure", skuId: sku.id, from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-05T00:00:00Z"),
      }] });
      expect(classifyLedgerCoverage("pure", coverage)).toMatchObject({ covered: true, coverage: "realtime" });
    } finally {
      await client.close();
    }
  });

  it("其他当前非快照仓曾有该 SKU 快照行，也不能忽略窗口内非零", async () => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    const [formerSnapshot] = await f.db.insert(schema.warehouses).values({ code: "COV-FORMER-SNAP", name: "合成曾用快照仓", kind: "finished" }).returning();
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "100", warehouseId: formerSnapshot.id }]);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(classifyLedgerCoverage("A", coverage)).toMatchObject({ covered: false, coverage: "snapshot_mixed" });
  }));

  it("不存在的窗口 key 必须报配置错误，不默认 covered", async () => withFixture(async (f) => {
    await ledger(f);
    const coverage = await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
    expect(() => classifyLedgerCoverage("not-loaded", coverage)).toThrow();
  }));

  it("1 个与 100 个样本都只做 4 次批量读库，不按样本 N+1 查询", async () => withFixture(async (f) => {
    await ledger(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    const query = vi.spyOn(f.client, "query");
    try {
      await loadStockUniverseCoverage(f.db, { windows: [windowOf(f)] });
      expect(query).toHaveBeenCalledTimes(4);
      query.mockClear();
      const windows = Array.from({ length: 100 }, (_, index) => windowOf(f, { key: `sample-${index}` }));
      const coverage = await loadStockUniverseCoverage(f.db, { windows });
      expect(query).toHaveBeenCalledTimes(4);
      expect(coverage.byWindow.size).toBe(100);
      expect([...coverage.byWindow.values()].every((verdict) => verdict.covered)).toBe(true);
    } finally {
      query.mockRestore();
    }
  }));
});
