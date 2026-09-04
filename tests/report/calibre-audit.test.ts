/**
 * 口径审计回归（2026-09 读模型体检 C2–C8）。
 *
 * 每个用例钉住一个**已确认的错数/过期**缺陷，修复前必红：
 *  C2 `inventory-alerts` source_binding 缺业务日 → 跨日仍以旧结论压住真实断货预警；
 *  C3 `risk-expiry-buckets` 在累加过程中逐步 r1() + float 相加 → 小批量被抹平成 0；
 *  C4 `transfer-suggest` 的 expiredHeldTotal 把同一 (SKU, 调出仓) 的过期量按建议条数重复累加；
 *  C5 `batch_stocks` 跨盘点期间相加 → 效期量按期数翻倍、调拨可让出量被清零；
 *  C7 source_binding 漏输入（数量原地更新 / 在库 / 销速 / 注记）；
 *  C8 计数口径误导（只在一期出现的 SKU 被算成「换档」；有运行 ≠ 这张图画得出线）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { latestStocktakeRows } from "@/server/core/stock-view";
import { buildTierMigration } from "@/server/modules/report/cockpit-trends";
import {
  INVENTORY_ALERTS_CACHE_KEY,
  computeInventoryAlerts,
  loadInventoryAlerts,
} from "@/server/modules/report/inventory-alerts";
import { expiryCheck } from "@/server/modules/replenish/expiry";
import { getRiskWorklist, type RiskRow } from "@/server/modules/report/risk";
import {
  RISK_EXPIRY_BUCKETS_KEY,
  buildRiskExpiryBuckets,
  riskExpiryBucketsBinding,
} from "@/server/modules/report/risk-expiry-buckets";
import { loadSourceRunHistory, weekKeys } from "@/server/modules/report/source-run-history";
import { getTransferSuggestions } from "@/server/modules/report/transfer-suggest";
import { todayShanghai } from "@/server/modules/master/common";

function shift(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

afterEach(() => {
  vi.useRealTimers();
});

/* ─────────────────────────── C5 · 盘点期间收口（共享纯函数） ─────────────────────────── */

describe("C5 · batch_stocks 盘点期间收口（core/stock-view.latestStocktakeRows）", () => {
  it("逐仓取最新一期：慢盘的仓保留自己的最新期，不被别的仓的期间抹掉", () => {
    const rows = [
      { warehouseId: 1, stocktakeDate: "2026-08-31", qty: "10" },
      { warehouseId: 1, stocktakeDate: "2026-07-31", qty: "10" }, // 同仓旧期 → 丢弃
      { warehouseId: 2, stocktakeDate: "2026-06-30", qty: "7" }, // 另一仓最新期虽更早，仍保留
    ];
    expect(latestStocktakeRows(rows)).toEqual([
      { warehouseId: 1, stocktakeDate: "2026-08-31", qty: "10" },
      { warehouseId: 2, stocktakeDate: "2026-06-30", qty: "7" },
    ]);
    expect(latestStocktakeRows([])).toEqual([]);
  });
});

/* ─────────────────────────── C3 · 效期段位累加精度 ─────────────────────────── */

describe("C3 · risk-expiry-buckets 累加不得逐步取整", () => {
  const row = (over: Partial<RiskRow> & { skuId: number }): RiskRow => ({
    skuId: over.skuId, code: `SKU${over.skuId}`, name: "x", brand: over.brand ?? "微批",
    action: over.action ?? "促销清库", onHand: over.onHand ?? 0, daily: 1, cover: 100,
    minDaysLeft: 10, expiredQty: 0, nearExpiryDays: 90, nearQty: 0,
    expiryBuckets: over.expiryBuckets ?? { expired: 0, d30: 0, d60: 0, d90: 0 },
    nearExpiryFallback: false, palletRemark: null, remarkMonth: null,
    disposalOpen: false, disposalId: null, externalNet30: null, externalLastSold: null,
  });

  it("10 个 0.04 的小批量累计 = 0.4（此前每步 r1() 后恒为 0——工作台给的全精度被读模型当场毁掉）", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ skuId: i + 1, expiryBuckets: { expired: 0, d30: 0.04, d60: 0, d90: 0 } }));
    const b = buildRiskExpiryBuckets(rows, { today: "2026-09-04", slowThreshold: 180 });
    expect(b.totals.find((t) => t.key === "d30")!.qty).toBe(0.4);
    expect(b.totals.find((t) => t.key === "d30")!.skus).toBe(10);
    expect(b.brands[0].buckets.d30).toBe(0.4);
    expect(b.brands[0].totalQty).toBe(0.4);
  });

  it("呆滞在库同样按定点小数累计；0.1 + 0.2 不得出现 float 尾巴", () => {
    const b = buildRiskExpiryBuckets([
      row({ skuId: 1, action: "滞销关注", onHand: 0.1 }),
      row({ skuId: 2, action: "滞销关注", onHand: 0.2 }),
    ], { today: "2026-09-04", slowThreshold: 180 });
    expect(b.brands[0].slowOnHand).toBe(0.3);
  });

  it("整数量仍与旧口径一致（升版只修精度，不改语义）", () => {
    const b = buildRiskExpiryBuckets([
      row({ skuId: 1, expiryBuckets: { expired: 10, d30: 20, d60: 0, d90: 0 } }),
      row({ skuId: 2, expiryBuckets: { expired: 0, d30: 0, d60: 5, d90: 7 } }),
    ], { today: "2026-09-04", slowThreshold: 180 });
    expect(b.totals.map((t) => [t.key, t.qty, t.skus])).toEqual([
      ["expired", 10, 1], ["d30", 20, 1], ["d60", 5, 1], ["d90", 7, 1],
    ]);
    expect(b.brands[0].totalQty).toBe(42);
  });
});

/* ─────────────────────────── C8(a) · 分层迁移计数 ─────────────────────────── */

describe("C8(a) · 分层迁移：只在一期出现的 SKU 不是「换档」", () => {
  it("新导入 300 个 SKU 报「300 个换档」是错的：拆成 retiered / entered / left", () => {
    const onboarded = Array.from({ length: 300 }, (_, i) => ({
      skuId: 1000 + i, from: "未分层" as const, to: "B" as const,
    }));
    const b = buildTierMigration({ from: "2026-08", to: "2026-09" }, [
      { skuId: 1, from: "S", to: "S" }, // 不变
      { skuId: 2, from: "A", to: "S" }, // 真换档
      { skuId: 3, from: "B", to: "未分层" }, // 退出分层
      ...onboarded,
    ], null);
    expect(b.retiered).toBe(1);
    expect(b.entered).toBe(300);
    expect(b.left).toBe(1);
    expect(b.stayed).toBe(1);
    // moved 仍是三者之和（保留作 stayed 的补数），但页面读数用分项
    expect(b.moved).toBe(302);
    expect(b.scanned).toBe(303);
  });
});

/* ─────────────────────────── C8(b) · 来源趋势按实际绘制的读数判 ─────────────────────────── */

describe("C8(b) · source-run-history：有运行 ≠ 这张图画得出线", () => {
  it("有 3 周运行但批次都没有业务截止日 → state ready，及时性 ageState 必须 insufficient", async () => {
    const { db, client } = await createTestDb();
    try {
      const today = todayShanghai();
      const weeks = weekKeys(today, 8);
      const [actor] = await db.insert(schema.users).values({ name: "导入人" }).returning();
      // 3 个不同周各一个批次：有 ok/fail 行（放行率可算），但 source_as_of 为空（滞后天数无读数）
      for (const [i, week] of [weeks[4], weeks[5], weeks[6]].entries()) {
        await db.insert(schema.importJobs).values({
          template: "sales", filename: `f${i}`, createdBy: actor.id, status: "done",
          okRows: 10, failRows: 0, sourceAsOf: null,
          createdAt: new Date(`${shift(week, 1)}T04:00:00Z`),
        });
      }
      const h = await loadSourceRunHistory(db, { today });
      const s = h.series.find((x) => x.weeksWithActivity >= 3)!;
      expect(s.weeksWithActivity).toBeGreaterThanOrEqual(3);
      expect(s.state).toBe("ready"); // 有运行
      expect(s.weeksWithAge).toBe(0);
      expect(s.ageState).toBe("insufficient"); // 但及时性图一个点都画不出 → 不得挂 ready 的 chip
      expect(s.ageGate).toContain("业务截止日");
      expect(s.weeksWithPassRate).toBe(3);
      expect(s.passRateState).toBe("ready"); // 放行率图有读数
    } finally {
      await client.close();
    }
  });
});

/* ─────────────────────────── PGlite 种子 ─────────────────────────── */

interface Seeded {
  skuId: number;
  whA: number;
  whB: number;
  whC: number;
  actorId: number;
}

/** 一个成品 SKU、三个记账仓 */
async function seedBase(db: TestDb, opts: { nearExpiryDays?: number | null } = {}): Promise<Seeded> {
  const [actor] = await db.insert(schema.users).values({ name: "口径审计", roles: ["pmc"] }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "CA-SPU", nameCn: "审计品" }).returning();
  const [sku] = await db.insert(schema.skus).values({
    code: "CA-001", name: "审计成品", spuId: spu.id, baseUom: "件", skuType: "finished",
    nearExpiryDays: opts.nearExpiryDays ?? null,
  }).returning();
  const [a] = await db.insert(schema.warehouses).values({ code: "CA-A", name: "甲仓", kind: "finished", accountingMode: "realtime" }).returning();
  const [b] = await db.insert(schema.warehouses).values({ code: "CA-B", name: "乙仓", kind: "finished", accountingMode: "realtime" }).returning();
  const [c] = await db.insert(schema.warehouses).values({ code: "CA-C", name: "丙仓", kind: "finished", accountingMode: "realtime" }).returning();
  return { skuId: sku.id, whA: a.id, whB: b.id, whC: c.id, actorId: actor.id };
}

/** 同一批实物货、两个盘点期间各一行（batch_stocks 唯一键含 stocktake_date，这是正常状态而非脏数据） */
async function seedTwoStocktakePeriods(
  db: TestDb,
  s: { skuId: number; warehouseId: number },
  opts: { expiryDate: string; qty: string; periods: [string, string]; batchNo?: string },
): Promise<void> {
  for (const period of opts.periods) {
    await db.insert(schema.batchStocks).values({
      skuId: s.skuId, warehouseId: s.warehouseId, stocktakeDate: period,
      expiryDate: opts.expiryDate, qty: opts.qty, batchNo: opts.batchNo ?? "B-CA-1", source: "import",
    });
  }
}

/* ─────────────────────────── C5 · 三条新负载路径 ─────────────────────────── */

describe("C5 · 两个盘点期间并存时，效期量不得翻倍", () => {
  it("replenish/expiry（喂 inventory-alerts.nearExpiry）：两期只算最新一期", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seedBase(db, { nearExpiryDays: 90 });
      const today = todayShanghai();
      await seedTwoStocktakePeriods(db, { skuId: s.skuId, warehouseId: s.whA }, {
        expiryDate: shift(today, 30), qty: "100", periods: ["2026-07-31", "2026-08-31"],
      });
      const res = await expiryCheck({ skuIds: [s.skuId] }, db);
      const item = res.items[0];
      expect(item.nearQty).toBe(100); // 两期相加会是 200
      expect(item.nearBatches).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("report/risk 效期段位（喂驾驶舱临期块）：两期只算最新一期", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seedBase(db, { nearExpiryDays: 90 });
      const today = todayShanghai();
      await db.insert(schema.stockBalances).values({ skuId: s.skuId, warehouseId: s.whA, qty: "100" });
      await seedTwoStocktakePeriods(db, { skuId: s.skuId, warehouseId: s.whA }, {
        expiryDate: shift(today, 20), qty: "100", periods: ["2026-07-31", "2026-08-31"],
      });
      const wl = await getRiskWorklist({ all: true, precise: true }, db);
      const row = wl.rows.find((r) => r.skuId === s.skuId)!;
      expect(row.expiryBuckets.d30).toBe(100); // 两期相加会是 200
      expect(row.nearQty).toBe(100);
    } finally {
      await client.close();
    }
  });

  it("transfer-suggest：两期过期量相加会 ≥ 在库，把整仓可调拨量清成 0", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seedBase(db);
      const today = todayShanghai();
      await db.insert(schema.skuParams).values({ skuId: s.skuId, normalLeadDays: 10, logisticsLeadDays: 5 });
      // 甲仓：在库 10000（无出库 → 呆滞盈余）；其中 6000 已过期（两期各一行）
      await db.insert(schema.stockBalances).values({ skuId: s.skuId, warehouseId: s.whA, qty: "10000" });
      await seedTwoStocktakePeriods(db, { skuId: s.skuId, warehouseId: s.whA }, {
        expiryDate: shift(today, -10), qty: "6000", periods: ["2026-07-31", "2026-08-31"],
      });
      // 乙仓：在库 10、近 90 天有出库 → 缺口仓
      await db.insert(schema.stockBalances).values({ skuId: s.skuId, warehouseId: s.whB, qty: "10" });
      await db.insert(schema.stockLedger).values({
        skuId: s.skuId, warehouseId: s.whB, batchId: null, qtyDelta: "-900",
        sourceDocType: "test_out", sourceDocId: 1, action: "post",
        occurredAt: new Date(Date.now() - 3 * 86_400_000),
      });
      const r = await getTransferSuggestions({ horizonDays: 90 }, db);
      // 两期相加 = 12000 ≥ 在库 10000 → 可调拨量被清零、一条建议都出不来
      expect(r.total).toBeGreaterThan(0);
      const line = r.rows[0];
      expect(line.expiredHeld).toBe(6000);
      expect(r.summary.expiredHeldTotal).toBe(6000);
      expect(line.qty).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

/* ─────────────────────────── C4 · expiredHeldTotal 去重 ─────────────────────────── */

describe("C4 · expiredHeldTotal 按 (SKU, 调出仓) 去重", () => {
  it("一个调出仓供两个缺口仓：过期量只算一次，不是两次", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seedBase(db);
      const today = todayShanghai();
      await db.insert(schema.skuParams).values({ skuId: s.skuId, normalLeadDays: 10, logisticsLeadDays: 5 });
      await db.insert(schema.stockBalances).values({ skuId: s.skuId, warehouseId: s.whA, qty: "100000" });
      await db.insert(schema.batchStocks).values({
        skuId: s.skuId, warehouseId: s.whA, stocktakeDate: "2026-08-31",
        expiryDate: shift(today, -5), qty: "500", batchNo: "B-EXP", source: "import",
      });
      // 乙、丙两个缺口仓：各有出库历史、在库很薄
      for (const wh of [s.whB, s.whC]) {
        await db.insert(schema.stockBalances).values({ skuId: s.skuId, warehouseId: wh, qty: "10" });
        await db.insert(schema.stockLedger).values({
          skuId: s.skuId, warehouseId: wh, batchId: null, qtyDelta: "-900",
          sourceDocType: "test_out", sourceDocId: wh, action: "post",
          occurredAt: new Date(Date.now() - 3 * 86_400_000),
        });
      }
      const r = await getTransferSuggestions({ horizonDays: 90 }, db);
      const fromA = r.rows.filter((x) => x.fromWarehouseId === s.whA);
      expect(fromA).toHaveLength(2); // 同一调出仓的两条建议
      // 每条行上都挂着同一份 expiredHeld（行级事实），但汇总只能算一次
      expect(fromA.every((x) => x.expiredHeld === 500)).toBe(true);
      expect(r.summary.expiredHeldTotal).toBe(500); // 未去重会是 1000
    } finally {
      await client.close();
    }
  });
});

/* ─────────────────────────── C2 · 跨日必须重算 ─────────────────────────── */

describe("C2 · inventory-alerts 跨日不得沿用旧结论", () => {
  it("底层一行不动、只过了一天：逾期的到货不再压住断货预警（缓存键必须带业务日）", async () => {
    const { db, client } = await createTestDb();
    try {
      // 固定业务日（只 fake Date，PGlite 内部计时器照常）
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-10T10:00:00+08:00"));
      const day1 = todayShanghai();
      expect(day1).toBe("2026-09-10");

      const s = await seedBase(db);
      await db.insert(schema.skuParams).values({ skuId: s.skuId, normalLeadDays: 20, logisticsLeadDays: 10 });
      const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
      for (const ym of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) {
        await db.insert(schema.salesMonthly).values({ skuId: s.skuId, channelId: ch.id, yearMonth: ym, qty: "500" });
      }
      await db.insert(schema.stockBalances).values({ skuId: s.skuId, warehouseId: s.whA, qty: "100" });
      // 一笔今天到货的 PO：阈值 35 天内 → 在库口径 alert 被降为 watch
      const [sup] = await db.insert(schema.suppliers).values({ code: "CA-S1", name: "供应商甲" }).returning();
      const [po] = await db.insert(schema.poDocs).values({ docNo: "PO-CA-1", status: "approved", supplierId: sup.id, createdBy: s.actorId }).returning();
      await db.insert(schema.poLines).values({
        poId: po.id, skuId: s.skuId, lineType: "raw", purchaseUom: "件", uomFactor: "1",
        qty: "3000", price: "5.00", expectedDate: day1,
      });

      const d1 = await loadInventoryAlerts(db);
      const r1 = d1.rows.find((r) => r.skuId === s.skuId)!;
      expect(r1.statusOnHand).toBe("alert");
      expect(r1.status).toBe("watch");
      expect(r1.downgradedBySupply).toBe(true);
      expect(r1.inTransitDated).toBe(3000);
      expect(r1.statusBasis).toContain("降为关注");
      const binding1 = d1.sourceBinding;

      // 只把时钟拨过一天：数据库一行没动，但那笔到货已经逾期
      vi.setSystemTime(new Date("2026-09-11T10:00:00+08:00"));
      expect(todayShanghai()).toBe("2026-09-11");

      const d2 = await loadInventoryAlerts(db);
      expect(d2.sourceBinding).not.toBe(binding1); // 绑定必须含业务日，否则命中旧缓存
      expect(d2.params.today).toBe("2026-09-11");
      const r2 = d2.rows.find((r) => r.skuId === s.skuId)!;
      expect(r2.inTransitOverdue).toBe(3000);
      expect(r2.inTransitDated).toBe(0);
      expect(r2.nextArrival).toBeNull();
      expect(r2.downgradedBySupply).toBe(false);
      expect(r2.status).toBe("alert"); // 降级被撤回
      expect(r2.statusBasis).toBeNull(); // 依据文案不再声称「到货在途」
    } finally {
      await client.close();
    }
  });

  it("缓存键已随口径升版（口径变了就必须换键，否则旧缓存把新线索藏起来）", () => {
    expect(INVENTORY_ALERTS_CACHE_KEY).toBe("inventory-alerts/v3");
    expect(RISK_EXPIRY_BUCKETS_KEY).toBe("risk-expiry-buckets/v2");
  });
});

/* ─────────────────────────── C7(b) · risk-expiry-buckets 绑定 ─────────────────────────── */

describe("C7(b) · risk-expiry-buckets 的 source_binding 必须覆盖读到的每一样输入", () => {
  it("批次数量原地改动 / 在库 / 销速 / 注记 变化，绑定都必须变", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seedBase(db, { nearExpiryDays: 90 });
      const today = todayShanghai();
      const [batchRow] = await db.insert(schema.batchStocks).values({
        skuId: s.skuId, warehouseId: s.whA, stocktakeDate: "2026-08-31",
        expiryDate: shift(today, 30), qty: "100", batchNo: "B-CA-1", source: "import",
      }).returning();
      await db.insert(schema.stockBalances).values({ skuId: s.skuId, warehouseId: s.whA, qty: "100" });
      const base = await riskExpiryBucketsBinding(db);

      // 1) 原地改数量：max(id)/count 完全不变 —— 只有数量指纹能发现
      await db.update(schema.batchStocks).set({ qty: "250" }).where(eq(schema.batchStocks.id, batchRow.id));
      const afterQty = await riskExpiryBucketsBinding(db);
      expect(afterQty).not.toBe(base);

      // 2) 在库变化（呆滞判定的分子）
      await db.update(schema.stockBalances).set({ qty: "900" }).where(eq(schema.stockBalances.skuId, s.skuId));
      const afterOnHand = await riskExpiryBucketsBinding(db);
      expect(afterOnHand).not.toBe(afterQty);

      // 3) 销速（呆滞判定的分母）
      const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
      await db.insert(schema.salesMonthly).values({ skuId: s.skuId, channelId: ch.id, yearMonth: "2026-08", qty: "10" });
      const afterVelocity = await riskExpiryBucketsBinding(db);
      expect(afterVelocity).not.toBe(afterOnHand);

      // 4) 货盘处置注记（直接改变 suggestRiskAction 的结论）
      const [job] = await db.insert(schema.importJobs).values({
        template: "pallet", filename: "pallet.xlsx", createdBy: s.actorId, status: "done",
      }).returning();
      await db.insert(schema.transitRefs).values({
        kind: "pallet", skuId: s.skuId, exception: "整托受潮", progress: "2026-08", sourceJobId: job.id,
      });
      const afterRemark = await riskExpiryBucketsBinding(db);
      expect(afterRemark).not.toBe(afterVelocity);

      // 业务日仍在（跨日段位会移动）
      expect(afterRemark).toContain(`day:${today}`);
    } finally {
      await client.close();
    }
  });
});

/* ─────────────────────────── 升版后仍能落缓存并复用 ─────────────────────────── */

describe("升版后的读模型仍按绑定落缓存并复用", () => {
  it("inventory-alerts/v3：同一天两次读取只落一行缓存", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seedBase(db);
      await db.insert(schema.stockBalances).values({ skuId: s.skuId, warehouseId: s.whA, qty: "5" });
      const first = await computeInventoryAlerts(db);
      expect(first.key).toBe(INVENTORY_ALERTS_CACHE_KEY);
      await loadInventoryAlerts(db);
      const again = await loadInventoryAlerts(db);
      expect(again.key).toBe(INVENTORY_ALERTS_CACHE_KEY);
      const cached = await db.execute(sql`SELECT key FROM report_read_model_cache WHERE key = ${INVENTORY_ALERTS_CACHE_KEY}`);
      const rows = (Array.isArray(cached) ? cached : (cached as { rows?: unknown[] }).rows ?? []) as { key: string }[];
      expect(rows).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
