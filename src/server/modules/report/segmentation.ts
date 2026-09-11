/**
 * ABC/XYZ 库存分层（只读报表层）。
 *
 * 单源（既有数据，不新增口径）：sales_monthly 近 6 月（窗口自 max(yearMonth) 动态回推，与 R11/风险表同法）。
 * - 分层范围：finished + active 成品 SKU（半成品/原料/包材不入销售分层）。
 * - ABC（销售贡献）：各 SKU 近6月总销量降序，按累计占比切分——A 累计前 80%，B 次 15%（80–95%），C 末 5%（95–100%）；零销量=C。
 * - XYZ（需求波动）：rules/volatility.classifyXyz（唯一权威）——CV=总体标准差/均值，X CV≤0.5 稳定，Y 0.5<CV≤1.0 中，Z CV>1.0 波动；
 *   规则对无动销/样本不足返回 null，本报表沿用历史展示口径映射为 Z（cv=0）并以 xyzUnclassified 单独计数。
 * - cell = ABC+XYZ（AX…CZ），每格给出建议补货策略。
 * - D58 四档 tier（S/A/B/C）：rules/abc.classifyTier，切点 sys_params grade_s/a/b_pct（缺省 50/80/95）；
 *   同一 6 月窗口、同一 value（销量件数）；abc 三档保持既有输出不变（不变量 tierToAbc(tier)===abc）。
 * - D59 权责 ownership：rules/replenish-ownership.decideOwnership（tier × 规则层 xyz（null 不假装 Z）×
 *   异动命中（planning/detector-hits）× 交期主数据已知（sku_params 加工+在途周期均已维护））。
 * - W12 金额口径并列列 valueTier：同一窗口、同一切点，但 value = 近 6 月销量 × 单位成本
 *   （core/valuation.resolveUnitCosts 唯一权威：sku_costs → 财务运营成本观察 → 无）。
 *   **纯对照，不改任何行为**：`tier` 仍是数量口径，权责/目标/预警筛选/固化策略全部继续读 `tier`；
 *   开关 sys_params `tier_basis`（qty|value，缺省 qty）只决定页面把哪一列标为「主口径」，
 *   不改变 `tier` 的取值，也不 repoint 任何消费者（要切换须另立 D 号并逐个消费者复核）。
 *   成本覆盖率（按销量加权）低于 sys_params `valuation_coverage_min_pct`（缺省 80）时，
 *   金额列一律 `insufficient`（valueTier=null），**绝不降级成某个等级**。
 * 全表无金额字段（金额只在内部用于排名，输出只有等级/覆盖率/占比），免脱敏；只读不写库。
 */
import { inArray, eq, sql } from "drizzle-orm";
import { loadExternalVelocitySafe } from "@/server/modules/report/external-velocity";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { lastMonths } from "@/server/core/velocity";
import { classifyAbc, classifyTier, tierBasisAgreementMatrix, tierDistribution, type Tier, type TierBasisAgreementMatrix, type TierCuts, DEFAULT_TIER_CUTS } from "@/server/rules/abc";
import { classifyXyz, type XyzClass } from "@/server/rules/volatility";
import { decideOwnership, type Ownership } from "@/server/rules/replenish-ownership";
import { getNumParam, getTextParam } from "@/server/core/params";
import { resolveUnitCosts } from "@/server/core/valuation";
import { dMul } from "@/server/core/decimal";
import { loadDetectorHitSkuIds } from "@/server/modules/planning/detector-hits";
import { num, r1 } from "@/server/core/svc";
import { salesWindow } from "@/server/core/sales-window";
import { participatesInNormalSalesMovement } from "@/server/rules/sku-standardization";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const r2 = (v: number): number => Math.round(v * 100) / 100;

export const SEG_CELLS = ["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"] as const;
export type SegCell = (typeof SEG_CELLS)[number];

/** 9 格建议补货策略（中文，只读建议） */
export const SEG_POLICY: Record<SegCell, string> = {
  AX: "高频精准补货·低安全库存（定期定量，优先保供）",
  AY: "核心且有波动·适度安全库存+滚动预测复核",
  AZ: "高价值波动大·加大安全库存+紧盯需求/缩短周期",
  BX: "稳定中值·经济批量补货，常规安全库存",
  BY: "中值波动·常规安全库存+定期复核订货量",
  BZ: "中值波动大·谨慎备货+缩短补货周期防积压",
  CX: "低值稳定·可批量低频补货，压库存成本",
  CY: "低值波动·按需补货，控制在库天数",
  CZ: "长尾波动·按需/停采评估，避免呆滞",
};

export interface SegRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  sales6m: number;
  avgMonthly: number;
  cv: number;
  abc: "A" | "B" | "C";
  xyz: "X" | "Y" | "Z";
  cell: SegCell;
  /** 外部观察（简道云天猫）近 90 天净需求：影子列，看内部 ABC 是否已与平台实际销量漂移；未映射 = null */
  externalNet90: string | null;
  /** D58 四档分层（S/A/B/C，参数化切点） */
  tier: Tier;
  /** 规则层 XYZ：null = 样本不足/无动销（xyz 列按历史口径记为 Z） */
  xyzRaw: XyzClass | null;
  /** D59 补货权责 */
  ownership: Ownership;
  ownershipReason: string;
  /** 异动侦测命中（report/detectors，任一规则） */
  detectorHit: boolean;
  /** sku_params 加工周期 >0 且在途周期已维护 */
  leadDaysKnown: boolean;
  /**
   * W12 金额口径并列分层（近 6 月销量 × 单位成本）。
   * null = `insufficient`：成本覆盖率不足门槛，或本 SKU 无单位成本——**不得当作 C 级读**。
   * 只用于对照，任何消费者（权责/目标/预警筛选/固化策略）都必须继续读 `tier`。
   */
  valueTier: Tier | null;
  /** 单位成本来源：sku_costs / finance_observation / null（无成本） */
  unitCostSource: "sku_costs" | "finance_observation" | null;
}

export interface SegMatrixCell {
  count: number;
  /** 该格销量占近6月总销量的百分比（1dp） */
  salesShare: number;
}

export interface SegmentationResult {
  months: string[];
  rows: SegRow[];
  total: number;
  matrix: Record<SegCell, SegMatrixCell>;
  policy: Record<SegCell, string>;
  /** 规则层 xyz=null（无动销/样本不足）而按历史口径记为 Z 的 SKU 数 */
  xyzUnclassified: number;
  /** D58 生效切点（sys_params） */
  tierCuts: TierCuts;
  /** 四档分布（全量，不受筛选影响）：SKU 数 / 销量合计 / 销量占比 */
  tierDistribution: Record<Tier, { count: number; value: number; valueSharePct: number }>;
  /** 权责分布（全量） */
  ownershipMix: Record<Ownership, number>;
  /** W12 声明的分层口径开关（sys_params tier_basis）；缺省/非法 = qty */
  tierBasis: TierBasis;
  /**
   * **实际驱动 `tier` 的口径恒为 qty**：本次只并列对照，不 repoint 任何消费者。
   * tierBasis=value 时页面把金额列标为「主口径（对照）」，但 `tier` 字段不变。
   */
  tierBasisApplied: "qty";
  /** 金额口径成本覆盖（按近 6 月销量加权，与 D51 估值覆盖率同族口径） */
  costCoverage: {
    skus: number;
    skusWithCost: number;
    /** 有成本 SKU 数占比 %（1dp） */
    skuPct: number | null;
    /** 有成本 SKU 的近 6 月销量占总销量 %（1dp）——门槛判定用的就是它 */
    salesWeightedPct: number | null;
    /** sys_params valuation_coverage_min_pct（缺省 80） */
    minPct: number;
    /** ready = 金额列可用；insufficient = 覆盖率不足，全表金额列为 null */
    state: "ready" | "insufficient";
    /** 覆盖不足时的说明（ready 时为 null） */
    reason: string | null;
  };
  /** 金额口径四档分布（仅计数与占比，不含金额；insufficient 时全 0） */
  valueTierDistribution: Record<Tier, { count: number }>;
  /** W12 迁移矩阵：数量口径 tier × 金额口径 valueTier（全量，不受筛选影响） */
  tierMigration: TierBasisAgreementMatrix;
  /** 本次口径的已知局限（页面必须原样展示） */
  valueTierLimitations: string[];
}

/**
 * CV/XYZ 走共享规则 rules/volatility（唯一权威）。看板数值保持不变：
 * 规则返回 null（样本 <6 点或无动销）时沿用旧展示口径 cv=0、xyz=Z，并由 xyzUnclassified 单独计数。
 */
function xyzOf(quantities: number[]): { cv: number; xyz: "X" | "Y" | "Z"; raw: XyzClass | null; unclassified: boolean } {
  const r = classifyXyz({ series: quantities, cuts: [0.5, 1.0], minPoints: 6 });
  return { cv: r.cv ?? 0, xyz: r.xyz ?? "Z", raw: r.xyz, unclassified: r.xyz == null };
}

const emptyTierDist = (): SegmentationResult["tierDistribution"] => ({
  S: { count: 0, value: 0, valueSharePct: 0 },
  A: { count: 0, value: 0, valueSharePct: 0 },
  B: { count: 0, value: 0, valueSharePct: 0 },
  C: { count: 0, value: 0, valueSharePct: 0 },
});
const emptyOwnershipMix = (): Record<Ownership, number> => ({ supply_chain_direct: 0, joint_review: 0, ops_fallback: 0 });

/** W12 分层口径开关取值 */
export type TierBasis = "qty" | "value";
export const DEFAULT_TIER_BASIS: TierBasis = "qty";

const emptyValueTierDist = (): Record<Tier, { count: number }> => ({ S: { count: 0 }, A: { count: 0 }, B: { count: 0 }, C: { count: 0 } });

/**
 * W12 局限（页面与读模型都必须带着走）：金额列不是「更好的分层」，只是另一把尺；
 * 在业务确认并另立 D 号之前，任何规则都不许改读它。
 */
export const VALUE_TIER_LIMITATIONS: readonly string[] = Object.freeze([
  "金额口径 = 近 6 月销量 × 单位成本（core/valuation：sku_costs 优先，其次财务运营成本观察），是**成本口径**而非售价/毛利口径——它回答「占用多少采购金额」，不回答「赚多少钱」。",
  "本次只并列对照，**不 repoint 任何消费者**：权责（rules/replenish-ownership）、目标覆盖天数、预警筛选、月度分层固化（sku_planning_policy）全部继续读数量口径 tier。切换须另立 D 号并逐个消费者复核。",
  "成本覆盖率按近 6 月销量加权；低于门槛时金额列一律 insufficient，绝不降级成某个等级（把「不知道」写成 C 会直接误导长尾判定）。",
  "财务运营成本观察是 observation_only 的月度成本，随批次变动；同一 SKU 在不同月份可能有不同成本，本口径取最新可用月，不做加权平均。",
  "无销量（sales6m=0）的 SKU 在两套口径下都恒为 C，不因成本高低上移。",
]);

/** W12 开关：sys_params tier_basis（qty|value）；非法值回落 qty，绝不让脏值改变口径 */
export async function loadTierBasis(db: AnyDb): Promise<TierBasis> {
  const raw = (await getTextParam("tier_basis", DEFAULT_TIER_BASIS, db)).trim().toLowerCase();
  return raw === "value" ? "value" : DEFAULT_TIER_BASIS;
}

/** D58 切点：sys_params grade_s/a/b_pct；非法（非递增）时回落缺省并由 rules/abc 断言兜底 */
export async function loadTierCuts(db: AnyDb): Promise<TierCuts> {
  const [sPct, aPct, bPct] = await Promise.all([
    getNumParam("grade_s_pct", DEFAULT_TIER_CUTS.sPct, db),
    getNumParam("grade_a_pct", DEFAULT_TIER_CUTS.aPct, db),
    getNumParam("grade_b_pct", DEFAULT_TIER_CUTS.bPct, db),
  ]);
  const ok = sPct > 0 && sPct < aPct && aPct < bPct && bPct <= 100;
  return ok ? { sPct, aPct, bPct } : { ...DEFAULT_TIER_CUTS };
}

export async function getSegmentation(
  query: {
    q?: string;
    cell?: string;
    /** D58 四档筛选 */
    tier?: string;
    /** D59 权责筛选 */
    ownership?: string;
    page?: number;
    pageSize?: number;
    allRows?: boolean;
  },
  dbArg?: AnyDb,
): Promise<SegmentationResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const externalVelocity = await loadExternalVelocitySafe(db);
  const tierCuts = await loadTierCuts(db);
  const tierBasis = await loadTierBasis(db);
  const coverageMinPct = await getNumParam("valuation_coverage_min_pct", 80, db);
  const page = Math.max(1, query.page ?? 1);
  // allRows：内部消费者（自动补货候选等）取全量，防静默截断；HTTP 层永不传 true
  const pageSize = query.allRows ? Number.MAX_SAFE_INTEGER : Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();
  const cellFilter = (query.cell ?? "").trim().toUpperCase();
  const tierFilter = (query.tier ?? "").trim().toUpperCase();
  const ownershipFilter = (query.ownership ?? "").trim();

  const emptyMatrix = (): Record<SegCell, SegMatrixCell> =>
    Object.fromEntries(SEG_CELLS.map((c) => [c, { count: 0, salesShare: 0 }])) as Record<SegCell, SegMatrixCell>;

  /* ── 近 6 月窗口（自 max(yearMonth) 回推） ── */
  const sm = schema.salesMonthly;
  const { maxYm } = await salesWindow(db);
  const months = maxYm ? lastMonths(maxYm, 6) : [];

  /* ── 成品主档（finished + active，且排除非销售用途——口径同驾驶舱/风险页） ── */
  const skuRowsRaw: { id: number; code: string; name: string; brand: string | null; commercialRole: string }[] = await db
    .select({
      id: schema.skus.id, code: schema.skus.code, name: schema.skus.name,
      brand: schema.brands.nameCn, commercialRole: schema.skus.commercialRole,
    })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(sql`${schema.skus.active} = true and ${schema.skus.skuType} = 'finished'`);
  // 样品/赠品/试用/内用不参与按销量的帕累托分层，否则会把"从来不卖"的品算成 C 类拖低基数。
  // 判定走共享规则，禁止在此本地重实现（口径漂移根因）。
  const skuRows = skuRowsRaw.filter((r) => participatesInNormalSalesMovement(r.commercialRole));
  if (skuRows.length === 0) {
    return {
      months, rows: [], total: 0, matrix: emptyMatrix(), policy: SEG_POLICY, xyzUnclassified: 0,
      tierCuts, tierDistribution: emptyTierDist(), ownershipMix: emptyOwnershipMix(),
      tierBasis, tierBasisApplied: "qty",
      costCoverage: { skus: 0, skusWithCost: 0, skuPct: null, salesWeightedPct: null, minPct: coverageMinPct, state: "insufficient", reason: "没有参与分层的成品 SKU" },
      valueTierDistribution: emptyValueTierDist(),
      tierMigration: tierBasisAgreementMatrix([]),
      valueTierLimitations: [...VALUE_TIER_LIMITATIONS],
    };
  }
  const skuIds = skuRows.map((s) => s.id);

  /* ── D59 权责输入：异动命中集合（唯一实现 report/detectors）+ 交期主数据是否已知（sku_params） ── */
  const detectorHits = await loadDetectorHitSkuIds(db);
  const leadRows: { skuId: number; normalLeadDays: number | null; logisticsLeadDays: number | null }[] = await db
    .select({ skuId: schema.skuParams.skuId, normalLeadDays: schema.skuParams.normalLeadDays, logisticsLeadDays: schema.skuParams.logisticsLeadDays })
    .from(schema.skuParams)
    .where(inArray(schema.skuParams.skuId, skuIds));
  const leadKnown = new Set<number>(
    leadRows.filter((r) => num(r.normalLeadDays) > 0 && r.logisticsLeadDays != null).map((r) => r.skuId),
  );

  /* ── 近6月逐 SKU×月 销量（跨渠道汇总） ── */
  const salesRows: { skuId: number; ym: string; qty: string | null }[] = months.length
    ? await db
        .select({ skuId: sm.skuId, ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
        .from(sm)
        .where(inArray(sm.yearMonth, months))
        .groupBy(sm.skuId, sm.yearMonth)
    : [];
  const qtyBySku = new Map<number, Map<string, number>>();
  for (const r of salesRows) {
    let m = qtyBySku.get(r.skuId);
    if (!m) { m = new Map(); qtyBySku.set(r.skuId, m); }
    m.set(r.ym, num(r.qty));
  }

  /* ── 逐 SKU 组装 6 月量、总量、均值、CV、XYZ ── */
  const interims: SegRow[] = [];
  let totalSales = 0;
  let xyzUnclassified = 0;
  for (const sku of skuRows) {
    const m = qtyBySku.get(sku.id);
    const quantities = months.map((ym) => (m ? m.get(ym) ?? 0 : 0));
    const sales6m = quantities.reduce((a, b) => a + b, 0);
    const mean = months.length ? sales6m / months.length : 0;
    totalSales += sales6m;
    const vol = xyzOf(quantities);
    if (vol.unclassified) xyzUnclassified += 1;
    interims.push({
      skuId: sku.id,
      code: sku.code,
      name: sku.name,
      brand: sku.brand,
      sales6m: r2(sales6m),
      avgMonthly: r2(mean),
      cv: r2(vol.cv),
      abc: "C",
      xyz: vol.xyz,
      cell: "CZ",
      externalNet90: externalVelocity.bySku[String(sku.id)]?.net90 ?? null,
      tier: "C",
      xyzRaw: vol.raw,
      ownership: "ops_fallback",
      ownershipReason: "",
      detectorHit: detectorHits.has(sku.id),
      leadDaysKnown: leadKnown.has(sku.id),
      valueTier: null,
      unitCostSource: null,
    });
  }

  /* ── ABC：按 6 月总销量降序累计占比切分（80% / 95%） ── */
  interims.sort((a, b) => b.sales6m - a.sales6m);
  const abcByKey = classifyAbc(interims.map((it, i) => ({ id: i, qty: it.sales6m })));
  /* ── D58 四档：同窗口同 value，参数化切点（唯一权威 rules/abc.classifyTier）；D59 权责逐行判定 ── */
  const tierByKey = classifyTier(interims.map((it, i) => ({ id: i, value: it.sales6m })), tierCuts);
  const ownershipMix = emptyOwnershipMix();
  for (const [i, it] of interims.entries()) {
    it.abc = abcByKey.get(i) ?? "C";
    it.cell = `${it.abc}${it.xyz}` as SegCell;
    it.tier = tierByKey.get(i) ?? "C";
    const own = decideOwnership({ tier: it.tier, xyz: it.xyzRaw, detectorHit: it.detectorHit, leadDaysKnown: it.leadDaysKnown });
    it.ownership = own.ownership;
    it.ownershipReason = own.reason;
    ownershipMix[own.ownership] += 1;
  }
  const tierDist = tierDistribution(interims.map((it, i) => ({ id: i, value: it.sales6m })), tierCuts);

  /* ────────────────────────────────────────────────────────────────────────
   * W12 金额口径并列列：value = 近 6 月销量 × 单位成本。
   * 金额一律走 decimal 字符串（禁 float 运算）；classifyTier 只需要一个用于**排名**的数，
   * 故最后一步才把 decimal 转成 number 排序，金额本身不进读模型输出。
   * ──────────────────────────────────────────────────────────────────────── */
  const costs = await resolveUnitCosts(db, skuIds);
  let costedSales = 0;
  let skusWithCost = 0;
  const valueByKey: { id: number; value: number }[] = [];
  for (const [i, it] of interims.entries()) {
    const cost = costs.get(it.skuId) ?? null;
    it.unitCostSource = cost?.source ?? null;
    const unitCost = cost?.unitCost ?? null;
    if (unitCost != null) {
      skusWithCost += 1;
      costedSales += it.sales6m;
      valueByKey.push({ id: i, value: Number(dMul(String(it.sales6m), unitCost, 2)) });
    } else {
      // 无成本 → 金额值为 0：排名上恒 C，但下面覆盖率不足时整列会被置为 insufficient
      valueByKey.push({ id: i, value: 0 });
    }
  }
  const salesWeightedPct = totalSales > 0 ? r1((costedSales / totalSales) * 100) : null;
  const skuPct = interims.length > 0 ? r1((skusWithCost / interims.length) * 100) : null;
  const coverageOk = salesWeightedPct != null && salesWeightedPct >= coverageMinPct;
  const valueTierDist = emptyValueTierDist();
  if (coverageOk) {
    const valueTierByKey = classifyTier(valueByKey, tierCuts);
    for (const [i, it] of interims.entries()) {
      // 无成本的行即使覆盖率达标也不能编一个等级出来——它自己就是「不知道」
      it.valueTier = it.unitCostSource == null ? null : valueTierByKey.get(i) ?? "C";
      if (it.valueTier) valueTierDist[it.valueTier].count += 1;
    }
  }
  const costCoverage: SegmentationResult["costCoverage"] = {
    skus: interims.length,
    skusWithCost,
    skuPct,
    salesWeightedPct,
    minPct: coverageMinPct,
    state: coverageOk ? "ready" : "insufficient",
    reason: coverageOk
      ? null
      : `成本覆盖率（按销量加权）${salesWeightedPct ?? 0}% < 门槛 ${coverageMinPct}%（valuation_coverage_min_pct）：金额口径分层不可用，整列显示 insufficient，不降级为等级。`,
  };
  const tierMigration = tierBasisAgreementMatrix(interims.map((it) => ({ qtyTier: it.tier, valueTier: it.valueTier })));

  /* ── 矩阵汇总（全量，不受筛选影响） ── */
  const matrix = emptyMatrix();
  for (const it of interims) {
    const c = matrix[it.cell];
    c.count += 1;
    c.salesShare += it.sales6m;
  }
  for (const c of SEG_CELLS) {
    matrix[c].salesShare = totalSales > 0 ? r1((matrix[c].salesShare / totalSales) * 100) : 0;
  }

  /* ── 筛选/排序/分页 ── */
  let filtered = interims;
  if (cellFilter) filtered = filtered.filter((r) => r.cell === cellFilter);
  if (tierFilter) filtered = filtered.filter((r) => r.tier === tierFilter);
  if (ownershipFilter) filtered = filtered.filter((r) => r.ownership === ownershipFilter);
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  filtered.sort((a, b) => b.sales6m - a.sales6m);
  return {
    months,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    matrix,
    policy: SEG_POLICY,
    xyzUnclassified,
    tierCuts,
    tierDistribution: tierDist,
    ownershipMix,
    tierBasis,
    // 恒 qty：W12 只并列对照，开关不改变 tier 的取值，也不 repoint 任何消费者
    tierBasisApplied: "qty",
    costCoverage,
    valueTierDistribution: valueTierDist,
    tierMigration,
    valueTierLimitations: [...VALUE_TIER_LIMITATIONS],
  };
}
