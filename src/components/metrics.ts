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
  externalNetDemand: {
    id: "externalNetDemand",
    label: "外部净需求信号",
    short: "简道云最新成功批次中，天猫支付件数扣除成功退款件数后的观察需求",
    formula: "Σ支付件数 − Σ成功退款件数（销量、退款、SKU 对照各取最新成功批次）",
    unit: "qty",
    tier: "registry",
    caveat: "这是 observation-only 经营信号，未映射平台 SKU 不得归属系统 SKU；在身份覆盖、控制总量和 UAT 通过前，不得作为正式销量、补货或财务口径",
  },
  salesConcentration: {
    id: "salesConcentration",
    label: "销量集中度",
    short: "最新月累计贡献达到 80% 所需的品牌、渠道或 SKU 数",
    formula: "按销量降序累计，取累计占比首次达到 80% 的成员数",
    unit: "count",
    tier: "derived",
    caveat: "集中度只描述结构，不直接代表风险；还需结合替代性、渠道战略和利润判断",
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
  qcPassRate: {
    id: "qcPassRate",
    label: "检验合格率",
    short: "已判定检验数量中正常合格的比例",
    formula: "正常合格数量 ÷（合格 + 返工 + 让步 + 报废）",
    unit: "pct",
    tier: "derived",
    caveat: "未检验与待判定数量不进入分母；必须同时查看待判定积压，避免幸存者偏差",
  },
  flowStageQty: {
    id: "flowStageQty",
    label: "全链阶段量级",
    short: "需求、计划、下单、到货与动销各阶段在当前窗口内的数量规模",
    unit: "qty",
    tier: "derived",
    caveat: "各阶段事实粒度和时间窗不同，只用于定位落差，不是严格转化或损耗率",
  },
  npdProgress: {
    id: "npdProgress",
    label: "新品组合进度",
    short: "进行中新品项目已完成的标准节点任务比例",
    formula: "Σ已完成节点 ÷ Σ已实例化节点",
    unit: "pct",
    tier: "ledger",
    caveat: "计划进度不等于商业成功；上市后销量、毛利、退货与复盘结论需单独接入",
  },
  wipPendingQty: {
    id: "wipPendingQty",
    label: "委外待收数量",
    short: "委外订单尚未通过正常收货行入库的剩余数量",
    formula: "Σ max(JG订单数量−正常行累计实收, 0)",
    unit: "qty",
    tier: "ledger",
    caveat: "跨 SKU 合计可能混合件、箱、kg 等基础单位，仅用于催交排序，不可视为统一产能",
  },
  platformIdentityCoverage: {
    id: "platformIdentityCoverage",
    label: "平台身份覆盖率",
    short: "平台唯一商品身份中已精确映射到系统 SKU 的比例",
    formula: "已精确映射的平台唯一身份 ÷ 平台唯一身份总数",
    unit: "pct",
    tier: "derived",
    caveat: "按平台自己的业务键分别计算，禁止跨平台直接去重或用名称模糊认领",
  },
  identityConflictCount: {
    id: "identityConflictCount",
    label: "身份冲突数",
    short: "同一来源作用域内指向多个条码或系统 SKU 的身份数量",
    formula: "count(distinct 来源scope + 类型 + 原始值 where 精确候选数 > 1)",
    unit: "count",
    tier: "registry",
    caveat: "冲突必须人工裁决；不能以销量、名称相似度或最近一次出现自动覆盖",
  },
  refundRate: {
    id: "refundRate",
    label: "成功退款率",
    short: "成功退款件数相对于支付件数的比例",
    formula: "Σ成功退款件数 ÷ Σ支付件数（同业务日、店铺与身份口径）",
    unit: "pct",
    tier: "derived",
    caveat: "退款申请、成功退款和退货入库不是同一事件；必须固定状态与观察窗口",
  },
  mappedDemandCoverage: {
    id: "mappedDemandCoverage",
    label: "已映射需求覆盖率",
    short: "可精确归属系统 SKU 的外部净需求占全部外部净需求的比例",
    formula: "已映射平台身份净需求 ÷ 全部平台身份净需求",
    unit: "pct",
    tier: "derived",
    caveat: "覆盖不足时不得把未映射需求当作零，也不得按名称摊给相似 SKU",
  },
  orderFulfillmentRate: {
    id: "orderFulfillmentRate",
    label: "订单履约率",
    short: "订单需求中已由有效出库事实履约的比例",
    formula: "有效出库数量 ÷ 有效订单数量（扣除取消并按退货口径单列）",
    unit: "pct",
    tier: "derived",
    caveat: "创建订单、平台发货和仓库出库时间不同，必须明确履约事件与截止日",
  },
  cashConversionDays: {
    id: "cashConversionDays",
    label: "订单到现金天数",
    short: "订单确认到对应回款或结算确认的平均业务天数",
    formula: "avg(回款/结算确认日 − 订单确认日)，仅含链路已对齐样本",
    unit: "days",
    tier: "derived",
    caveat: "未匹配订单不得从分母消失；应同时显示链路覆盖率和未收款尾部",
  },
  unreconciledOrderCount: {
    id: "unreconciledOrderCount",
    label: "未对账订单数",
    short: "无法完整连接订单、履约、退款与财务结算证据的订单数量",
    formula: "count(distinct 来源订单 where 任一必需链路缺失或金额超阈差异)",
    unit: "count",
    tier: "derived",
    caveat: "缺链路表示未知或待处理，不等同于漏单、坏账或平台错误",
  },
  inventoryReconciliationGap: {
    id: "inventoryReconciliationGap",
    label: "库存核对差异",
    short: "同一截止时点、仓库和 SKU 下各系统库存与 SCM 事实的差额",
    formula: "外部库存 − SCM 库存（按来源逐边显示，不互相抵销）",
    unit: "qty",
    tier: "derived",
    caveat: "跨 SKU 合计混合计量单位；缺仓、缺映射和不同截止日必须单列为未知",
  },
  openSupplyQty: {
    id: "openSupplyQty",
    label: "未结供给量",
    short: "已批准供应单据尚未由正常收货事实结清的数量",
    formula: "Σ max(批准数量 − 正常累计实收 − 已关闭数量, 0)",
    unit: "qty",
    tier: "ledger",
    caveat: "单据状态、单位和取消/红冲必须对齐；跨 SKU 合计只用于队列规模",
  },
  promiseReliability: {
    id: "promiseReliability",
    label: "承诺可信度",
    short: "有承诺日期的供应单行中按承诺数量和日期兑现的比例",
    formula: "按期足量完成的供应单行 ÷ 有有效承诺日的已到期供应单行",
    unit: "pct",
    tier: "derived",
    caveat: "未来未到期单行不进入分母；改期必须保留原承诺和变更审计",
  },
  netRevenue: {
    id: "netRevenue",
    label: "净收入",
    short: "销售收入扣除成功退款、折让和明确归属平台费用后的金额",
    formula: "销售收入 − 成功退款 − 折让 − 可归属平台费用",
    unit: "money",
    tier: "derived",
    caveat: "未关账、费用覆盖不足或币种未统一时只能作为观察值",
  },
  contributionMarginRate: {
    id: "contributionMarginRate",
    label: "贡献毛利率",
    short: "净收入扣除商品成本和可变履约费用后保留的比例",
    formula: "(净收入 − 商品成本 − 可变履约费用) ÷ 净收入",
    unit: "pct",
    tier: "derived",
    caveat: "不能与会计毛利率混用；费用归属、期间和成本版本必须同时展示",
  },
  costCoverage: {
    id: "costCoverage",
    label: "成本覆盖率",
    short: "净收入样本中已取得同期间有效商品成本的比例",
    formula: "有有效成本的净收入 ÷ 全部净收入",
    unit: "pct",
    tier: "derived",
    caveat: "覆盖不足时不得把缺失成本当作零，毛利指标必须降级或留白",
  },
  supplierPriceVariance: {
    id: "supplierPriceVariance",
    label: "供应商价格偏差",
    short: "同物料同单位的实际采购价相对批准基准价的偏差",
    formula: "(实际含税/未税同口径价 − 批准基准价) ÷ 批准基准价",
    unit: "pct",
    tier: "derived",
    caveat: "币种、税制、单位、MOQ、账期和规格未对齐前不可横向排名",
  },
  launchOnTimeRate: {
    id: "launchOnTimeRate",
    label: "新品按时上市率",
    short: "在承诺上市日前完成强制里程碑并产生有效首销的新品比例",
    formula: "按时完成且按时首销的新品项目 ÷ 到期新品项目",
    unit: "pct",
    tier: "derived",
    caveat: "移动计划日期不能抹除原承诺；延期原因和批准记录必须保留",
  },
  first90DayAchievement: {
    id: "first90DayAchievement",
    label: "首销 90 天达成率",
    short: "新品上市后 90 天实际净需求相对获批上市假设的比例",
    formula: "上市后 90 天累计净需求 ÷ 获批 90 天目标",
    unit: "pct",
    tier: "derived",
    caveat: "目标版本、正式上市日、退款和断货天数必须同时展示",
  },
  triangulationExceptionCount: {
    id: "triangulationExceptionCount",
    label: "三角核对异常数",
    short: "简道云观察、聚水潭履约和用友财务三边无法在阈值内解释的差异数量",
    formula: "count(distinct 业务日 + 身份 + 差异类型 where 差异超阈或链路缺失)",
    unit: "count",
    tier: "derived",
    caveat: "异常只是待解释证据，不能自动推断哪一边错误或自动调平",
  },
  exceptionSlaRate: {
    id: "exceptionSlaRate",
    label: "异常 SLA 达成率",
    short: "需要处理的跨系统异常中在目标时限内完成解释和关闭的比例",
    formula: "SLA 内关闭的异常 ÷ 已到期异常",
    unit: "pct",
    tier: "derived",
    caveat: "关闭必须有原因、责任人和证据；批量关闭不能算作有效解决",
  },
  cashGap13Week: {
    id: "cashGap13Week",
    label: "13 周现金缺口",
    short: "滚动 13 周情景中最低可用现金相对安全下限的不足金额",
    formula: "max(安全现金下限 − minₜ₌₁…₁₃(期初现金 + Σᵗ₍w₌₁₎(周流入_w − 周流出_w)), 0)",
    unit: "money",
    tier: "derived",
    caveat: "情景不是资金指令；未关账实际、税费、账期和融资边界必须明确",
  },
  scenarioCoverage: {
    id: "scenarioCoverage",
    label: "情景输入覆盖率",
    short: "S&OP 情景所需销量、供给、库存、成本和现金输入中已通过门禁的比例",
    formula: "已放行必需输入数 ÷ 必需输入总数",
    unit: "pct",
    tier: "derived",
    caveat: "覆盖不足时必须显示缺口，不得用零或乐观默认值补齐情景",
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
