import { sql } from "drizzle-orm";
import { getNumParam } from "@/server/core/params";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { getOnHandBySku } from "@/server/core/stock-view";
import { dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { classifyTier, DEFAULT_TIER_CUTS, type Tier } from "@/server/rules/abc";
import { alertDays as computeAlertDays, coverStatus, type CoverStatus } from "@/server/rules/alert-threshold";
import { pickPrimaryAlert, priorityScore, type AlertKind } from "@/server/rules/alert-priority";
import { loadExternalVelocitySafe } from "@/server/modules/report/external-velocity";
import { loadSalesSpike } from "@/server/modules/report/sales-spike";

/**
 * 库存预警表读模型 `inventory-alerts/v1`（D57；四屏第 2 屏 B-左）。
 *
 * 逐启用成品 SKU 一行：等级（sku_planning_policy 最新期，缺则按近 6 月内部销量现算四档）、
 * 日销三口径并列（外部平台净件数 ÷30 / 内部月表近 6 月折日 / 实时仓出库近 30 天折日）、
 * 在库、在库可销天数（按主日销）、阈值（加工+在途+缓冲，逐 SKU 主数据优先，缺省参数）、
 * 主预警（rules/alert-priority 一 SKU 一主预警）、优先级分数、动作链接。
 * 观察序列只用于预警，不进补货数量（D55）。
 */
export const INVENTORY_ALERTS_CACHE_KEY = "inventory-alerts/v1";

export type DailySource = "external" | "internal" | "ledger";

export interface InventoryAlertRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  tier: Tier | null;
  tierSource: "policy" | "computed" | null;
  onHand: string;
  daily: { external: number | null; internal: number | null; ledger: number | null };
  net7External: number | null;
  net30External: number | null;
  primaryDaily: number | null;
  primaryDailySource: DailySource | null;
  coverDays: number | null;
  alertDays: number;
  alertBasis: string;
  usedDefault: boolean;
  status: CoverStatus;
  primary: AlertKind | null;
  tags: AlertKind[];
  priorityScore: string;
  spike: boolean;
  actions: { transfer: string; replenish: string };
}

export interface InventoryAlertsReadModel {
  key: typeof INVENTORY_ALERTS_CACHE_KEY;
  builtAt: string;
  sourceBinding: string;
  params: { productionDefault: number; logisticsDefault: number; bufferDays: number; targetDays: number | null; tierCuts: { sPct: number; aPct: number; bPct: number } };
  totals: { skus: number; alert: number; watch: number; ok: number; outOfStock: number; byTier: Record<string, { skus: number; alert: number }> };
  rows: InventoryAlertRow[];
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function binding(db: AnyDb): Promise<string> {
  const [b] = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT (SELECT coalesce(max(id),0) FROM stock_ledger) AS l,
           (SELECT coalesce(max(id),0) FROM stock_snapshots) AS s,
           (SELECT coalesce(max(id),0) FROM sales_monthly) AS m,
           (SELECT coalesce(max(id),0) FROM sku_params) AS p,
           (SELECT coalesce(max(updated_at)::text,'') FROM sku_params) AS pu,
           (SELECT coalesce(max(id),0) FROM sku_planning_policy) AS pol,
           (SELECT coalesce(max(built_at)::text,'') FROM report_read_model_cache WHERE key LIKE 'jiandaoyun-external-velocity/%') AS ev
  `));
  return `alerts:${b?.l}:${b?.s}:${b?.m}:${b?.p}:${b?.pu}:${b?.pol}|ev:${b?.ev}`;
}

export async function computeInventoryAlerts(dbArg: AnyDb): Promise<InventoryAlertsReadModel> {
  const db = await resolveDb(dbArg);
  const [productionDefault, logisticsDefault, bufferDays, targetDaysRaw, sPct, aPct, bPct] = await Promise.all([
    getNumParam("default_production_lead_days", 30, db),
    getNumParam("default_logistics_lead_days", 15, db),
    getNumParam("alert_buffer_days", 5, db),
    getNumParam("cover_target_days", 0, db),
    getNumParam("grade_s_pct", DEFAULT_TIER_CUTS.sPct, db),
    getNumParam("grade_a_pct", DEFAULT_TIER_CUTS.aPct, db),
    getNumParam("grade_b_pct", DEFAULT_TIER_CUTS.bPct, db),
  ]);
  const targetDays = targetDaysRaw > 0 ? targetDaysRaw : null;

  // SKU 主档（启用成品）+ 周期主数据 + 最新期分层
  const skus = resultRows<{ id: number; code: string; name: string; brand: string | null; normal: number | null; logistics: number | null; purchase: number | null; tier: string | null; override: string | null }>(await db.execute(sql`
    SELECT k.id, k.code, k.name, b.code AS brand, p.normal_lead_days AS normal, p.logistics_lead_days AS logistics, p.purchase_lead_days AS purchase,
           pol.tier, pol.override_tier AS override
    FROM skus k
    LEFT JOIN brands b ON b.id = k.brand_id
    LEFT JOIN sku_params p ON p.sku_id = k.id
    LEFT JOIN LATERAL (
      SELECT tier, override_tier FROM sku_planning_policy sp WHERE sp.sku_id = k.id ORDER BY period DESC LIMIT 1
    ) pol ON true
    WHERE k.active = true AND k.sku_type = 'finished'
    ORDER BY k.code
  `));
  const skuIds = skus.map((s) => s.id);

  // 内部月销（近 6 月）→ 分层现算 + 内部日均
  const [maxYm] = resultRows<{ ym: string | null }>(await db.execute(sql`SELECT max(year_month) AS ym FROM sales_monthly`));
  const months = maxYm?.ym ? lastMonths(maxYm.ym, 6) : [];
  const salesRows = months.length
    ? resultRows<{ sku_id: number; qty: string }>(await db.execute(sql`
        SELECT sku_id, sum(qty)::text AS qty FROM sales_monthly WHERE year_month IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)}) GROUP BY sku_id`))
    : [];
  const internal6m = new Map(salesRows.map((r) => [Number(r.sku_id), num(r.qty)]));
  const computedTier = classifyTier(skus.map((s) => ({ id: s.id, value: internal6m.get(s.id) ?? 0 })), { sPct, aPct, bPct });

  // 实时仓出库近 30 天
  const ledgerRows = resultRows<{ sku_id: number; out: string }>(await db.execute(sql`
    SELECT l.sku_id, sum(-l.qty_delta)::text AS out FROM stock_ledger l
    WHERE l.qty_delta < 0 AND l.occurred_at >= now() - interval '30 days' GROUP BY l.sku_id`));
  const ledgerOut30 = new Map(ledgerRows.map((r) => [Number(r.sku_id), num(r.out)]));

  const [onHand, ev, spike] = await Promise.all([
    getOnHandBySku(db, { skuIds, finishedOnly: true }),
    loadExternalVelocitySafe(db),
    loadSalesSpike(db).catch(() => null),
  ]);
  const spikeSkus = new Set((spike?.hits ?? []).map((h) => h.skuId).filter((x): x is number => typeof x === "number"));

  const rows: InventoryAlertRow[] = skus.map((s) => {
    const oh = num(onHand.bySku.get(s.id) ?? "0");
    const evs = ev.bySku[String(s.id)];
    const external = evs && evs.net30 > 0 ? Math.round((evs.net30 / 30) * 100) / 100 : evs ? 0 : null;
    const internalWindow = internal6m.get(s.id);
    const internal = internalWindow != null && months.length ? Math.round(dailyFromWindow(internalWindow) * 100) / 100 : null;
    const ledgerOut = ledgerOut30.get(s.id);
    const ledger = ledgerOut != null ? Math.round((ledgerOut / 30) * 100) / 100 : null;
    const primaryDailySource: DailySource | null = external != null && external > 0 ? "external" : internal != null && internal > 0 ? "internal" : ledger != null && ledger > 0 ? "ledger" : null;
    const primaryDaily = primaryDailySource === "external" ? external : primaryDailySource === "internal" ? internal : primaryDailySource === "ledger" ? ledger : null;
    const cover = primaryDaily && primaryDaily > 0 ? Math.round((oh / primaryDaily) * 10) / 10 : null;
    const ad = computeAlertDays({ normalLeadDays: s.normal, logisticsLeadDays: s.logistics, purchaseLeadDays: s.purchase, defaults: { production: productionDefault, logistics: logisticsDefault }, bufferDays });
    const status = coverStatus(cover, ad.days, targetDays);
    const hasDemand = (primaryDaily ?? 0) > 0;
    const isSpike = spikeSkus.has(s.id);
    const { primary, tags } = pickPrimaryAlert({ outOfStock: oh <= 0 && hasDemand, spike: isSpike, lowStock: status === "alert" && oh > 0 });
    const tierValue = (s.override ?? s.tier ?? computedTier.get(s.id) ?? null) as Tier | null;
    return {
      skuId: s.id, code: s.code, name: s.name, brand: s.brand,
      tier: tierValue, tierSource: s.tier || s.override ? "policy" : tierValue ? "computed" : null,
      onHand: String(oh),
      daily: { external, internal, ledger },
      net7External: null, net30External: evs ? evs.net30 : null,
      primaryDaily, primaryDailySource, coverDays: cover,
      alertDays: ad.days,
      alertBasis: ad.basis.map((b) => `${b.part === "production" ? "加工" : b.part === "logistics" ? "在途" : "缓冲"} ${b.value}${b.source === "default" ? "(缺省)" : ""}`).join(" + "),
      usedDefault: ad.usedDefault,
      status, primary, tags,
      priorityScore: priorityScore({ dailyAvg: primaryDaily == null ? null : String(primaryDaily), alertDays: ad.days, coverDays: cover == null ? null : String(cover) }),
      spike: isSpike,
      actions: { transfer: `/report/transfer-suggest?skuIds=${s.id}`, replenish: `/replenish?sku=${encodeURIComponent(s.code)}` },
    };
  });

  const order: Record<string, number> = { S: 0, A: 1, B: 2, C: 3 };
  rows.sort((a, b) => {
    const pa = a.primary ? 0 : 1, pb = b.primary ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const sa = Number(a.priorityScore), sb = Number(b.priorityScore);
    if (sb !== sa) return sb - sa;
    return (order[a.tier ?? "C"] ?? 9) - (order[b.tier ?? "C"] ?? 9);
  });
  const byTier: Record<string, { skus: number; alert: number }> = {};
  for (const r of rows) {
    const k = r.tier ?? "未分层";
    byTier[k] = byTier[k] ?? { skus: 0, alert: 0 };
    byTier[k].skus++;
    if (r.status === "alert" || r.primary === "out_of_stock") byTier[k].alert++;
  }
  return {
    key: INVENTORY_ALERTS_CACHE_KEY,
    builtAt: new Date().toISOString(),
    sourceBinding: await binding(db),
    params: { productionDefault, logisticsDefault, bufferDays, targetDays, tierCuts: { sPct, aPct, bPct } },
    totals: {
      skus: rows.length,
      alert: rows.filter((r) => r.status === "alert").length,
      watch: rows.filter((r) => r.status === "watch").length,
      ok: rows.filter((r) => r.status === "ok").length,
      outOfStock: rows.filter((r) => r.primary === "out_of_stock").length,
      byTier,
    },
    rows,
    limitations: [
      "日销三口径不相加：外部 = 平台支付−退款近 30 天折日（observation_only，T+1）；内部 = 销量月表近 6 月折日（止于最新月）；实时仓 = 流水近 30 天出库折日（含调拨/发料，非纯销售）。主日销取外部 > 内部 > 实时仓。",
      "可销天数按「在库可销」（不含在途）；阈值 = 加工周期 + 在途周期 + 缓冲，逐 SKU 主数据优先，缺失用参数缺省并标注（D57）。",
      "观察序列只用于预警，不进入补货数量（D55）；等级来自最新期分层固化，缺则按近 6 月内部销量现算（D58）。",
    ],
  };
}

export async function loadInventoryAlerts(dbArg?: AnyDb): Promise<InventoryAlertsReadModel> {
  const db = await resolveDb(dbArg);
  const key = await binding(db);
  const [cached] = resultRows<{ payload: unknown }>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${INVENTORY_ALERTS_CACHE_KEY} AND source_binding = ${key} LIMIT 1`));
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload) as unknown; } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<InventoryAlertsReadModel>).key === INVENTORY_ALERTS_CACHE_KEY && Array.isArray((parsed as Partial<InventoryAlertsReadModel>).rows)) {
    return parsed as InventoryAlertsReadModel;
  }
  return refreshInventoryAlerts(db);
}

export async function refreshInventoryAlerts(dbArg?: AnyDb): Promise<InventoryAlertsReadModel> {
  const db = await resolveDb(dbArg);
  const result = await computeInventoryAlerts(db);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${INVENTORY_ALERTS_CACHE_KEY}, ${result.sourceBinding}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at`);
  return result;
}
