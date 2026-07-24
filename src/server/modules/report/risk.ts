/**
 * F 项：风险库存处置工作台（只读报表层，spec/13 §三）。
 *
 * 三源融合（全部既有数据，不新增口径）：
 * - 效期：batch_stocks（qty>0 且 expiryDate 非空）→ 逐 SKU minDaysLeft/expiredQty/nearQty(≤90天)；
 * - 注记：transit_refs kind=pallet exception 非空 → 逐 SKU 取最新（progress desc, id desc）；
 * - 销速：sales_monthly 近3月 ÷ 91（窗口动态回推，与驾驶舱/R11 同法）；
 * - 在库：Σ stock_balances + 快照仓最新快照（全网口径 D20，与 R11 同法本地重实现）。
 * 动作判定 = rules/risk-action.ts 纯函数；「正常」不进列表。
 * 全表无金额字段，免脱敏；只读不写库。
 */
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { getNumParam } from "@/server/core/params";
import { todayShanghai } from "@/server/modules/master/common";
import { RISK_ACTION_ORDER, suggestRiskAction, type RiskAction } from "@/server/rules/risk-action";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const r1 = (v: number): number => Math.round(v * 10) / 10;

function lastMonths(maxYm: string, n: number): string[] {
  const [y, m] = maxYm.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out.reverse();
}

/** 日界差（Asia/Shanghai 日期字符串直减，与 expiry.ts 同准） */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export interface RiskRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  action: RiskAction;
  onHand: number;
  daily: number;
  cover: number | null;
  /** 最短剩余天数（负=已过期）；无效期批次 = null */
  minDaysLeft: number | null;
  /** 已过期批次数量小计 */
  expiredQty: number;
  /** 90 天内到期数量小计（含已过期） */
  nearQty: number;
  /** 货盘处置注记原文（最新一条；无 = null） */
  palletRemark: string | null;
  /** 注记所属月份（progress） */
  remarkMonth: string | null;
}

export interface RiskWorklist {
  today: string;
  slowThreshold: number;
  rows: RiskRow[];
  total: number;
  byAction: Record<string, number>;
}

export async function getRiskWorklist(
  query: { q?: string; action?: string; page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<RiskWorklist> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = todayShanghai();
  const slowThreshold = await getNumParam("slow_days_threshold", 180, dbArg);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();

  /* ── SKU 主档（active 全类型——包材也可能滞销/有注记） ── */
  const skuRows: { id: number; code: string; name: string; brand: string | null }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, brand: schema.brands.nameCn })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(eq(schema.skus.active, true));
  const skuIds = skuRows.map((s) => s.id);
  if (skuIds.length === 0) return { today, slowThreshold, rows: [], total: 0, byAction: {} };

  /* ── 在库：实时账 + 快照仓最新快照 ── */
  const balRows: { skuId: number; qty: string | null }[] = await db
    .select({ skuId: schema.stockBalances.skuId, qty: sql<string | null>`sum(${schema.stockBalances.qty})` })
    .from(schema.stockBalances)
    .groupBy(schema.stockBalances.skuId);
  const onHandBySku = new Map<number, number>(balRows.map((r) => [r.skuId, num(r.qty)]));
  const s = schema.stockSnapshots;
  const latest = db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, maxDate: sql<string>`max(${s.bizDate})`.as("max_date") })
    .from(s)
    .groupBy(s.warehouseId, s.skuId)
    .as("latest");
  const snapRows: { skuId: number; qty: string }[] = await db
    .select({ skuId: s.skuId, qty: s.qty })
    .from(s)
    .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)));
  for (const r of snapRows) onHandBySku.set(r.skuId, (onHandBySku.get(r.skuId) ?? 0) + num(r.qty));

  /* ── 销速：近3月 ── */
  const sm = schema.salesMonthly;
  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const salesRows: { skuId: number; qty: string | null }[] = months3.length
    ? await db
        .select({ skuId: sm.skuId, qty: sql<string | null>`sum(${sm.qty})` })
        .from(sm)
        .where(inArray(sm.yearMonth, months3))
        .groupBy(sm.skuId)
    : [];
  const dailyBySku = new Map<number, number>(salesRows.map((r) => [r.skuId, num(r.qty) / 91]));

  /* ── 效期：batch_stocks 逐 SKU 聚合 ── */
  const bs = schema.batchStocks;
  const batchRows: { skuId: number; qty: string; expiryDate: string }[] = await db
    .select({ skuId: bs.skuId, qty: bs.qty, expiryDate: bs.expiryDate })
    .from(bs)
    .where(and(isNotNull(bs.expiryDate), gt(bs.qty, "0")));
  const expiryBySku = new Map<number, { minDaysLeft: number; expiredQty: number; nearQty: number }>();
  for (const r of batchRows) {
    const daysLeft = daysBetween(today, r.expiryDate);
    const cur = expiryBySku.get(r.skuId) ?? { minDaysLeft: Number.POSITIVE_INFINITY, expiredQty: 0, nearQty: 0 };
    cur.minDaysLeft = Math.min(cur.minDaysLeft, daysLeft);
    if (daysLeft <= 0) cur.expiredQty += num(r.qty);
    if (daysLeft <= 90) cur.nearQty += num(r.qty);
    expiryBySku.set(r.skuId, cur);
  }

  /* ── 货盘注记：kind=pallet exception 非空，最新（progress desc, id desc）为准 ── */
  const tr = schema.transitRefs;
  const remarkRows: { skuId: number | null; exception: string | null; progress: string | null; id: number }[] = await db
    .select({ skuId: tr.skuId, exception: tr.exception, progress: tr.progress, id: tr.id })
    .from(tr)
    .where(and(eq(tr.kind, "pallet"), isNotNull(tr.exception), isNotNull(tr.skuId)));
  const remarkBySku = new Map<number, { text: string; month: string | null; id: number }>();
  for (const r of remarkRows) {
    if (r.skuId == null || !r.exception) continue;
    const prev = remarkBySku.get(r.skuId);
    const newer = !prev || (r.progress ?? "") > (prev.month ?? "") || ((r.progress ?? "") === (prev.month ?? "") && r.id > prev.id);
    if (newer) remarkBySku.set(r.skuId, { text: r.exception, month: r.progress, id: r.id });
  }

  /* ── 逐 SKU 判定 ── */
  const all: RiskRow[] = [];
  for (const sku of skuRows) {
    const onHand = onHandBySku.get(sku.id) ?? 0;
    const daily = dailyBySku.get(sku.id) ?? 0;
    const cover = daily > 0 ? onHand / daily : null;
    const exp = expiryBySku.get(sku.id);
    const remark = remarkBySku.get(sku.id);
    const action = suggestRiskAction({
      minDaysLeft: exp ? exp.minDaysLeft : null,
      cover,
      onHand,
      slowThreshold,
      palletRemark: remark?.text ?? null,
    });
    if (!action) continue;
    all.push({
      skuId: sku.id,
      code: sku.code,
      name: sku.name,
      brand: sku.brand,
      action,
      onHand: r1(onHand),
      daily: r1(daily),
      cover: cover == null ? null : r1(cover),
      minDaysLeft: exp ? exp.minDaysLeft : null,
      expiredQty: r1(exp?.expiredQty ?? 0),
      nearQty: r1(exp?.nearQty ?? 0),
      palletRemark: remark?.text ?? null,
      remarkMonth: remark?.month ?? null,
    });
  }

  /* ── 汇总/筛选/排序/分页 ── */
  const byAction: Record<string, number> = {};
  for (const r of all) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
  let filtered = all;
  if (query.action) filtered = filtered.filter((r) => r.action === query.action);
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  filtered.sort(
    (a, b) =>
      RISK_ACTION_ORDER[a.action] - RISK_ACTION_ORDER[b.action] ||
      (a.minDaysLeft ?? 9999) - (b.minDaysLeft ?? 9999) ||
      b.onHand - a.onHand,
  );
  return {
    today,
    slowThreshold,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    byAction,
  };
}
