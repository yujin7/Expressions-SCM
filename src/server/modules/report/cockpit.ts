import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { getInbox } from "@/server/modules/inbox/service";
import { loadDataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { loadExternalVelocitySafe } from "@/server/modules/report/external-velocity";
import {
  loadInventoryPosition,
  todayShanghai,
  type DailyPoint,
  type MonthEndPoint,
  type QtyBlock,
  type WarehouseBlock,
} from "@/server/modules/report/inventory-position";
import { loadInventorySalesRatio, type RatioMonthRow, type RatioTargets } from "@/server/modules/report/inventory-sales-ratio";
import { countReviewItems } from "@/server/modules/review/checklist";
import { computeExceptions, type ExceptionItem } from "@/server/modules/workbench/focus";

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
      inventoryAlerts: Block<null>;
      salesSpike: Block<null>;
      orders: Block<null>;
    };
    inventory: {
      warehouses: Block<{ rows: WarehouseBlock[]; activeCount: number; realtimeCount: number; snapshotCount: number }>;
      transferLanes: Block<null>;
      transferAnomalies: Block<null>;
      turnover: Block<null>;
    };
    ops: {
      queues: Block<{ inboxPending: number; reviewOpen: number }>;
      todo: Block<null>;
      goals: Block<null>;
      conclusions: { text: string; evidenceHref: string; evidenceLabel: string }[];
      dataQuality: Block<null>;
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

function pending(note: string, source: string): Block<null> {
  return { state: "pending_domain", data: null, note, source: { tier: "derived", source, asOf: null } };
}

function settled<T>(r: PromiseSettledResult<T>): { ok: true; value: T } | { ok: false; error: string } {
  return r.status === "fulfilled" ? { ok: true, value: r.value } : { ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
}

function sum(values: (string | null | undefined)[]): string {
  // 数量口径直加仅作参考（跨 SKU），用整数/小数字符串安全相加
  let total = 0;
  for (const v of values) {
    const n = Number(v ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total.toFixed(4).replace(/\.?0+$/, "") || "0";
}

function severityOf(items: ExceptionItem[], key: string): RedlineItem["severity"] {
  const hit = items.find((i) => i.key === key);
  return hit?.severity ?? "medium";
}

export async function getCockpit(user: SessionUser, dbArg?: AnyDb): Promise<CockpitData> {
  const db = await resolveDb(dbArg);
  const today = todayShanghai();
  const canSeeMoney = user.roles.some((r) => (PRICE_VISIBLE_ROLES as readonly string[]).includes(r));
  const isRestrictedOps = Array.isArray(user.channelScope) && user.channelScope.length > 0 && !user.roles.includes("admin");

  const [posR, ratioR, readyR, excR, inboxR, reviewR, velR] = await Promise.allSettled([
    loadInventoryPosition(db),
    canSeeMoney ? loadInventorySalesRatio(db) : Promise.resolve(null),
    loadDataSourceReadiness(db),
    computeExceptions(db),
    getInbox(user, db),
    countReviewItems(db),
    loadExternalVelocitySafe(db),
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
    : { state: "error", data: null, note: pos.error, source: { tier: "snapshot", source: "inventory-position/v1", asOf: null } };

  const ratioS = settled(ratioR);
  let ratio: CockpitData["screens"]["sources"]["ratio"];
  let salesAmount: CockpitData["screens"]["sources"]["salesAmount"];
  if (!canSeeMoney) {
    ratio = { state: "no_access", data: null, note: "库存占比与销售金额仅采购/计划/财务/管理员可见", source: { tier: "manual", source: "inventory-sales-ratio/v1", asOf: null } };
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
    ratio = { state: "error", data: null, note: err, source: { tier: "derived", source: "inventory-sales-ratio/v1", asOf: null } };
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
  const redline: RedlineItem[] = [
    ...excItems.map((i) => ({ key: i.key, label: i.title, count: i.count, severity: i.severity, href: i.href })),
  ];
  if (!excItems.some((i) => i.key === "sales_spike")) redline.push({ key: "sales_spike", label: "爆单预警（待接入预警引擎）", count: 0, severity: severityOf(excItems, "sales_spike"), href: "/inventory/alerts?tab=spike" });
  if (!excItems.some((i) => i.key === "inventory_cover")) redline.push({ key: "inventory_cover", label: "断货预警 S/A/B（待接入预警引擎）", count: 0, severity: "high", href: "/inventory/alerts?tab=cover" });

  /* ── 屏 3 ── */
  const warehouses: CockpitData["screens"]["inventory"]["warehouses"] = pos.ok
    ? {
        state: pos.value.warehouses.length ? "ready" : "insufficient",
        data: {
          rows: pos.value.warehouses,
          activeCount: pos.value.warehouses.filter((w) => w.active).length,
          realtimeCount: pos.value.warehouses.filter((w) => w.mode === "realtime").length,
          snapshotCount: pos.value.warehouses.filter((w) => w.mode === "snapshot").length,
        },
        note: "快照仓无逐日流水：周转与出库列由调拨/周转领域接入后显示；数量跨 SKU 直加仅作参考",
        source: { tier: "snapshot", source: "inventory-position/v1 · warehouses", asOf: pos.value.builtAt },
      }
    : { state: "error", data: null, note: pos.error, source: { tier: "snapshot", source: "inventory-position/v1", asOf: null } };

  /* ── 屏 4 ── */
  const inbox = settled(inboxR);
  const review = settled(reviewR);
  const reviewOpen = review.ok
    ? review.value.counts.filter((c) => !["done", "closed", "resolved"].includes(String(c.status))).reduce((n, c) => n + Number(c.count ?? 0), 0)
    : 0;
  const queues: CockpitData["screens"]["ops"]["queues"] = inbox.ok || review.ok
    ? {
        state: "ready",
        data: { inboxPending: inbox.ok ? inbox.value.total : 0, reviewOpen },
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
        inventoryAlerts: pending("库存预警表（等级 / 日销 7·15·30 / 可销天数 / 阈值 / 主预警）由预警引擎领域接入（D57）", "inventory-alerts/v1"),
        salesSpike: pending("爆单预警（最近 3 天每日 ≥ 前 7 日日均 ×1.5）由预警引擎领域接入（D56）", "sales-spike/v1"),
        orders: pending("已下单 / 已下单金额 / 订单至交付 / 成本下降 由采购指标领域接入（D63）", "purchase-order-metrics/v1"),
      },
      inventory: {
        warehouses,
        transferLanes: pending("各调拨线路批次与均价由调拨领域接入（D60）", "transfer-routes/v1"),
        transferAnomalies: pending("调拨数量/费用异常与「启动调拨计算」由调拨领域接入（D60）", "transfer-routes/v1"),
        turnover: pending("各仓周转率与总周转由调拨/周转领域接入", "warehouse-inventory/v1"),
      },
      ops: {
        queues,
        todo: pending("待办跟进进度（指派/状态/完成率）由待办领域接入（D61）", "work_items"),
        goals: pending("供应链目标（按部门）由待办领域接入（D61）", "department_goals"),
        conclusions: SURVEY_CONCLUSIONS,
        dataQuality: pending("数据质量周核对（RPA / 人工 / 外部三类准确率）由数据质量领域接入（D65）", "data-quality/v1"),
      },
    },
    limitations: [
      "四屏只装配唯一权威读模型，不在本页重算任何口径；每块自带来源、时点、覆盖与限制。",
      "金额类块对非授权角色在服务端剥离；渠道运营受限账号只看公开内容与本渠道维度。",
      "标「待接入」的块对应尚未合并的领域，不显示 0。",
    ],
  };
}
