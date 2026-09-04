import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";
import { dAdd, dMul } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { getInbox } from "@/server/modules/inbox/service";
import { loadDataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { loadExternalVelocitySafe } from "@/server/modules/report/external-velocity";
import {
  INVENTORY_POSITION_CACHE_KEY,
  loadInventoryPosition,
  todayShanghai,
  type DailyPoint,
  type MonthEndPoint,
  type QtyBlock,
  type WarehouseBlock,
} from "@/server/modules/report/inventory-position";
import { INVENTORY_SALES_RATIO_CACHE_KEY, loadInventorySalesRatio, type RatioMonthRow, type RatioTargets } from "@/server/modules/report/inventory-sales-ratio";
import { countReviewItems } from "@/server/modules/review/checklist";
import { computeExceptions, type ExceptionItem } from "@/server/modules/workbench/focus";
import { countOpenAlerts } from "@/server/modules/alerts/engine";
import { INVENTORY_ALERTS_CACHE_KEY, loadInventoryAlerts, type InventoryAlertRow, type InventoryAlertsReadModel } from "@/server/modules/report/inventory-alerts";
import { loadSalesSpike, SALES_SPIKE_CACHE_KEY, type SalesSpikeReadModel, type SpikeHit } from "@/server/modules/report/sales-spike";
import { loadPurchaseOrderMetrics, purchaseOrderCockpitBlock, PURCHASE_ORDER_METRICS_KEY, type PurchaseOrderCockpitBlock } from "@/server/modules/report/purchase-order-metrics";
import { loadTransferRoutes, topLanes, TRANSFER_ROUTES_CACHE_KEY, type TransferAnomalyRow, type TransferLaneRow, type TransferRoutesModel } from "@/server/modules/report/transfer-routes";
import { loadWarehouseInventory, WAREHOUSE_INVENTORY_CACHE_KEY, type WarehouseInventoryModel, type WarehouseInventoryRow } from "@/server/modules/report/warehouse-inventory";
import { getTodoProgressBlock, type TodoProgressBlock } from "@/server/modules/todo/stats";
import { getGoalsBlock, type GoalsBlock } from "@/server/modules/goals/service";
import { DATA_QUALITY_CACHE_KEY, loadDataQuality, type DataQualityReport } from "@/server/modules/report/data-quality";

/**
 * 驾驶舱四屏装配（D50）。只读、只装配：每一块都来自已有的唯一权威读模型/服务，不在这里重算口径。
 *
 * 块状态：
 * - ready：数据可用；
 * - insufficient：来源存在但当前没有可用数据（缺流/缺批次），note 说明原因；
 * - no_access：当前角色无权看该块（服务端剥离，前端显示空态而不是 0）；
 * - pending_domain：承接该块的领域尚未合并（预警引擎/调拨线路/待办目标/采购指标/数据质量），前端显示「待接入」；
 * - error：装配时该来源抛错，其他块照常显示（allSettled）。
 */
export type BlockState = "ready" | "insufficient" | "no_access" | "pending_domain" | "error";

export interface CockpitSource {
  tier: "fact" | "snapshot" | "observation" | "manual" | "derived";
  source: string;
  asOf: string | null;
}

export interface Block<T> {
  state: BlockState;
  data: T | null;
  note: string;
  source: CockpitSource;
}

export interface SourceStatusRow {
  key: string;
  label: string;
  state: string;
  configured: boolean;
  lastSuccessAt: string | null;
  sourceAsOfEnd: string | null;
  sourceRows: number | null;
  stagedRows: number | null;
  successfulStreams: number | null;
  selectedContractCount: number;
  gate: string | null;
  nextAction: string | null;
}

export interface RedlineItem {
  key: string;
  label: string;
  count: number;
  severity: "critical" | "high" | "medium";
  href: string;
}

export interface CockpitData {
  generatedAt: string;
  today: string;
  currentMonth: string;
  topbar: {
    roleLabel: string;
    scopeLabel: string;
    dataAsOf: string | null;
    valuationCoveragePct: number | null;
    identityCoveragePct: number | null;
    calibreVersion: string;
  };
  screens: {
    sources: {
      position: Block<{
        current: { realtime: QtyBlock; snapshot: QtyBlock & { bizDate: string | null }; total: QtyBlock };
        monthToDate: { inQty: string; outQty: string; days: number };
        daily: DailyPoint[];
        monthEnd: MonthEndPoint[];
        ledgerFirstDay: string | null;
        latestSnapshotDate: string | null;
        limitations: string[];
      }>;
      ratio: Block<{ current: RatioMonthRow; rows: RatioMonthRow[]; target: RatioTargets; formula: string }>;
      salesAmount: Block<{ yearMonth: string; salesAmount: string | null; salesSource: RatioMonthRow["salesSource"] }>;
      dataSources: Block<SourceStatusRow[]>;
    };
    alerts: {
      redline: RedlineItem[];
      /** rows 只带前 20 行；alertRowCount = 有主预警/非 ok 的总行数（审计 #14：截断必须说出来） */
      inventoryAlerts: Block<{ rows: InventoryAlertRow[]; alertRowCount: number; totals: InventoryAlertsReadModel["totals"]; params: InventoryAlertsReadModel["params"]; limitations: string[] }>;
      /** hits/unmappedHits 各只带前 10 行；hitCount/unmappedCount 是读模型全量（审计 #3：数组长度不是总数） */
      salesSpike: Block<{ hits: SpikeHit[]; unmappedHits: SpikeHit[]; hitCount: number; unmappedCount: number; anchorDate: string | null; coverage: SalesSpikeReadModel["coverage"]; params: SalesSpikeReadModel["params"]; openAlerts: number; unacked: number }>;
      /** otifRatePct：服务端已折成百分数字符串（"83.3"），前端只拼 %（审计 #1：0.83 曾被显示成 0.83%） */
      orders: Block<PurchaseOrderCockpitBlock & { otifRatePct: string | null }>;
    };
    inventory: {
      /** rows 只带前 20 行，rowCount 为全部仓数 */
      warehouses: Block<{ rows: WarehouseBlock[]; rowCount: number; activeCount: number; realtimeCount: number; snapshotCount: number }>;
      transferLanes: Block<{ lanes: TransferLaneRow[]; summary: TransferRoutesModel["summary"]; asOf: string | null }>;
      /** rows 只带前 10 行；anomalyCount 为全部 */
      transferAnomalies: Block<{ rows: TransferAnomalyRow[]; anomalyCount: number; alertCount: number; scatteredLaneCount: number }>;
      /** rows 只带实时仓前 8 行（「哪些仓参与周转」是服务端口径，不在浏览器过滤）；rowCount 为实时仓总数 */
      turnover: Block<{ rows: WarehouseInventoryRow[]; rowCount: number; summary: WarehouseInventoryModel["summary"]; windowDays: number; asOf: string }>;
    };
    ops: {
      /** 子查询失败 → 对应项 null + errors 里给原因；绝不显示 0（审计 #4） */
      queues: Block<{ inboxPending: number | null; reviewOpen: number | null; errors: { inbox: string | null; review: string | null } }>;
      todo: Block<TodoProgressBlock>;
      /** rows 只带前 12 行；rowCount 为本期全部 */
      goals: Block<GoalsBlock & { rowCount: number }>;
      conclusions: { text: string; evidenceHref: string; evidenceLabel: string }[];
      dataQuality: Block<{
        sources: DataQualityReport["sources"];
        recon: DataQualityReport["recon"];
        snapshotQuality: { alerts: number; warehouses: number };
        salesConsistency: DataQualityReport["salesConsistency"];
        tolerancePct: number;
      }>;
    };
  };
  limitations: string[];
}

const ROLE_LABEL: Record<string, string> = {
  admin: "管理员", pmc: "计划", purchasing: "采购", warehouse: "仓库", finance: "财务", quality: "品控", ops: "渠道运营",
};

export const SURVEY_CONCLUSIONS: CockpitData["screens"]["ops"]["conclusions"] = [
  { text: "物理仓的日销数据已经体现（出库数据）", evidenceHref: "/inventory/position", evidenceLabel: "库存日级走向" },
  { text: "销售渠道的数据", evidenceHref: "/report/decision-studio?tab=external", evidenceLabel: "决策工作室 · 外部观察" },
  { text: "运营销售计划的评估、解决问题", evidenceHref: "/replenish", evidenceLabel: "补货建议（提报核对待接入）" },
  { text: "规则制定 = 备货负责；运营模式 = 数据支撑；20% 创收利润单品先磨合备包材", evidenceHref: "/replenish/sop", evidenceLabel: "S&OP 周期" },
];

// 保留：领域尚未接入时的占位（当前全部块已接入，函数留作后续新块使用）
function pending(note: string, source: string): Block<null> {
  return { state: "pending_domain", data: null, note, source: { tier: "derived", source, asOf: null } };
}

function settled<T>(r: PromiseSettledResult<T>): { ok: true; value: T } | { ok: false; error: string } {
  return r.status === "fulfilled" ? { ok: true, value: r.value } : { ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
}

function sum(values: (string | null | undefined)[]): string {
  // 数量口径直加仅作参考（跨 SKU）；decimal 字符串相加，不走 float（CLAUDE.md）
  let total = "0";
  for (const v of values) {
    if (v == null || v === "" || !/^-?\d+(\.\d+)?$/.test(String(v))) continue;
    total = dAdd(total, v, 4);
  }
  return total.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1") || "0";
}

function severityOf(items: ExceptionItem[], key: string): RedlineItem["severity"] {
  const hit = items.find((i) => i.key === key);
  return hit?.severity ?? "medium";
}

/**
 * 0–1 比例 → 百分数字符串（1 位小数）的**唯一权威**，decimal 字符串运算不走 float；
 * null 保持 null（不可评 ≠ 0%）。
 *
 * 换算一律在服务端做、下发已是百分数的值：驾驶舱 OTIF 曾把 0.83 直接拼 "%" 显示成 0.83%（审计 #1），
 * 修复就落在这里。`components/format.ts` 一度另留一对 `ratioToPct`/`pctFromRatio` 自称唯一权威、
 * 却零生产调用（2026-09-04 清理审计 #2 已删除）——客户端只负责拼后缀（`formatPct`），不做换算。
 * 回归钉在 `tests/report/cockpit.test.ts`（0.83 → "83.0%"）。
 */
export function otifRatePctOf(rate: number | string | null | undefined): string | null {
  if (rate == null || rate === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(String(rate))) return null;
  return dMul(String(rate), 100, 1);
}

/**
 * 同 `otifRatePctOf` 的口径，只是折回 number——Recharts 的 dataKey 必须是数值，
 * 字符串会被当成分类轴。换算本身仍走 decimal（`rate * 100` 的 float 乘法不再出现），
 * 这里只是把已经定好 1 位小数的十进制字符串解析回来。
 */
export function ratePctNumOf(rate: number | string | null | undefined): number | null {
  const pct = otifRatePctOf(rate);
  return pct == null ? null : Number(pct);
}

void pending;

export async function getCockpit(user: SessionUser, dbArg?: AnyDb): Promise<CockpitData> {
  const db = await resolveDb(dbArg);
  const today = todayShanghai();
  const canSeeMoney = user.roles.some((r) => (PRICE_VISIBLE_ROLES as readonly string[]).includes(r));
  const isRestrictedOps = Array.isArray(user.channelScope) && user.channelScope.length > 0 && !user.roles.includes("admin");

  const [posR, ratioR, readyR, excR, inboxR, reviewR, velR, alertsR, spikeR, spikeCountR, coverCountR, poR, lanesR, whR, todoR, goalsR, dqR] = await Promise.allSettled([
    loadInventoryPosition(db),
    canSeeMoney ? loadInventorySalesRatio(db) : Promise.resolve(null),
    loadDataSourceReadiness(db),
    computeExceptions(db, { memoMs: 60_000 }), // 例外块含全量补货引擎；驾驶舱刷新按分钟级足够
    getInbox(user, db),
    countReviewItems(db),
    loadExternalVelocitySafe(db),
    loadInventoryAlerts(db),
    loadSalesSpike(db),
    countOpenAlerts(db, "sales_spike"),
    countOpenAlerts(db, "inventory_cover"),
    loadPurchaseOrderMetrics({}, db),
    loadTransferRoutes(db),
    loadWarehouseInventory(db),
    getTodoProgressBlock(user, db),
    getGoalsBlock(user, db),
    loadDataQuality(db),
  ]);

  /* ── 屏 1 ── */
  const pos = settled(posR);
  const position: CockpitData["screens"]["sources"]["position"] = pos.ok
    ? {
        state: "ready",
        data: {
          current: pos.value.current,
          monthToDate: {
            inQty: sum(pos.value.daily.map((d) => d.realtime?.in ?? d.snapshot?.in ?? null)),
            outQty: sum(pos.value.daily.map((d) => d.realtime?.out ?? d.snapshot?.out ?? null)),
            days: pos.value.daily.filter((d) => d.realtime || d.snapshot).length,
          },
          daily: pos.value.daily,
          monthEnd: pos.value.monthEnd,
          ledgerFirstDay: pos.value.ledgerFirstDay,
          latestSnapshotDate: pos.value.latestSnapshotDate,
          limitations: pos.value.limitations,
        },
        note: pos.value.current.total.value.incomplete ? `估值覆盖率 ${pos.value.current.total.value.coveragePct ?? "—"}%，金额不完整（D51 门槛 ${pos.value.valuationCoverageMinPct}%）` : "",
        source: { tier: "snapshot", source: "SCM 实时账 + 快照仓最新快照；估值 core/valuation", asOf: pos.value.builtAt },
      }
    : { state: "error", data: null, note: pos.error, source: { tier: "snapshot", source: INVENTORY_POSITION_CACHE_KEY, asOf: null } };

  const ratioS = settled(ratioR);
  let ratio: CockpitData["screens"]["sources"]["ratio"];
  let salesAmount: CockpitData["screens"]["sources"]["salesAmount"];
  if (!canSeeMoney) {
    ratio = { state: "no_access", data: null, note: "库存占比与销售金额仅采购/计划/财务/管理员可见", source: { tier: "manual", source: INVENTORY_SALES_RATIO_CACHE_KEY, asOf: null } };
    salesAmount = { state: "no_access", data: null, note: "销售金额仅财务/计划/管理员可见", source: { tier: "manual", source: "sales_amount_monthly", asOf: null } };
  } else if (ratioS.ok && ratioS.value) {
    const m = ratioS.value;
    ratio = {
      state: m.current.ratioMonthEndPct == null ? "insufficient" : "ready",
      data: { current: m.current, rows: m.rows, target: m.target, formula: m.formula },
      note: m.current.gate ?? "",
      source: { tier: "derived", source: "月末库存金额 ÷ 当月销售金额（D54）", asOf: m.builtAt },
    };
    salesAmount = {
      state: m.current.salesAmount == null ? "insufficient" : "ready",
      data: { yearMonth: m.currentMonth, salesAmount: m.current.salesAmount, salesSource: m.current.salesSource },
      note: m.current.salesAmount == null ? "本月销售金额尚未录入；财务可在「录入/修正」填入或用平台观察值预填（D53）" : (m.current.salesSource === "prefill_observation" ? "来源：外部平台观察预填，待财务确认" : "来源：财务手工录入"),
      source: { tier: "manual", source: "sales_amount_monthly（append-only，审计）", asOf: m.builtAt },
    };
  } else {
    const err = ratioS.ok ? "无数据" : ratioS.error;
    ratio = { state: "error", data: null, note: err, source: { tier: "derived", source: INVENTORY_SALES_RATIO_CACHE_KEY, asOf: null } };
    salesAmount = { state: "error", data: null, note: err, source: { tier: "manual", source: "sales_amount_monthly", asOf: null } };
  }

  const ready = settled(readyR);
  const dataSources: CockpitData["screens"]["sources"]["dataSources"] = ready.ok
    ? {
        state: ready.value.length ? "ready" : "insufficient",
        data: ready.value.map((r) => ({
          key: r.key,
          label: r.label,
          state: r.state,
          configured: r.configured,
          lastSuccessAt: r.lastSuccessAt ?? null,
          sourceAsOfEnd: r.sourceAsOfEnd ?? null,
          sourceRows: r.sourceRows ?? null,
          stagedRows: r.stagedRows ?? null,
          successfulStreams: r.successfulStreams ?? null,
          selectedContractCount: r.selectedContractCount,
          gate: r.gate ?? null,
          nextAction: r.nextAction ?? null,
        })),
        note: "聚水潭/用友的授权阻断如实显示（D50）；解锁清单见 docs/integrations/EXTERNAL-SYSTEMS.md §1a",
        source: { tier: "fact", source: "integration_runs / job_runs / import_jobs", asOf: new Date().toISOString() },
      }
    : { state: "error", data: null, note: ready.error, source: { tier: "fact", source: "data-source-readiness", asOf: null } };

  /* ── 屏 2 ── */
  const exc = settled(excR);
  const excItems = exc.ok ? exc.value : [];
  const spikeCount = settled(spikeCountR);
  const coverCount = settled(coverCountR);
  const redline: RedlineItem[] = [
    { key: "sales_spike", label: `爆单预警${spikeCount.ok && spikeCount.value.unacked ? `（未知悉 ${spikeCount.value.unacked}）` : ""}`, count: spikeCount.ok ? spikeCount.value.open : 0, severity: "critical", href: "/inventory/alerts?tab=spike" },
    { key: "inventory_cover", label: "断货预警 S/A/B", count: coverCount.ok ? coverCount.value.open : 0, severity: severityOf(excItems, "inventory_cover") === "medium" ? "high" : severityOf(excItems, "inventory_cover"), href: "/inventory/alerts?tab=cover" },
    ...excItems.filter((i) => i.key !== "sales_spike" && i.key !== "inventory_cover").map((i) => ({ key: i.key, label: i.title, count: i.count, severity: i.severity, href: i.href })),
  ];
  const alertsS = settled(alertsR);
  const inventoryAlerts: CockpitData["screens"]["alerts"]["inventoryAlerts"] = alertsS.ok
    ? {
        state: alertsS.value.rows.length ? "ready" : "insufficient",
        data: (() => {
          const alertRows = alertsS.value.rows.filter((r) => r.primary || r.status !== "ok");
          return { rows: alertRows.slice(0, 20), alertRowCount: alertRows.length, totals: alertsS.value.totals, params: alertsS.value.params, limitations: alertsS.value.limitations };
        })(),
        note: `成品 ${alertsS.value.totals.skus} 个：断货 ${alertsS.value.totals.outOfStock}、低于阈值 ${alertsS.value.totals.alert}、关注 ${alertsS.value.totals.watch}；只显示前 20 行`,
        source: { tier: "observation", source: `${INVENTORY_ALERTS_CACHE_KEY}（日销三口径并列；观察序列只预警不定量）`, asOf: alertsS.value.builtAt },
      }
    : { state: "error", data: null, note: alertsS.error, source: { tier: "observation", source: INVENTORY_ALERTS_CACHE_KEY, asOf: null } };
  const spikeS = settled(spikeR);
  const salesSpike: CockpitData["screens"]["alerts"]["salesSpike"] = spikeS.ok
    ? {
        state: spikeS.value.state === "ready" ? "ready" : "insufficient",
        data: { hits: spikeS.value.hits.slice(0, 10), unmappedHits: spikeS.value.unmappedHits.slice(0, 10), hitCount: spikeS.value.hits.length, unmappedCount: spikeS.value.unmappedHits.length, anchorDate: spikeS.value.anchorDate, coverage: spikeS.value.coverage, params: spikeS.value.params, openAlerts: spikeCount.ok ? spikeCount.value.open : 0, unacked: spikeCount.ok ? spikeCount.value.unacked : 0 },
        note: spikeS.value.state === "ready" ? `规则：最近 ${spikeS.value.params.consecutiveDays} 天每日 ≥ 前 7 日日均 ×${(1 + spikeS.value.params.risePct / 100).toFixed(2)}，基线 ≥ ${spikeS.value.params.minBaseQty}` : spikeS.value.limitations[0] ?? "缺流",
        source: { tier: "observation", source: `${SALES_SPIKE_CACHE_KEY}（简道云天猫日销，T+1）`, asOf: spikeS.value.sourceAsOf ?? spikeS.value.builtAt },
      }
    : { state: "error", data: null, note: spikeS.error, source: { tier: "observation", source: SALES_SPIKE_CACHE_KEY, asOf: null } };

  /* ── 屏 3 ── */
  const warehouses: CockpitData["screens"]["inventory"]["warehouses"] = pos.ok
    ? {
        state: pos.value.warehouses.length ? "ready" : "insufficient",
        data: {
          rows: pos.value.warehouses.slice(0, 20),
          rowCount: pos.value.warehouses.length,
          activeCount: pos.value.warehouses.filter((w) => w.active).length,
          realtimeCount: pos.value.warehouses.filter((w) => w.mode === "realtime").length,
          snapshotCount: pos.value.warehouses.filter((w) => w.mode === "snapshot").length,
        },
        note: "快照仓无逐日流水：周转与出库列由调拨/周转领域接入后显示；数量跨 SKU 直加仅作参考",
        source: { tier: "snapshot", source: `${INVENTORY_POSITION_CACHE_KEY} · warehouses`, asOf: pos.value.builtAt },
      }
    : { state: "error", data: null, note: pos.error, source: { tier: "snapshot", source: INVENTORY_POSITION_CACHE_KEY, asOf: null } };

  /* ── 屏 2 · 订单系统（D63） ── */
  const po = settled(poR);
  const orders: CockpitData["screens"]["alerts"]["orders"] = po.ok
    ? (() => {
        const b = purchaseOrderCockpitBlock(po.value);
        const gated: PurchaseOrderCockpitBlock = canSeeMoney ? b : {
          orderSystem: { ...b.orderSystem, monthNetAmount: null, monthGrossAmount: null },
          costDown: { ...b.costDown, savingYtd: null, increaseYtd: null },
        } as PurchaseOrderCockpitBlock;
        return {
          state: b.orderSystem.monthPoCount > 0 || b.orderSystem.cycleSamples > 0 ? "ready" : "insufficient",
          data: { ...gated, otifRatePct: otifRatePctOf(b.orderSystem.otifRate) },
          note: `${canSeeMoney ? "" : "金额仅价格可见角色；"}交付 n=${b.orderSystem.cycleSamples}${b.orderSystem.cycleInsufficient ? "（样本不足）" : ""}；降本基线年 ${b.costDown.baselineYear}`,
          /* OTIF 有两套承诺口径（原始承诺 / 当前承诺），趋势层一直在出处里写明是哪一套，
             驾驶舱这块此前没写——同一个 OTIF 数字在两屏之间无法核对是不是同一口径。 */
          source: { tier: "fact", source: `${PURCHASE_ORDER_METRICS_KEY}（SCM PO/SH 事实；OTIF ${po.value.otifBasisLabel}口径）`, asOf: po.value.builtAt ?? null },
        };
      })()
    : { state: "error", data: null, note: po.error, source: { tier: "fact", source: PURCHASE_ORDER_METRICS_KEY, asOf: null } };

  /* ── 屏 3 · 调拨线路 / 异常 / 各仓周转（D60） ── */
  const lanesS = settled(lanesR);
  const transferLanes: CockpitData["screens"]["inventory"]["transferLanes"] = lanesS.ok
    ? {
        state: lanesS.value.summary.docCount > 0 ? "ready" : "insufficient",
        data: {
          lanes: topLanes(lanesS.value, 20).map((l) => canSeeMoney ? l : { ...l, amount: null, avgUnitFee: null, medianUnitFee: null }),
          summary: lanesS.value.summary,
          asOf: (lanesS.value as { asOf?: string | null }).asOf ?? null,
        },
        note: lanesS.value.summary.docCount > 0 ? `线路 ${lanesS.value.summary.laneCount} · 单据 ${lanesS.value.summary.docCount}（登记费用 ${lanesS.value.summary.feeDocCount}）· 未分类存量 ${lanesS.value.summary.unclassifiedDocCount}` : "尚无已完成调拨单",
        source: { tier: "fact", source: `${TRANSFER_ROUTES_CACHE_KEY}（已完成调拨单 + 人工登记费用）`, asOf: (lanesS.value as { builtAt?: string }).builtAt ?? null },
      }
    : { state: "error", data: null, note: lanesS.error, source: { tier: "fact", source: TRANSFER_ROUTES_CACHE_KEY, asOf: null } };
  const transferAnomalies: CockpitData["screens"]["inventory"]["transferAnomalies"] = lanesS.ok
    ? {
        state: lanesS.value.anomalies.length ? "ready" : "insufficient",
        data: {
          rows: lanesS.value.anomalies.slice(0, 10).map((a) => canSeeMoney ? a : { ...a, amount: null, unitFee: null }),
          anomalyCount: lanesS.value.summary.anomalyCount, alertCount: lanesS.value.summary.alertCount, scatteredLaneCount: lanesS.value.summary.scatteredLaneCount,
        },
        note: lanesS.value.anomalies.length ? "偏差 >20% 或数量 > 中位数×3 只提醒不阻断；样本 <8 不判定（D60）" : "当前没有数量/费用异常（或样本不足不判定）",
        source: { tier: "derived", source: "rules/transfer-cost（线路基线 + spc）", asOf: (lanesS.value as { builtAt?: string }).builtAt ?? null },
      }
    : { state: "error", data: null, note: lanesS.error, source: { tier: "derived", source: TRANSFER_ROUTES_CACHE_KEY, asOf: null } };
  const whS = settled(whR);
  const turnover: CockpitData["screens"]["inventory"]["turnover"] = whS.ok
    ? {
        state: whS.value.rows.length ? "ready" : "insufficient",
        data: (() => {
          // 周转只对实时仓有定义（快照仓无流水）：参与规则在服务端，不在浏览器过滤（审计「数字在客户端算」）
          const realtime = whS.value.rows.filter((r) => r.accountingMode === "realtime");
          return {
            rows: realtime.slice(0, 8).map((r) => canSeeMoney ? r : { ...r, amount: null }),
            rowCount: realtime.length,
            summary: whS.value.summary, windowDays: whS.value.windowDays, asOf: whS.value.asOf,
          };
        })(),
        note: `窗口 ${whS.value.windowDays} 天（仅实时仓，快照仓无流水不计算；口径见指标注册表 warehouseTurns / warehouseDio）`,
        source: { tier: "snapshot", source: WAREHOUSE_INVENTORY_CACHE_KEY, asOf: whS.value.builtAt },
      }
    : { state: "error", data: null, note: whS.error, source: { tier: "snapshot", source: WAREHOUSE_INVENTORY_CACHE_KEY, asOf: null } };

  /* ── 屏 4 · 待办 / 目标 / 数据质量（D61/D65） ── */
  const todoS = settled(todoR);
  const todo: CockpitData["screens"]["ops"]["todo"] = todoS.ok
    ? { state: "ready", data: todoS.value, note: todoS.value.caliber, source: { tier: "fact", source: "work_items", asOf: todoS.value.generatedAt } }
    : { state: "error", data: null, note: todoS.error, source: { tier: "fact", source: "work_items", asOf: null } };
  const goalsS = settled(goalsR);
  const goals: CockpitData["screens"]["ops"]["goals"] = goalsS.ok
    ? { state: goalsS.value.rows.length ? "ready" : "insufficient", data: { ...goalsS.value, rows: goalsS.value.rows.slice(0, 12), rowCount: goalsS.value.rows.length }, note: goalsS.value.rows.length ? goalsS.value.caliber : "本部门尚未设置目标（可在「供应链目标」页设置）", source: { tier: "manual", source: "department_goals + 各只读指标", asOf: goalsS.value.generatedAt } }
    : { state: "error", data: null, note: goalsS.error, source: { tier: "manual", source: "department_goals", asOf: null } };
  const dqS = settled(dqR);
  const dataQuality: CockpitData["screens"]["ops"]["dataQuality"] = dqS.ok
    ? {
        state: dqS.value.sources.length ? "ready" : "insufficient",
        data: {
          sources: dqS.value.sources, recon: dqS.value.recon,
          snapshotQuality: { alerts: dqS.value.snapshotQuality.alerts, warehouses: dqS.value.snapshotQuality.warehouses.length },
          salesConsistency: dqS.value.salesConsistency, tolerancePct: dqS.value.tolerancePct,
        },
        note: `准确率容差 ${dqS.value.tolerancePct}%；人工链路为代理口径（staging 首次通过率）；外部平台一致性仅覆盖天猫（D65）`,
        source: { tier: "derived", source: DATA_QUALITY_CACHE_KEY, asOf: dqS.value.today },
      }
    : { state: "error", data: null, note: dqS.error, source: { tier: "derived", source: DATA_QUALITY_CACHE_KEY, asOf: null } };

  /* ── 屏 4 ── */
  const inbox = settled(inboxR);
  const review = settled(reviewR);
  // 审计 #4：任一子查询失败 → 该项 null（前端显示 — + 错误 chip），不把失败显示成 0
  const reviewOpen: number | null = review.ok
    ? review.value.counts.filter((c) => !["done", "closed", "resolved"].includes(String(c.status))).reduce((n, c) => n + Number(c.count ?? 0), 0)
    : null;
  const queues: CockpitData["screens"]["ops"]["queues"] = inbox.ok || review.ok
    ? {
        state: "ready",
        data: {
          inboxPending: inbox.ok ? inbox.value.total : null,
          reviewOpen,
          errors: { inbox: inbox.ok ? null : inbox.error, review: review.ok ? null : review.error },
        },
        note: [inbox.ok ? "" : `待我审批读取失败：${inbox.error}`, review.ok ? "" : `复核清单读取失败：${review.error}`].filter(Boolean).join("；"),
        source: { tier: "fact", source: "审批收件箱 / review_items", asOf: new Date().toISOString() },
      }
    : { state: "error", data: null, note: `${inbox.ok ? "" : inbox.error} ${review.ok ? "" : review.error}`.trim(), source: { tier: "fact", source: "inbox / review", asOf: null } };

  const vel = settled(velR);
  const identityCoveragePct = vel.ok && vel.value.coverage.platformSkus > 0
    ? Math.round((vel.value.coverage.mappedPlatformSkus / vel.value.coverage.platformSkus) * 1000) / 10
    : null;

  return {
    generatedAt: new Date().toISOString(),
    today,
    currentMonth: today.slice(0, 7),
    topbar: {
      roleLabel: user.roles.map((r) => ROLE_LABEL[r] ?? r).join(" / "),
      scopeLabel: isRestrictedOps ? `范围：渠道 ${user.channelScope!.join(",")}` : "范围：全渠道",
      dataAsOf: pos.ok ? pos.value.builtAt : null,
      valuationCoveragePct: pos.ok ? pos.value.current.total.value.coveragePct : null,
      identityCoveragePct,
      calibreVersion: "cockpit/v1",
    },
    screens: {
      sources: { position, ratio, salesAmount, dataSources },
      alerts: {
        redline,
        inventoryAlerts,
        salesSpike,
        orders,
      },
      inventory: {
        warehouses,
        transferLanes,
        transferAnomalies,
        turnover,
      },
      ops: {
        queues,
        todo,
        goals,
        conclusions: SURVEY_CONCLUSIONS,
        dataQuality,
      },
    },
    limitations: [
      "四屏只装配唯一权威读模型，不在本页重算任何口径；每块自带来源、时点、覆盖与限制。",
      "金额类块对非授权角色在服务端剥离；渠道运营受限账号只看公开内容与本渠道维度。",
      "标「待接入」的块对应尚未合并的领域，不显示 0。",
    ],
  };
}
