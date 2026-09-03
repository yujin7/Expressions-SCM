/**
 * 库存占比读模型 `inventory-sales-ratio/v1`（D54；四屏第 1 屏 A4 卡与 B 行「占比」Tab）。
 *
 * 占比 = 月末库存金额 ÷ 当月销售金额 × 100（并列「月均库存」版本：(上月末 + 本月末)/2 ÷ 当月销售金额）。
 * - 分子：`inventory-position/v1` 月末序列（实时仓倒推 + 快照仓当月最后快照，经 core/valuation 估值；
 *   估值覆盖率不足门槛的月份分子按 null 处理并给出 gate）；
 * - 分母：sales_amount_monthly 公司口径链尾（finance 手工录入 / 观察预填）；
 * - 目标带：sys_params inventory_sales_ratio_target_low / high（缺省 45/47），基线 50（会议口径）；
 *   着色：红 > 基线、黄 (high, 基线]、绿 [low, high]、蓝 < low；
 * - 缺任一侧 → ratio=null + gate 文案（不补零、不猜）；环比用 rules/period-compare.momPointDiff（百分点差）。
 * - 分子按成本、分母按售价，非同口径；只作管理指标，不进补货/关账。
 *
 * 敏感性：月末/月均金额放 `{ amount }`、销售金额键 salesAmount——均在 SENSITIVE_FIELDS；占比数值本身
 * 由路由限定 PRICE_VISIBLE_ROLES（A2 ∩ A3 口径），其他角色 403 由前端显示无权限空态。
 */
import { sql } from "drizzle-orm";
import { type Dec, dCmp, dDiv, dMul } from "@/server/core/decimal";
import { getNumParam } from "@/server/core/params";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { listSalesAmountMonthly } from "@/server/modules/master/sales-amount";
import { inventoryPositionBinding, loadInventoryPosition, monthAverageAmount, type MonthEndPoint } from "@/server/modules/report/inventory-position";
import { momPointDiff } from "@/server/rules/period-compare";

export const INVENTORY_SALES_RATIO_CACHE_KEY = "inventory-sales-ratio/v1";
export const RATIO_TARGET_LOW_KEY = "inventory_sales_ratio_target_low";
export const RATIO_TARGET_HIGH_KEY = "inventory_sales_ratio_target_high";
export const RATIO_BASELINE_PCT = 50;
export const DEFAULT_RATIO_TARGET = { low: 45, high: 47 } as const;

export type RatioBand = "red" | "yellow" | "green" | "blue";

export interface RatioTargets {
  low: number;
  high: number;
  baseline: number;
}

/** 占比 %（2dp）；分子/分母缺失或分母 ≤ 0 → null */
export function ratioPct(inventoryAmount: Dec | null | undefined, salesAmount: Dec | null | undefined): number | null {
  if (inventoryAmount == null || salesAmount == null) return null;
  if (dCmp(salesAmount, 0) <= 0) return null;
  return Number(dMul(dDiv(inventoryAmount, salesAmount, 6), 100, 2));
}

/** 目标带着色：红 > 基线；黄 (high, 基线]；绿 [low, high]；蓝 < low；pct 为 null → null */
export function ratioBand(pct: number | null, t: RatioTargets): RatioBand | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct > t.baseline) return "red";
  if (pct > t.high) return "yellow";
  if (pct >= t.low) return "green";
  return "blue";
}

export interface RatioMonthRow {
  yearMonth: string;
  isCurrent: boolean;
  /** 月末库存金额（敏感键 amount；null = 无月末在库或估值不完整） */
  inventoryMonthEnd: { amount: string; coveragePct: number | null } | null;
  /** 月均库存金额 =（上月末 + 本月末）/ 2 */
  inventoryAvg: { amount: string } | null;
  /** 当月销售金额（公司口径链尾；敏感键） */
  salesAmount: string | null;
  salesSource: "manual" | "prefill_observation" | null;
  ratioMonthEndPct: number | null;
  ratioAvgPct: number | null;
  band: RatioBand | null;
  bandAvg: RatioBand | null;
  /** 与上月占比的百分点差 */
  momPoints: number | null;
  /** 缺任一侧时的原因文案；两侧齐全 = null */
  gate: string | null;
}

export interface InventorySalesRatioReadModel {
  key: typeof INVENTORY_SALES_RATIO_CACHE_KEY;
  builtAt: string;
  sourceBinding: string;
  currentMonth: string;
  target: RatioTargets;
  rows: RatioMonthRow[];
  /** 当月行（便于卡片直接取） */
  current: RatioMonthRow;
  formula: string;
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function loadRatioTargets(db: AnyDb): Promise<RatioTargets> {
  const [low, high] = await Promise.all([
    getNumParam(RATIO_TARGET_LOW_KEY, DEFAULT_RATIO_TARGET.low, db),
    getNumParam(RATIO_TARGET_HIGH_KEY, DEFAULT_RATIO_TARGET.high, db),
  ]);
  return { low: Math.min(low, high), high: Math.max(low, high), baseline: RATIO_BASELINE_PCT };
}

export async function inventorySalesRatioBinding(db: AnyDb, opts: { today?: string; historyMonths?: number } = {}): Promise<string> {
  const [pos, t, sales] = await Promise.all([
    inventoryPositionBinding(db, opts),
    loadRatioTargets(db),
    db.execute(sql`SELECT coalesce(max(id), 0)::text AS m, count(*)::text AS n FROM sales_amount_monthly`),
  ]);
  const [s] = resultRows<{ m: unknown; n: unknown }>(sales);
  return `${pos}|sales:${String(s?.m ?? 0)}:${String(s?.n ?? 0)}|target:${t.low}:${t.high}:${t.baseline}`;
}

function gateOf(inv: MonthEndPoint, sales: string | null): string | null {
  const reasons: string[] = [];
  if (!inv.total) reasons.push("缺月末库存（该月无流水覆盖且无快照）");
  else if (inv.total.value.incomplete) reasons.push(`库存估值覆盖率 ${inv.total.value.coveragePct ?? "—"}% 低于门槛，金额不完整`);
  if (sales == null) reasons.push("缺当月销售金额（财务未录入，可用观察预填）");
  else if (dCmp(sales, 0) <= 0) reasons.push("当月销售金额为 0，占比无意义");
  return reasons.length ? reasons.join("；") : null;
}

export async function computeInventorySalesRatio(
  dbArg?: AnyDb,
  opts: { today?: string; historyMonths?: number } = {},
): Promise<InventorySalesRatioReadModel> {
  const db = await resolveDb(dbArg);
  const [position, target, sourceBinding] = await Promise.all([
    loadInventoryPosition(db, opts),
    loadRatioTargets(db),
    inventorySalesRatioBinding(db, opts),
  ]);
  const months = position.monthEnd.map((m) => m.yearMonth);
  const { rows: salesRows } = await listSalesAmountMonthly(
    { scopeKind: "company", scopeId: null, fromMonth: months[0], toMonth: months[months.length - 1], pageSize: 500 },
    db,
  );
  const salesByMonth = new Map(salesRows.map((r) => [r.yearMonth, r]));

  const rows: RatioMonthRow[] = position.monthEnd.map((inv, i) => {
    const sales = salesByMonth.get(inv.yearMonth) ?? null;
    const salesAmount = sales?.salesAmount ?? null;
    const monthEndAmount = inv.total && !inv.total.value.incomplete ? inv.total.value.amount : null;
    const avgAmount = monthAverageAmount(i > 0 ? position.monthEnd[i - 1] : null, inv);
    const ratioMonthEndPct = ratioPct(monthEndAmount, salesAmount);
    const ratioAvgPct = ratioPct(avgAmount, salesAmount);
    return {
      yearMonth: inv.yearMonth,
      isCurrent: inv.isCurrent,
      inventoryMonthEnd: monthEndAmount == null ? null : { amount: monthEndAmount, coveragePct: inv.total?.value.coveragePct ?? null },
      inventoryAvg: avgAmount == null ? null : { amount: avgAmount },
      salesAmount,
      salesSource: sales?.source ?? null,
      ratioMonthEndPct,
      ratioAvgPct,
      band: ratioBand(ratioMonthEndPct, target),
      bandAvg: ratioBand(ratioAvgPct, target),
      momPoints: null,
      gate: gateOf(inv, salesAmount),
    };
  });
  for (let i = 1; i < rows.length; i++) rows[i].momPoints = momPointDiff(rows[i].ratioMonthEndPct, rows[i - 1].ratioMonthEndPct);

  return {
    key: INVENTORY_SALES_RATIO_CACHE_KEY,
    builtAt: new Date().toISOString(),
    sourceBinding,
    currentMonth: position.currentMonth,
    target,
    rows,
    current: rows[rows.length - 1],
    formula: "月末库存金额 ÷ 当月销售金额 × 100；并列（上月末 + 本月末）/ 2 ÷ 当月销售金额",
    limitations: [
      "分子按成本（sku_costs → 财务运营成本观察）、分母按售价（财务口径），非同口径；基线 50%（D54）。",
      "当月分子 = 当前时点在库，月未结束时占比偏高/偏低属正常，月末再看。",
      "缺任一侧不出数（null + 原因），不补零；历史月不强制补录。",
    ],
  };
}

export async function loadInventorySalesRatio(dbArg?: AnyDb, opts: { today?: string; historyMonths?: number } = {}): Promise<InventorySalesRatioReadModel> {
  const db = await resolveDb(dbArg);
  const binding = await inventorySalesRatioBinding(db, opts);
  const [cached] = resultRows<{ payload: unknown }>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${INVENTORY_SALES_RATIO_CACHE_KEY} AND source_binding = ${binding} LIMIT 1
  `));
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload) as unknown; } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<InventorySalesRatioReadModel>).key === INVENTORY_SALES_RATIO_CACHE_KEY
    && Array.isArray((parsed as Partial<InventorySalesRatioReadModel>).rows)) {
    return parsed as InventorySalesRatioReadModel;
  }
  return refreshInventorySalesRatio(db, opts);
}

export async function refreshInventorySalesRatio(dbArg?: AnyDb, opts: { today?: string; historyMonths?: number } = {}): Promise<InventorySalesRatioReadModel> {
  const db = await resolveDb(dbArg);
  const result = await computeInventorySalesRatio(db, opts);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${INVENTORY_SALES_RATIO_CACHE_KEY}, ${result.sourceBinding}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return result;
}
