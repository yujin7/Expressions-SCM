/**
 * 补货试点读模型 `replenish-pilot/v2`（D59 R5：试点从稳定 SKU 起）。
 *
 * v2 口径升级（W12，缓存键升版，旧缓存不再命中）：并列出**金额口径分层** valueTier
 * （近 6 月销量 × 单位成本，来自 report/segmentation 的 W12 列）与「数量 × 金额」迁移矩阵。
 * **只对照，不改行为**：候选判定、权责、固化仍只读数量口径 tier；成本覆盖率不足时
 * 金额列为 insufficient（null），绝不降级成某个等级。
 *
 * 候选口径（纯消费既有信号，不新算）：生效分层 tier ∈ S/A/B（sku_planning_policy 最近期，含人工覆写；
 * 未固化则取分层页实时 tier）∧ 规则层 XYZ = X（rules/volatility，null 不算 X）∧ 周期主数据已维护
 * （sku_params 加工周期 >0 且在途周期已填）∧ 无异动侦测命中（report/detectors）。
 * 这与 rules/replenish-ownership 的 supply_chain_direct 条件相同；本读模型额外给出每个阻塞维度的人数与销量占比，
 * 让「名单为什么短」可见（研究结论：交期主数据覆盖率是最常见瓶颈）。
 *
 * 缓存：report_read_model_cache key=`replenish-pilot/v2`，source_binding = 期间|销量最新月|策略最近固化时刻|覆写数|试点数|
 * sku_params 最近更新+行数|运行参数（grade_* / default_*_lead_days / alert_buffer_days / detector_*）当前值|业务日；
 * 任一变化即重算，绝不以旧值冒充当前值。授权层级 derived（内部销量 + 主数据），无金额。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { salesWindow } from "@/server/core/sales-window";
import { type AnyDb, r1, resolveDb } from "@/server/core/svc";
import { todayShanghai } from "@/server/modules/master/common";
import { latestPolicyPeriod, loadPolicyMap } from "@/server/modules/planning/policy";
import { FINANCE_COST_STREAM } from "@/server/core/valuation";
import { getSegmentation, type SegmentationResult } from "@/server/modules/report/segmentation";
import { tierBasisAgreementMatrix, type Tier, type TierBasisAgreementMatrix } from "@/server/rules/abc";
import { OWNERSHIP_LABELS, type Ownership } from "@/server/rules/replenish-ownership";
import type { XyzClass } from "@/server/rules/volatility";

export const PILOT_CACHE_KEY = "replenish-pilot/v2";

export interface PilotRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  /** 生效分层（策略期覆写优先；未固化 = 实时） */
  tier: Tier;
  tierSource: "policy" | "policy_override" | "live";
  xyz: XyzClass | null;
  cv: number;
  ownership: Ownership;
  ownershipLabel: string;
  sales6m: number;
  leadDaysKnown: boolean;
  detectorHit: boolean;
  /** 已标记试点（sku_planning_policy.pilot） */
  pilot: boolean;
  /** 候选 = 四个条件全部满足 */
  eligible: boolean;
  /** 未入候选的阻塞原因（候选为空数组） */
  blockers: string[];
  /**
   * W12 金额口径并列分层（近 6 月销量 × 单位成本）；null = insufficient（覆盖率不足或无成本）。
   * **纯对照列**：候选判定、权责与固化都不读它。
   */
  valueTier: Tier | null;
  /** 单位成本来源：sku_costs / finance_observation / null */
  unitCostSource: "sku_costs" | "finance_observation" | null;
}

export interface PilotReadModel {
  key: typeof PILOT_CACHE_KEY;
  authority: "derived";
  builtAt: string;
  sourceBinding: string;
  period: string | null;
  months: string[];
  /** 参与判定的成品 SKU 数（分层页口径：finished + active + 正常销售角色） */
  scanned: number;
  totalSales6m: number;
  candidates: number;
  candidateSales6m: number;
  /** 候选销量占近 6 月总销量 %（1dp） */
  candidateSalesSharePct: number;
  pilotMarked: number;
  pilotSalesSharePct: number;
  byTier: Record<Tier, { total: number; eligible: number }>;
  /** S/A/B 中各阻塞维度的 SKU 数（一个 SKU 可同时计入多项） */
  blockers: { tierC: number; xyzNotX: number; xyzUnclassified: number; leadMissing: number; detectorHit: number };
  rows: PilotRow[];
  notes: string[];
  /** W12 声明的分层口径开关（sys_params tier_basis）；缺省 qty */
  tierBasis: "qty" | "value";
  /** 实际驱动候选/权责/固化的口径恒为 qty——开关只切换页面的「主口径」标注 */
  tierBasisApplied: "qty";
  /** 金额口径成本覆盖（按近 6 月销量加权） */
  costCoverage: SegmentationResult["costCoverage"];
  /** 数量口径 tier × 金额口径 valueTier 一致性矩阵（全量；同一时点两把尺子，不是期间迁移） */
  tierMigration: TierBasisAgreementMatrix;
  /** 金额口径已知局限（页面原样展示） */
  valueTierLimitations: string[];
}

export async function computeReplenishPilot(dbArg?: AnyDb): Promise<PilotReadModel> {
  const db = await resolveDb(dbArg);
  const seg = await getSegmentation({ allRows: true }, db);
  const { period, bySku: policy } = await loadPolicyMap(db);
  const byTier: PilotReadModel["byTier"] = { S: { total: 0, eligible: 0 }, A: { total: 0, eligible: 0 }, B: { total: 0, eligible: 0 }, C: { total: 0, eligible: 0 } };
  const blockers = { tierC: 0, xyzNotX: 0, xyzUnclassified: 0, leadMissing: 0, detectorHit: 0 };
  let candidateSales = 0;
  let pilotSales = 0;
  let pilotMarked = 0;
  const rows: PilotRow[] = seg.rows.map((r) => {
    const p = policy.get(r.skuId);
    const tier: Tier = p ? p.effectiveTier : r.tier;
    const tierSource: PilotRow["tierSource"] = p ? (p.overrideTier ? "policy_override" : "policy") : "live";
    const reasons: string[] = [];
    if (tier === "C") { reasons.push("C 级长尾"); blockers.tierC += 1; }
    else {
      if (r.xyzRaw == null) { reasons.push("波动样本不足/无动销"); blockers.xyzUnclassified += 1; }
      else if (r.xyzRaw !== "X") { reasons.push(`需求波动 ${r.xyzRaw}`); blockers.xyzNotX += 1; }
      if (!r.leadDaysKnown) { reasons.push("加工/在途周期未维护"); blockers.leadMissing += 1; }
      if (r.detectorHit) { reasons.push("异动侦测命中"); blockers.detectorHit += 1; }
    }
    const eligible = reasons.length === 0;
    byTier[tier].total += 1;
    if (eligible) { byTier[tier].eligible += 1; candidateSales += r.sales6m; }
    const pilot = p?.pilot ?? false;
    if (pilot) { pilotMarked += 1; pilotSales += r.sales6m; }
    return {
      skuId: r.skuId,
      code: r.code,
      name: r.name,
      brand: r.brand,
      tier,
      tierSource,
      xyz: r.xyzRaw,
      cv: r.cv,
      ownership: r.ownership,
      ownershipLabel: OWNERSHIP_LABELS[r.ownership],
      sales6m: r.sales6m,
      leadDaysKnown: r.leadDaysKnown,
      detectorHit: r.detectorHit,
      pilot,
      eligible,
      blockers: reasons,
      valueTier: r.valueTier,
      unitCostSource: r.unitCostSource,
    };
  });
  const totalSales = seg.rows.reduce((s, r) => s + r.sales6m, 0);
  const order: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3 };
  rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || order[a.tier] - order[b.tier] || b.sales6m - a.sales6m);
  const candidates = rows.filter((r) => r.eligible).length;
  const notes = [
    "候选 = 生效分层 S/A/B ∧ XYZ=X ∧ 加工/在途周期已维护 ∧ 无异动命中（与 rules/replenish-ownership 的「供应链直出」同条件）。",
    seg.costCoverage.state === "ready"
      ? `W12 金额口径分层为并列对照列（成本覆盖率按销量加权 ${seg.costCoverage.salesWeightedPct}% ≥ ${seg.costCoverage.minPct}%）：候选、权责与固化仍只读数量口径。`
      : `W12 金额口径分层不可用：${seg.costCoverage.reason}`,
    period ? `分层取 ${period} 期固化值（含人工覆写）；XYZ/周期/异动为实时判定。` : "尚未固化任何期间的分层（sku_planning_policy 为空），分层按分层页实时值；请先执行本期固化。",
    "试点成功指标与首批范围待业务确定（计划 §7）；本读模型只给候选与销量占比，不代表已纳入。",
  ];
  return {
    key: PILOT_CACHE_KEY,
    authority: "derived",
    builtAt: new Date().toISOString(),
    sourceBinding: "",
    period,
    months: seg.months,
    scanned: rows.length,
    totalSales6m: r1(totalSales),
    candidates,
    candidateSales6m: r1(candidateSales),
    candidateSalesSharePct: totalSales > 0 ? r1((candidateSales / totalSales) * 100) : 0,
    pilotMarked,
    pilotSalesSharePct: totalSales > 0 ? r1((pilotSales / totalSales) * 100) : 0,
    byTier,
    blockers,
    rows,
    notes,
    tierBasis: seg.tierBasis,
    tierBasisApplied: "qty",
    costCoverage: seg.costCoverage,
    /*
     * 迁移矩阵按**生效分层**（含固化期与人工覆写）重算：seg.tierMigration 用的是分层页实时 tier，
     * 而试点页展示的是生效 tier，两者在固化后可能不同——矩阵必须与同页表格的分层列一致。
     */
    tierMigration: tierBasisAgreementMatrix(rows.map((r) => ({ qtyTier: r.tier, valueTier: r.valueTier }))),
    valueTierLimitations: seg.valueTierLimitations,
  };
}

/**
 * 参与候选判定的运行参数键（sys_params global）：分层切点、缺省周期、预警缓冲、异动阈值。
 * 任一值变化都会改变 XYZ/异动/阻塞判定，故纳入 source_binding。
 */
export const PILOT_BINDING_PARAM_KEYS = [
  "grade_s_pct", "grade_a_pct", "grade_b_pct",
  "default_production_lead_days", "default_logistics_lead_days", "alert_buffer_days",
  "detector_sales_drop_pct", "detector_channel_shift_pct", "detector_velocity_dev_pct",
  // W12：分层口径开关与估值覆盖率门槛会改变金额并列列与迁移矩阵
  "tier_basis", "valuation_coverage_min_pct",
] as const;

/**
 * 来源绑定：任一输入变化即失效。
 * 组成 = 策略期 | 销量最新月 | 策略最近固化时刻 | 覆写数 | 试点数 | sku_params 最近更新时刻+行数 |
 *        单位成本输入（sku_costs 最近更新+行数、财务成本观察最新批次，W12） | 运行参数当前值 | 业务日。
 * 周期主数据（sku_params）是最常见的阻塞维度：补录后读模型必须立即反映，不能等到次日。
 */
export async function pilotSourceBinding(db: AnyDb): Promise<string> {
  const period = await latestPolicyPeriod(db);
  const { maxYm } = await salesWindow(db);
  const [pol]: { builtAt: string | null; overrides: number; pilots: number }[] = await db
    .select({
      builtAt: sql<string | null>`max(${schema.skuPlanningPolicy.builtAt})::text`,
      overrides: sql<number>`count(${schema.skuPlanningPolicy.overrideTier})::int`,
      pilots: sql<number>`count(*) filter (where ${schema.skuPlanningPolicy.pilot})::int`,
    })
    .from(schema.skuPlanningPolicy);
  const [sp]: { updatedAt: string | null; rows: number }[] = await db
    .select({
      updatedAt: sql<string | null>`max(${schema.skuParams.updatedAt})::text`,
      rows: sql<number>`count(*)::int`,
    })
    .from(schema.skuParams);
  // W12：金额口径分层的输入——手工成本表与财务成本观察批次，任一变化都会改变金额列与迁移矩阵
  const [cost]: { updatedAt: string | null; rows: number }[] = await db
    .select({
      updatedAt: sql<string | null>`max(${schema.skuCosts.updatedAt})::text`,
      rows: sql<number>`count(*)::int`,
    })
    .from(schema.skuCosts);
  const [finance]: { jobId: number | null }[] = await db
    .select({ jobId: sql<number | null>`max(${schema.integrationRuns.importJobId})` })
    .from(schema.integrationRuns)
    .where(and(eq(schema.integrationRuns.connector, "jdy"), eq(schema.integrationRuns.stream, FINANCE_COST_STREAM), eq(schema.integrationRuns.status, "succeeded")));
  const paramRows: { key: string; value: string }[] = await db
    .select({ key: schema.sysParams.key, value: schema.sysParams.value })
    .from(schema.sysParams)
    .where(and(eq(schema.sysParams.scope, "global"), inArray(schema.sysParams.key, [...PILOT_BINDING_PARAM_KEYS])));
  const paramValues = new Map(paramRows.map((r) => [r.key, r.value]));
  const params = PILOT_BINDING_PARAM_KEYS.map((k) => `${k}=${paramValues.get(k) ?? "default"}`).join(",");
  return [
    period ?? "none", maxYm ?? "none", pol?.builtAt ?? "none", pol?.overrides ?? 0, pol?.pilots ?? 0,
    `sp:${sp?.updatedAt ?? "none"}/${sp?.rows ?? 0}`,
    `cost:${cost?.updatedAt ?? "none"}/${cost?.rows ?? 0}/${finance?.jobId ?? "none"}`,
    params, todayShanghai(),
  ].join("|");
}

export async function loadReplenishPilot(dbArg?: AnyDb, opts: { refresh?: boolean } = {}): Promise<PilotReadModel> {
  const db = await resolveDb(dbArg);
  const binding = await pilotSourceBinding(db);
  if (!opts.refresh) {
    const cached = await db.execute(sql`
      SELECT payload FROM report_read_model_cache WHERE key = ${PILOT_CACHE_KEY} AND source_binding = ${binding} LIMIT 1
    `);
    const rows = (Array.isArray(cached) ? cached : (cached as { rows?: unknown[] }).rows ?? []) as { payload?: unknown }[];
    const payload = rows[0]?.payload;
    const parsed = typeof payload === "string" ? safeJson(payload) : payload;
    if (parsed && typeof parsed === "object" && (parsed as Partial<PilotReadModel>).key === PILOT_CACHE_KEY && Array.isArray((parsed as Partial<PilotReadModel>).rows)) {
      return parsed as PilotReadModel;
    }
  }
  const model = await computeReplenishPilot(db);
  model.sourceBinding = binding;
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${PILOT_CACHE_KEY}, ${binding}, ${JSON.stringify(model)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return model;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
