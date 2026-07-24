/**
 * 毛利视角 v1（手工成本；只读报表 + 成本录入写路径）。
 *
 * 诚实口径声明：成本自动口径（D2）未定，本表 sku_costs 为「手工录入基准」，非系统自动核算。
 * - 范围：finished + active 成品 SKU；左联 sku_costs 取单位成本（空=待录入，绝不臆造）。
 * - 销量代理：sales_monthly 近 3 月（窗口自 max(yearMonth) 动态回推，与 R11/风险表/分层同法）。
 * - 售价来源：库内无「销售价」口径——price_lists 系供应商采购基准价（R1），非售价，故不充作售价。
 *   priceAvailable=false 时仅呈现 成本/销量，售价/毛利留白并标注「售价待接入」；
 *   一旦接入售价源，unitMargin=售价−成本、marginPct、margin3m=unitMargin×近3月销量 即可点亮。
 * - 排序：有成本行在前（按 margin3m 或成本×销量降序），待录入行沉底。
 * 写路径（成本录入）=finance/admin，writeAudit 留痕。
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { ApiError, type SessionUser } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { lastMonths } from "@/server/core/velocity";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const r2 = (v: number): number => Math.round(v * 100) / 100;


export interface MarginRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  /** 单位成本（手工基准）；未录入 = null */
  unitCost: number | null;
  /** 近 3 月销量（跨渠道汇总） */
  sales3m: number;
  /** 以下仅 priceAvailable 时有值，否则 null */
  price: number | null;
  unitMargin: number | null;
  marginPct: number | null;
  margin3m: number | null;
}

export interface MarginReport {
  months: string[];
  rows: MarginRow[];
  total: number;
  summary: { costedSkus: number; uncostedSkus: number; totalMargin3m: number | null };
  priceAvailable: boolean;
}

export async function getMarginReport(
  query: { q?: string; page?: number; pageSize?: number; onlyCosted?: boolean },
  dbArg?: AnyDb,
): Promise<MarginReport> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();

  /* 售价口径：库内暂无销售价源（price_lists 为供应商采购基准价，非售价）。 */
  const priceAvailable = false;

  /* ── 近 3 月窗口（自 max(yearMonth) 回推） ── */
  const sm = schema.salesMonthly;
  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months = maxYm ? lastMonths(maxYm, 3) : [];

  /* ── 成品主档（finished + active） ── */
  const skuRows: { id: number; code: string; name: string; brand: string | null }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, brand: schema.brands.nameCn })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(sql`${schema.skus.active} = true and ${schema.skus.skuType} = 'finished'`);
  if (skuRows.length === 0) {
    return { months, rows: [], total: 0, summary: { costedSkus: 0, uncostedSkus: 0, totalMargin3m: priceAvailable ? 0 : null }, priceAvailable };
  }

  /* ── 手工成本（sku_costs 全量） ── */
  const costRows: { skuId: number; unitCost: string }[] = await db
    .select({ skuId: schema.skuCosts.skuId, unitCost: schema.skuCosts.unitCost })
    .from(schema.skuCosts);
  const costBySku = new Map<number, number>(costRows.map((r) => [r.skuId, num(r.unitCost)]));

  /* ── 近 3 月逐 SKU 销量（跨渠道汇总） ── */
  const salesRows: { skuId: number; qty: string | null }[] = months.length
    ? await db
        .select({ skuId: sm.skuId, qty: sql<string | null>`sum(${sm.qty})` })
        .from(sm)
        .where(inArray(sm.yearMonth, months))
        .groupBy(sm.skuId)
    : [];
  const salesBySku = new Map<number, number>(salesRows.map((r) => [r.skuId, num(r.qty)]));

  /* ── 逐 SKU 组装 ── */
  const all: MarginRow[] = [];
  let costedSkus = 0;
  let uncostedSkus = 0;
  let totalMargin3m = 0;
  for (const sku of skuRows) {
    const cost = costBySku.has(sku.id) ? (costBySku.get(sku.id) as number) : null;
    const sales3m = salesBySku.get(sku.id) ?? 0;
    if (cost == null) uncostedSkus++;
    else costedSkus++;
    // 售价未接入：售价/毛利留白；接入后按 priceAvailable 分支点亮。
    const price: number | null = null;
    const unitMargin: number | null = priceAvailable && price != null && cost != null ? r2(price - cost) : null;
    const marginPct: number | null = priceAvailable && unitMargin != null && price != null && price !== 0 ? r2((unitMargin / price) * 100) : null;
    const margin3m: number | null = priceAvailable && unitMargin != null ? r2(unitMargin * sales3m) : null;
    if (margin3m != null) totalMargin3m += margin3m;
    all.push({
      skuId: sku.id,
      code: sku.code,
      name: sku.name,
      brand: sku.brand,
      unitCost: cost == null ? null : r2(cost),
      sales3m: r2(sales3m),
      price,
      unitMargin,
      marginPct,
      margin3m,
    });
  }

  /* ── 筛选/排序/分页 ── */
  let filtered = all;
  if (query.onlyCosted) filtered = filtered.filter((r) => r.unitCost != null);
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  // 有成本行在前；排序键 = margin3m（可算时）否则 成本×销量代理；待录入成本行沉底。
  const sortKey = (r: MarginRow): number =>
    r.unitCost == null ? -Infinity : r.margin3m != null ? r.margin3m : r.unitCost * r.sales3m;
  filtered.sort((a, b) => {
    const ca = a.unitCost == null ? 1 : 0;
    const cb = b.unitCost == null ? 1 : 0;
    if (ca !== cb) return ca - cb; // 有成本(0)在前
    return sortKey(b) - sortKey(a);
  });

  return {
    months,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    summary: { costedSkus, uncostedSkus, totalMargin3m: priceAvailable ? r2(totalMargin3m) : null },
    priceAvailable,
  };
}

/** 成本录入（手工基准）：finance/admin；skuCode→skuId；onConflict 更新；writeAudit 留痕。 */
export async function upsertSkuCost(
  user: SessionUser,
  input: { skuCode: string; unitCost: string | number; note?: string },
  dbArg?: AnyDb,
): Promise<{ ok: true }> {
  requireAnyRole(user, "finance");
  const code = String(input.skuCode ?? "").trim();
  if (!code) throw new ApiError(400, "skuCode 必填");
  const raw = String(input.unitCost ?? "").trim();
  if (!/^\d+(\.\d{1,4})?$/.test(raw) || Number(raw) <= 0) {
    throw new ApiError(400, "单位成本须为正数（最多 4 位小数）");
  }
  const unitCost = raw;
  const note = String(input.note ?? "").trim().slice(0, 300) || null;
  const db: AnyDb = dbArg ?? (await getDbAsync());

  const [sku]: { id: number }[] = await db
    .select({ id: schema.skus.id })
    .from(schema.skus)
    .where(eq(schema.skus.code, code));
  if (!sku) throw new ApiError(404, `SKU 编码不存在：${code}`);

  await db.transaction(async (tx: AnyDb) => {
    await tx
      .insert(schema.skuCosts)
      .values({ skuId: sku.id, unitCost, note, updatedBy: user.id, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.skuCosts.skuId,
        set: { unitCost, note, updatedBy: user.id, updatedAt: new Date() },
      });
    await writeAudit(tx, {
      userId: user.id,
      entity: "sku_cost",
      action: "upsert",
      after: { skuCode: code, unitCost },
    });
  });
  return { ok: true };
}
