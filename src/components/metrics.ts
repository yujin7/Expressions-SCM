/**
 * E7-02 指标语义注册表（唯一权威）。
 *
 * 问题：同一指标在不同页面各自解释（或根本不解释），口径写在横幅里、tooltip 里、注释里，
 * 改一处漏三处。本表让每个指标**定义一次**：公式、口径层级、单位、格式化、常见误解。
 * 页面引用 id 取说明，横幅与 tooltip 自动生成。
 *
 * 与 components/dictionary.ts 的分工：
 * - dictionary = **词**（术语、状态、动作、口径命名）；
 * - metrics    = **数**（指标的公式与解释）。
 */
import { TIER, type TierKey } from "@/components/dictionary";

export type MetricUnit = "qty" | "days" | "pct" | "count" | "money" | "ratio";

export interface MetricDef {
  id: string;
  label: string;
  /** 一句话说明——用户能懂的话，不用行话 */
  short: string;
  /** 公式（给愿意深究的人） */
  formula?: string;
  unit: MetricUnit;
  tier: TierKey;
  /** 常见误解/边界——最容易被误读的地方 */
  caveat?: string;
}

export const METRICS: Record<string, MetricDef> = {
  activeSkuSpu: {
    id: "activeSkuSpu",
    label: "在用 SKU / SPU",
    short: "当前启用的可经营 SKU 数与产品 SPU 数",
    formula: "启用 SKU 数 / SPU 主数据总数",
    unit: "count",
    tier: "ledger",
    caveat: "主数据规模不是经营绩效；应结合动销与生命周期判断组合健康度",
  },
  salesQty: {
    id: "salesQty",
    label: "全渠道销量",
    short: "已导入销售事实在所选窗口内的数量合计",
    formula: "Σ销售月事实.qty",
    unit: "qty",
    tier: "snapshot",
    caveat: "当前只有月粒度数量；没有日销、收入、客户、区域和促销维度",
  },
  onHandSystem: {
    id: "onHandSystem",
    label: "系统库存",
    short: "本系统所有仓的合计库存",
    formula: "Σ实时记账账 + 各快照仓最新快照",
    unit: "qty",
    tier: "ledger",
    caveat: "跨 SKU 相加时量纲混装（件/箱/kg），只作规模参考，不可当单一实物量",
  },
  onHandExternal: {
    id: "onHandExternal",
    label: "外部登记库存",
    short: "总库存明细文件口径（含海外/其他部门仓）",
    unit: "qty",
    tier: "registry",
    caveat: "系统未接管这些仓，数字来自文件、随文件时点老化——只作核对，绝不入账",
  },
  daysCover: {
    id: "daysCover",
    label: "可销天数",
    short: "按当前销速，现有库存还能卖多少天",
    formula: "系统库存 ÷ 近3月日均销（日均=近3月销量÷91）",
    unit: "days",
    tier: "derived",
    caveat: "无动销（日均=0）时无意义，显示为「无动销」而非 0 或 ∞",
  },
  coverFull: {
    id: "coverFull",
    label: "全管道可销天数",
    short: "算上在途与在制后还能卖多少天",
    formula: "（max(系统库存, 外部登记) + PO在途 + 在制 + 存量单 + 在订 − 借出未还） ÷ 日均销",
    unit: "days",
    tier: "derived",
    caveat: "含参考层数据，可信度低于系统口径；用于判断「是否真的缺」而非对账",
  },
  safetyQty: {
    id: "safetyQty",
    label: "安全库存",
    short: "为吸收需求与交期波动而应常备的量",
    formula: "z(服务水平) × √(交期 × 需求日标准差² + 日均² × 交期标准差²)",
    unit: "qty",
    tier: "derived",
    caveat: "样本<3个月或缺生产周期时降级为「兜底天数×日均」，界面会标注为兜底口径",
  },
  suggestQty: {
    id: "suggestQty",
    label: "建议补货量",
    short: "补到目标水位所需的量",
    formula: "逐日推演至首次跌破安全库存 → 补至（安全库存 + 目标覆盖天数需求）→ 施加 MOQ/订货倍数",
    unit: "qty",
    tier: "derived",
    caveat: "只在短缺落入生产周期内（来不及补）时才产生；生成的是草稿，仍走审批",
  },
  wape: {
    id: "wape",
    label: "预测误差 WAPE",
    short: "预测偏离实际的加权幅度，越小越准",
    formula: "Σ|预测−实际| ÷ Σ实际",
    unit: "ratio",
    tier: "derived",
    caveat: "比 MAPE 对零值稳健；电商稀疏序列应以此为准",
  },
  forecastBias: {
    id: "forecastBias",
    label: "预测偏差",
    short: "预测系统性偏高还是偏低",
    formula: "Σ(预测−实际) ÷ Σ实际",
    unit: "ratio",
    tier: "derived",
    caveat: "正=高估（备货偏多），负=低估（断货风险）；|偏差|≤10% 视为无系统性偏差",
  },
  turns: {
    id: "turns",
    label: "库存周转次数",
    short: "一年能把库存卖空几遍，越高越健康",
    formula: "窗口出库量 ÷ 平均库存 × (365 ÷ 窗口天数)",
    unit: "ratio",
    tier: "derived",
    caveat: "平均库存目前用当前在库近似（无每日库存历史），趋势可用、绝对值偏差需知悉",
  },
  dio: {
    id: "dio",
    label: "库存周转天数 DIO",
    short: "平均一件货在仓里待多久",
    formula: "365 ÷ 周转次数",
    unit: "days",
    tier: "derived",
  },
  adoptRate: {
    id: "adoptRate",
    label: "建议采纳率",
    short: "系统建议被批准进入执行的比例",
    formula: "（已审批+执行中+已完成的草稿）÷ 全部由建议生成的草稿",
    unit: "pct",
    tier: "derived",
    caveat: "采纳≠到货；要看货真落地请用「实际到货率」",
  },
  deliveredRate: {
    id: "deliveredRate",
    label: "实际到货率",
    short: "系统建议最终真有货入库的比例",
    formula: "下游 WO→JG→收货正常行实收>0 的草稿 ÷ 全部草稿",
    unit: "pct",
    tier: "ledger",
  },
  onTimeRate: {
    id: "onTimeRate",
    label: "供应商准时率",
    short: "供应商按承诺交期到货的比例",
    formula: "实际收货日 ≤ 承诺交期 的样本数 ÷ 有承诺交期的样本数",
    unit: "pct",
    tier: "derived",
    caveat: "实际收货以收货单建单时刻为准，仓库补录会使其偏晚",
  },
  expiryRiskQty: {
    id: "expiryRiskQty",
    label: "效期风险量（≤6月）",
    short: "剩余效期不超过 180 天的批次库存数量",
    formula: "Σ批次在库量，其中 过期日−口径日≤180天",
    unit: "qty",
    tier: "derived",
    caveat: "仅覆盖已维护批次与效期的库存；覆盖不足时不得外推到全部库存",
  },
  riskActionCount: {
    id: "riskActionCount",
    label: "风险处置 SKU",
    short: "风险库存工作台中需要负责人处理的 SKU 数",
    formula: "效期、货盘注记与销速规则命中的去重 SKU 数",
    unit: "count",
    tier: "derived",
    caveat: "命中表示需要判断，不代表系统已替人决定处置方式",
  },
  slowMoverCount: {
    id: "slowMoverCount",
    label: "滞销 SKU",
    short: "可销天数超过 180 天或当前无动销的 SKU 数",
    formula: "count(daysCover>180 或 日均销=0 且在库>0)",
    unit: "count",
    tier: "derived",
    caveat: "新品试销、季节品和停售品应按生命周期复核，不能只按阈值处置",
  },
  coverageSku: {
    id: "coverageSku",
    label: "库存覆盖 SKU",
    short: "系统库存与外部登记库存可进行同编码核对的 SKU 数",
    formula: "count(系统与外部登记均可映射的 SKU)",
    unit: "count",
    tier: "derived",
    caveat: "覆盖差异主要来自海外/其他部门仓与编码映射缺口，不能将未覆盖部分当作零",
  },
  finishedSkuCount: {
    id: "finishedSkuCount",
    label: "成品 SKU 数",
    short: "当前筛选范围内有库存或销售事实的在用成品 SKU 数",
    formula: "count(distinct SKU where skuType=finished and active=true)",
    unit: "count",
    tier: "ledger",
  },
  unknownOriginQty: {
    id: "unknownOriginQty",
    label: "来源不明库存",
    short: "当前在库超过可追溯历史入库流水的数量",
    formula: "max(当前在库−可追溯入库流水, 0)",
    unit: "qty",
    tier: "derived",
    caveat: "多为期初直接建账或无流水的快照仓；不能伪造入库日期，账龄按未知单列",
  },
  demandAchievement: {
    id: "demandAchievement",
    label: "需求达成率",
    short: "所选范围内销售达成量相对于登记需求量的比例",
    formula: "Σ销售达成 ÷ Σ登记需求",
    unit: "pct",
    tier: "derived",
    caveat: "当前来自月度登记文件，不是订单承诺或实时 sell-through；需求为 0 时显示数据不足",
  },
};

/** 取指标定义；未登记返回 undefined（调用方应回退到原文案） */
export function metric(id: string): MetricDef | undefined {
  return METRICS[id];
}

/** 生成 tooltip 文案：一句话 + 公式 + 口径层级 + 注意事项 */
export function metricTooltip(id: string): string {
  const m = METRICS[id];
  if (!m) return "";
  const lines = [m.short];
  if (m.formula) lines.push(`公式：${m.formula}`);
  lines.push(`口径：${TIER[m.tier].full}`);
  if (m.caveat) lines.push(`注意：${m.caveat}`);
  return lines.join("\n");
}
