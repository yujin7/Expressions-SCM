import { sql } from "drizzle-orm";
import { dCmp, dDiv } from "@/server/core/decimal";
import { getNumParam } from "@/server/core/params";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { getOnHandBySku } from "@/server/core/stock-view";
import { getOpenSupplyLines, type OpenSupplyLine } from "@/server/core/supply";
import { calendarMonthWindow } from "@/server/core/velocity";
import { completedShanghaiDays, isCurrentObservationDay } from "@/server/core/business-day";
import { getLedgerMovementSummary } from "@/server/core/sales-ledger";
import { classifyTier, DEFAULT_TIER_CUTS, type Tier } from "@/server/rules/abc";
import {
  alertDays as computeAlertDays, coverStatus, coverStatusWithSupply,
  type CoverStatus, type LearnedLead, type LearnedLeadObservation, type SupplyArrival,
} from "@/server/rules/alert-threshold";
import { pickPrimaryAlert, priorityScore, type AlertKind, type PriorityScoreTerms } from "@/server/rules/alert-priority";
import { isSlowMover } from "@/server/rules/risk-action";
import { todayShanghai } from "@/server/modules/master/common";
import { expiryCheck, type ExpiryCheckItem } from "@/server/modules/replenish/expiry";
import { loadExternalVelocitySafe, type ExternalVelocityBySku } from "@/server/modules/report/external-velocity";
import { loadSalesSpike, SALES_SPIKE_CACHE_KEY } from "@/server/modules/report/sales-spike";
import { salesSpikeEvidenceCurrent } from "@/server/rules/sales-spike";

/**
 * 库存预警表读模型（键见 `INVENTORY_ALERTS_CACHE_KEY`；D57，四屏第 2 屏 B-左）。
 *
 * 逐启用成品 SKU 一行：等级（sku_planning_policy 最新期，缺则按近 6 月内部销量现算四档）、
 * 日销三口径并列（外部平台净件数 ÷30 / 内部月表近 6 月折日 / 实时仓销售净出库近 30 个完整业务日折日）、
 * 在库、在库可销天数（按主日销）、阈值（加工+在途+缓冲，逐 SKU 主数据优先，缺省参数）、
 * 主预警（rules/alert-priority 一 SKU 一主预警）、优先级分数、动作链接。
 * 观察序列只用于预警，不进补货数量（D55）。
 *
 * v2 口径升级（审计 #1/#4/#5/#6/#11b，缓存键升版，旧缓存不再命中）：
 * - 未结供给接入（core/supply 唯一权威）：inTransitDated/Undated/Overdue、nextArrival、coverDaysWithSupply；
 *   在库口径 alert 且在库 > 0、下一笔确认到货日落在阈值天数内 → 降为 watch（statusBasis 写明依据）；
 *   在库 = 0 是物理事实，out_of_stock 不因在途降级。在库可销 coverDays 仍按在库口径单独给出。
 * - 学习交期只观察（rollup_supplier_lead，样本 ≥ 3 且 P90 超档案 > 容差）：basis 多一段 learned，阈值不变。
 * - 优先级分带 terms/formula；临期（replenish/expiry）与积压（rules/risk-action.isSlowMover，C 级不判）
 *   两个此前从未产出的预警种类开始产出，仍一 SKU 一主预警。
 *
 * v3 口径升版（缓存键升版，旧缓存不再命中）：
 * - source_binding 补上**业务日**：today 参与在途 dated/overdue/undated 归类、阈值内到货的
 *   alert→watch 降级与临期段位。此前底层行不动就跨日不重算，一笔已经逾期的到货能无限期
 *   压住真实断货预警，依据文案还在说「到货在途」。
 * - 临期口径（replenish/expiry）改为逐仓只取最新盘点期：batch_stocks 唯一键含 stocktake_date，
 *   两期并存时 nearQty/expiredQty 直接翻倍。
 */
/**
 * v5 口径升版（绑定补完，缓存键升版，旧缓存不再命中）：
 * - `batch_stocks` 此前只绑 `max(id)`：**原地改数量**（同一行 qty 从 500 改成 5）与**删行**都不改变 max(id)，
 *   临期量因此可以整夜不重算。改为绑数量指纹（max(id) / 行数 / Σqty / 最新盘点期），
 *   与兄弟读模型 `risk-expiry-buckets` 同法。
 * - `skus` 此前**一列都没绑**，而行集就是「启用成品」、临期判定又逐 SKU 读 `near_expiry_days`：
 *   停用一个 SKU、新建一个成品、把某 SKU 的 near_expiry_days 从 90 改成 30，绑定全都看不见。
 *   改为绑启用成品的行数/最大 id/已维护 near_expiry_days 的个数与其合计/最大 updated_at。
 */
// v9：外部逐序列7/15/30日覆盖与T+1准入；历史完整数可看，不作当前主需求。
// v10：批次参考临期小计改用定点十进制求和，失效旧浮点聚合缓存。
export const INVENTORY_ALERTS_CACHE_KEY = "inventory-alerts/v10";

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
  ledgerDemand: {
    startDay: string; endDayExclusive: string; days: number;
    salesNetQty: string | null; operationsOutQty: string | null;
  };
  /** 仅已登记月销量；有行月份数不证明全部渠道或每月完整。 */
  internalDemand: { startDay: string | null; endDayExclusive: string | null; days: number | null; salesQty: string | null; observedMonths: number };
  net7External: string | null;
  net15External: string | null;
  net30External: string | null;
  externalDemand: { anchorDate: string | null; current: boolean; windows: ExternalVelocityBySku["windows"] | null };
  primaryDaily: number | null;
  primaryDailySource: DailySource | null;
  /** 在库可销天数（不含在途，原口径） */
  coverDays: number | null;
  /** （在库 + 有确认到货日且未逾期的在途）÷ 主日销；粗口径，不做逐日推演（逐日推演在补货页） */
  coverDaysWithSupply: number | null;
  /** 有确认到货日且未逾期的在途量 */
  inTransitDated: number;
  /** 无到货日的在途量（曲线无法安放，须人工催交期） */
  inTransitUndated: number;
  /** 到货日已过仍未到的在途量（不作为可信供给） */
  inTransitOverdue: number;
  /** 最近一笔未逾期、有确认到货日的供给 */
  nextArrival: SupplyArrival | null;
  alertDays: number;
  alertBasis: string;
  usedDefault: boolean;
  /** 学习交期观察项（阈值未变） */
  learnedLead: LearnedLeadObservation | null;
  /** 在库口径三色（不看在途） */
  statusOnHand: CoverStatus;
  /** 最终三色：在库 alert 但阈值内有确认到货 → watch */
  status: CoverStatus;
  downgradedBySupply: boolean;
  statusBasis: string | null;
  primary: AlertKind | null;
  tags: AlertKind[];
  priorityScore: string;
  priorityTerms: PriorityScoreTerms;
  priorityFormula: string;
  spike: boolean;
  /** 爆单在大促预期内（当前合格窗口 expected） */
  spikeExpected: boolean;
  nearExpiry: { minDaysLeft: number | null; nearQty: number; expiredQty: number; thresholdDays: number } | null;
  overstock: boolean;
  /** 动作深链：每个主预警种类都有落地页（断货/低库存 → 补货；调拨常备；临期 → 效期批次清单；积压 → 风险处置） */
  actions: { transfer: string; replenish: string; nearExpiry: string; overstock: string };
}

export interface InventoryAlertsReadModel {
  key: typeof INVENTORY_ALERTS_CACHE_KEY;
  builtAt: string;
  sourceBinding: string;
  params: {
    productionDefault: number; logisticsDefault: number; bufferDays: number; targetDays: number | null;
    tierCuts: { sPct: number; aPct: number; bPct: number };
    slowDaysThreshold: number; learnedToleranceDays: number; today: string;
  };
  totals: {
    skus: number; alert: number; watch: number; ok: number; outOfStock: number;
    downgradedBySupply: number; nearExpiry: number; overstock: number; learnedObserved: number;
    byTier: Record<string, { skus: number; alert: number }>;
  };
  rows: InventoryAlertRow[];
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown): number | null => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * 来源绑定：**读到的每一样输入都要在里面**，包括业务日。
 *
 * `todayShanghai()` 不是装饰：它决定在途算 dated / overdue / undated、决定阈值内到货能不能
 * 把 alert 降成 watch、决定临期段位。少了日期分量，一夜之间「明天到货」变成「已经逾期」
 * 这件事对绑定不可见，缓存永远命中旧结论——兄弟读模型 risk-expiry-buckets 与
 * replenish-pilot 的绑定都带 `todayShanghai()`，本模型此前漏了。
 */
/**
 * 本读模型读到的**全部**运行参数键（与 :202-210 的 getNumParam 一一对应）——绑定必须逐键带上当前值。
 * 此前 binding() 一个都没带：PMC 在 /admin/params 把 alert_buffer_days 从 5 改成 10，
 * 预警结论要等到某张事实表恰好变动才会重算。
 * 护栏：`tests/report/inventory-alerts-param-binding.test.ts`（改任一参数值必须换出新 sourceBinding，
 * 且本清单必须等于文件里实际读的参数键集合）。
 */
export const INVENTORY_ALERTS_BINDING_PARAM_KEYS = [
  "default_production_lead_days",
  "default_logistics_lead_days",
  "alert_buffer_days",
  "cover_target_days",
  "grade_s_pct",
  "grade_a_pct",
  "grade_b_pct",
  "slow_days_threshold",
  "alert_learned_lead_tolerance_days",
] as const;

async function binding(db: AnyDb, today = todayShanghai()): Promise<string> {
  const paramRows = resultRows<{ key: string; value: string }>(await db.execute(sql`
    SELECT key, value FROM sys_params
    WHERE scope = 'global' AND key IN (${sql.join(INVENTORY_ALERTS_BINDING_PARAM_KEYS.map((k) => sql`${k}`), sql`, `)})`));
  const paramValues = new Map(paramRows.map((r) => [String(r.key), String(r.value)]));
  const params = INVENTORY_ALERTS_BINDING_PARAM_KEYS.map((k) => `${k}=${paramValues.get(k) ?? "default"}`).join(",");
  /* 临期量的分子在 batch_stocks 里：原地改数量与删行都不动 max(id)，必须绑数量指纹。 */
  const [bsf] = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT coalesce(max(id), 0)::int AS max_id, count(*)::int AS n,
           coalesce(sum(qty), 0)::text AS qty_sum,
           coalesce(max(stocktake_date)::text, '') AS max_period
    FROM batch_stocks WHERE expiry_date IS NOT NULL AND qty > 0`));
  /* 行集 = 启用成品；临期阈值逐 SKU 读 skus.near_expiry_days。停用/新建/改阈值都必须换出新绑定。 */
  const [skf] = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n,
           coalesce(max(id), 0)::int AS max_id,
           count(near_expiry_days)::int AS maintained,
           coalesce(sum(near_expiry_days), 0)::int AS sum_days,
           coalesce(max(updated_at)::text, '') AS updated
    FROM skus WHERE active = true AND sku_type = 'finished'`));
  const [b] = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT (SELECT coalesce(max(id),0) FROM stock_ledger) AS l,
           (SELECT coalesce(max(id),0) FROM stock_snapshots) AS s,
           (SELECT coalesce(max(id),0) FROM sales_monthly) AS m,
           (SELECT coalesce(max(id),0) FROM sku_params) AS p,
           (SELECT coalesce(max(updated_at)::text,'') FROM sku_params) AS pu,
           (SELECT coalesce(max(id),0) FROM sku_planning_policy) AS pol,
           (SELECT coalesce(max(built_at)::text,'') FROM report_read_model_cache WHERE key LIKE 'jiandaoyun-external-velocity/%') AS ev,
           (SELECT coalesce(max(id),0)::text || ':' || coalesce(sum(received_qty),0)::text || ':' || coalesce(string_agg(DISTINCT expected_date::text, ','), '') FROM po_lines) AS pol_l,
           (SELECT count(*) FILTER (WHERE status IN ('approved','in_progress'))::text || ':' || coalesce(max(id),0)::text || ':' || coalesce(string_agg(DISTINCT expected_date::text, ','), '') FROM po_docs) AS po_d,
           (SELECT count(*) FILTER (WHERE status IN ('approved','in_progress') AND is_paused = false)::text || ':' || coalesce(max(id),0)::text || ':' || coalesce(string_agg(DISTINCT due_date::text, ','), '') FROM wo_docs) AS wo,
           (SELECT coalesce(max(id),0)::text || ':' || coalesce(sum(inbound_qty),0)::text || ':' || coalesce(sum(closed_qty),0)::text FROM transit_refs WHERE kind = 'fg_order') AS tr,
           (SELECT coalesce(max(built_at)::text,'') FROM rollup_supplier_lead) AS rl,
           (SELECT coalesce(max(built_at)::text,'') FROM report_read_model_cache WHERE key LIKE 'sales-spike/%') AS sp,
           (SELECT coalesce(string_agg(id::text || ':' || accounting_mode::text, ',' ORDER BY id), '') FROM warehouses) AS wm
  `));
  const bs = `${Number(bsf?.max_id ?? 0)}/${Number(bsf?.n ?? 0)}/${String(bsf?.qty_sum ?? "0")}/${String(bsf?.max_period ?? "")}`;
  const sk = `${Number(skf?.n ?? 0)}/${Number(skf?.max_id ?? 0)}/${Number(skf?.maintained ?? 0)}/${Number(skf?.sum_days ?? 0)}/${String(skf?.updated ?? "")}`;
  return `alerts:${b?.l}:${b?.s}:${b?.m}:${b?.p}:${b?.pu}:${b?.pol}|ev:${b?.ev}|supply:${b?.pol_l}|${b?.po_d}|${b?.wo}|${b?.tr}|bs:${bs}|sku:${sk}|rl:${b?.rl}|sp:${SALES_SPIKE_CACHE_KEY}:${b?.sp}|params:${params}|warehouses:${b?.wm}|day:${today}`;
}

/** 逐 SKU 汇总未结供给：有日期未逾期 / 无日期 / 逾期 / 下一笔到货 */
export function summarizeSupplyForAlerts(lines: OpenSupplyLine[], today: string): Map<number, { dated: number; undated: number; overdue: number; next: SupplyArrival | null }> {
  const out = new Map<number, { dated: number; undated: number; overdue: number; next: SupplyArrival | null }>();
  for (const l of lines) {
    const e = out.get(l.skuId) ?? { dated: 0, undated: 0, overdue: 0, next: null };
    if (!l.expectDate) e.undated = num((e.undated + l.qty).toFixed(4));
    else if (l.expectDate < today) e.overdue = num((e.overdue + l.qty).toFixed(4));
    else {
      e.dated = num((e.dated + l.qty).toFixed(4));
      if (!e.next || l.expectDate < e.next.date) e.next = { date: l.expectDate, qty: l.qty, source: l.source, ref: l.ref };
    }
    out.set(l.skuId, e);
  }
  return out;
}

async function expiryBySku(db: AnyDb, skuIds: number[]): Promise<Map<number, ExpiryCheckItem>> {
  const out = new Map<number, ExpiryCheckItem>();
  for (let i = 0; i < skuIds.length; i += 200) { // expiryCheck 单次上限 200
    const res = await expiryCheck({ skuIds: skuIds.slice(i, i + 200) }, db);
    for (const it of res.items) if (it.nearBatches > 0) out.set(it.skuId, it);
  }
  return out;
}

export async function computeInventoryAlerts(dbArg: AnyDb): Promise<InventoryAlertsReadModel> {
  const db = await resolveDb(dbArg);
  const [productionDefault, logisticsDefault, bufferDays, targetDaysRaw, sPct, aPct, bPct, slowDaysThreshold, learnedToleranceDays] = await Promise.all([
    getNumParam("default_production_lead_days", 30, db),
    getNumParam("default_logistics_lead_days", 15, db),
    getNumParam("alert_buffer_days", 5, db),
    getNumParam("cover_target_days", 0, db),
    getNumParam("grade_s_pct", DEFAULT_TIER_CUTS.sPct, db),
    getNumParam("grade_a_pct", DEFAULT_TIER_CUTS.aPct, db),
    getNumParam("grade_b_pct", DEFAULT_TIER_CUTS.bPct, db),
    getNumParam("slow_days_threshold", 180, db),
    getNumParam("alert_learned_lead_tolerance_days", 3, db),
  ]);
  const targetDays = targetDaysRaw > 0 ? targetDaysRaw : null;
  const today = todayShanghai();

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
  const internalDemandWindow = maxYm?.ym ? calendarMonthWindow(maxYm.ym, 6) : null;
  const months = internalDemandWindow?.months ?? [];
  const salesRows = months.length
    ? resultRows<{ sku_id: number; qty: string; observed_months: number }>(await db.execute(sql`
        SELECT sku_id, sum(qty)::text AS qty, count(DISTINCT year_month)::int AS observed_months
        FROM sales_monthly WHERE year_month IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)}) GROUP BY sku_id`))
    : [];
  const internal6m = new Map(salesRows.map((r) => [Number(r.sku_id), num(r.qty)]));
  const internalFacts = new Map(salesRows.map((r) => [Number(r.sku_id), r]));
  const computedTier = classifyTier(skus.map((s) => ({ id: s.id, value: internal6m.get(s.id) ?? 0 })), { sPct, aPct, bPct });

  const ledgerWindow = completedShanghaiDays(30, today);
  const ledgerRows = await getLedgerMovementSummary(db, ledgerWindow, skuIds);
  const ledgerBySku = new Map(ledgerRows.map((r) => [r.skuId, r]));

  // 学习交期（rollup_supplier_lead，每 SKU 取样本最多的供应商行）——只观察不生效
  const learnedRows = resultRows<{ sku_id: number; samples: number; p50: string | null; p90: string | null; otr: string | null }>(await db.execute(sql`
    SELECT DISTINCT ON (r.sku_id) r.sku_id, r.samples, r.lead_p50_days AS p50, r.lead_p90_days AS p90, r.on_time_rate AS otr
    FROM rollup_supplier_lead r INNER JOIN skus k ON k.id = r.sku_id
    WHERE k.active = true AND k.sku_type = 'finished'
    ORDER BY r.sku_id, r.samples DESC, r.id DESC`));
  const learnedBySku = new Map<number, LearnedLead>(learnedRows.map((r) => [Number(r.sku_id), { p50: numOrNull(r.p50), p90: numOrNull(r.p90), samples: num(r.samples), onTimeRate: numOrNull(r.otr) }]));

  const [onHand, ev, spike, supplyLines, expiry] = await Promise.all([
    getOnHandBySku(db, { skuIds, finishedOnly: true }),
    loadExternalVelocitySafe(db),
    loadSalesSpike(db).catch(() => null),
    getOpenSupplyLines(db, skuIds),
    expiryBySku(db, skuIds),
  ]);
  const spikeHits = new Map<number, { expected: boolean }>();
  if (salesSpikeEvidenceCurrent(spike?.anchorDate ?? null)) {
    for (const h of spike?.hits ?? []) if (typeof h.skuId === "number") spikeHits.set(h.skuId, { expected: h.expected === true });
  }
  const supplyBySku = summarizeSupplyForAlerts(supplyLines, today);
  const externalCurrent = isCurrentObservationDay(ev.anchorDate);

  const rows: InventoryAlertRow[] = skus.map((s) => {
    const oh = num(onHand.bySku.get(s.id) ?? "0");
    const evs = ev.bySku[String(s.id)];
    const external = evs?.net30 == null ? null : Number(dDiv(evs.net30, "30", 6));
    const internalFact = internalFacts.get(s.id);
    const internal = internalFact && internalDemandWindow ? Number(dDiv(internalFact.qty, internalDemandWindow.days, 6)) : null;
    const ledgerFacts = ledgerBySku.get(s.id);
    const ledgerNet = ledgerFacts?.salesNetQty ?? null;
    // 数量四位的小额销售也要保留需求信号；只在展示时压缩，不用两位舍入参与判定。
    const ledger = ledgerNet != null ? Number(dDiv(ledgerNet, "30", 6)) : null;
    const primaryDailySource: DailySource | null = externalCurrent && evs?.windows?.[30]?.complete === true && external != null && external > 0 ? "external" : internal != null && internal > 0 ? "internal" : ledger != null && ledger > 0 ? "ledger" : null;
    const primaryDaily = primaryDailySource === "external" ? external : primaryDailySource === "internal" ? internal : primaryDailySource === "ledger" ? ledger : null;
    const cover = primaryDaily && primaryDaily > 0 ? r1(oh / primaryDaily) : null;
    const sup = supplyBySku.get(s.id) ?? { dated: 0, undated: 0, overdue: 0, next: null };
    const coverWithSupply = primaryDaily && primaryDaily > 0 ? r1((oh + sup.dated) / primaryDaily) : null;
    const ad = computeAlertDays({
      normalLeadDays: s.normal, logisticsLeadDays: s.logistics, purchaseLeadDays: s.purchase,
      defaults: { production: productionDefault, logistics: logisticsDefault }, bufferDays,
      learned: learnedBySku.get(s.id) ?? null, learnedToleranceDays,
    });
    const statusOnHand = coverStatus(cover, ad.days, targetDays);
    const withSupply = coverStatusWithSupply({ status: statusOnHand, onHand: oh, nextArrival: sup.next, today, alertDaysValue: ad.days });
    const status = withSupply.status;
    const hasDemand = (primaryDaily ?? 0) > 0;
    const spikeHit = spikeHits.get(s.id) ?? null;
    const tierValue = (s.override ?? s.tier ?? computedTier.get(s.id) ?? null) as Tier | null;
    const exp = expiry.get(s.id) ?? null;
    const overstock = tierValue != null && tierValue !== "C" && isSlowMover({ cover, onHand: oh, slowThreshold: slowDaysThreshold });
    const { primary, tags } = pickPrimaryAlert({
      outOfStock: oh <= 0 && hasDemand,
      spike: spikeHit != null,
      lowStock: status === "alert" && oh > 0,
      nearExpiry: exp != null && exp.nearQty > 0,
      overstock,
    });
    const ps = priorityScore({ dailyAvg: primaryDaily == null ? null : String(primaryDaily), alertDays: ad.days, coverDays: cover == null ? null : String(cover) });
    const basisText = ad.basis.map((b) => {
      if (b.part === "learned") return `学习修正 +${b.value}(P90, n=${ad.learned?.samples ?? "?"}, 观察)`;
      const label = b.part === "production" ? "加工" : b.part === "logistics" ? "在途" : "缓冲";
      return `${label} ${b.value}${b.source === "default" ? "(缺省)" : ""}`;
    }).join(" + ");
    return {
      skuId: s.id, code: s.code, name: s.name, brand: s.brand,
      tier: tierValue, tierSource: s.tier || s.override ? "policy" : tierValue ? "computed" : null,
      onHand: String(oh),
      daily: { external, internal, ledger },
      ledgerDemand: {
        startDay: ledgerWindow.startDay, endDayExclusive: ledgerWindow.endDayExclusive, days: ledgerWindow.days,
        salesNetQty: ledgerNet, operationsOutQty: ledgerFacts?.operationsOutQty ?? null,
      },
      internalDemand: {
        startDay: internalDemandWindow?.startDay ?? null, endDayExclusive: internalDemandWindow?.endDayExclusive ?? null,
        days: internalDemandWindow?.days ?? null, salesQty: internalFact?.qty ?? null, observedMonths: internalFact?.observed_months ?? 0,
      },
      net7External: evs?.windows?.[7]?.net ?? null, net15External: evs?.windows?.[15]?.net ?? null, net30External: evs?.net30 ?? null,
      externalDemand: { anchorDate: ev.anchorDate, current: externalCurrent, windows: evs?.windows ?? null },
      primaryDaily, primaryDailySource, coverDays: cover,
      coverDaysWithSupply: coverWithSupply,
      inTransitDated: sup.dated, inTransitUndated: sup.undated, inTransitOverdue: sup.overdue, nextArrival: sup.next,
      alertDays: ad.days,
      alertBasis: basisText,
      usedDefault: ad.usedDefault,
      learnedLead: ad.learned,
      statusOnHand, status, downgradedBySupply: withSupply.downgraded, statusBasis: withSupply.basis,
      primary, tags,
      priorityScore: ps.score, priorityTerms: ps.terms, priorityFormula: ps.formula,
      spike: spikeHit != null, spikeExpected: spikeHit?.expected === true,
      nearExpiry: exp ? { minDaysLeft: exp.minDaysLeft, nearQty: exp.nearQty, expiredQty: exp.expiredQty, thresholdDays: exp.thresholdDays } : null,
      overstock,
      actions: {
        transfer: `/report/transfer-suggest?skuIds=${s.id}`,
        replenish: `/replenish?q=${encodeURIComponent(s.code)}`,
        // 效期页默认只看「已到期」段位，临期批次落在 3/6 月段——深链必须显式 bucket=all 才看得到该 SKU 全部批次
        nearExpiry: `/inventory/expiry?q=${encodeURIComponent(s.code)}&bucket=all`,
        overstock: `/report/risk?q=${encodeURIComponent(s.code)}`,
      },
    };
  });

  const order: Record<string, number> = { S: 0, A: 1, B: 2, C: 3 };
  rows.sort((a, b) => {
    const pa = a.primary ? 0 : 1, pb = b.primary ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const scoreOrder = dCmp(b.priorityScore, a.priorityScore);
    if (scoreOrder !== 0) return scoreOrder;
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
    sourceBinding: await binding(db, today),
    params: { productionDefault, logisticsDefault, bufferDays, targetDays, tierCuts: { sPct, aPct, bPct }, slowDaysThreshold, learnedToleranceDays, today },
    totals: {
      skus: rows.length,
      alert: rows.filter((r) => r.status === "alert").length,
      watch: rows.filter((r) => r.status === "watch").length,
      ok: rows.filter((r) => r.status === "ok").length,
      outOfStock: rows.filter((r) => r.primary === "out_of_stock").length,
      downgradedBySupply: rows.filter((r) => r.downgradedBySupply).length,
      nearExpiry: rows.filter((r) => r.primary === "near_expiry" || r.tags.includes("near_expiry")).length,
      overstock: rows.filter((r) => r.primary === "overstock" || r.tags.includes("overstock")).length,
      learnedObserved: rows.filter((r) => r.learnedLead != null).length,
      byTier,
    },
    rows,
    limitations: [
      "爆单标记仅采纳完整且符合 T+1 时效的观测窗口；过期/缺失证据不作为当前命中，也不证明没有需求。历史爆单与已有告警请在爆单页复核。",
      "日销三口径不相加：外部 = 平台支付−退款近 30 天折日（observation_only，T+1）；内部 = 销量月表近 6 月折日（止于最新月）；实时仓 = 正式销售净出库 ÷ 30（已扣同窗销售红字）。主日销在正值中取外部 > 内部 > 实时仓销售；不代表三者来源/截止相同或全渠道覆盖完整。",
      `实时仓窗口 [${ledgerWindow.startDay}, ${ledgerWindow.endDayExclusive}) 为上海近 30 个已结束业务日，不含今天与未来记录。销售红字按纠正业务日净减，负净量保留展示；无销售事件显示未知，不当作零销售。非销售作业量单列（负向流量，未扣正向冲销），不进主日销、可销天数或补货需求。`,
      internalDemandWindow
        ? `内部月销窗口 [${internalDemandWindow.startDay}, ${internalDemandWindow.endDayExclusive}) 共 ${internalDemandWindow.days} 个自然日；已登记销量除以同一窗口天数，不使用三个月91天分母。有记录月份数单列，不证明各月/各渠道完整；缺失数据需回源补齐。`
        : "尚无已登记内部月销窗口，内部日均保持未知。",
      "可销天数按「在库可销」（不含在途）；阈值 = 加工周期 + 在途周期 + 缓冲，逐 SKU 主数据优先，缺失用参数缺省并标注（D57）。",
      "未结供给（core/supply：PO 未收、WO 在制、存量单在途）只用于降级：在库 alert 且在库 > 0、下一笔确认到货日落在阈值天数内 → watch 并写明依据；在库 = 0 不降级（物理事实）；逾期/无日期在途不算可信供给。含在途可销 = (在库 + 有日期未逾期在途) ÷ 主日销，粗口径，逐日推演以补货页为准。",
      `学习交期只观察不生效：rollup_supplier_lead 样本 ≥ 3 且 P90 超档案加工周期 > ${learnedToleranceDays} 天（alert_learned_lead_tolerance_days）时在阈值依据里单列，阈值本周期不变。`,
      `临期 = 批次参考层 batch_stocks 剩余天数 ≤ skus.nearExpiryDays（缺省 90）；积压 = 可销天数 > ${slowDaysThreshold} 天或有库存无动销（slow_days_threshold），C 级不判积压。仍一 SKU 一主预警（断货 > 爆单 > 低库存 > 临期 > 积压），其余作标签。`,
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
