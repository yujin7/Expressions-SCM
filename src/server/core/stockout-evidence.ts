/**
 * 「这条断货结论能不能用实时仓流水来打分」——**覆盖判定的唯一实现**（红队审计 A3）。
 *
 * 背景：全网在库口径（core/stock-view.getOnHandBySku）= 实时记账仓余额 **+ 各快照仓最新一期快照**。
 * 而回看断货是否发生只能靠 stock_ledger，**快照仓没有流水**。两个回看任务各写了一套判定，
 * 都只问了"这个 SKU 在实时仓有没有流水"：
 *  - jobs/alert-outcome.verifyOne：只要历史上在实时仓动过一笔，就标 `coverage: "realtime"` 并给出
 *    true_positive / false_positive——哪怕这个 SKU 的货**绝大部分躺在快照仓**。
 *    这个数进 alertPrecision，再进驾驶舱精确率块，是人调阈值时看的那个数。
 *  - report/closed-loop.getSuppressionReview：余额从 0 起算、只累计实时仓流水，
 *    一个从快照仓发货的 SKU 天然是负数 → **恒判"随后断货"**，抑制闸门被系统性判错。
 *
 * 纪律：**只有实时仓流水确实覆盖了这条告警/建议所指的那批货，才允许打真/误的分**；
 * 只要该 SKU 在窗口内还有快照仓在库，一律弃权（unverifiable）并给出覆盖原因。
 * 弃权比错误结论便宜——错误结论会被当成"阈值太松"的证据去调参数。
 */
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd, dCmp } from "@/server/core/decimal";
import { getLatestSnapshotRows } from "@/server/core/stock-view";
import type { AnyDb } from "@/server/core/svc";
import { shanghaiDayOf } from "@/server/core/business-day";

/** 覆盖档位：realtime=可打分；none=无实时流水；snapshot_mixed=有实时流水但货还在快照仓 */
export type LedgerCoverage = "realtime" | "none" | "snapshot_mixed";

export type CoverageReason =
  | "snapshot_only_no_realtime_ledger"
  | "snapshot_stock_outside_ledger";

export interface StockUniverseCoverage {
  realtimeWarehouseIds: number[];
  /** 在实时仓有过任何一笔流水的 SKU */
  skusWithRealtimeLedger: Set<number>;
  /** 截至 asOf，快照仓在库非零的 SKU → 实时仓流水看不见它们 */
  snapshotQtyBySku: Map<number, string>;
}

export interface CoverageVerdict {
  covered: boolean;
  coverage: LedgerCoverage;
  reason: CoverageReason | null;
  note: string;
}

const shanghaiDay = shanghaiDayOf;

/**
 * 一次性载入一批 SKU 的覆盖事实（每轮任务一次查询，不在逐条循环里查）。
 * `asOf` 取本轮所有窗口的**最晚一天**：判定偏保守（多弃权、不多打分），这正是想要的方向。
 */
export async function loadStockUniverseCoverage(
  db: AnyDb,
  opts: { skuIds: readonly number[]; asOf: Date },
): Promise<StockUniverseCoverage> {
  const skuIds = [...new Set(opts.skuIds)];
  const realtime: { id: number }[] = await db.select({ id: schema.warehouses.id }).from(schema.warehouses)
    .where(eq(schema.warehouses.accountingMode, "realtime"));
  const realtimeWarehouseIds = realtime.map((w) => w.id);
  const empty = { realtimeWarehouseIds, skusWithRealtimeLedger: new Set<number>(), snapshotQtyBySku: new Map<number, string>() };
  if (!skuIds.length) return empty;

  const l = schema.stockLedger;
  const ever: { skuId: number }[] = realtimeWarehouseIds.length
    ? await db.selectDistinct({ skuId: l.skuId }).from(l)
      .where(and(inArray(l.skuId, skuIds), inArray(l.warehouseId, realtimeWarehouseIds)))
    : [];
  const snapRows = await getLatestSnapshotRows(db, { skuIds, asOf: shanghaiDay(opts.asOf) });
  const snapshotQtyBySku = new Map<number, string>();
  for (const r of snapRows) snapshotQtyBySku.set(r.skuId, dAdd(snapshotQtyBySku.get(r.skuId) ?? "0", r.qty, 6));
  return { realtimeWarehouseIds, skusWithRealtimeLedger: new Set(ever.map((r) => r.skuId)), snapshotQtyBySku };
}

/** 该 SKU 能否用实时仓流水打分（唯一判定）。 */
export function classifyLedgerCoverage(skuId: number, cov: StockUniverseCoverage): CoverageVerdict {
  if (!cov.realtimeWarehouseIds.length) {
    return { covered: false, coverage: "none", reason: "snapshot_only_no_realtime_ledger", note: "没有实时记账仓，无流水可核验" };
  }
  if (!cov.skusWithRealtimeLedger.has(skuId)) {
    return { covered: false, coverage: "none", reason: "snapshot_only_no_realtime_ledger", note: "该 SKU 在实时仓无任何流水（快照仓 SKU），弃权不打分" };
  }
  const snap = cov.snapshotQtyBySku.get(skuId) ?? "0";
  if (dCmp(snap, "0") !== 0) {
    return {
      covered: false, coverage: "snapshot_mixed", reason: "snapshot_stock_outside_ledger",
      note: `该 SKU 窗口内仍有快照仓在库 ${snap}（全网在库口径含快照仓），实时仓流水覆盖不了告警所指的那批货，弃权不打分`,
    };
  }
  return { covered: true, coverage: "realtime", reason: null, note: "" };
}
