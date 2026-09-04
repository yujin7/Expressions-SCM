/**
 * 选源决策辅助（W2 审计 6）——`/outsource/wo`「生成单据」那个**唯一的真选源决策点**旁边该看到什么。
 *
 * 事故形态：委外工单生成 PO 时，供应商是从一个**光秃秃的下拉框**里选的。系统里躺着这家供应商的
 * 基准价、学出来的交期 P90、外部历史观察 P50、OTIF、记分卡等级、是否已暂停/拉黑——
 * 一样都没端到人眼前。于是「选谁」这个每天都在发生的决定，靠的是记忆和人情。
 *
 * 纪律：
 * - **只读**。本模块不写任何表、不改任何主数据，也不替人选供应商（不排名次、不给「推荐」标记）——
 *   只把已有事实按 SKU × 供应商摆出来，选择权仍在采购手里。
 * - **口径全部复用既有权威**，一处都不新造：
 *     基准价 → `outsource/price-list.currentPriceListRow`（与 PO 比价 findBaseline 同一取行规则）
 *     学习交期 P50/P90 → `report/leadtime-learning`（系统学习值）
 *     历史观察 P50 → `report/supplier-lead-history`（**observation_only**，来自简道云，只观察不定量）
 *     OTIF → `report/purchase-order-metrics.bySupplier`（v3 起主口径 = 原始承诺）
 *     记分卡等级 → `report/supplier-scorecard`
 *     暂停/拉黑 → `suppliers.status`（与 PO 提交时的既有拦截同一字段）
 * - **金额按角色**：`price` 与 `moneyVisible` 由 `canSeePrices` 决定；无权限时返回 null 并显式说明，
 *   而不是渲染成 0 或空（0 会被当成「免费」，空会被当成「没维护」）。
 * - 观察值必须**带标签下发**（`observedLabel`），页面不得把它和系统事实混排成同一列。
 */
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { canSeePrices, type SessionUser } from "@/server/core/dto";
import { getLeadTimeLearning } from "@/server/modules/report/leadtime-learning";
import { loadPurchaseOrderMetrics } from "@/server/modules/report/purchase-order-metrics";
import { loadSupplierLeadHistory } from "@/server/modules/report/supplier-lead-history";
import { getSupplierScorecard } from "@/server/modules/report/supplier-scorecard";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "./common";
import { currentPriceListRow } from "./price-list";

/** 不建议继续下单的供应商状态（与 PO 提交时的既有拦截同一集合） */
export const BLOCKED_SUPPLIER_STATUSES: readonly string[] = ["paused", "blacklisted"];
export const SUPPLIER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "待评估",
  qualified: "合格",
  paused: "已暂停",
  blacklisted: "已拉黑",
};
/** 观察值统一标签：外部观察不是系统事实，页面必须标出来 */
export const OBSERVED_LABEL = "历史观察（简道云，只观察不定量）";

export interface SourcingAidRow {
  supplierId: number;
  code: string;
  name: string;
  status: string;
  statusLabel: string;
  /** 已暂停/拉黑：仍然展示（让人知道为什么不该选它），但明确标出来 */
  blocked: boolean;
  /** 基准价（基础单位未税）；无权限 → null，无价目行 → null（两者由 moneyVisible 区分） */
  price: string | null;
  priceCurrency: string | null;
  priceEffectiveDate: string | null;
  /** 系统学习交期（report/leadtime-learning，按 供应商 × SKU） */
  learnedLeadP50: number | null;
  learnedLeadP90: number | null;
  learnedSamples: number;
  /** 外部历史观察交期 P50（observation_only） */
  observedLeadP50: number | null;
  observedSamples: number;
  observedLabel: string;
  /** OTIF（原始承诺口径，年度累计）；可评样本不足 → null */
  otifRate: number | null;
  otifEvaluable: number;
  /** 记分卡：综合分与建议等级（样本不足 → null，不假装打分） */
  score: number | null;
  grade: string | null;
  /** 档案现有等级（人工维护值） */
  currentLevel: string | null;
  /** 在办质量案件（W2 审计 4b 起进记分卡维度）；无案件 → null */
  openQualityCases: number | null;
}

export interface SourcingAid {
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  moneyVisible: boolean;
  /** OTIF 主口径标签（原始承诺）——决策辅助不能不说自己看的是哪一版 */
  otifBasisLabel: string;
  otifYear: number;
  rows: SourcingAidRow[];
  limitations: string[];
}

/**
 * 给定 SKU（可选给定候选供应商集合）的选源辅助行。
 * `supplierIds` 省略时，取**与该 SKU 有过往来**的供应商（有基准价 或 有已批 PO 行），
 * 而不是全量供应商目录——决策点要的是候选，不是通讯录。
 */
export async function getSourcingAid(
  user: SessionUser,
  query: { skuId: number; supplierIds?: number[] },
  dbArg?: AnyDb,
): Promise<SourcingAid> {
  requireAnyRole(user, "purchasing", "pmc", "ops");
  const db = await resolveDb(dbArg);
  if (!Number.isInteger(query.skuId) || query.skuId <= 0) throw new ApiError(400, "物料 id 非法");
  const [sku] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, baseUom: schema.skus.baseUom })
    .from(schema.skus)
    .where(eq(schema.skus.id, query.skuId));
  if (!sku) throw new ApiError(404, `物料不存在: #${query.skuId}`);

  const candidates = new Set<number>(query.supplierIds?.filter((n) => Number.isInteger(n) && n > 0) ?? []);
  if (candidates.size === 0) {
    for (const r of await db
      .select({ supplierId: schema.priceLists.supplierId })
      .from(schema.priceLists)
      .where(eq(schema.priceLists.skuId, sku.id))) {
      candidates.add(r.supplierId);
    }
    for (const r of await db
      .select({ supplierId: schema.poDocs.supplierId })
      .from(schema.poLines)
      .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
      .where(eq(schema.poLines.skuId, sku.id))) {
      candidates.add(r.supplierId);
    }
  }

  const moneyVisible = canSeePrices(user.roles);
  const poMetrics = await loadPurchaseOrderMetrics({}, db);
  if (candidates.size === 0) {
    return {
      skuId: sku.id, skuCode: sku.code, skuName: sku.name, baseUom: sku.baseUom,
      moneyVisible, otifBasisLabel: poMetrics.otifBasisLabel, otifYear: poMetrics.year,
      rows: [], limitations: [noCandidateNote(sku.code)],
    };
  }

  const supplierRows: { id: number; code: string; name: string; status: string; level: string | null }[] = await db
    .select({
      id: schema.suppliers.id, code: schema.suppliers.code, name: schema.suppliers.name,
      status: schema.suppliers.status, level: schema.suppliers.level,
    })
    .from(schema.suppliers)
    .where(inArray(schema.suppliers.id, [...candidates]));

  const [learning, scorecard, leadHistory] = await Promise.all([
    getLeadTimeLearning({ pageSize: 500 }, db),
    getSupplierScorecard({ pageSize: 500 }, db),
    loadSupplierLeadHistory(db).catch(() => null), // 外部观察缺失不该拖垮决策辅助
  ]);
  const learnedBySupplier = new Map(
    learning.rows.filter((r) => r.skuId === sku.id).map((r) => [r.supplierId, r]),
  );
  const scoreBySupplier = new Map(scorecard.rows.map((r) => [r.supplierId, r]));
  const observedBySupplier = new Map(
    (leadHistory?.bySupplierSku ?? [])
      .filter((r) => r.skuId === sku.id && r.supplierId != null)
      .map((r) => [r.supplierId as number, r]),
  );
  const otifBySupplier = new Map(poMetrics.bySupplier.map((r) => [r.supplierId, r]));

  const rows: SourcingAidRow[] = [];
  for (const s of supplierRows) {
    const price = moneyVisible ? await currentPriceListRow(db, { skuId: sku.id, supplierId: s.id }) : null;
    const learned = learnedBySupplier.get(s.id) ?? null;
    const observed = observedBySupplier.get(s.id) ?? null;
    const otif = otifBySupplier.get(s.id) ?? null;
    const card = scoreBySupplier.get(s.id) ?? null;
    rows.push({
      supplierId: s.id,
      code: s.code,
      name: s.name,
      status: s.status,
      statusLabel: SUPPLIER_STATUS_LABELS[s.status] ?? s.status,
      blocked: BLOCKED_SUPPLIER_STATUSES.includes(s.status),
      price: price?.price ?? null,
      priceCurrency: price?.currency ?? null,
      priceEffectiveDate: price?.effectiveDate ?? null,
      learnedLeadP50: learned?.p50 ?? null,
      learnedLeadP90: learned?.p90 ?? null,
      learnedSamples: learned?.samples ?? 0,
      observedLeadP50: observed?.observed.p50 ?? null,
      observedSamples: observed?.observed.samples ?? 0,
      observedLabel: OBSERVED_LABEL,
      otifRate: otif?.otif.rate ?? null,
      otifEvaluable: otif?.otif.evaluable ?? 0,
      score: card?.score ?? null,
      grade: card?.grade ?? null,
      currentLevel: s.level,
      openQualityCases: card?.openQualityCases ?? null,
    });
  }
  // 可选的先排前面；其余按编码稳定排序。**不排名次、不打「推荐」**：选择权在采购。
  rows.sort((a, b) => Number(a.blocked) - Number(b.blocked) || a.code.localeCompare(b.code));

  return {
    skuId: sku.id,
    skuCode: sku.code,
    skuName: sku.name,
    baseUom: sku.baseUom,
    moneyVisible,
    otifBasisLabel: poMetrics.otifBasisLabel,
    otifYear: poMetrics.year,
    rows,
    limitations: [
      `基准价 = 采购价目表当前生效行（生效日 ≤ 今日中最新一条），与 PO 提交时的 R1 比价基准同一取行规则；${moneyVisible ? "" : "当前角色无价格权限，金额列为空而非 0。"}`,
      `OTIF = ${poMetrics.otifBasisLabel}口径年度累计（${poMetrics.year} 年），供应商改期不抬高该值；可评样本不足时为空，不用 0 冒充。`,
      "学习交期来自系统内 PO→SH 履约；历史观察来自简道云，authority=observation_only，**只观察不定量**，两列不得混排。",
      "记分卡样本不足不评级（宁可留空也不打低分）；已暂停/拉黑的供应商仍然列出，但明确标注——让人知道它为什么不该被选。",
      "本页只读：不排名次、不给推荐标记，也不写任何主数据。选谁仍由采购判断。",
    ],
  };
}

function noCandidateNote(skuCode: string): string {
  return `${skuCode} 在系统内既无采购价目表基准价、也无历史采购订单行：这是首次寻源，没有可比事实——请先在「采购价目表」维护候选供应商基准价。`;
}
