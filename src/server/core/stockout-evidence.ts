/**
 * 断货结论的覆盖前置（告警核验 / 抑制复核共用）。
 * 每个样本独立检查自己的时间窗，不能借用本轮其他样本的结束时间。
 * 按仓检查期初有效快照及窗口内每次变化：期末清零、跨仓正负抵销均不能证明全窗覆盖。
 * 缺少明确的快照起点是未知，不是零。这里只验证已登记仓与已记录日快照，
 * 不声称证明未接入仓或快照之间的日内轨迹，也不替代实时账的期初盘点验收。
 */
import { and, gt, inArray, lte, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dCmp } from "@/server/core/decimal";
import { getLatestSnapshotRows } from "@/server/core/stock-view";
import type { AnyDb } from "@/server/core/svc";
import { shanghaiDay, shanghaiDayOf } from "@/server/core/business-day";

/** 覆盖档位：realtime=可打分；none=无实时流水；snapshot_mixed=有实时流水但货还在快照仓 */
export type LedgerCoverage = "realtime" | "none" | "snapshot_mixed";

export type CoverageReason =
  | "snapshot_only_no_realtime_ledger"
  | "snapshot_stock_outside_ledger"
  | "realtime_ledger_starts_after_window_start"
  | "snapshot_history_incomplete";

export interface StockCoverageWindow {
  /** 样本身份，不是 SKU；同一个 SKU 的不同窗口必须独立判定。 */
  key: string;
  skuId: number;
  from: Date;
  to: Date;
  endExclusive?: boolean;
}

export interface StockUniverseCoverage {
  realtimeWarehouseIds: number[];
  byWindow: Map<string, CoverageVerdict>;
}

export interface CoverageVerdict {
  covered: boolean;
  coverage: LedgerCoverage;
  reason: CoverageReason | null;
  note: string;
}

interface SnapshotHistory {
  days: string[];
  /** 前缀计数：让每个窗口只做二分和区间差，不反复扫描快照历史。 */
  nonzero: number[];
  invalid: number[];
}

function afterDay(days: readonly string[], day: string): number {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (days[mid] <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function unavailable(reason: CoverageReason, note: string): CoverageVerdict {
  return { covered: false, coverage: "none", reason, note };
}

/**
 * 固定批量查询：仓目录、实时账首次证据、最早窗的期初快照、区间快照变化。
 * 查询可以合批，判定不能合窗。快照按上海业务日生效，右开窗口先减 1ms 再转日。
 */
export async function loadStockUniverseCoverage(
  db: AnyDb,
  opts: { windows: readonly StockCoverageWindow[] },
): Promise<StockUniverseCoverage> {
  const keys = new Set<string>();
  const windows = opts.windows.map((w) => {
    const fromMs = w.from.getTime();
    const toMs = w.to.getTime();
    if (!w.key || keys.has(w.key) || !Number.isInteger(w.skuId) || w.skuId <= 0
      || !Number.isFinite(fromMs) || !Number.isFinite(toMs)
      || fromMs > toMs || (w.endExclusive && fromMs === toMs)) {
      throw new Error("Invalid or duplicate stock coverage window");
    }
    keys.add(w.key);
    return { ...w, fromMs, fromDay: shanghaiDayOf(w.from), toDay: shanghaiDayOf(new Date(toMs - (w.endExclusive ? 1 : 0))) };
  });
  const byWindow = new Map<string, CoverageVerdict>();
  if (!windows.length) return { realtimeWarehouseIds: [], byWindow };

  // 停用仓仍可能持有历史存货；历史快照也不能因当前仓模式不同而被丢弃。
  const warehouses: { id: number; accountingMode: string }[] = await db
    .select({ id: schema.warehouses.id, accountingMode: schema.warehouses.accountingMode }).from(schema.warehouses);
  const realtimeWarehouseIds = warehouses.filter((w) => w.accountingMode === "realtime").map((w) => w.id);
  const snapshotWarehouseIds = warehouses.filter((w) => w.accountingMode === "snapshot").map((w) => w.id);
  const skuIds = [...new Set(windows.map((w) => w.skuId))];
  const firstDay = windows.reduce((day, w) => w.fromDay < day ? w.fromDay : day, windows[0].fromDay);
  const lastDay = windows.reduce((day, w) => w.toDay > day ? w.toDay : day, windows[0].toDay);
  const l = schema.stockLedger;
  // 仅聚合首笔时点，不读取全历史明细；不要按本批末日裁剪，否则连弃权原因都会随批次变化。
  // 窗口之后的首笔只能使样本弃权，绝不能证明窗口起点覆盖。
  const firstLedger: { skuId: number; firstAt: Date | string }[] = realtimeWarehouseIds.length
    ? await db.select({ skuId: l.skuId, firstAt: sql<Date | string>`min(${l.occurredAt})` }).from(l)
      .where(and(inArray(l.skuId, skuIds), inArray(l.warehouseId, realtimeWarehouseIds)))
      .groupBy(l.skuId)
    : [];
  const firstLedgerBySku = new Map(firstLedger.map((r) => [r.skuId, new Date(r.firstAt).getTime()]));
  const initial = await getLatestSnapshotRows(db, { skuIds, asOf: firstDay });
  const s = schema.stockSnapshots;
  const changes: { warehouseId: number; skuId: number; qty: string; bizDate: string }[] = await db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, qty: s.qty, bizDate: s.bizDate }).from(s)
    .where(and(inArray(s.skuId, skuIds), gt(s.bizDate, firstDay), lte(s.bizDate, lastDay)))
    .orderBy(s.skuId, s.warehouseId, s.bizDate);
  const histories = new Map<number, Map<number, SnapshotHistory>>();
  for (const row of [...initial, ...changes]) {
    const perSku = histories.get(row.skuId) ?? new Map<number, SnapshotHistory>();
    const history = perSku.get(row.warehouseId) ?? { days: [], nonzero: [0], invalid: [0] };
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(row.bizDate) && shanghaiDay(row.bizDate) === row.bizDate
      && /^-?\d+(?:\.\d+)?$/.test(row.qty);
    history.days.push(row.bizDate);
    history.nonzero.push(history.nonzero.at(-1)! + (valid && dCmp(row.qty, "0") !== 0 ? 1 : 0));
    history.invalid.push(history.invalid.at(-1)! + (valid ? 0 : 1));
    perSku.set(row.warehouseId, history);
    histories.set(row.skuId, perSku);
  }

  for (const w of windows) {
    const firstAt = firstLedgerBySku.get(w.skuId);
    if (!realtimeWarehouseIds.length || firstAt == null || !Number.isFinite(firstAt)) {
      byWindow.set(w.key, unavailable("snapshot_only_no_realtime_ledger", "没有可用的实时仓流水证据，弃权不打分"));
      continue;
    }
    if (firstAt > w.fromMs) {
      byWindow.set(w.key, unavailable("realtime_ledger_starts_after_window_start", "实时仓首笔流水晚于窗口起点，不能把此前未知库存当作零，弃权不打分"));
      continue;
    }
    const perSku = histories.get(w.skuId);
    const required = new Set(snapshotWarehouseIds);
    for (const [warehouseId, history] of perSku ?? []) {
      // 另一窗口将来的快照不能改变本窗口的仓集合。
      if (history.days[0] <= w.toDay) required.add(warehouseId);
    }
    let incomplete = false;
    let nonzero = false;
    for (const warehouseId of required) {
      const history = perSku?.get(warehouseId);
      if (!history) { incomplete = true; continue; }
      const start = afterDay(history.days, w.fromDay) - 1;
      const end = afterDay(history.days, w.toDay);
      if (start < 0) incomplete = true;
      const firstRelevant = Math.max(0, start);
      if (history.invalid[end] - history.invalid[firstRelevant] > 0) incomplete = true;
      if (history.nonzero[end] - history.nonzero[firstRelevant] > 0) nonzero = true;
    }
    byWindow.set(w.key, nonzero
      ? { covered: false, coverage: "snapshot_mixed", reason: "snapshot_stock_outside_ledger",
          note: "该 SKU 在自身窗口的期初或期间存在非零快照仓在库；按仓检查不轧差，实时流水不足以核验，弃权不打分" }
      : incomplete
        ? unavailable("snapshot_history_incomplete", "登记快照仓缺少该 SKU 的明确期初零库存证据或存在无效快照，覆盖未知，弃权不打分")
        : { covered: true, coverage: "realtime", reason: null,
            note: "按已登记仓和上海日快照核验：起点已有实时流水，各快照仓期初及窗口内均明确为零；不代表未接入仓或日内轨迹已验证" });
  }
  return { realtimeWarehouseIds, byWindow };
}

/** 未加载的样本身份属于调用错误，不能默认成覆盖成功。 */
export function classifyLedgerCoverage(key: string, cov: StockUniverseCoverage): CoverageVerdict {
  const verdict = cov.byWindow.get(key);
  if (!verdict) throw new Error(`Stock coverage window not loaded: ${key}`);
  return verdict;
}
