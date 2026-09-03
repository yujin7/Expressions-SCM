/**
 * 库存日级 / 月级读模型 `inventory-position/v1`（D51/D52；四屏第 1 屏 A1/A2/B 行与第 3 屏「各仓库存明细」的数据核）。
 *
 * 口径（只消费共享权威，不本地重实现）：
 * - 当前在库 = `core/stock-view`（实时仓 stock_balances + 快照仓最新快照），实时仓 / 快照仓**分列**；
 * - 当月至今逐日走向：实时仓按 stock_ledger.occurred_at 的 **Asia/Shanghai 日界** 分日聚合入/出；
 *   快照仓按同 (仓,SKU) **相邻 biz_date 差分**，落在后一快照日，标 source=snapshot_delta；缺日留空（null）不补零；
 * - 历史月末在库：实时仓由当前余额按流水**倒推**（月末 = 当前 − Σ该月之后的 qty_delta），流水最早日之前的月份留空；
 *   快照仓取**当月最后一期**快照，当月无快照留空；当月 = 当前时点；
 * - 环比 = `rules/period-compare.momPct`（上期缺/0 → null）；
 * - 金额全部经 `core/valuation`（sku_costs → 财务运营成本观察 → null），输出 coveragePct，
 *   覆盖率 < valuation_coverage_min_pct（缺省 80）标 incomplete；历史月按**当前**成本版本估值（无历史成本快照）。
 * - 缓存：report_read_model_cache，key 带 /v1，source_binding = stock_ledger max(id) + 最新快照 import_job/日期/行数
 *   + 成本来源版本（sku_costs 版本 + 财务观察批次）+ 口径日；任一变化即失效重算。
 *
 * 金额字段一律放在 `{ amount }` 对象里：`amount` 在 SENSITIVE_FIELDS，maskSensitive 会为非 PRICE_VISIBLE_ROLES 剥离，
 * 数量类字段全员可见（库存总量属公开内容，D62）。
 */
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dDiv, dNeg, dQty, dSub } from "@/server/core/decimal";
import { getNumParam } from "@/server/core/params";
import { getLatestSnapshotRows } from "@/server/core/stock-view";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import {
  latestFinanceCostBatch,
  resolveUnitCosts,
  type UnitCostResolution,
  type UnitCostSource,
  valueOnHand,
  type ValuationResult,
} from "@/server/core/valuation";
import { momPct } from "@/server/rules/period-compare";

export const INVENTORY_POSITION_CACHE_KEY = "inventory-position/v1";
/** D51：覆盖率门槛参数键（未登记时按 80） */
export const VALUATION_COVERAGE_PARAM_KEY = "valuation_coverage_min_pct";
export const DEFAULT_VALUATION_COVERAGE_MIN_PCT = 80;
const DEFAULT_HISTORY_MONTHS = 24; // 固定计算窗口：缓存只有一行，请求方按需切片（审阅 must-fix：months 参数不得打穿缓存）
/** 快照日差分回看：前一期快照允许落在上月（月初第一期与上月末差分） */
const SNAPSHOT_DELTA_LOOKBACK_DAYS = 45;

export interface ValueDto {
  /** 金额 scale 2（敏感键：非价格可见角色由 maskSensitive 剥离） */
  amount: string;
  /** 按数量的覆盖率 %（总量 0 → null） */
  coveragePct: number | null;
  /** 覆盖率 < 门槛 → 总额只能标「不完整」 */
  incomplete: boolean;
  coveredSkus: number;
  uncoveredSkus: number;
  bySource: Record<UnitCostSource, { amount: string; qty: string; skus: number }>;
}

export interface QtyBlock {
  /** 数量 scale 4（跨 SKU 按基础单位直加，仅作规模参考） */
  qty: string;
  skus: number;
  value: ValueDto;
}

export interface DailyRealtime {
  in: string;
  out: string;
  net: string;
  inValue: ValueDto;
  outValue: ValueDto;
  /** 当日流水行数（0 = 有账期覆盖但无异动） */
  ledgerRows: number;
}

export interface DailySnapshotDelta {
  source: "snapshot_delta";
  in: string;
  out: string;
  net: string;
  netValue: ValueDto;
  /** 参与差分的快照仓数 */
  warehouses: number;
  /** 差分跨越的最大天数（>1 = 中间缺日，差分含多日累计） */
  maxSpanDays: number;
}

export interface DailyPoint {
  date: string;
  /** 实时仓（null = 该日早于流水最早日，无账期覆盖） */
  realtime: DailyRealtime | null;
  /** 快照仓（null = 该日无快照或无前一期可差分——缺日留空不补零） */
  snapshot: DailySnapshotDelta | null;
}

export interface MonthEndPart {
  qty: string;
  skus: number;
  value: ValueDto;
  /** 快照仓：该月参与的最晚快照日；实时仓：月末日 */
  asOf: string | null;
}

export interface MonthEndPoint {
  yearMonth: string;
  isCurrent: boolean;
  /** null = 流水最早日之后才有账期覆盖（缺月留空） */
  realtime: MonthEndPart | null;
  /** null = 当月无快照（缺月留空） */
  snapshot: MonthEndPart | null;
  /** 可用部分之和；两侧皆空 → null */
  total: { qty: string; value: ValueDto; parts: ("realtime" | "snapshot")[] } | null;
  momQtyPct: number | null;
  momValuePct: number | null;
}

export interface WarehouseBlock {
  warehouseId: number;
  code: string;
  name: string;
  kind: string;
  mode: "realtime" | "snapshot";
  regionCode: string;
  parentId: number | null;
  active: boolean;
  qty: string;
  skus: number;
  /** 快照仓最新 bizDate；实时仓 null */
  bizDate: string | null;
  value: ValueDto;
}

export interface InventoryPositionReadModel {
  key: typeof INVENTORY_POSITION_CACHE_KEY;
  builtAt: string;
  sourceBinding: string;
  today: string;
  currentMonth: string;
  monthStart: string;
  valuationCoverageMinPct: number;
  /** 流水最早业务日（上海日界）；无流水 = null */
  ledgerFirstDay: string | null;
  /** 快照仓最新快照日；无快照 = null */
  latestSnapshotDate: string | null;
  current: {
    realtime: QtyBlock;
    snapshot: QtyBlock & { bizDate: string | null };
    total: QtyBlock;
  };
  daily: DailyPoint[];
  monthEnd: MonthEndPoint[];
  warehouses: WarehouseBlock[];
  limitations: string[];
}

export interface InventoryPositionOptions {
  /** 口径日（YYYY-MM-DD，缺省 Asia/Shanghai 今日） */
  today?: string;
  /** 历史月数（不含当月），缺省 12 */
  historyMonths?: number;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** Asia/Shanghai 今日 YYYY-MM-DD */
export function todayShanghai(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
}

function assertDay(d: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`日期须为 YYYY-MM-DD: ${d}`);
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${ym}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function monthShift(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const isNum = (v: unknown): v is string => typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim());
const qtyOf = (v: unknown): string => (isNum(v) ? dQty(v) : typeof v === "number" && Number.isFinite(v) ? dQty(v) : "0.0000");

function valueDto(v: ValuationResult, minPct: number): ValueDto {
  return {
    amount: v.amount,
    coveragePct: v.coveragePct,
    incomplete: v.coveragePct != null && v.coveragePct < minPct,
    coveredSkus: v.coveredSkus,
    uncoveredSkus: v.uncoveredSkus,
    bySource: {
      sku_costs: { ...v.bySource.sku_costs },
      finance_observation: { ...v.bySource.finance_observation },
    },
  };
}

function qtyBlock(bySku: Map<number, string>, costs: Map<number, UnitCostResolution>, minPct: number): QtyBlock {
  let qty = "0.0000";
  const rows: { skuId: number; qty: string }[] = [];
  for (const [skuId, q] of bySku) {
    if (dCmp(q, 0) === 0) continue;
    qty = dAdd(qty, q, 4);
    rows.push({ skuId, qty: q });
  }
  return { qty, skus: rows.length, value: valueDto(valueOnHand(rows, costs), minPct) };
}

function addTo(map: Map<number, string>, skuId: number, qty: string): void {
  map.set(skuId, dAdd(map.get(skuId) ?? "0", qty, 4));
}

/** 缓存绑定：流水 / 快照 / 成本版本 / 口径日任一变化即失效 */
export async function inventoryPositionBinding(db: AnyDb, opts: InventoryPositionOptions = {}): Promise<string> {
  const today = opts.today ?? todayShanghai();
  const months = opts.historyMonths ?? DEFAULT_HISTORY_MONTHS;
  const [row] = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT (SELECT coalesce(max(id), 0) FROM stock_ledger)::text AS ledger_max,
           (SELECT count(*) FROM stock_ledger)::text AS ledger_n,
           (SELECT coalesce(max(import_job_id), 0) FROM stock_snapshots)::text AS snap_job,
           (SELECT coalesce(max(biz_date)::text, '') FROM stock_snapshots) AS snap_date,
           (SELECT count(*) FROM stock_snapshots)::text AS snap_n,
           (SELECT coalesce(max(updated_at)::text, '') FROM sku_costs) AS cost_at,
           (SELECT count(*) FROM sku_costs)::text AS cost_n
  `));
  const finance = await latestFinanceCostBatch(db);
  const minPct = await getNumParam(VALUATION_COVERAGE_PARAM_KEY, DEFAULT_VALUATION_COVERAGE_MIN_PCT, db);
  return [
    `ledger:${String(row?.ledger_max ?? 0)}:${String(row?.ledger_n ?? 0)}`,
    `snap:${String(row?.snap_job ?? 0)}:${String(row?.snap_date ?? "")}:${String(row?.snap_n ?? 0)}`,
    `cost:${String(row?.cost_at ?? "")}:${String(row?.cost_n ?? 0)}:fin=${finance ?? "none"}`,
    `day:${today}:m${months}:min${minPct}`,
  ].join("|");
}

export async function computeInventoryPosition(
  dbArg: AnyDb | undefined,
  opts: InventoryPositionOptions = {},
): Promise<InventoryPositionReadModel> {
  const db = await resolveDb(dbArg);
  const today = opts.today ?? todayShanghai();
  assertDay(today);
  const historyMonths = opts.historyMonths ?? DEFAULT_HISTORY_MONTHS;
  if (!Number.isInteger(historyMonths) || historyMonths < 0 || historyMonths > 60) throw new Error(`historyMonths 须为 0–60 的整数: ${historyMonths}`);
  const currentMonth = today.slice(0, 7);
  const monthStart = `${currentMonth}-01`;
  const firstHistoryMonth = monthShift(currentMonth, -historyMonths);
  const minPct = await getNumParam(VALUATION_COVERAGE_PARAM_KEY, DEFAULT_VALUATION_COVERAGE_MIN_PCT, db);
  const sourceBinding = await inventoryPositionBinding(db, { today, historyMonths });

  /* ── 主数据：仓库 ── */
  const whRows: {
    id: number; code: string; name: string; kind: string; accountingMode: "realtime" | "snapshot";
    regionCode: string; parentId: number | null; active: boolean;
  }[] = await db.select({
    id: schema.warehouses.id, code: schema.warehouses.code, name: schema.warehouses.name, kind: schema.warehouses.kind,
    accountingMode: schema.warehouses.accountingMode, regionCode: schema.warehouses.regionCode,
    parentId: schema.warehouses.parentId, active: schema.warehouses.active,
  }).from(schema.warehouses);
  const whById = new Map(whRows.map((w) => [w.id, w]));

  /* ── 当前在库：实时仓余额（按仓×SKU）+ 快照仓最新快照（stock-view 唯一实现）── */
  const balRows = resultRows<{ warehouse_id: unknown; sku_id: unknown; qty: unknown }>(await db.execute(sql`
    SELECT warehouse_id, sku_id, sum(qty)::text AS qty FROM stock_balances GROUP BY warehouse_id, sku_id
  `));
  const snapRows = await getLatestSnapshotRows(db);

  /* ── 流水：最早日 / 当月逐日 / 历史逐月 ── */
  const [ledgerMeta] = resultRows<{ first_day: string | null }>(await db.execute(sql`
    SELECT min((occurred_at AT TIME ZONE 'Asia/Shanghai')::date)::text AS first_day FROM stock_ledger
  `));
  const ledgerFirstDay = ledgerMeta?.first_day ?? null;
  const dailyLedger = resultRows<{ d: string; sku_id: unknown; in_qty: string; out_qty: string; n: unknown }>(await db.execute(sql`
    SELECT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date::text AS d, sku_id,
           sum(CASE WHEN qty_delta > 0 THEN qty_delta ELSE 0 END)::text AS in_qty,
           sum(CASE WHEN qty_delta < 0 THEN -qty_delta ELSE 0 END)::text AS out_qty,
           count(*) AS n
    FROM stock_ledger
    WHERE (occurred_at AT TIME ZONE 'Asia/Shanghai')::date >= ${monthStart}::date
      AND (occurred_at AT TIME ZONE 'Asia/Shanghai')::date <= ${today}::date
    GROUP BY 1, 2
  `));
  const monthlyLedger = resultRows<{ ym: string; sku_id: unknown; delta: string }>(await db.execute(sql`
    SELECT to_char(occurred_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS ym, sku_id, sum(qty_delta)::text AS delta
    FROM stock_ledger
    WHERE to_char(occurred_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') > ${firstHistoryMonth}
    GROUP BY 1, 2
  `));

  /* ── 快照：历史各月最后一期（按仓）/ 当月相邻差分 ── */
  const monthSnap = resultRows<{ ym: string; warehouse_id: unknown; sku_id: unknown; qty: string; d: string }>(await db.execute(sql`
    WITH last AS (
      SELECT warehouse_id, to_char(biz_date, 'YYYY-MM') AS ym, max(biz_date) AS d
      FROM stock_snapshots
      WHERE to_char(biz_date, 'YYYY-MM') >= ${firstHistoryMonth} AND to_char(biz_date, 'YYYY-MM') < ${currentMonth}
      GROUP BY 1, 2
    )
    SELECT l.ym, s.warehouse_id, s.sku_id, s.qty::text AS qty, s.biz_date::text AS d
    FROM stock_snapshots s
    INNER JOIN last l ON l.warehouse_id = s.warehouse_id AND l.d = s.biz_date
  `));
  const deltaRows = resultRows<{ warehouse_id: unknown; sku_id: unknown; d: string; qty: string; prev_qty: string | null; prev_d: string | null }>(await db.execute(sql`
    SELECT warehouse_id, sku_id, biz_date::text AS d, qty::text AS qty,
           (lag(qty) OVER w)::text AS prev_qty, (lag(biz_date) OVER w)::text AS prev_d
    FROM stock_snapshots
    WHERE biz_date >= ${shiftDay(monthStart, -SNAPSHOT_DELTA_LOOKBACK_DAYS)}::date AND biz_date <= ${today}::date
    WINDOW w AS (PARTITION BY warehouse_id, sku_id ORDER BY biz_date)
  `));

  /* ── 单位成本（一次解析全部涉及 SKU）── */
  const skuIds = new Set<number>();
  for (const r of balRows) skuIds.add(Number(r.sku_id));
  for (const r of snapRows) skuIds.add(r.skuId);
  for (const r of dailyLedger) skuIds.add(Number(r.sku_id));
  for (const r of monthlyLedger) skuIds.add(Number(r.sku_id));
  for (const r of monthSnap) skuIds.add(Number(r.sku_id));
  for (const r of deltaRows) skuIds.add(Number(r.sku_id));
  const costs = await resolveUnitCosts(db, [...skuIds]);

  /* ── 当前在库分列 + 各仓明细 ── */
  const realtimeBySku = new Map<number, string>();
  const snapshotBySku = new Map<number, string>();
  const whAgg = new Map<number, { bySku: Map<number, string>; mode: "realtime" | "snapshot"; bizDate: string | null }>();
  for (const r of balRows) {
    const skuId = Number(r.sku_id);
    const whId = Number(r.warehouse_id);
    const q = qtyOf(r.qty);
    addTo(realtimeBySku, skuId, q);
    const e = whAgg.get(whId) ?? { bySku: new Map<number, string>(), mode: "realtime" as const, bizDate: null };
    addTo(e.bySku, skuId, q);
    whAgg.set(whId, e);
  }
  let latestSnapshotDate: string | null = null;
  for (const r of snapRows) {
    const q = qtyOf(r.qty);
    addTo(snapshotBySku, r.skuId, q);
    if (latestSnapshotDate == null || r.bizDate > latestSnapshotDate) latestSnapshotDate = r.bizDate;
    const e = whAgg.get(r.warehouseId) ?? { bySku: new Map<number, string>(), mode: "snapshot" as const, bizDate: null };
    addTo(e.bySku, r.skuId, q);
    e.mode = "snapshot";
    if (e.bizDate == null || r.bizDate > e.bizDate) e.bizDate = r.bizDate;
    whAgg.set(r.warehouseId, e);
  }
  const totalBySku = new Map<number, string>();
  for (const [k, v] of realtimeBySku) addTo(totalBySku, k, v);
  for (const [k, v] of snapshotBySku) addTo(totalBySku, k, v);
  const current = {
    realtime: qtyBlock(realtimeBySku, costs, minPct),
    snapshot: { ...qtyBlock(snapshotBySku, costs, minPct), bizDate: latestSnapshotDate },
    total: qtyBlock(totalBySku, costs, minPct),
  };
  const warehouses: WarehouseBlock[] = [...whAgg.entries()]
    .map(([id, e]) => {
      const w = whById.get(id);
      const block = qtyBlock(e.bySku, costs, minPct);
      return {
        warehouseId: id,
        code: w?.code ?? `#${id}`,
        name: w?.name ?? `#${id}`,
        kind: w?.kind ?? "unknown",
        mode: w?.accountingMode ?? e.mode,
        regionCode: w?.regionCode ?? "CN",
        parentId: w?.parentId ?? null,
        active: w?.active ?? true,
        qty: block.qty,
        skus: block.skus,
        bizDate: (w?.accountingMode ?? e.mode) === "snapshot" ? e.bizDate : null,
        value: block.value,
      };
    })
    .sort((a, b) => dCmp(b.qty, a.qty) || a.warehouseId - b.warehouseId);

  /* ── 当月逐日 ── */
  const ledgerByDay = new Map<string, { inRows: { skuId: number; qty: string }[]; outRows: { skuId: number; qty: string }[]; n: number }>();
  for (const r of dailyLedger) {
    const e = ledgerByDay.get(r.d) ?? { inRows: [], outRows: [], n: 0 };
    const skuId = Number(r.sku_id);
    if (dCmp(r.in_qty, 0) > 0) e.inRows.push({ skuId, qty: qtyOf(r.in_qty) });
    if (dCmp(r.out_qty, 0) > 0) e.outRows.push({ skuId, qty: qtyOf(r.out_qty) });
    e.n += Number(r.n) || 0;
    ledgerByDay.set(r.d, e);
  }
  const snapByDay = new Map<string, { rows: { skuId: number; qty: string }[]; warehouses: Set<number>; maxSpan: number }>();
  for (const r of deltaRows) {
    if (r.prev_qty == null || r.prev_d == null) continue;
    if (r.d < monthStart || r.d > today) continue;
    const delta = dSub(qtyOf(r.qty), qtyOf(r.prev_qty), 4);
    const e = snapByDay.get(r.d) ?? { rows: [], warehouses: new Set<number>(), maxSpan: 0 };
    e.rows.push({ skuId: Number(r.sku_id), qty: delta });
    e.warehouses.add(Number(r.warehouse_id));
    e.maxSpan = Math.max(e.maxSpan, spanDays(r.prev_d, r.d));
    snapByDay.set(r.d, e);
  }
  const daily: DailyPoint[] = [];
  for (let d = monthStart; d <= today; d = shiftDay(d, 1)) {
    let realtime: DailyRealtime | null = null;
    if (ledgerFirstDay != null && d >= ledgerFirstDay) {
      const e = ledgerByDay.get(d) ?? { inRows: [], outRows: [], n: 0 };
      const inQty = e.inRows.reduce((acc, r) => dAdd(acc, r.qty, 4), "0.0000");
      const outQty = e.outRows.reduce((acc, r) => dAdd(acc, r.qty, 4), "0.0000");
      realtime = {
        in: inQty, out: outQty, net: dSub(inQty, outQty, 4),
        inValue: valueDto(valueOnHand(e.inRows, costs), minPct),
        outValue: valueDto(valueOnHand(e.outRows, costs), minPct),
        ledgerRows: e.n,
      };
    }
    let snapshot: DailySnapshotDelta | null = null;
    const s = snapByDay.get(d);
    if (s) {
      let inQty = "0.0000";
      let outQty = "0.0000";
      for (const r of s.rows) {
        if (dCmp(r.qty, 0) > 0) inQty = dAdd(inQty, r.qty, 4);
        else if (dCmp(r.qty, 0) < 0) outQty = dAdd(outQty, dNeg(r.qty, 4), 4);
      }
      // 净变动估值：正负各自计价后相减；覆盖率按 |变动量| 合并计算
      const inV = valueOnHand(s.rows.filter((r) => dCmp(r.qty, 0) > 0), costs);
      const outV = valueOnHand(s.rows.filter((r) => dCmp(r.qty, 0) < 0).map((r) => ({ skuId: r.skuId, qty: dNeg(r.qty, 4) })), costs);
      const absV = valueOnHand(s.rows.map((r) => ({ skuId: r.skuId, qty: dCmp(r.qty, 0) < 0 ? dNeg(r.qty, 4) : r.qty })), costs);
      const netValue: ValueDto = {
        ...valueDto(absV, minPct),
        amount: dSub(inV.amount, outV.amount, 2),
        bySource: {
          sku_costs: { ...absV.bySource.sku_costs, amount: dSub(inV.bySource.sku_costs.amount, outV.bySource.sku_costs.amount, 2) },
          finance_observation: { ...absV.bySource.finance_observation, amount: dSub(inV.bySource.finance_observation.amount, outV.bySource.finance_observation.amount, 2) },
        },
      };
      snapshot = {
        source: "snapshot_delta",
        in: inQty, out: outQty, net: dSub(inQty, outQty, 4),
        netValue,
        warehouses: s.warehouses.size,
        maxSpanDays: s.maxSpan,
      };
    }
    daily.push({ date: d, realtime, snapshot });
  }

  /* ── 历史月末序列（倒推）── */
  const deltaByMonth = new Map<string, Map<number, string>>();
  for (const r of monthlyLedger) {
    const m = deltaByMonth.get(r.ym) ?? new Map<number, string>();
    addTo(m, Number(r.sku_id), qtyOf(r.delta));
    deltaByMonth.set(r.ym, m);
  }
  const snapByMonth = new Map<string, { bySku: Map<number, string>; asOf: string | null }>();
  for (const r of monthSnap) {
    const e = snapByMonth.get(r.ym) ?? { bySku: new Map<number, string>(), asOf: null };
    addTo(e.bySku, Number(r.sku_id), qtyOf(r.qty));
    if (e.asOf == null || r.d > e.asOf) e.asOf = r.d;
    snapByMonth.set(r.ym, e);
  }
  const months: string[] = [];
  for (let i = historyMonths; i >= 1; i--) months.push(monthShift(currentMonth, -i));
  // 从当月起往前倒推：running = 当前实时余额；每退一个月，减去「该月之后那个月」的 Σdelta
  const running = new Map<number, string>(realtimeBySku);
  const realtimeMonthEnd = new Map<string, Map<number, string>>();
  let cursor = currentMonth;
  for (let i = months.length - 1; i >= 0; i--) {
    const ym = months[i];
    const deltaAfter = deltaByMonth.get(cursor); // cursor 月内的变动 = ym 月末之后、cursor 月末之前
    if (deltaAfter) for (const [skuId, dlt] of deltaAfter) running.set(skuId, dSub(running.get(skuId) ?? "0", dlt, 4));
    realtimeMonthEnd.set(ym, new Map(running));
    cursor = ym;
  }
  const monthEnd: MonthEndPoint[] = [];
  const buildPoint = (ym: string, isCurrent: boolean): MonthEndPoint => {
    const endDay = isCurrent ? today : lastDayOfMonth(ym);
    let realtime: MonthEndPart | null = null;
    if (ledgerFirstDay != null && endDay >= ledgerFirstDay) {
      const bySku = isCurrent ? realtimeBySku : (realtimeMonthEnd.get(ym) ?? new Map<number, string>());
      const b = qtyBlock(bySku, costs, minPct);
      realtime = { qty: b.qty, skus: b.skus, value: b.value, asOf: endDay };
    }
    let snapshot: MonthEndPart | null = null;
    if (isCurrent) {
      if (latestSnapshotDate != null) {
        const b = qtyBlock(snapshotBySku, costs, minPct);
        snapshot = { qty: b.qty, skus: b.skus, value: b.value, asOf: latestSnapshotDate };
      }
    } else {
      const s = snapByMonth.get(ym);
      if (s) {
        const b = qtyBlock(s.bySku, costs, minPct);
        snapshot = { qty: b.qty, skus: b.skus, value: b.value, asOf: s.asOf };
      }
    }
    let total: MonthEndPoint["total"] = null;
    if (realtime || snapshot) {
      const bySku = new Map<number, string>();
      const parts: ("realtime" | "snapshot")[] = [];
      if (realtime) {
        parts.push("realtime");
        for (const [k, v] of isCurrent ? realtimeBySku : (realtimeMonthEnd.get(ym) ?? new Map<number, string>())) addTo(bySku, k, v);
      }
      if (snapshot) {
        parts.push("snapshot");
        for (const [k, v] of isCurrent ? snapshotBySku : (snapByMonth.get(ym)?.bySku ?? new Map<number, string>())) addTo(bySku, k, v);
      }
      const b = qtyBlock(bySku, costs, minPct);
      total = { qty: b.qty, value: b.value, parts };
    }
    return { yearMonth: ym, isCurrent, realtime, snapshot, total, momQtyPct: null, momValuePct: null };
  };
  for (const ym of months) monthEnd.push(buildPoint(ym, false));
  monthEnd.push(buildPoint(currentMonth, true));
  for (let i = 1; i < monthEnd.length; i++) {
    const cur = monthEnd[i].total;
    const prev = monthEnd[i - 1].total;
    monthEnd[i].momQtyPct = momPct(cur?.qty ?? null, prev?.qty ?? null);
    const curV = cur && !cur.value.incomplete ? cur.value.amount : null;
    const prevV = prev && !prev.value.incomplete ? prev.value.amount : null;
    monthEnd[i].momValuePct = momPct(curV, prevV);
  }

  return {
    key: INVENTORY_POSITION_CACHE_KEY,
    builtAt: new Date().toISOString(),
    sourceBinding,
    today,
    currentMonth,
    monthStart,
    valuationCoverageMinPct: minPct,
    ledgerFirstDay,
    latestSnapshotDate,
    current,
    daily,
    monthEnd,
    warehouses,
    limitations: [
      "当月 = 当前时点在库（D52）；历史月末：实时仓由当前余额按流水倒推，快照仓取当月最后一期快照；缺月留空不补零。",
      "逐日走向：实时仓按流水 Asia/Shanghai 日界；快照仓按相邻快照差分并标 source=snapshot_delta，差分跨越多日时为累计值。",
      "金额 = 数量 × 单位成本（sku_costs → 财务运营成本观察 → 无），历史月按当前成本版本估值；覆盖率低于门槛的总额标「不完整」，环比不用不完整金额。",
      "跨 SKU 数量按基础单位直加，仅作规模参考；非财务账面。",
    ],
  };
}

/** 读缓存；绑定不一致则重算并写回 */
export async function loadInventoryPosition(dbArg?: AnyDb, opts: InventoryPositionOptions = {}): Promise<InventoryPositionReadModel> {
  const db = await resolveDb(dbArg);
  // 生产路径（API/任务/占比读模型）不传 historyMonths → 统一 24 月窗口、单一缓存绑定；只有测试/内部调用才传显式窗口
  const binding = await inventoryPositionBinding(db, opts);
  const [cached] = resultRows<{ payload: unknown }>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${INVENTORY_POSITION_CACHE_KEY} AND source_binding = ${binding} LIMIT 1
  `));
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload) as unknown; } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<InventoryPositionReadModel>).key === INVENTORY_POSITION_CACHE_KEY
    && Array.isArray((parsed as Partial<InventoryPositionReadModel>).daily)) {
    return parsed as InventoryPositionReadModel;
  }
  return refreshInventoryPosition(db, opts);
}

/** 强制重算并写缓存（任务 / 手动刷新） */
export async function refreshInventoryPosition(dbArg?: AnyDb, opts: InventoryPositionOptions = {}): Promise<InventoryPositionReadModel> {
  const db = await resolveDb(dbArg);
  const result = await computeInventoryPosition(db, opts);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${INVENTORY_POSITION_CACHE_KEY}, ${result.sourceBinding}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return result;
}

/** 月均库存金额 =（上月末 + 本月末）/ 2；任一缺失或不完整 → null（供占比读模型并列口径） */
export function monthAverageAmount(prev: MonthEndPoint | null | undefined, cur: MonthEndPoint | null | undefined): string | null {
  const a = prev?.total && !prev.total.value.incomplete ? prev.total.value.amount : null;
  const b = cur?.total && !cur.total.value.incomplete ? cur.total.value.amount : null;
  if (a == null || b == null) return null;
  return dDiv(dAdd(a, b, 2), 2, 2);
}
