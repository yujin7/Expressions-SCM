/**
 * R11 补货建议（成品维度，报表层）。
 *
 * 口径纪律：
 * - R13 doctrine：本页只呈现建议，不自动开单——「生成草稿」由人工点击（人工闸），产物为 BH 草稿走正常审批；
 * - 在库 = 全网口径（D20）：Σ stock_balances（实时账）+ 快照仓最新快照（latest-snapshot 模式与驾驶舱同口径，
 *   本地重实现，不 import report/dashboard.ts）；
 * - 在途 = 已审批/执行中 PO 实物行未收量（基础单位 = qty×uomFactor − receivedQty，逐行下限 0）。
 *   func#1：WO 在制产出已纳入全管道口径（wipQty，非建议驱动）；建议驱动仍为 PO 在途（保守）；
 * - 日均销 = 近3月销量 ÷ 91（窗口由 sales_monthly max(yearMonth) 动态回推，与驾驶舱同法，本地重推导）；
 * - 建议量 = R11 纯函数（rules/netreq.ts）：净需求 = 毛需求(日均×目标覆盖天数) − 在库 − 在途，
 *   MOQ/订货倍数取 uom_convs 首行（按 id）兜底——与 wo.ts 快照同一 PoC 口径（值按基础单位解释）；无行则纯净需求向上取整由 dQty 收口。
 * - D58/D59：tier / ownership / pilot 取 sku_planning_policy **最近固化期**（含人工覆写），不在此重算——
 *   未固化任何期间时三列为 null 并在 meta.policyPeriod=null 提示；C 级默认折叠（hideTierC）并标「运营兜底」；
 *   计划事件（ops_plan_events）只作行上下文标签，不进公式。
 * - 全表无金额字段，免脱敏。
 * - W3 逐行可解释：targetBasis（目标覆盖天数来自页面/分域/ABC/全局哪一层）、safetyDaysBasis（安全库存兜底命中层）、
 *   noSuggestReason（没有建议时的结构化原因）——空单元格不再模棱两可。
 * - W5 declinedToday：当日「已复核并放弃」由审计台账下发（服务端权威），不再只存在点击者的浏览器里。
 * - B7 forecastAccuracy：引擎本就为门控算了滚动回测，把 WAPE/偏差/FVA 一并下发，供计划员判断该信几分。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadExternalVelocitySafe } from "@/server/modules/report/external-velocity";
import { z } from "zod";

import { getNumParam } from "@/server/core/params";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dDiv, dMul, dQty, dSub } from "@/server/core/decimal";
import { suggestQtyDetailed } from "@/server/rules/netreq";
import { belowLeadtime, detectRefGap, fuseCover, shouldSuppressSuggest } from "@/server/rules/fusion";
import { forecastDaily } from "@/server/rules/forecast";
import { backtest } from "@/server/rules/backtest";
import { classifyAbc } from "@/server/rules/abc";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { createBh } from "@/server/modules/outsource/bh";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { todayShanghai } from "@/server/modules/master/common";
import { lastMonths } from "@/server/core/velocity";
import { getOnHandBySku } from "@/server/core/stock-view";
import { safetyStock } from "@/server/rules/safety-stock";
import { timePhasedNetReq } from "@/server/rules/timephased";
import { getOpenSupplyLines, type OpenSupplyLine } from "@/server/core/supply";
import { describeScope, FALLBACK_SCOPE, makeResolver, type ParamLayer } from "@/server/core/scoped-params";
import { netExpiringStock, type ExpiryBatch } from "@/server/rules/expiry-netting";
import { loadExpiryBatches } from "./expiry";
import { EMPTY_IN_FLIGHT, inFlightWarning, loadInFlightDrafts, type InFlightDrafts } from "./in-flight-drafts";
import { loadActiveSuppressions, loadDeclinedToday } from "./decline";
import { suppressionState } from "@/server/rules/replenish-suppression";
import { DECLINE_REASON_LABELS, type DeclineReasonCode } from "@/lib/replenish-decline-reasons";
import { type AnyDb, num, r1, resolveDb } from "@/server/core/svc";
import { getSkuSupplyParams } from "@/server/modules/master/sku-supply-params";
import { salesWindow } from "@/server/core/sales-window";
import { loadPolicyMap } from "@/server/modules/planning/policy";
import { loadOpenPlanEventsBySku, planEventTag } from "@/server/modules/planning/plan-events";
import type { Tier } from "@/server/rules/abc";
import { OWNERSHIP_LABELS, type Ownership } from "@/server/rules/replenish-ownership";

/* ────────────── W3 逐行可解释：目标覆盖天数 / 安全库存兜底 / 为什么没有建议 ────────────── */

/** 目标覆盖天数的来源层：页面指定 > 分域参数（sku/brand/segment）> ABC 分层参数 > 全局/系统缺省 */
export type TargetBasisSource = "user" | "sku" | "brand" | "segment" | "global" | "abc_a" | "abc_b" | "abc_c";

export interface ReplenishTargetBasis {
  /** 生效值（天） */
  value: number;
  source: TargetBasisSource;
  /** 分域解析器实际命中的 scope 串（`sku:401`/`brand:12`/`segment:A`/`global`/`fallback`）；非分域来源为 null */
  scope: string | null;
  abcClass: "A" | "B" | "C" | null;
  /** 中文解释（界面 tooltip 直接用） */
  label: string;
}

/** 分域参数命中说明（safety_days_fallback 等）——层级来自 core/scoped-params 的解析结果，不在此重判 */
export interface ScopedParamBasis {
  value: number;
  layer: ParamLayer;
  scope: string;
  label: string;
}

/**
 * 「没有建议」的结构化原因（W3）——空单元格此前无法区分「不需要补」与「引擎算不出来」。
 * cover_ok=视野内水位够 / ref_gap_suppressed=覆盖缺口抑制 / insufficient_history=无销量历史 /
 * lead_unknown=无生产周期（行动窗口只能近似、无法倒推下单日）/ no_demand=无动销 / not_triggered=短缺尚在行动窗口外。
 */
export const NO_SUGGEST_REASON_CODES = [
  "cover_ok",
  "ref_gap_suppressed",
  "insufficient_history",
  "lead_unknown",
  "no_demand",
  "not_triggered",
  /** W2-#6：本 SKU 处在「已复核并放弃」的抑制窗口内（原因与到期日在 suppression 上） */
  "decline_suppressed",
] as const;
export type NoSuggestReasonCode = (typeof NO_SUGGEST_REASON_CODES)[number];

export const NO_SUGGEST_REASON_LABELS: Record<NoSuggestReasonCode, string> = {
  cover_ok: "库存充足",
  ref_gap_suppressed: "已抑制",
  insufficient_history: "无销量历史",
  lead_unknown: "缺生产周期",
  no_demand: "无动销",
  not_triggered: "未到下单窗口",
  decline_suppressed: "已抑制（放弃）",
};

export interface NoSuggestReason {
  code: NoSuggestReasonCode;
  /** 短标签（列内 Tag 文案） */
  label: string;
  /** 完整中文说明（tooltip） */
  text: string;
}

/** B7 预测准确度（该 SKU 的滚动回测结果，已在引擎内算出，此前只用于 gate、不下发） */
export interface ReplenishForecastAccuracy {
  /** 参与回测的期数；0 = 无法回测 */
  samples: number;
  /** WAPE = Σ|预测−实际| ÷ Σ实际；无法计算 = null */
  wape: number | null;
  /** 偏差 = Σ(预测−实际) ÷ Σ实际；>0 高估 */
  bias: number | null;
  /** FVA = 朴素 WAPE − 模型 WAPE；>0 才说明模型有增量 */
  fva: number | null;
  /** 样本 ≥3 期才算可靠 */
  reliable: boolean;
}

/**
 * W2-#6 生效中的抑制窗口（放弃后下一次运行不再重复建议）。
 * **绝不静默**：本对象一旦非空，行上必须显示"已抑制 + 原因 + 到期日 + 解除入口"。
 */
export interface ReplenishSuppression {
  id: number;
  reasonCode: DeclineReasonCode;
  reasonLabel: string;
  reason: string;
  by: string;
  /** 放弃的业务日 */
  since: string;
  /** 抑制到期日（含当天） */
  untilDate: string;
  daysLeft: number;
  /** true = 供应事实一变即自动解除：到货入库 / 被登记为未结供给 / 安排被取消（C8） */
  releaseOnArrival: boolean;
  /** 被抑制而未下发的建议量（人工解除后即恢复；也可在本页勾选放行） */
  withheldQty: string | null;
  label: string;
}

/** W5 当日「已复核并放弃」（服务端权威，来自审计台账） */
export interface ReplenishDeclinedToday {
  by: string;
  /** ISO 时间戳 */
  at: string;
  reason: string;
  reasonCode: DeclineReasonCode;
  businessDate: string;
}

/**
 * W2-#2 临期净额（逐行可解释）。
 *
 * 结构性缺货的来源：`getOnHandBySku` 把临期与已过期批次一并当作在库，引擎因此判「够，不用补」，
 * 那批货随后过期报废——库存表上一直有数，货架上却断了。这里把「在效期内卖不掉的量」netting 掉，
 * 但**不动账面在库**：两个数并排给出，谁扣的、扣多少、为什么，逐行说明。
 */
export interface ReplenishExpiryRisk {
  /** 视野内卖不掉的量（已按账面在库上限夹取） */
  unsellableQty: number;
  /** 其中已过期小计 */
  expiredQty: number;
  /** 参与判定的临期+已过期批次合计（批次参考层） */
  atRiskQty: number;
  batches: number;
  /** 最短剩余效期（可为负 = 已过期） */
  minDaysLeft: number | null;
  /** 决定净额的那一批剩余天数 */
  bindingDaysLeft: number | null;
  /** 判定视野（天）——与逐日推演同一视野 */
  horizonDays: number;
  /** C4：因盘点观测过旧而**未参与扣减**的批次量（只提示，不进 unsellableQty） */
  staleQty: number;
  staleBatches: number;
  /** 被排除批次里最旧的盘点期距今天数；无排除 = null */
  staleAgeDays: number | null;
  /** 生效的观测鲜度上限（天）；未设限 = null */
  maxStocktakeAgeDays: number | null;
  /** 中文解释（界面 tooltip 直接用） */
  label: string;
}

export interface ReplenishRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  /** 全网在库（展示口径，1dp）——**账面口径，不因临期扣减**（口径由 core/stock-view 唯一给出） */
  onHand: number;
  /** W2-#2 进入建议判定的可用在库 = onHand − expiryRisk.unsellableQty（1dp）；两个数并排展示，不许只留一个 */
  availableOnHand: number;
  /** W2-#2 临期净额：在效期内卖不掉、因此不能算作可用库存的量；无风险 = null */
  expiryRisk: ReplenishExpiryRisk | null;
  /** PO 在途（展示口径，1dp） */
  inTransit: number;
  /** 近3月日均销（1dp） */
  daily: number;
  /** 可销天数（1dp；日均=0 → null） */
  daysCover: number | null;
  /** R11 建议补货量（qty scale=4）；未触发预警为 null */
  suggestQty: string | null;
  /** 外部观察（简道云天猫+拼多多）近 30 天净需求折日均与最近售出日：影子列，只并排显示，不进入建议量。未映射 = null */
  externalDaily30: number | null;
  externalDaily30Gate: string | null;
  externalLastSold: string | null;
  /** 全口径参考在库（总库存明细文件，2026-07-21 时点；无参考 = null） */
  refQty: number | null;
  /** 在订未出（总库存明细「已下单未出货」；无参考 = null） */
  onOrder: number | null;
  /** 存量单在途（transit_refs fg_order 未入库余量，旧流程收尾口径） */
  legacyTransit: number;
  /** 在制委外产出（WO 计划产出，func#1；in_progress WO 残余部分批已收会高估，列注标明） */
  wipQty: number;
  /** 借出未还（func#20，从全管道扣减） */
  borrowOut: number;
  /** func#14 ABC 分层与生效目标覆盖天数 */
  abcClass: "A" | "B" | "C" | null;
  effectiveTarget: number;
  /** W3：effectiveTarget 由哪一层给出（页面 / 分域参数 / ABC 分层 / 全局） */
  targetBasis: ReplenishTargetBasis;
  /** W3：安全库存兜底天数命中的分域层级 */
  safetyDaysBasis: ScopedParamBasis;
  /** W3：suggestQty=null 时的结构化原因；有建议 = null */
  noSuggestReason: NoSuggestReason | null;
  /** D58 四档（最近固化期生效值，含覆写）；未固化 = null */
  tier: Tier | null;
  /** 是否人工覆写 */
  tierOverridden: boolean;
  /** D59 权责；未固化 = null */
  ownership: Ownership | null;
  ownershipLabel: string | null;
  pilot: boolean;
  /** 运营计划事件标签（未结束/即将开始），如「大促 9/15–9/30」 */
  planEventTags: string[];
  /** 总供应周期（生产 + 物流/调拨；生产周期缺失时 = null） */
  leadDays: number | null;
  /** 常规生产周期（天） */
  productionLeadDays: number | null;
  /** 物流/调拨周期（天；null=尚未维护，本轮按 0 兼容） */
  logisticsLeadDays: number | null;
  /** 全管道可销天数（max(系统,参考)+全部在途 ÷ 日均；1dp） */
  coverFull: number | null;
  /** 覆盖缺口 SKU（参考显著>系统——海外/其他部门仓不在快照源） */
  refGap: boolean;
  /** 建议被抑制的原因（refGap 且全管道充足 → 防重复下单）；无抑制 = null */
  suppressReason: string | null;
  /** 可销天数已低于常规生产周期（补货窗口迫近） */
  belowLead: boolean;
  /** 被抑制时的「原始建议量」——人工核实覆盖缺口后可勾选放行（#2 修复） */
  heldQty: string | null;
  /** #2 预测日均（Holt 近6月，展示口径） */
  forecastDaily: number;
  /** 预测趋势 up/down/flat */
  forecastTrend: "up" | "down" | "flat";
  /** #13：预测与朴素日均显著分歧（>30%）——最值得人工复核的信号 */
  forecastDivergent: boolean;
  /** 该 SKU 的预测是否经回测证明优于朴素预测（否则预测列仅供参考，不发偏离告警） */
  forecastTrusted: boolean;
  /** B7：该 SKU 的预测误差（WAPE/偏差/FVA）——计划员据此判断这条建议该信几分 */
  forecastAccuracy: ReplenishForecastAccuracy;
  /** W5：当日已复核并放弃（服务端从审计台账下发，全员可见）；未放弃 = null */
  declinedToday: ReplenishDeclinedToday | null;
  /** W2-#6：生效中的放弃抑制窗口；未抑制 = null */
  suppression: ReplenishSuppression | null;
  /* ── E2-01/05 计划引擎 v2 ── */
  /** 安全库存（件） */
  safetyQty: number;
  /** 安全库存口径：statistical=统计法 / fallback=兜底天数 / none */
  safetyMethod: string;
  /** 首次跌破安全库存日；无短缺=null */
  shortageDate: string | null;
  /** 距短缺天数 */
  daysToShortage: number | null;
  /** 最晚下单日（短缺日−生产周期） */
  orderByDate: string | null;
  /** 已错过下单窗口 */
  orderWindowMissed: boolean;
  /** 建议量的逐步解释（可解释链） */
  planExplain: string[];
  /**
   * R11 规整警告（`rules/netreq.suggestQtyDetailed` 的 warnings）——超买、单次上限下调、
   * MOQ 与上限自相矛盾。此前服务端从不传 maxOrder/dailyDemand，规则里那条
   * 「MOQ 导致多买 N 天库存」的警告**结构上永远不可能触发**，等于规则写了没接。
   */
  lotWarnings: { level: "info" | "warn" | "blocking"; message: string }[];
  /** 超买折算天数（相对日均；无日均 = null）——超买天数是呆滞库存的先行指标 */
  overshootDays: number | null;
  /**
   * C10 跨页在途草稿：**另一页**（先挪后买 / 调拨建议）已经为这个 SKU 起草了多少。
   * 只提示不净额——草稿随时可能被驳回或改量，拿它自动扣减建议量等于让一张临时单据改写判定口径。
   */
  inFlightDrafts: InFlightDrafts;
  /** 上面这件事的中文提示；无在途草稿 = null（行上不显示任何东西） */
  inFlightWarning: string | null;
  /** E8-10：版本捕获专用的精确输入/输出；页面可忽略，保存时不得从展示舍入值反推。 */
  decisionEvidence: ReplenishDecisionEvidence;
}

export interface ReplenishDecisionEvidence {
  businessDate: string;
  /** 账面在库（core/stock-view 口径，未扣临期） */
  onHand: string;
  /** 进入推演的可用在库 = onHand − expiringUnsellable */
  availableOnHand: string;
  /** 临期净额（W2-#2） */
  expiringUnsellable: string;
  poInTransit: string;
  daily: string;
  safetyQty: string;
  targetLevel: string;
  demandQty: string;
  netRequiredQty: string;
  actionWindowDays: number;
  horizonDays: number;
  supplyLines: Array<{
    source: OpenSupplyLine["source"];
    ref: string | null;
    sourceDocId: number;
    sourceLineId: number | null;
    expectDate: string | null;
    qty: string;
  }>;
}

export interface ReplenishResult {
  rows: ReplenishRow[];
  total: number;
  meta: {
    coverDaysTarget: number;
    minCoverAlert: number;
    months3: string[];
    snapDate: string | null;
    /** 全部成品中触发建议的 SKU 数（不受分页影响） */
    suggestCount: number;
    /** 全口径参考时点（总库存明细 progress；无参考数据 = null） */
    refDate: string | null;
    /** 因覆盖缺口+全管道充足而被抑制的建议数 */
    suppressedCount: number;
    /** W2-#6：处在「已复核并放弃」抑制窗口内的行数（抑制不静默，横幅据此提示） */
    declineSuppressedCount: number;
    /** E2：建议引擎口径（time_phased=逐日推演触发；legacy=单桶覆盖天数） */
    engine: string;
    /** 目标服务水平（%） */
    serviceLevel: number;
    /** D58 分层来源期（sku_planning_policy 最近固化期；null = 尚未固化） */
    policyPeriod: string | null;
    /** 因 hideTierC 折叠的 C 级行数 */
    hiddenTierC: number;
    /** 全部成品中已固化行的权责分布 */
    ownershipMix: Record<Ownership, number>;
  };
}

export const REPLENISH_SORT_FIELDS = [
  "code",
  "name",
  "brand",
  "abcClass",
  "tier",
  "ownership",
  "onHand",
  "inTransit",
  "legacyTransit",
  "wipQty",
  "refQty",
  "onOrder",
  "borrowOut",
  "daily",
  "externalDaily30",
  "forecastDaily",
  "daysCover",
  "coverFull",
  "leadDays",
  "suggestQty",
  /* E2-05 决策字段：引擎早就算出「最晚什么时候必须下单」与「还有几天断货」，
     此前既不下发到列上也不可排序，计划员只能靠可销天数近似——而可销天数不含生产周期。 */
  "orderByDate",
  "daysToShortage",
] as const;

export type ReplenishSortBy = (typeof REPLENISH_SORT_FIELDS)[number];
export type ReplenishSortOrder = "ascend" | "descend";

/**
 * 未指定排序时的缺省列：**最晚下单日升序**。
 * 补货页的唯一问题是「今天该下哪几张单」，而不是「谁的可销最低」——
 * 可销最低的 SKU 若生产周期短，反而不急；最晚下单日最早的才是今天必须动的。
 * 空值（未触发/无法倒推）按 compareReplenishRows 的规则一律置底。
 */
export const REPLENISH_DEFAULT_SORT_BY: ReplenishSortBy = "orderByDate";

export function normalizeReplenishSort(
  sortBy: string | null | undefined,
  sortOrder: string | null | undefined,
): { sortBy: ReplenishSortBy; sortOrder: ReplenishSortOrder } {
  return {
    sortBy: REPLENISH_SORT_FIELDS.includes(sortBy as ReplenishSortBy)
      ? (sortBy as ReplenishSortBy)
      : REPLENISH_DEFAULT_SORT_BY,
    sortOrder: sortOrder === "descend" ? "descend" : "ascend",
  };
}

export function isPddWindowIncomplete(
  externalRow: { pddIdentityCovered: boolean } | null,
  pddWindowComplete30: boolean,
): boolean {
  return externalRow?.pddIdentityCovered === true && !pddWindowComplete30;
}

export interface ReplenishQuery {
  coverDaysTarget?: number;
  minCoverAlert?: number;
  q?: string;
  page?: number;
  pageSize?: number;
  sortBy?: ReplenishSortBy;
  sortOrder?: ReplenishSortOrder;
  /** 内部消费者（如 MRP 相关需求展开）取全量，绕过 API 分页夹取——防静默截断。HTTP 层永不传 true。 */
  allRows?: boolean;
  /**
   * 只算这几个 SKU（内部消费者用；HTTP 层不下发）。
   * 逐行口径与全量跑完全相同——ABC 分层、销量锚点、分域参数都各有独立的全量查询，
   * 不随本过滤变化；这里只是不去装配用不到的行（单 SKU 曲线抽屉不必为 441 个成品算一遍）。
   */
  skuIds?: number[];
  /** D58 四档筛选（S/A/B/C；"none" = 未固化） */
  tier?: string;
  /** D59 权责筛选 */
  ownership?: string;
  /** C 级默认折叠：true 时 C 级行不进列表（meta.hiddenTierC 计数），默认 false 以保持既有消费者不变 */
  hideTierC?: boolean;
  /** D62 渠道范围（计划事件标签按范围裁剪）；缺省不裁剪 */
  scopeUser?: { roles: string[]; channelScope?: number[] | null };
}

const replenishCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

function replenishSortValue(
  row: ReplenishRow,
  sortBy: ReplenishSortBy,
): string | number | null {
  switch (sortBy) {
    case "code":
    case "name":
      return row[sortBy];
    case "brand":
    case "abcClass":
    case "tier":
    case "ownership":
      return row[sortBy];
    case "suggestQty":
      return row.suggestQty ?? row.heldQty;
    case "orderByDate":
      // YYYY-MM-DD 定长日期串，字典序即时间序；null（未触发/无生产周期）交给下方置底规则
      return row.orderByDate;
    default:
      return row[sortBy];
  }
}

/** 全量结果先排序、后分页；空值无论升降序都置底，避免“无数据”霸占决策视野。 */
export function compareReplenishRows(
  a: ReplenishRow,
  b: ReplenishRow,
  sortBy: ReplenishSortBy,
  sortOrder: ReplenishSortOrder,
): number {
  const av = replenishSortValue(a, sortBy);
  const bv = replenishSortValue(b, sortBy);
  if (av == null && bv == null) return replenishCollator.compare(a.code, b.code);
  if (av == null) return 1;
  if (bv == null) return -1;
  const primary = sortBy === "suggestQty"
    ? dCmp(String(av), String(bv))
    : typeof av === "number" && typeof bv === "number"
      ? av - bv
      : replenishCollator.compare(String(av), String(bv));
  if (primary !== 0) return sortOrder === "descend" ? -primary : primary;
  return replenishCollator.compare(a.code, b.code);
}

export async function getReplenishSuggestions(query: ReplenishQuery, dbArg?: AnyDb): Promise<ReplenishResult> {
  const db = await resolveDb(dbArg);
  // 外部观察销速影子列：内部日均来自 sales_monthly（当前停在 6 月），外部是天猫近 30 天；只并排，不进公式
  const externalVelocity = await loadExternalVelocitySafe(db);
  const userTarget = query.coverDaysTarget != null;
  const coverDaysTarget = Math.min(365, Math.max(1, Math.floor(query.coverDaysTarget ?? (await getNumParam("cover_target_days", 45, dbArg)))));
  const [targetA, targetB, targetC] = await Promise.all([
    getNumParam("cover_target_days_a", 60, dbArg),
    getNumParam("cover_target_days_b", 45, dbArg),
    getNumParam("cover_target_days_c", 25, dbArg),
  ]);
  const minCoverAlert = Math.min(365, Math.max(1, Math.floor(query.minCoverAlert ?? (await getNumParam("cover_alert_days", 30, dbArg)))));
  /* R11 单次订货上限与超买提示（rules/netreq 的 maxOrder / overshootWarnDays）。
     上限 0 = 不设（默认，行为与此前一致）；>0 时上限量 = 日均 × 天数，逐 SKU 各算各的。 */
  const [maxOrderCoverDays, overshootWarnDays, expiryMaxStocktakeAgeDays] = await Promise.all([
    getNumParam("replenish_max_order_cover_days", 0, dbArg),
    getNumParam("replenish_overshoot_warn_days", 90, dbArg),
    /* C4 临期净额的观测鲜度门：batch_stocks 是盘点快照，「逐仓最新盘点期」可能已是两个月前。
       0 = 不设限（回到旧行为）。 */
    getNumParam("expiry_netting_max_stocktake_age_days", 45, dbArg),
  ]);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = query.allRows ? Number.MAX_SAFE_INTEGER : Math.min(999, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim();
  const { sortBy, sortOrder } = normalizeReplenishSort(query.sortBy, query.sortOrder);

  /* ── 成品 SKU（active） ── */
  const conds = [eq(schema.skus.skuType, "finished" as const), eq(schema.skus.active, true)];
  if (query.skuIds?.length) conds.push(inArray(schema.skus.id, [...new Set(query.skuIds)]));
  if (q) {
    conds.push(sql`(${schema.skus.code} ILIKE ${"%" + q + "%"} OR ${schema.skus.name} ILIKE ${"%" + q + "%"})`);
  }
  const skuRows: { id: number; code: string; name: string; baseUom: string; brand: string | null; brandId: number | null }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      baseUom: schema.skus.baseUom,
      brand: schema.brands.nameCn,
      brandId: schema.skus.brandId, // 分域参数 brand 层解析需要（缺它则 brand 覆盖永不命中）
    })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(and(...conds));
  const emptyMix = (): Record<Ownership, number> => ({ supply_chain_direct: 0, joint_review: 0, ops_fallback: 0 });
  if (skuRows.length === 0) {
    return { rows: [], total: 0, meta: { coverDaysTarget, minCoverAlert, months3: [], snapDate: null, suggestCount: 0, refDate: null, suppressedCount: 0, declineSuppressedCount: 0, engine: "time_phased", serviceLevel: 95, policyPeriod: null, hiddenTierC: 0, ownershipMix: emptyMix() } };
  }
  const skuIds = skuRows.map((s) => s.id);

  /* ── D58/D59 固化策略（最近期）+ 运营计划事件标签 ── */
  const policy = await loadPolicyMap(db);
  const planEventsBySku = await loadOpenPlanEventsBySku(db, skuIds, query.scopeUser);

  /* ── 在库：全网口径（core/stock-view 唯一实现） ── */
  const onHandView = await getOnHandBySku(db, { skuIds });
  const onHandBySku = onHandView.bySku;
  const snapDate: string | null = onHandView.snapDate;

  /* ── 在途：已审批/执行中 PO 未收量（基础单位，逐行下限 0；与 wo.ts 快照同口径） ── */
  const transitRows: { skuId: number; qty: string; uomFactor: string; receivedQty: string }[] = await db
    .select({
      skuId: schema.poLines.skuId,
      qty: schema.poLines.qty,
      uomFactor: schema.poLines.uomFactor,
      receivedQty: schema.poLines.receivedQty,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .where(and(inArray(schema.poLines.skuId, skuIds), inArray(schema.poDocs.status, ["approved", "in_progress"])));
  const inTransitBySku = new Map<number, string>();
  for (const r of transitRows) {
    const remain = dSub(dMul(r.qty, r.uomFactor, 6), r.receivedQty, 6);
    if (dCmp(remain, "0") <= 0) continue; // 超收行不抵扣其他行
    inTransitBySku.set(r.skuId, dAdd(inTransitBySku.get(r.skuId) ?? "0", remain, 6));
  }

  /* ── func#1 在制委外产出：WO（已审批/执行中、未暂停）计划产出——成品主要补给来源，
        原补货完全看不见导致重复下单。归入全管道口径（非建议驱动，同参考层纪律）。
        口径诚实：以 WO qty 计，未净部分批已收（in_progress WO 残余高估），列注标明。 ── */
  const woRows: { skuId: number; qty: string }[] = await db
    .select({ skuId: schema.woDocs.productSkuId, qty: schema.woDocs.qty })
    .from(schema.woDocs)
    .where(and(inArray(schema.woDocs.productSkuId, skuIds), inArray(schema.woDocs.status, ["approved", "in_progress"]), eq(schema.woDocs.isPaused, false)));
  const wipBySku = new Map<number, string>();
  for (const r of woRows) wipBySku.set(r.skuId, dAdd(wipBySku.get(r.skuId) ?? "0", r.qty, 6));

  /* ── func#20 借出未还：transit_refs kind=borrow orderType=借出——已借给其他渠道，从管道扣减 ── */
  const trB = schema.transitRefs;
  const borrowRows: { skuId: number | null; qty: string | null }[] = await db
    .select({ skuId: trB.skuId, qty: trB.qty })
    .from(trB)
    .where(and(eq(trB.kind, "borrow"), eq(trB.orderType, "借出"), inArray(trB.skuId, skuIds)));
  const borrowOutBySku = new Map<number, number>();
  for (const r of borrowRows) { if (r.skuId != null) borrowOutBySku.set(r.skuId, (borrowOutBySku.get(r.skuId) ?? 0) + num(r.qty)); }

  /* ── 销量矩阵：一次取回近 6 月 SKU×月（冗余#5：原分三次查 sales_monthly——
        近3月汇总 / ABC 全量 / 预测序列；其中近3月汇总与预测序列同窗同集，合并为一次），
        近3月汇总由矩阵按月 dAdd 精确累加（保持 decimal 字符串，不经 float）。 ── */
  const sm = schema.salesMonthly;
  const { maxYm } = await salesWindow(db);
  const months6 = maxYm ? lastMonths(maxYm, 6) : [];
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const months3Set = new Set(months3);
  const monthIdx = new Map(months6.map((m, i) => [m, i]));

  const sales3mBySku = new Map<number, string>();
  const seriesBySku = new Map<number, number[]>();
  if (months6.length) {
    const monthlyRows: { skuId: number; ym: string; qty: string | null }[] = await db
      .select({ skuId: sm.skuId, ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
      .from(sm)
      .where(and(inArray(sm.skuId, skuIds), inArray(sm.yearMonth, months6)))
      .groupBy(sm.skuId, sm.yearMonth);
    for (const r of monthlyRows) {
      const i = monthIdx.get(r.ym);
      if (i == null) continue;
      let arr = seriesBySku.get(r.skuId);
      if (!arr) { arr = new Array(months6.length).fill(0); seriesBySku.set(r.skuId, arr); }
      arr[i] = num(r.qty);
      if (months3Set.has(r.ym)) {
        sales3mBySku.set(r.skuId, dAdd(sales3mBySku.get(r.skuId) ?? "0", r.qty ?? "0", 6));
      }
    }
  }

  /* ── func#14 ABC 分层（全成品口径，与 q 过滤无关——故需独立一次全量查询）→ 逐 SKU 目标覆盖天数。
        窗口与「库存分层」页一致取近 6 月（同一 SKU 两页必须同类——曾因窗口不同产生 41 处分歧）。 ── */
  const abcBySku = new Map<number, "A" | "B" | "C">();
  if (months6.length) {
    const popRows: { skuId: number; qty: string | null }[] = await db
      .select({ skuId: sm.skuId, qty: sql<string | null>`sum(${sm.qty})` })
      .from(sm)
      .innerJoin(schema.skus, eq(sm.skuId, schema.skus.id))
      .where(and(eq(schema.skus.skuType, "finished"), eq(schema.skus.active, true), inArray(sm.yearMonth, months6)))
      .groupBy(sm.skuId);
    for (const [id, cls] of classifyAbc(popRows.map((r) => ({ id: r.skuId, qty: num(r.qty) })))) abcBySku.set(id, cls);
  }
  /* ── W3 目标覆盖天数的**来源**：此前 effectiveTarget 是个裸数字，行上无从判断它是页面输入、
        分域覆盖、还是 ABC 分层参数——正是「写得进、读不到」那类问题的另一半（写进去了也看不出有没有生效）。
        优先级：页面指定 > 分域覆盖（sku > brand > segment）> ABC 分层参数 > 全局/系统缺省。
        分域层放在 ABC 之前：给某个 SKU/品牌单独设的目标必须压过分层默认值，否则那次设置等于没设。 ── */
  const resolveTargetDays = await makeResolver("cover_target_days", 45, dbArg);
  const clampDays = (v: number): number => Math.min(365, Math.max(1, Math.floor(v)));
  const scopeLabelOf = (scope: string, brandName: string | null, abcClass: "A" | "B" | "C" | null): string => {
    if (scope === FALLBACK_SCOPE) return "系统缺省";
    if (scope === "global") return "全局";
    if (scope.startsWith("brand:")) return `品牌${brandName ? `「${brandName}」` : `#${scope.slice(6)}`}`;
    if (scope.startsWith("segment:")) return `${abcClass ?? scope.slice(8)} 类分层`;
    if (scope.startsWith("sku:")) return "本 SKU";
    return describeScope(scope);
  };
  const targetBasisFor = (
    s: { id: number; brand: string | null; brandId: number | null },
    abcClass: "A" | "B" | "C" | null,
  ): ReplenishTargetBasis => {
    if (userTarget) {
      return { value: coverDaysTarget, source: "user", scope: null, abcClass, label: `页面指定目标覆盖 ${coverDaysTarget} 天（本次查询覆盖分层与分域参数）` };
    }
    const hit = resolveTargetDays({ skuId: s.id, brandId: s.brandId ?? undefined, segment: abcClass ?? undefined });
    if (hit.layer === "sku" || hit.layer === "brand" || hit.layer === "segment") {
      const value = clampDays(hit.value);
      return {
        value,
        source: hit.layer,
        scope: hit.scope,
        abcClass,
        label: `${scopeLabelOf(hit.scope, s.brand, abcClass)}覆盖 ${value} 天（分域参数 cover_target_days）`,
      };
    }
    if (abcClass) {
      const value = clampDays(abcClass === "A" ? targetA : abcClass === "B" ? targetB : targetC);
      const source = (abcClass === "A" ? "abc_a" : abcClass === "B" ? "abc_b" : "abc_c") as TargetBasisSource;
      return { value, source, scope: null, abcClass, label: `ABC ${abcClass} 类目标覆盖 ${value} 天（运行参数 cover_target_days_${abcClass.toLowerCase()}）` };
    }
    const value = clampDays(hit.value);
    return { value, source: "global", scope: hit.scope, abcClass: null, label: `${scopeLabelOf(hit.scope, s.brand, null)}目标覆盖 ${value} 天（运行参数 cover_target_days，本 SKU 未分层）` };
  };

  /* ── 全口径参考：transit_refs kind=stock_summary（总库存明细，只参考不入账） ── */
  const tr = schema.transitRefs;
  const refRows: { skuId: number | null; qty: string | null; inboundQty: string | null; progress: string | null }[] = await db
    .select({ skuId: tr.skuId, qty: tr.qty, inboundQty: tr.inboundQty, progress: tr.progress })
    .from(tr)
    .where(and(eq(tr.kind, "stock_summary"), inArray(tr.skuId, skuIds)));
  const refBySku = new Map<number, { qty: number | null; onOrder: number | null }>();
  let refDate: string | null = null;
  for (const r of refRows) {
    if (r.skuId == null) continue;
    refBySku.set(r.skuId, { qty: r.qty == null ? null : num(r.qty), onOrder: r.inboundQty == null ? null : num(r.inboundQty) });
    if (r.progress && (refDate == null || r.progress > refDate)) refDate = r.progress;
  }

  /* ── 存量单在途：transit_refs kind=fg_order 未入库余量（旧流程收尾，登记口径） ── */
  const fgRows: { skuId: number | null; qty: string | null; inboundQty: string | null; closedQty: string | null }[] = await db
    .select({ skuId: tr.skuId, qty: tr.qty, inboundQty: tr.inboundQty, closedQty: tr.closedQty })
    .from(tr)
    .where(and(eq(tr.kind, "fg_order"), inArray(tr.skuId, skuIds)));
  const legacyBySku = new Map<number, number>();
  for (const r of fgRows) {
    if (r.skuId == null || r.qty == null) continue;
    /* 数量走 core/decimal 再落回 number：float 直减会留下 ~1e-16 的残渣
       （8.7 − 8.6 − 0.1 = 5.3e-16 > 0），于是一张**已经收完的**存量单被算作还有在途。
       量上可以忽略，但「已入库/已关单的存量单不再计在途」这条判断本身就失效了。 */
    const remain = Number(dSub(dSub(r.qty, r.inboundQty ?? "0"), r.closedQty ?? "0"));
    if (remain <= 0) continue; // 已入库/已关单的存量单不再计在途
    legacyBySku.set(r.skuId, (legacyBySku.get(r.skuId) ?? 0) + remain);
  }

  /* ── 供应参数（生产周期 / MOQ / 订货倍数）：master/sku-supply-params 唯一读 facade，
        一次读齐，避免各服务分别 join uom_convs 与 sku_params（口径与顺序易漂移）。 ── */
  const supplyParams = await getSkuSupplyParams(skuIds, db);
  const leadBySkuId = new Map<number, number>();
  const productionLeadBySkuId = new Map<number, number>();
  const logisticsLeadBySkuId = new Map<number, number | null>();
  const uomBySku = new Map<number, { moq: string | null; orderMultiple: string | null }>();
  for (const [id, p] of supplyParams) {
    if (p.normalLeadDays != null && p.normalLeadDays > 0) {
      productionLeadBySkuId.set(id, p.normalLeadDays);
      leadBySkuId.set(id, p.normalLeadDays + Math.max(0, p.logisticsLeadDays ?? 0));
    }
    logisticsLeadBySkuId.set(id, p.logisticsLeadDays);
    uomBySku.set(id, { moq: p.moq, orderMultiple: p.orderMultiple });
  }

  /* ── E2-05：预取「有确认到货日」的未结供给（core/supply 唯一定义）供逐日推演 ── */
  const supplyLines = await getOpenSupplyLines(db, skuIds);
  const arrivalsBySku = new Map<number, { date: string; qty: number }[]>();
  const supplyLinesBySku = new Map<number, OpenSupplyLine[]>();
  for (const l of supplyLines) {
    const evidence = supplyLinesBySku.get(l.skuId) ?? [];
    evidence.push(l);
    supplyLinesBySku.set(l.skuId, evidence);
    if (!l.expectDate || l.qty <= 0) continue;
    const arr = arrivalsBySku.get(l.skuId) ?? [];
    arr.push({ date: l.expectDate, qty: l.qty });
    arrivalsBySku.set(l.skuId, arr);
  }

  /* ── E2-01+：交期波动（rollup_supplier_lead 物化结果）——此前因热路径开销未接入，
        E7-01 预聚合落地后改为一次批量读取，安全库存自此计入交期不确定性。
        同 SKU 多供应商时取样本最多的一条（最有代表性）。 ── */
  const leadStdevBySku = new Map<number, number>();
  {
    const rows: { skuId: number; stdev: string | null; samples: number }[] = await db
      .select({
        skuId: schema.rollupSupplierLead.skuId,
        stdev: schema.rollupSupplierLead.leadStdevDays,
        samples: schema.rollupSupplierLead.samples,
      })
      .from(schema.rollupSupplierLead)
      .where(inArray(schema.rollupSupplierLead.skuId, skuIds));
    const bestSamples = new Map<number, number>();
    for (const r of rows) {
      if (r.stdev == null) continue;
      const prev = bestSamples.get(r.skuId) ?? -1;
      if (r.samples > prev) {
        bestSamples.set(r.skuId, r.samples);
        leadStdevBySku.set(r.skuId, num(r.stdev));
      }
    }
  }

  /* ── E2-01：安全库存参数（服务水平/兜底天数），分域解析器（sku>brand>segment>global） ── */
  const serviceLevel = await getNumParam("service_level_pct", 95, dbArg);
  const resolveSafetyDays = await makeResolver("safety_days_fallback", 7, dbArg);
  const todayStr = todayShanghai();

  /* ── W2-#2 临期批次（batch_stocks 参考层，盘点期收口由 replenish/expiry 唯一实现）──
        引擎此前只看 getOnHandBySku 的总量，把临期与已过期一并当作可用；
        「够，不用补」→ 批次过期报废 → 结构性缺货。这里按 FEFO 算出卖不掉的量并从**判定**里扣除，
        账面在库照旧下发（onHand），扣减量与理由逐行给出。 ── */
  /* ── W2-#6 生效中的放弃抑制窗口（未清除、未到期）；是否真的还在压由 suppressionState 逐行判 ── */
  const suppressions = await loadActiveSuppressions(db, todayStr, skuIds);

  /* C10：另一页（先挪后买 / 调拨建议）已经为同一个 SKU 起草的调拨，本页必须看得见——
     否则计划员在那边起草调拨、在这边按**全额** suggestQty 起草采购，两页各自正确、合起来多订。 */
  const inFlightBySku = await loadInFlightDrafts(db, skuIds);

  const expiryBatchesBySku = new Map<number, ExpiryBatch[]>();
  for (const b of await loadExpiryBatches(db, skuIds, { today: todayStr })) {
    const arr = expiryBatchesBySku.get(b.skuId) ?? [];
    arr.push({ daysLeft: b.daysLeft, qty: b.qty, stocktakeAgeDays: b.stocktakeAgeDays });
    expiryBatchesBySku.set(b.skuId, arr);
  }

  /* ── 逐 SKU 计算（decimal 计算、展示层 Number） ── */
  const all: ReplenishRow[] = skuRows.map((s) => {
    const onHand = dQty(onHandBySku.get(s.id) ?? "0");
    const inTransit = dQty(inTransitBySku.get(s.id) ?? "0");
    const sales3m = sales3mBySku.get(s.id) ?? "0";
    const dailyDec = dCmp(sales3m, "0") > 0 ? dDiv(sales3m, "91", 6) : "0";
    const dailyNum = num(dailyDec);
    const cover = dailyNum > 0 ? (num(onHand) + num(inTransit)) / dailyNum : null;
    /* ── 预测与「预测偏离」告警 ──
       告警只在**该 SKU 的预测确有价值时**才发：先做滚动回测，若 Holt 的 WAPE 不优于
       朴素预测（下月＝上月），说明这条序列上模型本身就是噪声——此时「预测偏离日均」
       并不指示需求异常，只指示模型不适用（真实数据实测：441 个成品里 243 个如此，
       多为间歇性需求，Holt 本就不适配）。据此发警报＝制造告警疲劳。
       回测是纯计算（12 点序列，无 IO），不构成热路径开销。 ── */
    const series = seriesBySku.get(s.id) ?? [];
    const fc = forecastDaily(series);
    const fcBt = backtest(
      series.map((q, i) => ({ ym: String(i), qty: q })),
      (h) => { const r = forecastDaily(h); return r.forecastMonthly > 0 ? r.forecastMonthly : r.forecastDaily * 30.4; },
      3,
    );
    const forecastTrusted = fcBt.fva != null && fcBt.fva > 0;
    const forecastDivergent =
      forecastTrusted && dailyNum > 0 && fc.forecastDaily > 0 &&
      Math.abs(fc.forecastDaily - dailyNum) / dailyNum > 0.3;

    /* 全口径融合（rules/fusion.ts）：参考只调高在库认知，绝不调低 */
    const ref = refBySku.get(s.id);
    const legacyTransit = legacyBySku.get(s.id) ?? 0;
    const wipQty = num(wipBySku.get(s.id) ?? "0");
    const borrowOut = borrowOutBySku.get(s.id) ?? 0;
    const productionLeadDays = productionLeadBySkuId.get(s.id) ?? null;
    const logisticsLeadDays = logisticsLeadBySkuId.get(s.id) ?? null;
    const leadDays = leadBySkuId.get(s.id) ?? null;
    const refGap = detectRefGap(num(onHand), ref?.qty ?? null);
    const coverFull = fuseCover({
      onHand: num(onHand),
      refQty: ref?.qty ?? null,
      inTransit: num(inTransit),
      legacyTransit,
      onOrder: ref?.onOrder ?? 0,
      wip: wipQty,
      borrowOut,
      daily: dailyNum,
    });

    const abcClass = abcBySku.get(s.id) ?? null;
    const targetBasis = targetBasisFor(s, abcClass);
    const effectiveTarget = targetBasis.value;
    const pol = policy.bySku.get(s.id) ?? null;

    /* ── E2-01 安全库存：统计法（需求σ×交期），样本/交期不足降级兜底天数并注明 ── */
    /* 解析上下文必须带齐三层，缺一层则那一层的覆盖**永远不命中**：
       此前只传 {skuId, segment}，于是 /api/admin/params/scoped 写入的 brand 覆盖
       返 201、GET 列得出、审计也留痕，唯独建议量纹丝不动——写得进、读不到。
       （segment 传的是 ABC 单字母；九宫格 AX/BY 这类 cell 目前不在本引擎上下文里，
       要支持需先把 segmentation 的 cell 引进来，属另一件事，不在此处臆造。） */
    const externalRow = externalVelocity.bySku[String(s.id)] ?? null;
    const safetyDays = resolveSafetyDays({
      skuId: s.id,
      brandId: s.brandId ?? undefined,
      segment: abcClass ?? undefined,
    });
    const safetyDaysBasis: ScopedParamBasis = {
      value: safetyDays.value,
      layer: safetyDays.layer,
      scope: safetyDays.scope,
      label: `${scopeLabelOf(safetyDays.scope, s.brand, abcClass)}兜底 ${safetyDays.value} 天（分域参数 safety_days_fallback；仅统计法不可用时生效）`,
    };
    const ss = safetyStock({
      monthly: seriesBySku.get(s.id) ?? [],
      daily: dailyNum,
      leadDays,
      leadDaysStdev: leadStdevBySku.get(s.id) ?? 0, // 交期波动（无历史样本=0，退化为确定性交期）
      serviceLevel: String(serviceLevel),
      fallbackDays: safetyDays.value,
    });

    /* ── E2-05 时间分段净需求：逐日推演到首次跌破安全库存，替代「日均×覆盖天数」单桶乘法。
          触发＝再订货点逻辑：短缺发生在生产周期内（来不及补）才建议下单。 ── */
    const actionWindow = leadDays != null && leadDays > 0 ? leadDays : minCoverAlert;
    const horizonDays = Math.min(365, actionWindow + effectiveTarget + 30);

    /* W2-#2 临期净额：批次参考层与账面在库不同源，故净额按账面在库夹取上限（不得扣出负库存）。 */
    const net = netExpiringStock({
      batches: expiryBatchesBySku.get(s.id) ?? [],
      daily: dailyNum,
      horizonDays,
      maxStocktakeAgeDays: expiryMaxStocktakeAgeDays > 0 ? expiryMaxStocktakeAgeDays : undefined,
    });
    /* 上限夹取必须**同时夹下限 0**（小项 a）：账面在库为负（委外仓垫料等合法负值经全网汇总后可为负）时，
       Math.min(净额, 负数) 会给出一个负的 unsellableQty，随后 dSub(onHand, 负数) 把可用在库**调高**，
       DTO 里还会出现负的 expiringUnsellable/unsellableQty。净额永远是「扣掉多少」，不可能是负数。 */
    const unsellableQty = Math.max(0, Math.min(net.unsellableQty, num(onHand)));
    const availableOnHand = unsellableQty > 0 ? dSub(onHand, String(unsellableQty), 6) : onHand;
    /* 鲜度门排除的量必须**照样出现在行上**：静默丢弃就等于「系统看过但没告诉你」，
       计划员无从判断这个 SKU 到底有没有临期风险、也不知道该去补一次盘点。 */
    const staleLabel = net.staleQty > 0
      ? `另有 ${r1(net.staleQty)} 件命中批次来自 ${net.staleAgeDays} 天前的盘点期（鲜度上限 ${net.maxStocktakeAgeDays} 天），`
        + "已过旧、不能当作今天的在库，故**未参与扣减**；如需按它净额请先补一次批次盘点"
      : "";
    const expiryRisk: ReplenishExpiryRisk | null = net.atRiskQty > 0 || net.staleQty > 0
      ? {
          unsellableQty: r1(unsellableQty),
          expiredQty: r1(net.expiredQty),
          atRiskQty: r1(net.atRiskQty),
          batches: net.batchesConsidered,
          minDaysLeft: net.minDaysLeft,
          bindingDaysLeft: net.bindingDaysLeft,
          horizonDays,
          staleQty: r1(net.staleQty),
          staleBatches: net.staleBatches,
          staleAgeDays: net.staleAgeDays,
          maxStocktakeAgeDays: net.maxStocktakeAgeDays,
          label: net.atRiskQty === 0
            ? `临期净额未生效：${staleLabel || "视野内无临期批次"}`
            : unsellableQty > 0
              ? `临期净额 ${r1(unsellableQty)}：${horizonDays} 天视野内命中 ${net.batchesConsidered} 个临期/已过期批次共 ${r1(net.atRiskQty)}（其中已过期 ${r1(net.expiredQty)}），按日均 ${r1(dailyNum)} 计，最紧的一批只剩 ${net.bindingDaysLeft} 天效期、卖不完的部分已从**可用在库**扣除；账面在库仍为 ${r1(num(onHand))}（批次参考层来自盘点，与记账在库不同源，故扣减以账面在库为上限）${staleLabel ? `。${staleLabel}` : ""}`
              : `命中 ${net.batchesConsidered} 个临期批次共 ${r1(net.atRiskQty)}（最短剩余 ${net.minDaysLeft} 天），按日均 ${r1(dailyNum)} 可在效期内售出，未扣减可用在库${staleLabel ? `。${staleLabel}` : ""}`,
        }
      : null;
    const expiryExplain = [
      ...(unsellableQty > 0
        ? [`临期净额：账面在库 ${r1(num(onHand))} 中 ${r1(unsellableQty)} 在效期内卖不掉，判定按可用在库 ${r1(num(availableOnHand))} 起算`]
        : []),
      ...(net.staleQty > 0 ? [`临期净额鲜度门：${staleLabel}`] : []),
    ];

    const tp = timePhasedNetReq({
      today: todayStr,
      onHand: num(availableOnHand),
      daily: dailyNum,
      arrivals: arrivalsBySku.get(s.id) ?? [],
      safetyQty: ss.safetyQty,
      coverTargetDays: effectiveTarget,
      leadDays,
      horizonDays,
    });

    let suggest: string | null = null;
    let heldQty: string | null = null;
    let suppressReason: string | null = null;
    let lotWarnings: ReplenishRow["lotWarnings"] = [];
    let overshootDays: number | null = null;
    const planExplain: string[] = [`安全库存 ${ss.safetyQty}（${ss.reason}）`, ...expiryExplain, ...tp.explain];
    const triggered = tp.shortageDate != null && tp.daysToShortage != null && tp.daysToShortage <= actionWindow;
    if (triggered && tp.requiredQty > 0) {
      const uom = uomBySku.get(s.id);
      /* 净需求已由逐日推演得出；此处施加 MOQ/订货倍数/单次上限（onHand/inTransit 已在推演中扣除，故传 0）。
         maxOrder 与 dailyDemand 此前不传，规则里的超买/上限两条警告因此永远不触发（等于规则写了没接）。 */
      const detail = suggestQtyDetailed({
        grossReq: String(tp.requiredQty),
        onHand: "0",
        inTransit: "0",
        moq: uom?.moq ?? null,
        orderMultiple: uom?.orderMultiple ?? null,
        maxOrder: maxOrderCoverDays > 0 && dailyNum > 0 ? dMul(dailyDec, String(maxOrderCoverDays), 4) : null,
        dailyDemand: dailyNum > 0 ? dailyDec : null,
        overshootWarnDays,
      });
      const suggested = detail.qty;
      lotWarnings = detail.warnings;
      overshootDays = detail.overshootDays == null ? null : r1(num(detail.overshootDays));
      planExplain.push(`施加 MOQ/订货倍数${maxOrderCoverDays > 0 ? "/单次上限" : ""}后 → ${suggested}`);
      for (const w of detail.warnings) planExplain.push(`规整提示（${w.level}）：${w.message}`);
      /* 抑制基准必须与**触发**基准同源（2026-07-26 红队实证）。
         触发用 actionWindow（=生产周期，本仓 40–68 天，见 :405/:421），
         而抑制此前仍用 minCoverAlert(=cover_alert_days 缺省 30)。
         二者不一致时，凡系统可销落在 30–生产周期之间的 SKU，
         shouldSuppressSuggest 的第一个条件 coverSystem < 基准 恒不成立 → **闸门结构性打不开**：
         实测 37/80 条建议（46%）不可抑制，其中 18 条按同源基准本应抑制、合计 115,391 件，
         等于对海外/其他部门仓已有的货重复下单。
         抑制≠拦单：被抑制的量仍以 heldQty 保留、逐行给出原因，人工核实后可手工放行。 */
      if (shouldSuppressSuggest(cover, coverFull, actionWindow, refGap)) {
        suppressReason = "全口径参考充足（覆盖缺口 SKU：海外/其他部门仓不在系统快照源）——请先核实全口径库存，防重复下单";
        if (dCmp(suggested, "0") > 0) heldQty = suggested;
      } else if (dCmp(suggested, "0") > 0) {
        suggest = suggested;
      }
    } else if (tp.shortageDate != null) {
      planExplain.push(`短缺在 ${tp.daysToShortage} 天后、超出行动窗口 ${actionWindow} 天（生产周期内可补），暂不建议下单`);
    }

    /* ── W2-#6 放弃抑制窗口：上一次「已复核并放弃」在窗口内的，不再重复建议同一个 SKU。
          **绝不静默**：建议量转入 heldQty（人工勾选即可放行），行上给出原因、到期日与解除入口。
          提前解除按两条基线判（C8，判定在 rules/replenish-suppression）：
          账面在库比基线高＝那批货真到了；全管道量比基线高＝它被登记进系统了；
          全管道量比基线低＝安排告吹，抑制的前提没了，必须立刻恢复建议而不是压满 30 天。 ── */
    let suppression: ReplenishSuppression | null = null;
    const supRow = suppressions.get(s.id);
    if (supRow) {
      const onHandNow = num(onHand);
      let pipelineNow = onHandNow;
      for (const line of supplyLinesBySku.get(s.id) ?? []) if (line.qty > 0) pipelineNow += line.qty;
      const state = suppressionState({
        untilDate: supRow.untilDate,
        releaseOnArrival: supRow.releaseOnArrival,
        pipelineBaseline: supRow.pipelineBaseline,
        pipelineNow,
        onHandBaseline: supRow.onHandBaseline,
        onHandNow,
        today: todayStr,
      });
      if (state.active) {
        const withheld = suggest ?? heldQty;
        if (suggest != null) { heldQty = suggest; suggest = null; }
        suppression = {
          id: supRow.id,
          reasonCode: supRow.reasonCode,
          reasonLabel: DECLINE_REASON_LABELS[supRow.reasonCode].label,
          reason: supRow.reason,
          by: supRow.by,
          since: supRow.businessDate,
          untilDate: supRow.untilDate,
          daysLeft: state.daysLeft,
          releaseOnArrival: supRow.releaseOnArrival,
          withheldQty: withheld,
          // 文案必须与实现一致（C8）：旧文案只承诺「落库后自动解除」，而实现根本检测不到落库，也没说取消会解除
          label: `${supRow.businessDate} 由 ${supRow.by} 以「${DECLINE_REASON_LABELS[supRow.reasonCode].label}」放弃：${supRow.reason}；抑制至 ${supRow.untilDate}（还剩 ${state.daysLeft} 天）${supRow.releaseOnArrival ? "，或该批供应到货入库、被登记为未结供给、安排被取消（三者任一）后自动解除" : ""}${withheld ? `。被扣下的建议量 ${withheld}，勾选即可放行` : ""}`,
        };
        planExplain.push(`已抑制：${suppression.label}`);
      } else if (state.releasedBy === "supply_arrived") {
        planExplain.push(`放弃抑制已自动解除：账面在库由 ${r1(supRow.onHandBaseline)} 升到 ${r1(onHandNow)}，「供应已安排」那批货已到货入库`);
      } else if (state.releasedBy === "supply_registered") {
        planExplain.push(`放弃抑制已自动解除：全管道量由 ${r1(supRow.pipelineBaseline)} 回升到 ${r1(pipelineNow)}，「供应已安排」已在系统内登记为未结供给`);
      } else if (state.releasedBy === "supply_cancelled") {
        planExplain.push(
          `放弃抑制已自动解除：全管道量由 ${r1(supRow.pipelineBaseline)} 降到 ${r1(pipelineNow)}，`
          + "「供应已安排」这个前提已不成立（相关供给被作废/短关），建议恢复下发——继续静音等于把一次真实缺货压掉",
        );
      }
    }

    /* ── W3「为什么没有建议」：空单元格无法区分「不需要补」与「引擎算不出来」，
          两者的处置完全不同（前者不用管，后者要去补主数据）。判定顺序即解释力顺序。 ── */
    let noSuggestReason: NoSuggestReason | null = null;
    if (suggest == null) {
      const reason = (code: NoSuggestReasonCode, text: string): NoSuggestReason => ({ code, label: NO_SUGGEST_REASON_LABELS[code], text });
      if (suppression != null) {
        noSuggestReason = reason("decline_suppressed", suppression.label);
      } else if (suppressReason != null) {
        noSuggestReason = reason("ref_gap_suppressed", `${suppressReason}${heldQty ? `；原始建议 ${heldQty}（核实后可放行）` : ""}`);
      } else if (months6.length === 0 || !seriesBySku.has(s.id)) {
        noSuggestReason = reason("insufficient_history", "近 6 个月无销量记录，日均与预测都无从推导——补齐销量数据或按人工判断处理");
      } else if (dailyNum <= 0) {
        noSuggestReason = reason("no_demand", `近 3 月（${months3.join("、")}）无动销，日均 0，不产生补货需求`);
      } else if (tp.shortageDate == null) {
        noSuggestReason = reason("cover_ok", `${horizonDays} 天视野内水位始终不低于安全库存 ${ss.safetyQty}，无需补货`);
      } else if (leadDays == null) {
        noSuggestReason = reason("lead_unknown", `未维护生产周期：行动窗口只能按预警阈值 ${actionWindow} 天近似，也无法倒推最晚下单日——请在「供应参数」补齐加工/物流周期`);
      } else if (!triggered) {
        noSuggestReason = reason("not_triggered", `短缺在 ${tp.daysToShortage} 天后，尚在行动窗口 ${actionWindow} 天之外（生产周期内来得及补），现在下单过早`);
      } else {
        noSuggestReason = reason("cover_ok", "已触发但测算净需求为 0（施加 MOQ/订货倍数后不足 1 个基础单位）");
      }
      planExplain.push(`未给出建议：${noSuggestReason.text}`);
    }

    const targetLevel = dAdd(
      String(ss.safetyQty),
      dMul(dailyDec, String(effectiveTarget), 6),
      6,
    );
    const demandQty = tp.daysToShortage == null
      ? "0"
      : dAdd(
          dMul(dailyDec, String(tp.daysToShortage + 1), 6),
          targetLevel,
          6,
        );
    const pddWindowIncomplete = isPddWindowIncomplete(
      externalRow,
      externalVelocity.coverage.pddWindowComplete30,
    );
    /* C10：本页负责「买」，所以提示的是另一侧——调拨侧已经起草了多少。 */
    const inFlight = inFlightBySku.get(s.id) ?? EMPTY_IN_FLIGHT;
    const inFlightNote = inFlightWarning(inFlight, "buy");
    if (inFlightNote) planExplain.push(`跨页在途草稿：${inFlightNote}`);

    const externalDaily30Gate = !externalRow
      ? "该 SKU 尚无已映射的外部需求"
      : pddWindowIncomplete
        ? `拼多多近 30 天仅观测到 ${externalVelocity.coverage.pddObservedDays30} 个业务日，暂不折算日均`
        : null;
    return {
      skuId: s.id,
      code: s.code,
      name: s.name,
      brand: s.brand,
      baseUom: s.baseUom,
      onHand: r1(num(onHand)),
      availableOnHand: r1(num(availableOnHand)),
      expiryRisk,
      inTransit: r1(num(inTransit)),
      daily: r1(dailyNum),
      daysCover: cover == null ? null : r1(cover),
      suggestQty: suggest,
      externalDaily30: externalRow && !pddWindowIncomplete
        ? r1(num(dDiv(String(externalRow.net30), "30", 6)))
        : null,
      externalDaily30Gate,
      externalLastSold: externalRow?.lastSoldDate ?? null,
      refQty: ref?.qty == null ? null : r1(ref.qty),
      onOrder: ref?.onOrder == null ? null : r1(ref.onOrder),
      legacyTransit: r1(legacyTransit),
      wipQty: r1(wipQty),
      borrowOut: r1(borrowOut),
      abcClass,
      effectiveTarget,
      targetBasis,
      safetyDaysBasis,
      noSuggestReason,
      tier: pol?.effectiveTier ?? null,
      tierOverridden: pol?.overrideTier != null,
      ownership: pol?.ownership ?? null,
      ownershipLabel: pol ? OWNERSHIP_LABELS[pol.ownership] : null,
      pilot: pol?.pilot ?? false,
      planEventTags: (planEventsBySku.get(s.id) ?? []).map((e) => planEventTag(e)),
      leadDays,
      productionLeadDays,
      logisticsLeadDays,
      coverFull: coverFull == null ? null : r1(coverFull),
      refGap,
      suppressReason,
      belowLead: belowLeadtime(cover, leadDays),
      heldQty,
      forecastDaily: fc.forecastDaily,
      forecastTrend: fc.trend,
      forecastDivergent,
      forecastTrusted,
      forecastAccuracy: {
        samples: fcBt.n,
        wape: fcBt.wape,
        bias: fcBt.bias,
        fva: fcBt.fva,
        reliable: fcBt.reliable,
      },
      declinedToday: null, // 分页后统一回填（只查当前页 SKU 的当日放弃状态）
      suppression,
      safetyQty: ss.safetyQty,
      safetyMethod: ss.method,
      shortageDate: tp.shortageDate,
      daysToShortage: tp.daysToShortage,
      orderByDate: tp.orderByDate,
      orderWindowMissed: tp.orderWindowMissed,
      planExplain,
      lotWarnings,
      overshootDays,
      inFlightDrafts: inFlight,
      inFlightWarning: inFlightNote,
      decisionEvidence: {
        businessDate: todayStr,
        onHand,
        availableOnHand,
        expiringUnsellable: dQty(String(unsellableQty)),
        poInTransit: inTransit,
        daily: dailyDec,
        safetyQty: String(ss.safetyQty),
        targetLevel,
        demandQty,
        netRequiredQty: String(tp.requiredQty),
        actionWindowDays: actionWindow,
        horizonDays,
        supplyLines: (supplyLinesBySku.get(s.id) ?? []).map((line) => ({
          source: line.source,
          ref: line.ref,
          sourceDocId: line.sourceDocId,
          sourceLineId: line.sourceLineId,
          expectDate: line.expectDate,
          qty: dQty(String(line.qty)),
        })),
      },
    };
  });

  /* ── D58/D59 筛选：tier / ownership / C 级折叠（在排序分页之前，计数不受分页影响） ── */
  const ownershipMix = emptyMix();
  for (const r of all) if (r.ownership) ownershipMix[r.ownership] += 1;
  let visible = all;
  const tierFilter = (query.tier ?? "").trim();
  if (tierFilter === "none") visible = visible.filter((r) => r.tier == null);
  else if (tierFilter) visible = visible.filter((r) => r.tier === tierFilter.toUpperCase());
  const ownershipFilter = (query.ownership ?? "").trim();
  if (ownershipFilter) visible = visible.filter((r) => r.ownership === ownershipFilter);
  let hiddenTierC = 0;
  if (query.hideTierC && !tierFilter) {
    hiddenTierC = visible.filter((r) => r.tier === "C").length;
    visible = visible.filter((r) => r.tier !== "C");
  }

  // 决策列按用户选择全量排序后再分页；默认全管道可销天数升序（越紧急越靠前）。
  visible.sort((a, b) => compareReplenishRows(a, b, sortBy, sortOrder));
  const suggestCount = visible.filter((r) => r.suggestQty != null).length;
  const suppressedCount = visible.filter((r) => r.suppressReason != null).length;
  const declineSuppressedCount = visible.filter((r) => r.suppression != null).length;
  const paged = visible.slice((page - 1) * pageSize, page * pageSize);
  /* W5：当日「已复核并放弃」由服务端下发（审计台账是唯一权威）。
     此前只存在点击者自己的 sessionStorage 里，同事、另一台设备一律看不到，
     于是同一条建议被不同的人重复复核。当日放弃条数极少，一次全量读回内存按 SKU 命中即可。 */
  const declinedRows = await loadDeclinedToday(db, todayStr);
  const declinedBySku = new Map(declinedRows.map((d) => [d.skuId, d]));
  const rows: ReplenishRow[] = paged.map((r) => ({
    skuId: r.skuId,
    code: r.code,
    name: r.name,
    brand: r.brand,
    baseUom: r.baseUom,
    onHand: r.onHand,
    availableOnHand: r.availableOnHand,
    expiryRisk: r.expiryRisk,
    inTransit: r.inTransit,
    daily: r.daily,
    daysCover: r.daysCover,
    suggestQty: r.suggestQty,
    externalDaily30: r.externalDaily30,
    externalDaily30Gate: r.externalDaily30Gate,
    externalLastSold: r.externalLastSold,
    refQty: r.refQty,
    onOrder: r.onOrder,
    legacyTransit: r.legacyTransit,
    wipQty: r.wipQty,
    borrowOut: r.borrowOut,
    abcClass: r.abcClass,
    effectiveTarget: r.effectiveTarget,
    targetBasis: r.targetBasis,
    safetyDaysBasis: r.safetyDaysBasis,
    noSuggestReason: r.noSuggestReason,
    tier: r.tier,
    tierOverridden: r.tierOverridden,
    ownership: r.ownership,
    ownershipLabel: r.ownershipLabel,
    pilot: r.pilot,
    planEventTags: r.planEventTags,
    leadDays: r.leadDays,
    productionLeadDays: r.productionLeadDays,
    logisticsLeadDays: r.logisticsLeadDays,
    coverFull: r.coverFull,
    refGap: r.refGap,
    suppressReason: r.suppressReason,
    belowLead: r.belowLead,
    heldQty: r.heldQty,
    forecastDaily: r.forecastDaily,
    forecastTrend: r.forecastTrend,
    safetyQty: r.safetyQty,
    safetyMethod: r.safetyMethod,
    shortageDate: r.shortageDate,
    daysToShortage: r.daysToShortage,
    orderByDate: r.orderByDate,
    orderWindowMissed: r.orderWindowMissed,
    planExplain: r.planExplain,
    lotWarnings: r.lotWarnings,
    inFlightDrafts: r.inFlightDrafts,
    inFlightWarning: r.inFlightWarning,
    overshootDays: r.overshootDays,
    forecastDivergent: r.forecastDivergent,
    forecastTrusted: r.forecastTrusted,
    forecastAccuracy: r.forecastAccuracy,
    declinedToday: declinedBySku.get(r.skuId)
      ? {
          by: declinedBySku.get(r.skuId)!.by,
          at: declinedBySku.get(r.skuId)!.at,
          reason: declinedBySku.get(r.skuId)!.reason,
          reasonCode: declinedBySku.get(r.skuId)!.reasonCode,
          businessDate: declinedBySku.get(r.skuId)!.businessDate,
        }
      : null,
    suppression: r.suppression,
    decisionEvidence: r.decisionEvidence,
  }));
  return {
    rows,
    total: visible.length,
    meta: { coverDaysTarget, minCoverAlert, months3, snapDate, suggestCount, refDate, suppressedCount, declineSuppressedCount, engine: "time_phased", serviceLevel, policyPeriod: policy.period, hiddenTierC, ownershipMix },
  };
}

/* ────────────────────────── 生成 BH 草稿（R13 人工闸） ────────────────────────── */

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字")
  .refine((s) => dCmp(s, "0") > 0, "数量必须大于 0");

export const createReplenishDraftSchema = z.object({
  remark: z.string().trim().max(500).optional(),
  items: z
    .array(z.object({ skuId: z.number().int().positive({ message: "必须选择 SKU" }), qty: decStr }))
    .min(1, "至少选择一项建议")
    .max(200, "一次最多 200 项"),
});
export type CreateReplenishDraftInput = z.infer<typeof createReplenishDraftSchema>;

/**
 * 将勾选的补货建议生成 ONE 张 BH 备货申请草稿（复用 outsource/bh.createBh，走正常审批流）。
 * 权限：pmc（admin 兜底）——本函数即人工闸的授权边界；createBh 内的 ops 门针对 BH 直录路径，
 * 故以补充 ops 角色的委托身份调用（审计仍记真实 userId，另落 replenish 来源审计）。
 */
export async function createReplenishDraft(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ id: number; docNo: string }> {
  requireAnyRole(user, "pmc");
  const v = createReplenishDraftSchema.parse(input);
  const db = await resolveDb(dbArg);
  const { assertLiveSuggestionsWritable } = await import("./sop-cycle");
  await assertLiveSuggestionsWritable(db);

  const delegate: SessionUser = user.roles.includes("ops")
    ? user
    : { ...user, roles: [...user.roles, "ops"] };
  const doc = await createBh(
    delegate,
    {
      remark: v.remark?.trim() ? v.remark.trim() : "由补货建议页生成（R11，人工确认）",
      lines: v.items.map((i) => ({ skuId: i.skuId, qty: i.qty })),
    },
    db,
  );
  // createBh 内已按 bh 实体留痕；此处补一条来源审计（replenish → bh）
  await writeAudit(db, {
    userId: user.id,
    entity: "replenish",
    entityId: doc.id,
    action: "draft_bh",
    after: { docNo: doc.docNo, lineCount: v.items.length, source: "replenish_suggestion" },
  });
  return { id: doc.id, docNo: doc.docNo };
}
