import { sql } from "drizzle-orm";
import { getNumParam } from "@/server/core/params";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { detectSalesSpike } from "@/server/rules/sales-spike";

/**
 * 爆单预警读模型 `sales-spike/v1`（D56；观察口径，只预警不定量）。
 *
 * 序列：天猫 SKU 日销（简道云 tmall-sku-sales-observation 最新可用批次，店铺 × 平台 SKU × 统计日，paidNumber）。
 * 身份：对照表批次 `_identity.skuId`（shop|platformSkuId → 系统 SKU）∪ 直接认领 sku_identifiers(JIANDAOYUN:TMALL, value=shop|platformSkuId)。
 * 已映射按系统 SKU 汇总后判定；未映射平台 SKU 按 shop|platformSkuId 判定并另列（身份缺口，不冒充）。
 * 规则：最近 N 天每日 ≥ 前 7 日日均 ×(1+rise%) 且基线 ≥ 最低基数（rules/sales-spike，参数 spike_*）。
 */
export const SALES_SPIKE_CACHE_KEY = "sales-spike/v1";

export interface SpikeHit {
  kind: "sku" | "platform";
  skuId: number | null;
  code: string | null;
  name: string | null;
  shopName: string;
  platformSkuId: string | null;
  anchorDate: string;
  days: { date: string; qty: string; risePct: string | null }[];
  baseline: string;
  threshold: string;
  risePct: string | null;
  href: string;
}

export interface SalesSpikeReadModel {
  key: typeof SALES_SPIKE_CACHE_KEY;
  builtAt: string;
  sourceBinding: string;
  state: "ready" | "insufficient";
  anchorDate: string | null;
  sourceAsOf: string | null;
  params: { consecutiveDays: number; risePct: number; minBaseQty: number; baselineDays: number };
  coverage: { platformSeries: number; mappedSeries: number; systemSkus: number };
  hits: SpikeHit[];
  unmappedHits: SpikeHit[];
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

async function latestBatch(db: AnyDb, stream: string, snapshot: boolean): Promise<{ importJobId: number; sourceAsOf: string | null } | null> {
  const [row] = resultRows<{ import_job_id: unknown; source_as_of: unknown }>(await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream} AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND ij.status <> 'superseded'
      AND ${snapshot
        ? sql`(coalesce(ir.request_scope->>'qualityBlocked','false') = 'false'
               OR (coalesce((ir.request_scope->'controlSummary'->>'invalidNumericValues')::int,0) = 0
                   AND coalesce((ir.request_scope->'controlSummary'->>'reconciliationMismatchedRows')::int,0) = 0
                   AND coalesce((ir.request_scope->'controlSummary'->>'deletedRows')::int,0) = 0))`
        : sql`true`}
    ORDER BY ir.id DESC LIMIT 1`));
  const id = Number(row?.import_job_id);
  return id > 0 ? { importJobId: id, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) } : null;
}

async function binding(db: AnyDb, sales: { importJobId: number } | null, cw: { importJobId: number } | null): Promise<string> {
  const [c] = resultRows<{ n: unknown; m: unknown }>(await db.execute(sql`
    SELECT count(*)::int AS n, coalesce(max(id),0)::int AS m FROM sku_identifiers WHERE kind='external' AND scope='JIANDAOYUN:TMALL' AND active = true`));
  const [p] = resultRows<{ v: unknown }>(await db.execute(sql`
    SELECT string_agg(key || '=' || value, ',' ORDER BY key) AS v FROM sys_params WHERE key LIKE 'spike_%'`));
  return `spike:sales=${sales?.importJobId ?? "none"}:cw=${cw?.importJobId ?? "none"}:claims=${c?.n ?? 0}:${c?.m ?? 0}:params=${p?.v ?? ""}`;
}

export async function computeSalesSpike(dbArg: AnyDb): Promise<SalesSpikeReadModel> {
  const db = await resolveDb(dbArg);
  const [consecutiveDays, risePct, minBaseQty] = await Promise.all([
    getNumParam("spike_consecutive_days", 3, db),
    getNumParam("spike_rise_pct", 50, db),
    getNumParam("spike_min_base_qty", 10, db),
  ]);
  const baselineDays = 7;
  const [sales, cw] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", true),
    latestBatch(db, "tmall-sku-crosswalk-observation", false),
  ]);
  const sourceBinding = await binding(db, sales, cw);
  const empty = (note: string): SalesSpikeReadModel => ({
    key: SALES_SPIKE_CACHE_KEY, builtAt: new Date().toISOString(), sourceBinding, state: "insufficient", anchorDate: null,
    sourceAsOf: sales?.sourceAsOf ?? null, params: { consecutiveDays, risePct, minBaseQty, baselineDays },
    coverage: { platformSeries: 0, mappedSeries: 0, systemSkus: 0 }, hits: [], unmappedHits: [], limitations: [note],
  });
  if (!sales) return empty("天猫 SKU 日销流尚未同步或无可用批次。");

  const windowDays = consecutiveDays + baselineDays + 2;
  const rows = resultRows<{ shop: string; psku: string; d: string; qty: string; sku_id: unknown; code: string | null; name: string | null }>(await db.execute(sql`
    WITH s AS (
      SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate',10))
             payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku, left(payload->'data'->>'statisticalDate',10) AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'paidNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'paidNumber')::numeric ELSE 0 END AS qty
      FROM staging_rows
      WHERE import_job_id = ${sales.importJobId} AND target_table = 'jdy_tmall_sku_sales_observation'
        AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate',10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND nullif(trim(payload->'data'->>'skuId'),'') IS NOT NULL
      ORDER BY payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate',10), row_no DESC
    ),
    a AS (SELECT max(d::date) AS d FROM s),
    cw AS (
      SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'platformSkuId')
             payload->'data'->>'shopName' AS shop, payload->'data'->>'platformSkuId' AS psku, (payload->'_identity'->>'skuId')::int AS sku_id
      FROM staging_rows WHERE import_job_id = ${cw?.importJobId ?? -1} AND target_table = 'jdy_tmall_sku_crosswalk_observation'
        AND status IN ('pending','validated','committed') AND payload->'_identity'->>'skuId' IS NOT NULL
      ORDER BY payload->'data'->>'shopName', payload->'data'->>'platformSkuId', row_no DESC
    ),
    direct AS (
      SELECT split_part(value,'|',1) AS shop, split_part(value,'|',2) AS psku, sku_id FROM sku_identifiers
      WHERE kind='external' AND scope='JIANDAOYUN:TMALL' AND active = true
    ),
    map AS (
      SELECT shop, psku, sku_id FROM direct
      UNION
      SELECT cw.shop, cw.psku, cw.sku_id FROM cw WHERE NOT EXISTS (SELECT 1 FROM direct dd WHERE dd.shop = cw.shop AND dd.psku = cw.psku)
    )
    SELECT s.shop, s.psku, s.d, s.qty::text AS qty, m.sku_id, k.code, k.name
    FROM s CROSS JOIN a
    LEFT JOIN map m ON m.shop = s.shop AND m.psku = s.psku
    LEFT JOIN skus k ON k.id = m.sku_id
    WHERE s.d::date > a.d - ${windowDays}::int
    ORDER BY s.shop, s.psku, s.d
  `));
  if (!rows.length) return empty("最新批次在判定窗口内没有日销行。");
  const anchor = rows.reduce((m, r) => (r.d > m ? r.d : m), rows[0].d);

  // 已映射：按系统 SKU 汇总；未映射：按 shop|psku
  const bySku = new Map<number, { code: string | null; name: string | null; shops: Set<string>; daily: Map<string, number> }>();
  const byPlatform = new Map<string, { shop: string; psku: string; daily: Map<string, number> }>();
  let platformSeries = 0, mappedSeries = 0;
  const seenSeries = new Set<string>();
  for (const r of rows) {
    const seriesKey = `${r.shop}|${r.psku}`;
    if (!seenSeries.has(seriesKey)) { seenSeries.add(seriesKey); platformSeries++; if (r.sku_id != null) mappedSeries++; }
    const q = Number(r.qty) || 0;
    if (r.sku_id != null) {
      const id = Number(r.sku_id);
      const e = bySku.get(id) ?? { code: r.code, name: r.name, shops: new Set<string>(), daily: new Map<string, number>() };
      e.shops.add(r.shop); e.daily.set(r.d, (e.daily.get(r.d) ?? 0) + q); bySku.set(id, e);
    } else {
      const e = byPlatform.get(seriesKey) ?? { shop: r.shop, psku: r.psku, daily: new Map<string, number>() };
      e.daily.set(r.d, (e.daily.get(r.d) ?? 0) + q); byPlatform.set(seriesKey, e);
    }
  }
  const toSeries = (daily: Map<string, number>) => [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, qty]) => ({ date, qty: String(qty) }));
  const opts = { consecutiveDays, risePct, minBaseQty, baselineDays, asOf: anchor };
  const hits: SpikeHit[] = [];
  for (const [skuId, e] of bySku) {
    const r = detectSalesSpike(toSeries(e.daily), opts);
    if (!r.hit) continue;
    const last = r.days[r.days.length - 1];
    hits.push({ kind: "sku", skuId, code: e.code, name: e.name, shopName: [...e.shops].join("、"), platformSkuId: null, anchorDate: r.anchorDate ?? anchor,
      days: r.days.map((d) => ({ date: d.date, qty: d.qty, risePct: d.risePct })), baseline: r.baseline, threshold: r.threshold, risePct: last?.risePct ?? null,
      href: `/replenish?sku=${encodeURIComponent(e.code ?? "")}` });
  }
  const unmappedHits: SpikeHit[] = [];
  for (const [, e] of byPlatform) {
    const r = detectSalesSpike(toSeries(e.daily), opts);
    if (!r.hit) continue;
    const last = r.days[r.days.length - 1];
    unmappedHits.push({ kind: "platform", skuId: null, code: null, name: null, shopName: e.shop, platformSkuId: e.psku, anchorDate: r.anchorDate ?? anchor,
      days: r.days.map((d) => ({ date: d.date, qty: d.qty, risePct: d.risePct })), baseline: r.baseline, threshold: r.threshold, risePct: last?.risePct ?? null,
      href: `/report/decision-studio?tab=identity&platformSku=${encodeURIComponent(e.psku)}` });
  }
  const byRise = (a: SpikeHit, b: SpikeHit) => Number(b.risePct ?? 0) - Number(a.risePct ?? 0);
  hits.sort(byRise); unmappedHits.sort(byRise);
  return {
    key: SALES_SPIKE_CACHE_KEY, builtAt: new Date().toISOString(), sourceBinding, state: "ready", anchorDate: anchor,
    sourceAsOf: sales.sourceAsOf, params: { consecutiveDays, risePct, minBaseQty, baselineDays },
    coverage: { platformSeries, mappedSeries, systemSkus: bySku.size }, hits, unmappedHits,
    limitations: [
      "来源：简道云天猫 SKU 日销（observation_only，T+1）；拼多多订单流暂未纳入爆单判定；唯品会无 SKU 级日销。",
      `规则：最近 ${consecutiveDays} 天每日 ≥ 前 ${baselineDays} 日日均 ×${(1 + risePct / 100).toFixed(2)} 且基线 ≥ ${minBaseQty} 件（参数 spike_*，可调）；缺日按 0 计并记 gaps；大促日历未接。`,
      "已映射 SKU 按系统 SKU 汇总多店铺；未映射平台 SKU 另列并附认领入口，不冒充系统 SKU。只预警，不自动开单、不定量（D55/D56）。",
    ],
  };
}

export async function loadSalesSpike(dbArg?: AnyDb): Promise<SalesSpikeReadModel> {
  const db = await resolveDb(dbArg);
  const [sales, cw] = await Promise.all([latestBatch(db, "tmall-sku-sales-observation", true), latestBatch(db, "tmall-sku-crosswalk-observation", false)]);
  const key = await binding(db, sales, cw);
  const [cached] = resultRows<{ payload: unknown }>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${SALES_SPIKE_CACHE_KEY} AND source_binding = ${key} LIMIT 1`));
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload) as unknown; } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<SalesSpikeReadModel>).key === SALES_SPIKE_CACHE_KEY && Array.isArray((parsed as Partial<SalesSpikeReadModel>).hits)) {
    return parsed as SalesSpikeReadModel;
  }
  return refreshSalesSpike(db);
}

export async function refreshSalesSpike(dbArg?: AnyDb): Promise<SalesSpikeReadModel> {
  const db = await resolveDb(dbArg);
  const result = await computeSalesSpike(db);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${SALES_SPIKE_CACHE_KEY}, ${result.sourceBinding}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at`);
  return result;
}
