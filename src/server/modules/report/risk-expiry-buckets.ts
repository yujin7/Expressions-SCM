/**
 * C3 临期与呆滞读模型 `risk-expiry-buckets/v1`（驾驶舱第 3 屏「临期与呆滞」块）。
 *
 * 口径（不新增计算，只把 report/risk.ts 的风险工作台按品牌 × 效期段位重新聚合）：
 * - 段位 = 批次剩余天数统一刻度：已过期(≤0) / ≤30 / 31–60 / 61–90；> 90 天不入桶（不是「没有库存」）。
 *   段位与逐 SKU 临期阈值（skus.near_expiry_days）无关——阈值只决定风险动作，段位是统一读数刻度。
 * - 数量 = batch_stocks.qty（效期盘点载体，不是账本）；跨 SKU 直加只作规模参考。
 * - 呆滞 = 风险工作台判定为「滞销关注」的 SKU（可销天数 ≥ slow_days_threshold），按品牌计数与在库量。
 * - 兜底标注：near_expiry_days 未维护、按 90 天兜底的 SKU 数单列——段位不是统一口径这件事必须写在读数旁边。
 * - externalNet30（简道云天猫观察）只作注记：标出「内部说呆滞、外部近 30 天仍在卖」的 SKU 数，
 *   observation_only，不驱动处置数量（D55）。
 * - 覆盖前提：风险工作台只收在库 > 0（或有货盘注记）的 SKU，所以「有效期批次但全网在库为 0」的 SKU
 *   不进本块——那是在库账与效期盘点对不上，应在数据质量页处理，不在这里当成临期量。
 * - 缓存：report_read_model_cache key `risk-expiry-buckets/v1`，source_binding 绑
 *   batch_stocks max(id)+行数 + skus.near_expiry_days 指纹 + slow_days_threshold + 业务日（跨日必须重算）。
 */
import { sql } from "drizzle-orm";
import { getNumParam } from "@/server/core/params";
import { r1, resolveDb, type AnyDb } from "@/server/core/svc";
import { todayShanghai } from "@/server/modules/master/common";
import {
  EXPIRY_BUCKET_KEYS,
  EXPIRY_BUCKET_LABELS,
  getRiskWorklist,
  type ExpiryBucketKey,
  type RiskRow,
} from "@/server/modules/report/risk";

export const RISK_EXPIRY_BUCKETS_KEY = "risk-expiry-buckets/v1";

/** 风险工作台里代表「呆滞」的动作（rules/risk-action.ts 的中文动作名，唯一权威在那儿） */
const SLOW_MOVER_ACTION = "滞销关注";

export interface ExpiryBucketTotals {
  key: ExpiryBucketKey;
  label: string;
  qty: number;
  skus: number;
}

export interface ExpiryBrandRow {
  brand: string;
  /** 各段位数量 */
  buckets: Record<ExpiryBucketKey, number>;
  /** 该品牌落在 0–90 天任一段位的 SKU 数 */
  expirySkus: number;
  /** 呆滞（滞销关注）SKU 数与在库量 */
  slowSkus: number;
  slowOnHand: number;
  /** 呆滞但外部近 30 天仍有观察动销的 SKU 数（注记，不定量） */
  slowStillSellingExternally: number;
  /** 段位数量合计（排序用） */
  totalQty: number;
}

export interface RiskExpiryBucketsModel {
  key: typeof RISK_EXPIRY_BUCKETS_KEY;
  authority: "snapshot";
  builtAt: string;
  sourceBinding: string;
  today: string;
  slowThreshold: number;
  totals: ExpiryBucketTotals[];
  brands: ExpiryBrandRow[];
  /** 有效期批次的 SKU 数（落在 0–90 天任一段位） */
  expirySkus: number;
  /** 呆滞 SKU 数 */
  slowSkus: number;
  /** 临期阈值走 90 天兜底的 SKU 数（分母 = 进入段位的 SKU 数） */
  fallbackSkus: number;
  /** 外部观察注记：呆滞但近 30 天外部仍在卖的 SKU 数；未映射不计（不按 0 处理） */
  slowStillSellingExternally: number;
  /** 有外部观察映射的呆滞 SKU 数（注记分母） */
  slowWithExternalSignal: number;
  limitations: string[];
}

const emptyBuckets = (): Record<ExpiryBucketKey, number> => ({ expired: 0, d30: 0, d60: 0, d90: 0 });

const BRAND_LIMIT = 12;
const NO_BRAND = "（未设品牌）";

export function buildRiskExpiryBuckets(
  rows: RiskRow[],
  opts: { today: string; slowThreshold: number },
): Omit<RiskExpiryBucketsModel, "key" | "authority" | "builtAt" | "sourceBinding"> {
  const byBrand = new Map<string, ExpiryBrandRow>();
  const totalsQty = emptyBuckets();
  const totalsSkus = emptyBuckets();
  let expirySkus = 0;
  let slowSkus = 0;
  let fallbackSkus = 0;
  let slowStillSelling = 0;
  let slowWithSignal = 0;

  for (const r of rows) {
    const inExpiry = EXPIRY_BUCKET_KEYS.some((k) => r.expiryBuckets[k] > 0);
    const isSlow = r.action === SLOW_MOVER_ACTION;
    if (!inExpiry && !isSlow) continue;
    const brand = r.brand ?? NO_BRAND;
    const row = byBrand.get(brand) ?? {
      brand, buckets: emptyBuckets(), expirySkus: 0, slowSkus: 0, slowOnHand: 0,
      slowStillSellingExternally: 0, totalQty: 0,
    };
    byBrand.set(brand, row);
    if (inExpiry) {
      expirySkus += 1;
      row.expirySkus += 1;
      if (r.nearExpiryFallback) fallbackSkus += 1;
      for (const k of EXPIRY_BUCKET_KEYS) {
        const q = r.expiryBuckets[k];
        if (q <= 0) continue;
        row.buckets[k] = r1(row.buckets[k] + q);
        row.totalQty = r1(row.totalQty + q);
        totalsQty[k] = r1(totalsQty[k] + q);
        totalsSkus[k] += 1;
      }
    }
    if (isSlow) {
      slowSkus += 1;
      row.slowSkus += 1;
      row.slowOnHand = r1(row.slowOnHand + r.onHand);
      if (r.externalNet30 != null) {
        slowWithSignal += 1;
        if (r.externalNet30 > 0) {
          slowStillSelling += 1;
          row.slowStillSellingExternally += 1;
        }
      }
    }
  }

  const brands = [...byBrand.values()]
    .sort((a, b) => b.totalQty - a.totalQty || b.slowSkus - a.slowSkus || a.brand.localeCompare(b.brand, "zh-CN"))
    .slice(0, BRAND_LIMIT);

  return {
    today: opts.today,
    slowThreshold: opts.slowThreshold,
    totals: EXPIRY_BUCKET_KEYS.map((k) => ({ key: k, label: EXPIRY_BUCKET_LABELS[k], qty: totalsQty[k], skus: totalsSkus[k] })),
    brands,
    expirySkus,
    slowSkus,
    fallbackSkus,
    slowStillSellingExternally: slowStillSelling,
    slowWithExternalSignal: slowWithSignal,
    limitations: [
      "段位按批次剩余天数统一刻度（已过期 / ≤30 / 31–60 / 61–90），> 90 天不入桶；与逐 SKU 临期阈值无关。",
      "数量取 batch_stocks（效期盘点载体，不是账本）；跨 SKU 基础单位直加只作规模参考。",
      `呆滞 = 风险工作台「${SLOW_MOVER_ACTION}」（可销天数 ≥ ${opts.slowThreshold} 天）；只按品牌看规模，不代表已决定处置。`,
      "外部近 30 天动销为简道云天猫观察，仅作注记：未映射 SKU 不计（不按 0 处理），不驱动处置数量（D55）。",
      "覆盖：只含在库 > 0（或有货盘注记）的 SKU——风险工作台的入表条件；在库为 0 但仍有效期批次的 SKU 不计入。",
    ],
  };
}

/** 绑定：效期批次事实 + 逐 SKU 临期阈值指纹 + 呆滞阈值 + 业务日（跨日段位会移动，必须重算） */
export async function riskExpiryBucketsBinding(db: AnyDb): Promise<string> {
  const [bs] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT coalesce(max(id), 0)::int AS max_id, count(*)::int AS n
    FROM batch_stocks WHERE expiry_date IS NOT NULL AND qty > 0`));
  const [sk] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n,
           count(near_expiry_days)::int AS maintained,
           coalesce(sum(near_expiry_days), 0)::int AS sum_days
    FROM skus WHERE active = true`));
  const slowThreshold = await getNumParam("slow_days_threshold", 180, db);
  return [
    `bs:${int(bs?.max_id)}/${int(bs?.n)}`,
    `sku:${int(sk?.n)}/${int(sk?.maintained)}/${int(sk?.sum_days)}`,
    `slow:${slowThreshold}`,
    `day:${todayShanghai()}`,
  ].join("|");
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export async function refreshRiskExpiryBuckets(dbArg?: AnyDb): Promise<RiskExpiryBucketsModel> {
  const db = await resolveDb(dbArg);
  const binding = await riskExpiryBucketsBinding(db);
  // all + precise：读模型口径不分页、不截断小数（屏显 1dp 由前端决定）
  const worklist = await getRiskWorklist({ all: true, precise: true }, db);
  const model: RiskExpiryBucketsModel = {
    key: RISK_EXPIRY_BUCKETS_KEY,
    authority: "snapshot",
    builtAt: new Date().toISOString(),
    sourceBinding: binding,
    ...buildRiskExpiryBuckets(worklist.rows, { today: worklist.today, slowThreshold: worklist.slowThreshold }),
  };
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${RISK_EXPIRY_BUCKETS_KEY}, ${binding}, ${JSON.stringify(model)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return model;
}

/** 页面读：绑定一致走缓存，未命中即重建（与其余读模型同法） */
export async function loadRiskExpiryBuckets(dbArg?: AnyDb): Promise<RiskExpiryBucketsModel> {
  const db = await resolveDb(dbArg);
  const binding = await riskExpiryBucketsBinding(db);
  const [cached] = rowsOf<{ payload?: unknown }>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${RISK_EXPIRY_BUCKETS_KEY} AND source_binding = ${binding} LIMIT 1`));
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? safeJson(payload) : payload;
  if (parsed && typeof parsed === "object"
    && (parsed as Partial<RiskExpiryBucketsModel>).key === RISK_EXPIRY_BUCKETS_KEY
    && Array.isArray((parsed as Partial<RiskExpiryBucketsModel>).totals)) {
    return parsed as RiskExpiryBucketsModel;
  }
  return refreshRiskExpiryBuckets(db);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
