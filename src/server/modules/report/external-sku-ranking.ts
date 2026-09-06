/**
 * SKU 外部销量排名（/v1，BI-R4）：把外部观察销速（天猫+拼多多，按系统 SKU）摊开成一张可筛选、
 * 可导出的排名表，并列内部近 3 月销量对照。
 *
 * 唯一权威只消费不重写：
 *   - 外部件数 / 分平台 / 最近售出 / 动销天数 → `report/external-velocity.ts`（组合装已按 D47 拆到组件）；
 *   - 内部近 3 月窗口 → `core/velocity.lastMonths`（sales_monthly 最新月回推 3 个自然月）。
 * 观察口径：不与内部相加、不驱动补货定量；未映射平台 SKU 不进任何系统 SKU（覆盖率随表输出）。
 * 无金额字段（件数为主，D50「金额按角色」在全渠道观察卡里已收口）。
 */
import { sql, type SQL } from "drizzle-orm";

import { lastMonths } from "@/server/core/velocity";
import { compareDecimalValues } from "@/lib/decimal-sort";
import { loadExternalVelocity, EXTERNAL_VELOCITY_CACHE_KEY, type ExternalVelocity } from "@/server/modules/report/external-velocity";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const READ_MODEL_CACHE_KEY = "external-sku-ranking/v2";
const VELOCITY_CACHE_KEY = EXTERNAL_VELOCITY_CACHE_KEY;

export interface ExternalSkuRankRow {
  rank: number | null;
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  skuType: string | null;
  net30: string | null;
  net90: string | null;
  tmallNet30: string;
  pddNet30: string;
  tmallNet90: string;
  pddNet90: string;
  lastSoldDate: string | null;
  activeDays90: number;
  platformSkus: number;
  /** 内部 sales_monthly 近 3 月（数据最新月回推）合计；无内部事实为 null */
  internal3m: number | null;
}

export interface ExternalSkuRanking {
  state: "ready" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  platform: "天猫+拼多多";
  sourceAsOf: string | null;
  pddSourceAsOf: string | null;
  anchorDate: string | null;
  /** 内部对照窗口（升序月份，空 = 无 sales_monthly） */
  internalMonths: string[];
  coverage: ExternalVelocity["coverage"];
  brands: string[];
  rows: ExternalSkuRankRow[];
  gate: string;
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const text = (v: unknown): string | null => { const t = v == null ? "" : String(v).trim(); return t ? t : null; };

async function internalWindow(db: ReadDb): Promise<{ months: string[]; maxYm: string | null; rowCount: number }> {
  const [row] = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT max(year_month)::text AS max_ym, count(*)::int AS n FROM sales_monthly`));
  const maxYm = text(row?.max_ym);
  return { months: maxYm ? lastMonths(maxYm, 3) : [], maxYm, rowCount: num(row?.n) };
}

async function binding(db: ReadDb): Promise<string> {
  const [velocity, sales, skus] = await Promise.all([
    db.execute(sql`SELECT source_binding FROM report_read_model_cache WHERE key = ${VELOCITY_CACHE_KEY} LIMIT 1`),
    internalWindow(db),
    db.execute(sql`SELECT count(*)::int AS n, coalesce(max(id), 0)::int AS m FROM skus`),
  ]);
  const v = resultRows<Record<string, unknown>>(velocity)[0];
  const k = resultRows<Record<string, unknown>>(skus)[0];
  return `velocity:${text(v?.source_binding) ?? "none"}|sales:${sales.maxYm ?? "none"}:${sales.rowCount}|skus:${num(k?.n)}:${num(k?.m)}`;
}

export async function computeExternalSkuRanking(db: ReadDb): Promise<ExternalSkuRanking> {
  const velocity = await loadExternalVelocity(db);
  const { months } = await internalWindow(db);
  const skuIds = Object.keys(velocity.bySku).map(Number).filter((id) => id > 0);
  const base: Omit<ExternalSkuRanking, "rows" | "brands" | "state" | "gate"> = {
    authority: "observation_only", source: "JIANDAOYUN", platform: "天猫+拼多多",
    sourceAsOf: velocity.sourceAsOf, pddSourceAsOf: velocity.pddSourceAsOf, anchorDate: velocity.anchorDate,
    internalMonths: months, coverage: velocity.coverage,
    limitations: [
      ...velocity.limitations,
      "排名按近 30 天净件数，其次近 90 天；覆盖不足的未知行列在末尾、不授予名次。件数为观察值，不代表正式销量。",
      months.length ? `内部对照 = sales_monthly ${months[0]} ～ ${months[months.length - 1]}（数据最新月回推 3 月，全渠道合计），与外部窗口时点不同，只作并列参考。` : "内部 sales_monthly 无数据，内部对照列为空。",
    ],
  };
  if (velocity.state !== "ready" || skuIds.length === 0) {
    return { ...base, state: "insufficient", brands: [], rows: [], gate: velocity.gate };
  }
  const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT k.id, k.code, k.name, k.sku_type::text AS sku_type, b.code AS brand,
           (SELECT sum(sm.qty) FROM sales_monthly sm WHERE sm.sku_id = k.id
              AND sm.year_month IN (${sql.join(months.length ? months.map((m) => sql`${m}`) : [sql`''`], sql`, `)})) AS internal3m
    FROM skus k LEFT JOIN brands b ON b.id = k.brand_id
    WHERE k.id IN (${sql.join(skuIds.map((id) => sql`${id}`), sql`, `)})
  `));
  const ranked: ExternalSkuRankRow[] = rows.map((r) => {
    const skuId = num(r.id);
    const v = velocity.bySku[String(skuId)];
    return {
      rank: 0, skuId, code: String(r.code ?? ""), name: String(r.name ?? ""), brand: text(r.brand), skuType: text(r.sku_type),
      net30: v.net30, net90: v.net90, tmallNet30: v.tmallNet30, pddNet30: v.pddNet30, tmallNet90: v.tmallNet90, pddNet90: v.pddNet90,
      lastSoldDate: v.lastSoldDate, activeDays90: v.activeDays90, platformSkus: v.platformSkus,
      internal3m: months.length === 0 ? null : r.internal3m == null ? 0 : num(r.internal3m),
    };
  }).sort((a, b) => compareDecimalValues(b.net30, a.net30, "first") || compareDecimalValues(b.net90, a.net90, "first") || a.code.localeCompare(b.code));
  ranked.forEach((r, i) => { r.rank = r.net30 == null ? null : i + 1; });
  const brands = [...new Set(ranked.map((r) => r.brand).filter((b): b is string => !!b))].sort();
  return {
    ...base,
    state: "ready",
    brands,
    rows: ranked,
    gate: `${velocity.gate} 共 ${ranked.length} 个系统 SKU 进入排名。`,
  };
}

export async function loadExternalSkuRanking(db: ReadDb): Promise<ExternalSkuRanking> {
  // 先确保外部销速缓存是新鲜的（loadExternalVelocity 内部按其自身绑定校验），再算本模型绑定
  await loadExternalVelocity(db);
  const key = await binding(db);
  const cached = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${READ_MODEL_CACHE_KEY} AND source_binding = ${key} LIMIT 1`))[0];
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<ExternalSkuRanking>).authority === "observation_only" && Array.isArray((parsed as Partial<ExternalSkuRanking>).rows)) {
    return parsed as ExternalSkuRanking;
  }
  return refreshExternalSkuRanking(db);
}

export async function refreshExternalSkuRanking(db: ReadDb): Promise<ExternalSkuRanking> {
  const result = await computeExternalSkuRanking(db);
  const key = await binding(db);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${READ_MODEL_CACHE_KEY}, ${key}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return result;
}

export type ExternalSkuRankPlatformFilter = "all" | "tmall" | "pdd";

/** API/页面共用的筛选：品牌精确、平台按该平台近 90 天有净件数、q 匹配编码/名称（不区分大小写） */
export function filterExternalSkuRanking(
  model: ExternalSkuRanking,
  filter: { brand?: string | null; platform?: ExternalSkuRankPlatformFilter | null; q?: string | null; limit?: number | null },
): ExternalSkuRanking & { totalRows: number } {
  const q = (filter.q ?? "").trim().toLowerCase();
  let rows = model.rows;
  if (filter.brand) rows = rows.filter((r) => r.brand === filter.brand);
  if (filter.platform === "tmall") rows = rows.filter((r) => compareDecimalValues(r.tmallNet90, "0") !== 0 || compareDecimalValues(r.tmallNet30, "0") !== 0);
  if (filter.platform === "pdd") rows = rows.filter((r) => compareDecimalValues(r.pddNet90, "0") !== 0 || compareDecimalValues(r.pddNet30, "0") !== 0);
  if (q) rows = rows.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const totalRows = rows.length;
  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 5000) : 200;
  return { ...model, rows: rows.slice(0, limit), totalRows };
}
