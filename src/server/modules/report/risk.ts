/**
 * F 项：风险库存处置工作台（只读报表层，spec/13 §三）。
 *
 * 三源融合（全部既有数据，不新增口径）：
 * - 效期：batch_stocks（qty>0 且 expiryDate 非空，**逐仓只取最新盘点期**）→ 逐 SKU minDaysLeft/expiredQty/nearQty(≤逐 SKU 阈值)；
 * - 注记：transit_refs kind=pallet exception 非空 → 逐 SKU 取最新（progress desc, id desc）；
 * - 销速：sales_monthly 近3月 ÷ 91（窗口动态回推，与驾驶舱/R11 同法）；
 * - 在库：Σ stock_balances + 快照仓最新快照（全网口径 D20，与 R11 同法本地重实现）。
 * 动作判定 = rules/risk-action.ts 纯函数；「正常」不进列表。
 *
 * 金额（W2-5）：单位成本走 `core/valuation.resolveUnitCosts` 唯一权威——
 * `amount` = 在库 × 单位成本，`atRiskAmount` = 临期(含过期)量 × 单位成本。
 * 两键都在 SENSITIVE_FIELDS，调用方按 canSeePrices 请求、出口经 maskSensitive 兜底。
 * 没有金额，处置队列只能按数量排，5 万元的临期和 50 元的临期在页面上一样重。
 * 只读不写库。
 */
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { loadExternalVelocitySafe, type ExternalVelocity } from "@/server/modules/report/external-velocity";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { getNumParam } from "@/server/core/params";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { ApiError } from "@/server/modules/master/common";
import { todayShanghai } from "@/server/modules/master/common";
import { RISK_ACTION_ORDER, suggestRiskAction, type RiskAction } from "@/server/rules/risk-action";
import { dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { dMul } from "@/server/core/decimal";
import { resolveUnitCosts } from "@/server/core/valuation";
import { coverDays, daysLeftOf, getOnHandBySku, latestStocktakeRows } from "@/server/core/stock-view";
import { num, r1 } from "@/server/core/svc";
import { salesWindow } from "@/server/core/sales-window";
import { participatesInNormalSalesMovement } from "@/server/rules/sku-standardization";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 效期段位（C3 驾驶舱临期桶；按批次剩余天数分档，与逐 SKU 临期阈值无关——段位是统一刻度） */
export type ExpiryBucketKey = "expired" | "d30" | "d60" | "d90";
export const EXPIRY_BUCKET_KEYS = ["expired", "d30", "d60", "d90"] as const;
export const EXPIRY_BUCKET_LABELS: Record<ExpiryBucketKey, string> = {
  expired: "已过期", d30: "≤30 天", d60: "31–60 天", d90: "61–90 天",
};
/** 批次剩余天数 → 段位；> 90 天不入桶（返回 null） */
export function expiryBucketOf(daysLeft: number): ExpiryBucketKey | null {
  if (daysLeft <= 0) return "expired";
  if (daysLeft <= 30) return "d30";
  if (daysLeft <= 60) return "d60";
  if (daysLeft <= 90) return "d90";
  return null;
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
  /** 当前 SKU 的临期阈值（未维护时 90 天兜底） */
  nearExpiryDays: number;
  /** 临期阈值内到期数量小计（含已过期） */
  nearQty: number;
  /** 逐 SKU 的效期段位数量（统一 0/30/60/90 刻度，与逐 SKU 临期阈值无关；> 90 天不入桶） */
  expiryBuckets: Record<ExpiryBucketKey, number>;
  /** 该 SKU 的临期阈值来自 90 天兜底（skus.near_expiry_days 未维护） */
  nearExpiryFallback: boolean;
  /** 货盘处置注记原文（最新一条；无 = null） */
  palletRemark: string | null;
  /** 注记所属月份（progress） */
  remarkMonth: string | null;
  /** 已有未关闭的处置登记（复核清单 risk_disposal） */
  disposalOpen: boolean;
  /** 未关闭处置登记 ID；用于把报废出库单精确绑定到本登记。 */
  disposalId: number | null;
  /** 外部观察（简道云天猫）近 30 天净需求与最近售出日；未映射/缺席 = null，不是 0 */
  externalNet30: number | null;
  externalLastSold: string | null;
  /** 在库金额 = 在库 × 单位成本；无成本 → null，非价格角色 → 缺键 */
  amount?: string | null;
  /** 风险金额 = 临期(含已过期)量 × 单位成本；处置队列按它排序 */
  atRiskAmount?: string | null;
}

export interface RiskWorklist {
  today: string;
  slowThreshold: number;
  rows: RiskRow[];
  total: number;
  byAction: Record<string, number>;
}

export async function getRiskWorklist(
  query: {
    q?: string; action?: string; page?: number; pageSize?: number; precise?: boolean; all?: boolean;
    /** 是否附带金额列（调用方按 canSeePrices 决定） */
    withValue?: boolean;
  },
  dbArg?: AnyDb,
  externalVelocityArg?: ExternalVelocity,
): Promise<RiskWorklist> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  // 外部观察销速影子列：内部说"无动销"、外部近 30 天仍在售的 SKU，处置前必须先看到
  const externalVelocity = externalVelocityArg ?? await loadExternalVelocitySafe(db);
  /** E1-06：导出走全精度（precise），屏显仍 1dp——截断值不得流入对账口径 */
  const rq = (v: number): number => (query.precise ? v : r1(v));
  const today = todayShanghai();
  const slowThreshold = await getNumParam("slow_days_threshold", 180, dbArg);
  const page = query.all ? 1 : Math.max(1, query.page ?? 1);
  // all = 读模型口径（不分页）；页面/导出仍受 500 行上限约束
  const pageSize = query.all ? Number.MAX_SAFE_INTEGER : Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();

  /* ── SKU 主档（active 全类型——包材也可能滞销/有注记） ── */
  const skuRows: {
    id: number;
    code: string;
    name: string;
    brand: string | null;
    nearExpiryDays: number | null;
    commercialRole: string;
  }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      brand: schema.brands.nameCn,
      nearExpiryDays: schema.skus.nearExpiryDays,
      commercialRole: schema.skus.commercialRole,
    })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(eq(schema.skus.active, true));
  const skuIds = skuRows.map((s) => s.id);
  const nearThreshBySku = new Map(skuRows.map((s) => [s.id, s.nearExpiryDays ?? 90])); // func#8 逐 SKU 临期阈值
  const nearFallbackBySku = new Map(skuRows.map((s) => [s.id, s.nearExpiryDays == null])); // 90 天兜底计数（C3 必须标注）
  if (skuIds.length === 0) return { today, slowThreshold, rows: [], total: 0, byAction: {} };

  /* ── 在库：全网口径（core/stock-view 唯一实现） ── */
  const onHandView = await getOnHandBySku(db, { skuIds });
  const onHandBySku = new Map<number, number>();
  for (const [id, v] of onHandView.bySku) onHandBySku.set(id, num(v));

  /* ── 销速：近3月 ── */
  const sm = schema.salesMonthly;
  const { maxYm } = await salesWindow(db);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const salesRows: { skuId: number; qty: string | null }[] = months3.length
    ? await db
        .select({ skuId: sm.skuId, qty: sql<string | null>`sum(${sm.qty})` })
        .from(sm)
        .where(inArray(sm.yearMonth, months3))
        .groupBy(sm.skuId)
    : [];
  // 日均走 core/velocity 唯一口径——此前这里手写 /91，除数虽然一样，
  // 但第二实现意味着窗口口径一旦调整这里不会跟着变
  const dailyBySku = new Map<number, number>(salesRows.map((r) => [r.skuId, dailyFromWindow(num(r.qty))]));

  /* ── 效期：batch_stocks 逐 SKU 聚合（**只取每仓最新盘点期**——多期并存会把效期量按盘点次数翻倍）── */
  const bs = schema.batchStocks;
  const batchRowsAllPeriods: { skuId: number; warehouseId: number; stocktakeDate: string; qty: string; expiryDate: string }[] = await db
    .select({ skuId: bs.skuId, warehouseId: bs.warehouseId, stocktakeDate: bs.stocktakeDate, qty: bs.qty, expiryDate: bs.expiryDate })
    .from(bs)
    .where(and(isNotNull(bs.expiryDate), gt(bs.qty, "0")));
  const batchRows = latestStocktakeRows(batchRowsAllPeriods);
  const expiryBySku = new Map<number, { minDaysLeft: number; expiredQty: number; nearQty: number; buckets: Record<ExpiryBucketKey, number> }>();
  for (const r of batchRows) {
    const daysLeft = daysLeftOf(today, r.expiryDate);
    const cur = expiryBySku.get(r.skuId) ?? { minDaysLeft: Number.POSITIVE_INFINITY, expiredQty: 0, nearQty: 0, buckets: { expired: 0, d30: 0, d60: 0, d90: 0 } };
    cur.minDaysLeft = Math.min(cur.minDaysLeft, daysLeft);
    if (daysLeft <= 0) cur.expiredQty += num(r.qty);
    if (daysLeft <= (nearThreshBySku.get(r.skuId) ?? 90)) cur.nearQty += num(r.qty);
    const bucket = expiryBucketOf(daysLeft);
    if (bucket) cur.buckets[bucket] += num(r.qty);
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

  /* ── 已登记处置（open）── */
  const dispRows: { id: number; refKey: string | null }[] = await db
    .select({ id: schema.reviewItems.id, refKey: schema.reviewItems.refKey })
    .from(schema.reviewItems)
    .where(and(eq(schema.reviewItems.category, "risk_disposal"), eq(schema.reviewItems.status, "open")));
  const dispBySku = new Map(
    dispRows
      .filter((row): row is { id: number; refKey: string } => Boolean(row.refKey))
      .map((row) => [row.refKey, row.id]),
  );

  /* ── 逐 SKU 判定 ── */
  const all: RiskRow[] = [];
  for (const sku of skuRows) {
    const onHand = onHandBySku.get(sku.id) ?? 0;
    const daily = dailyBySku.get(sku.id) ?? 0;
    const cover = coverDays(onHand, daily);
    const exp = expiryBySku.get(sku.id);
    const remark = remarkBySku.get(sku.id);
    const action = suggestRiskAction({
      minDaysLeft: exp ? exp.minDaysLeft : null,
      cover,
      onHand,
      slowThreshold,
      nearExpiryDays: nearThreshBySku.get(sku.id) ?? 90,
      palletRemark: remark?.text ?? null,
      includeSlowMover: participatesInNormalSalesMovement(sku.commercialRole),
    });
    if (!action) continue;
    all.push({
      skuId: sku.id,
      code: sku.code,
      name: sku.name,
      brand: sku.brand,
      action,
      onHand: rq(onHand),
      daily: rq(daily),
      cover: cover == null ? null : rq(cover),
      minDaysLeft: exp ? exp.minDaysLeft : null,
      expiredQty: rq(exp?.expiredQty ?? 0),
      nearExpiryDays: nearThreshBySku.get(sku.id) ?? 90,
      nearQty: rq(exp?.nearQty ?? 0),
      expiryBuckets: {
        expired: rq(exp?.buckets.expired ?? 0), d30: rq(exp?.buckets.d30 ?? 0),
        d60: rq(exp?.buckets.d60 ?? 0), d90: rq(exp?.buckets.d90 ?? 0),
      },
      nearExpiryFallback: nearFallbackBySku.get(sku.id) ?? true,
      palletRemark: remark?.text ?? null,
      remarkMonth: remark?.month ?? null,
      disposalOpen: dispBySku.has(sku.code),
      disposalId: dispBySku.get(sku.code) ?? null,
      externalNet30: externalVelocity.bySku[String(sku.id)]?.net30 ?? null,
      externalLastSold: externalVelocity.bySku[String(sku.id)]?.lastSoldDate ?? null,
    });
  }

  /* ── 金额（可选；单位成本唯一权威 core/valuation） ── */
  if (query.withValue) {
    const unitCosts = await resolveUnitCosts(db, all.map((r) => r.skuId));
    for (const row of all) {
      const unitCost = unitCosts.get(row.skuId)?.unitCost ?? null;
      row.amount = unitCost == null ? null : dMul(String(row.onHand), unitCost, 2);
      row.atRiskAmount = unitCost == null ? null : dMul(String(row.nearQty), unitCost, 2);
    }
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

/** #3 修复：处置决定登记 → 复核清单（category=risk_disposal，refKey=SKU 编码；幂等：同 SKU open 项唯一） */
export async function registerRiskDisposal(
  user: SessionUser,
  input: { skuCode: string; action: string; note?: string },
  dbArg?: AnyDb,
): Promise<{ ok: true }> {
  requireAnyRole(user, "pmc", "ops", "warehouse");
  const code = String(input.skuCode ?? "").trim();
  const action = String(input.action ?? "").trim();
  if (!code || !action) throw new ApiError(400, "skuCode/action 必填");
  const note = String(input.note ?? "").trim().slice(0, 300);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const open: { id: number }[] = await db
    .select({ id: schema.reviewItems.id })
    .from(schema.reviewItems)
    .where(and(eq(schema.reviewItems.category, "risk_disposal"), eq(schema.reviewItems.refKey, code), eq(schema.reviewItems.status, "open")));
  if (open.length > 0) return { ok: true }; // 幂等：已有在案登记
  await db.transaction(async (tx: AnyDb) => {
    await tx.insert(schema.reviewItems).values({
      category: "risk_disposal",
      refType: "sku",
      refKey: code,
      title: `处置决定：${action} ${code}`,
      detail: note || null,
    });
    await writeAudit(tx, {
      userId: user.id,
      entity: "risk_disposal",
      action: "register",
      after: { skuCode: code, action, note: note || null },
    });
  });
  return { ok: true };
}

/** func#6：完成/关闭处置登记（实物处置已走各自单据后，人工在此收口——否则登记台账永不清零） */
export async function closeRiskDisposal(
  user: SessionUser,
  input: { skuCode: string },
  dbArg?: AnyDb,
): Promise<{ closed: number }> {
  requireAnyRole(user, "pmc", "ops", "warehouse");
  const code = String(input.skuCode ?? "").trim();
  if (!code) throw new ApiError(400, "skuCode 必填");
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const open: { id: number }[] = await db
    .select({ id: schema.reviewItems.id })
    .from(schema.reviewItems)
    .where(and(eq(schema.reviewItems.category, "risk_disposal"), eq(schema.reviewItems.refKey, code), eq(schema.reviewItems.status, "open")));
  if (open.length === 0) return { closed: 0 };
  await db.transaction(async (tx: AnyDb) => {
    for (const o of open) {
      await tx.update(schema.reviewItems).set({ status: "done", note: "处置已完成（人工收口）", decidedBy: user.id, decidedAt: new Date() }).where(eq(schema.reviewItems.id, o.id));
    }
    await writeAudit(tx, { userId: user.id, entity: "risk_disposal", action: "close", after: { skuCode: code } });
  });
  return { closed: open.length };
}

/** #10：批量处置登记（逐项复用单项幂等逻辑；返回新增/已存在计数） */
export async function registerRiskDisposalBatch(
  user: SessionUser,
  input: { items: { skuCode: string; action: string; note?: string }[] },
  dbArg?: AnyDb,
): Promise<{ registered: number; skipped: number }> {
  requireAnyRole(user, "pmc", "ops", "warehouse");
  const items = Array.isArray(input.items) ? input.items.slice(0, 500) : [];
  if (items.length === 0) throw new ApiError(400, "未选择任何行");
  const db: AnyDb = dbArg ?? (await getDbAsync());
  let registered = 0;
  let skipped = 0;
  for (const it of items) {
    const code = String(it.skuCode ?? "").trim();
    const action = String(it.action ?? "").trim();
    if (!code || !action) { skipped++; continue; }
    const open: { id: number }[] = await db
      .select({ id: schema.reviewItems.id })
      .from(schema.reviewItems)
      .where(and(eq(schema.reviewItems.category, "risk_disposal"), eq(schema.reviewItems.refKey, code), eq(schema.reviewItems.status, "open")));
    if (open.length > 0) { skipped++; continue; }
    await db.transaction(async (tx: AnyDb) => {
      await tx.insert(schema.reviewItems).values({
        category: "risk_disposal", refType: "sku", refKey: code,
        title: `处置决定：${action} ${code}`, detail: String(it.note ?? "").trim().slice(0, 300) || null,
      });
      await writeAudit(tx, { userId: user.id, entity: "risk_disposal", action: "register_batch", after: { skuCode: code, action } });
    });
    registered++;
  }
  return { registered, skipped };
}
