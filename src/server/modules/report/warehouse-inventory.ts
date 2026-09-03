/**
 * D60 / IAL-05 各地各仓库存明细与周转读模型（缓存键 `warehouse-inventory/v1`）——**唯一实现**；
 * 驾驶舱屏 3「各地各仓库存明细」与 `/inventory/warehouses` 同读同缓存键，inventory-analytics 口径不改。
 *
 * 口径：
 * - 在库：实时仓 = Σ stock_balances；快照仓 = 每 (仓,SKU) 最新一期快照（core/stock-view.getLatestSnapshotRows，唯一实现）。
 * - 金额：core/valuation（sku_costs → 财务运营成本观察 → null），逐仓给覆盖率；覆盖率 < 80% 的仓标 incomplete。
 * - 周转（仅实时仓）：窗口出库 = Σ(-qty_delta | qty_delta<0, occurred_at ≥ 窗口起点)；
 *   期初 = 期末 − 窗口内净变动（流水倒推）；平均在库 = (期初+期末)/2；turns/dio = rules/inventory-metrics.turnover。
 *   出库含调拨/发料/盘亏等非纯销售出库（发货强度而非销量）。
 * - 快照仓无流水 → turns/dio=null，turnoverNote="无流水"。
 * - 分组：warehouses.region_code（各地）与 parent_id（仓库树）；总周转只汇总实时仓。
 * 数量 scale 4、金额 scale 2；金额键 amount 已在 SENSITIVE_FIELDS，API 出口 maskSensitive 按角色剥离。
 * source_binding：stock_ledger max(id)、stock_snapshots max(id)、sku_costs max(updated_at)、财务成本批次、
 * warehouses 变更指纹、窗口天数与 asOf 日期。
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dDiv, dMul, dQty, dSub } from "@/server/core/decimal";
import { getLatestSnapshotRows } from "@/server/core/stock-view";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { latestFinanceCostBatch, resolveUnitCosts, valueOnHand } from "@/server/core/valuation";
import { turnover } from "@/server/rules/inventory-metrics";

export const WAREHOUSE_INVENTORY_CACHE_KEY = "warehouse-inventory/v1";
/** 实际落缓存的键带窗口后缀；任何读方（部门目标 auto 实际值等）必须用它，不能拿裸前缀查 */
export function warehouseInventoryCacheKey(windowDays = 90): string {
  return `${WAREHOUSE_INVENTORY_CACHE_KEY}/w${normalizeWindow(windowDays)}`;
}
export const WAREHOUSE_WINDOWS = [30, 90, 365] as const;
/** 覆盖率低于此值时金额标「不完整」（D51） */
export const VALUATION_COVERAGE_MIN_PCT = 80;
/** 实体仓（D60 上限口径） */
export const PHYSICAL_WAREHOUSE_KINDS = ["finished", "raw", "packaging"] as const;

const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

export interface WarehouseInventoryRow {
  warehouseId: number;
  code: string;
  name: string;
  kind: string;
  accountingMode: "realtime" | "snapshot";
  regionCode: string;
  parentId: number | null;
  parentName: string | null;
  active: boolean;
  /** 在库（scale 4，跨 SKU 直加仅作规模参考） */
  onHand: string;
  skuCount: number;
  /** 金额（scale 2；无成本 SKU 不计入；角色不可见时由 maskSensitive 剥离） */
  amount: string | null;
  valuationCoveragePct: number | null;
  valuationIncomplete: boolean;
  /** 快照仓：最新快照日；实时仓 null */
  snapshotDate: string | null;
  /** 窗口出库（scale 4；快照仓 null） */
  outboundQty: string | null;
  /** 期初在库（流水倒推；快照仓 null） */
  openingOnHand: string | null;
  avgOnHand: string | null;
  turns: number | null;
  dio: number | null;
  turnoverNote: string | null;
}

export interface WarehouseRegionGroup {
  regionCode: string;
  warehouseCount: number;
  onHand: string;
  amount: string | null;
  outboundQty: string;
  turns: number | null;
  dio: number | null;
  warehouseIds: number[];
}

export interface WarehouseInventoryModel {
  key: string;
  builtAt: string;
  asOf: string;
  windowDays: number;
  windowStart: string;
  rows: WarehouseInventoryRow[];
  regions: WarehouseRegionGroup[];
  summary: {
    warehouseCount: number;
    realtimeCount: number;
    snapshotCount: number;
    physicalActiveCount: number;
    onHand: string;
    amount: string | null;
    valuationCoveragePct: number | null;
    /** 总周转（仅实时仓） */
    outboundQty: string;
    avgOnHand: string;
    turns: number | null;
    dio: number | null;
    latestSnapshotDate: string | null;
  };
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function shiftDay(ymd: string, delta: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

export function normalizeWindow(v: unknown): number {
  const n = Number(v);
  return (WAREHOUSE_WINDOWS as readonly number[]).includes(n) ? n : 90;
}

export async function warehouseInventoryBinding(db: AnyDb, windowDays: number, asOf: string): Promise<string> {
  const [row] = resultRows<{ sl: unknown; ss: unknown; sc: unknown; wh: unknown }>(await db.execute(sql`
    SELECT
      (SELECT max(id) FROM stock_ledger) AS sl,
      (SELECT max(id) FROM stock_snapshots) AS ss,
      (SELECT max(updated_at) FROM sku_costs) AS sc,
      (SELECT string_agg(id || ':' || active || ':' || region_code || ':' || coalesce(parent_id, 0) || ':' || kind, ',' ORDER BY id) FROM warehouses) AS wh
  `));
  const fin = await latestFinanceCostBatch(db);
  const sc = row?.sc ? new Date(row.sc as string).toISOString() : "-";
  return `sl:${row?.sl ?? 0}|ss:${row?.ss ?? 0}|sc:${sc}|fin:${fin ?? 0}|wh:${row?.wh ?? ""}|w:${windowDays}|asOf:${asOf}`;
}

async function computeWarehouseInventory(db: AnyDb, windowDays: number, asOf: string): Promise<Omit<WarehouseInventoryModel, "key" | "builtAt">> {
  const windowStart = shiftDay(asOf, -windowDays + 1);
  const since = new Date(`${windowStart}T00:00:00+08:00`);

  const whRows: {
    id: number; code: string; name: string; kind: string; accountingMode: "realtime" | "snapshot";
    regionCode: string; parentId: number | null; active: boolean;
  }[] = await db
    .select({
      id: schema.warehouses.id,
      code: schema.warehouses.code,
      name: schema.warehouses.name,
      kind: schema.warehouses.kind,
      accountingMode: schema.warehouses.accountingMode,
      regionCode: schema.warehouses.regionCode,
      parentId: schema.warehouses.parentId,
      active: schema.warehouses.active,
    })
    .from(schema.warehouses)
    .where(eq(schema.warehouses.active, true))
    .orderBy(schema.warehouses.regionCode, schema.warehouses.code);
  const nameById = new Map(whRows.map((w) => [w.id, w.name]));
  const realtimeIds = whRows.filter((w) => w.accountingMode === "realtime").map((w) => w.id);
  const snapshotIds = new Set(whRows.filter((w) => w.accountingMode === "snapshot").map((w) => w.id));

  /* ── 在库：实时仓 stock_balances 逐 (仓,SKU)；快照仓最新快照（stock-view 唯一实现） ── */
  const bySkuByWh = new Map<number, Map<number, string>>();
  const touch = (wh: number, sku: number, qty: string) => {
    let m = bySkuByWh.get(wh);
    if (!m) { m = new Map(); bySkuByWh.set(wh, m); }
    m.set(sku, dAdd(m.get(sku) ?? "0", qty, 4));
  };
  if (realtimeIds.length > 0) {
    const bal: { warehouseId: number; skuId: number; qty: string | null }[] = await db
      .select({ warehouseId: schema.stockBalances.warehouseId, skuId: schema.stockBalances.skuId, qty: sql<string | null>`sum(${schema.stockBalances.qty})` })
      .from(schema.stockBalances)
      .where(inArray(schema.stockBalances.warehouseId, realtimeIds))
      .groupBy(schema.stockBalances.warehouseId, schema.stockBalances.skuId);
    for (const r of bal) touch(r.warehouseId, r.skuId, r.qty ?? "0");
  }
  const snapDateByWh = new Map<number, string>();
  if (snapshotIds.size > 0) {
    const snaps = await getLatestSnapshotRows(db);
    for (const r of snaps) {
      if (!snapshotIds.has(r.warehouseId)) continue;
      touch(r.warehouseId, r.skuId, r.qty);
      const prev = snapDateByWh.get(r.warehouseId);
      if (!prev || r.bizDate > prev) snapDateByWh.set(r.warehouseId, r.bizDate);
    }
  }

  /* ── 估值：唯一权威 core/valuation ── */
  const allSkuIds = [...new Set([...bySkuByWh.values()].flatMap((m) => [...m.keys()]))];
  const unitCosts = await resolveUnitCosts(db, allSkuIds);

  /* ── 窗口流水（仅实时仓）：出库合计与净变动 ── */
  const outByWh = new Map<number, string>();
  const netByWh = new Map<number, string>();
  if (realtimeIds.length > 0) {
    const sl = schema.stockLedger;
    const outRows: { warehouseId: number; out: string | null }[] = await db
      .select({ warehouseId: sl.warehouseId, out: sql<string | null>`sum(-${sl.qtyDelta})` })
      .from(sl)
      .where(and(inArray(sl.warehouseId, realtimeIds), lt(sl.qtyDelta, "0"), gte(sl.occurredAt, since)))
      .groupBy(sl.warehouseId);
    for (const r of outRows) outByWh.set(r.warehouseId, dQty(r.out ?? "0"));
    const netRows: { warehouseId: number; net: string | null }[] = await db
      .select({ warehouseId: sl.warehouseId, net: sql<string | null>`sum(${sl.qtyDelta})` })
      .from(sl)
      .where(and(inArray(sl.warehouseId, realtimeIds), gte(sl.occurredAt, since)))
      .groupBy(sl.warehouseId);
    for (const r of netRows) netByWh.set(r.warehouseId, dQty(r.net ?? "0"));
  }

  const rows: WarehouseInventoryRow[] = [];
  let sumOut = "0.0000";
  let sumAvg = "0.0000";
  let sumOnHand = "0.0000";
  let sumAmount = "0.00";
  let sumCoveredQty = "0.0000";
  let anyAmount = false;
  let latestSnapshotDate: string | null = null;
  for (const w of whRows) {
    const skuMap = bySkuByWh.get(w.id) ?? new Map<number, string>();
    let onHand = "0.0000";
    for (const q of skuMap.values()) onHand = dAdd(onHand, q, 4);
    const val = valueOnHand([...skuMap.entries()].map(([skuId, qty]) => ({ skuId, qty })), unitCosts);
    const hasStock = dCmp(onHand, 0) !== 0;
    const amount = skuMap.size > 0 ? val.amount : null;
    if (amount != null) { anyAmount = true; sumAmount = dAdd(sumAmount, amount, 2); }
    sumCoveredQty = dAdd(sumCoveredQty, val.coveredQty, 4);
    sumOnHand = dAdd(sumOnHand, onHand, 4);
    let outboundQty: string | null = null;
    let openingOnHand: string | null = null;
    let avgOnHand: string | null = null;
    let turns: number | null = null;
    let dio: number | null = null;
    let turnoverNote: string | null = null;
    const snapshotDate = snapDateByWh.get(w.id) ?? null;
    if (w.accountingMode === "realtime") {
      outboundQty = outByWh.get(w.id) ?? "0.0000";
      const net = netByWh.get(w.id) ?? "0.0000";
      openingOnHand = dSub(onHand, net, 4);
      avgOnHand = dDiv(dAdd(openingOnHand, onHand, 4), 2, 4);
      const t = turnover(Number(outboundQty), Number(avgOnHand), windowDays);
      turns = t.turns == null ? null : Math.round(t.turns * 100) / 100;
      dio = t.dio == null ? null : Math.round(t.dio * 10) / 10;
      if (t.turns == null) turnoverNote = hasStock ? "平均在库 ≤ 0" : "窗口内无在库";
      else if (t.dio == null) turnoverNote = "窗口内零出库";
      sumOut = dAdd(sumOut, outboundQty, 4);
      sumAvg = dAdd(sumAvg, avgOnHand, 4);
    } else {
      turnoverNote = "无流水（快照仓）";
      if (snapshotDate && (!latestSnapshotDate || snapshotDate > latestSnapshotDate)) latestSnapshotDate = snapshotDate;
    }
    rows.push({
      warehouseId: w.id,
      code: w.code,
      name: w.name,
      kind: w.kind,
      accountingMode: w.accountingMode,
      regionCode: w.regionCode,
      parentId: w.parentId,
      parentName: w.parentId != null ? (nameById.get(w.parentId) ?? null) : null,
      active: w.active,
      onHand,
      skuCount: skuMap.size,
      amount,
      valuationCoveragePct: val.coveragePct,
      valuationIncomplete: val.coveragePct != null && val.coveragePct < VALUATION_COVERAGE_MIN_PCT,
      snapshotDate,
      outboundQty,
      openingOnHand,
      avgOnHand,
      turns,
      dio,
      turnoverNote,
    });
  }

  /* ── 各地分组（region_code） ── */
  const regionMap = new Map<string, { onHand: string; amount: string; anyAmount: boolean; out: string; avg: string; ids: number[] }>();
  for (const r of rows) {
    const g = regionMap.get(r.regionCode) ?? { onHand: "0.0000", amount: "0.00", anyAmount: false, out: "0.0000", avg: "0.0000", ids: [] };
    g.onHand = dAdd(g.onHand, r.onHand, 4);
    if (r.amount != null) { g.amount = dAdd(g.amount, r.amount, 2); g.anyAmount = true; }
    if (r.outboundQty != null) g.out = dAdd(g.out, r.outboundQty, 4);
    if (r.avgOnHand != null) g.avg = dAdd(g.avg, r.avgOnHand, 4);
    g.ids.push(r.warehouseId);
    regionMap.set(r.regionCode, g);
  }
  const regions: WarehouseRegionGroup[] = [...regionMap.entries()].map(([regionCode, g]) => {
    const t = turnover(Number(g.out), Number(g.avg), windowDays);
    return {
      regionCode,
      warehouseCount: g.ids.length,
      onHand: g.onHand,
      amount: g.anyAmount ? g.amount : null,
      outboundQty: g.out,
      turns: t.turns == null ? null : Math.round(t.turns * 100) / 100,
      dio: t.dio == null ? null : Math.round(t.dio * 10) / 10,
      warehouseIds: g.ids,
    };
  }).sort((a, b) => dCmp(b.onHand, a.onHand) || a.regionCode.localeCompare(b.regionCode));

  const total = turnover(Number(sumOut), Number(sumAvg), windowDays);
  const coveragePct = dCmp(sumOnHand, 0) > 0 ? Number(dMul(dDiv(sumCoveredQty, sumOnHand, 6), 100, 2)) : null;
  return {
    asOf,
    windowDays,
    windowStart,
    rows,
    regions,
    summary: {
      warehouseCount: rows.length,
      realtimeCount: realtimeIds.length,
      snapshotCount: snapshotIds.size,
      physicalActiveCount: whRows.filter((w) => (PHYSICAL_WAREHOUSE_KINDS as readonly string[]).includes(w.kind)).length,
      onHand: sumOnHand,
      amount: anyAmount ? sumAmount : null,
      valuationCoveragePct: coveragePct,
      outboundQty: sumOut,
      avgOnHand: sumAvg,
      turns: total.turns == null ? null : Math.round(total.turns * 100) / 100,
      dio: total.dio == null ? null : Math.round(total.dio * 10) / 10,
      latestSnapshotDate,
    },
    limitations: [
      `周转 = 窗口（${windowDays} 天）出库 ÷ (期初+期末)/2，期初由流水倒推；出库含调拨/发料/盘亏等非纯销售出库。`,
      "快照仓无流水不计算周转；在库取该仓最新一期快照。",
      "跨 SKU 数量直加仅作规模参考；金额只计有成本的 SKU，覆盖率 < 80% 标「不完整」。",
      "总周转只汇总实时仓。",
    ],
  };
}

export async function refreshWarehouseInventory(dbArg?: AnyDb, opts: { windowDays?: number; asOf?: string } = {}): Promise<WarehouseInventoryModel> {
  const db = await resolveDb(dbArg);
  const windowDays = normalizeWindow(opts.windowDays ?? 90);
  const asOf = opts.asOf ?? SHANGHAI_DATE.format(new Date());
  const binding = await warehouseInventoryBinding(db, windowDays, asOf);
  const key = warehouseInventoryCacheKey(windowDays);
  const model: WarehouseInventoryModel = { key, builtAt: new Date().toISOString(), ...(await computeWarehouseInventory(db, windowDays, asOf)) };
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${key}, ${binding}, ${JSON.stringify(model)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return model;
}

export async function loadWarehouseInventory(
  dbArg?: AnyDb,
  opts: { windowDays?: number; asOf?: string; refresh?: boolean } = {},
): Promise<WarehouseInventoryModel> {
  const db = await resolveDb(dbArg);
  const windowDays = normalizeWindow(opts.windowDays ?? 90);
  const asOf = opts.asOf ?? SHANGHAI_DATE.format(new Date());
  if (!opts.refresh) {
    const binding = await warehouseInventoryBinding(db, windowDays, asOf);
    const key = warehouseInventoryCacheKey(windowDays);
    const [row] = resultRows<{ payload: unknown }>(await db.execute(sql`
      SELECT payload FROM report_read_model_cache WHERE key = ${key} AND source_binding = ${binding} LIMIT 1
    `));
    const payload = row?.payload;
    const parsed = typeof payload === "string" ? safeJson(payload) : payload;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Partial<WarehouseInventoryModel>).rows)) {
      return parsed as WarehouseInventoryModel;
    }
  }
  return refreshWarehouseInventory(db, { windowDays, asOf });
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
