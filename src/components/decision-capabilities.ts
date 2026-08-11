export type CapabilityReadiness = "ready" | "partial" | "blocked";

export interface DecisionCapability {
  id: string;
  title: string;
  decision: string;
  owner: string;
  proven: string[];
  required: string[];
  nextAction: string;
}

/**
 * Advanced decision capabilities are intentionally expressed as evidence contracts.
 * A capability is never presented as available merely because a chart can be drawn.
 */
export const DECISION_CAPABILITIES: DecisionCapability[] = [
  {
    id: "inventory-execution",
    title: "库存与委外执行",
    decision: "哪些 SKU 会缺货、哪些加工厂必须催交、现有管道能否覆盖风险窗口？",
    owner: "PMC / 采购",
    proven: ["库存账与受控快照", "PO/JG/收货执行事实", "月销量与补货推演"],
    required: ["库存账与受控快照", "PO/JG/收货执行事实", "月销量与补货推演"],
    nextAction: "持续修复仓库映射与来源不明库存，并按覆盖率解释结果。",
  },
  {
    id: "supplier-quality",
    title: "供应商交付与质量",
    decision: "应优先整改或替换哪些供应商，质量与交付风险集中在哪里？",
    owner: "采购 / 品质",
    proven: ["检验判定与数量", "承诺交期", "收货事实"],
    required: ["检验判定与数量", "承诺交期", "收货事实", "供应商纠正措施与关闭日期"],
    nextAction: "将供应商纠正措施、责任人和关闭日期纳入闭环，避免只有排名没有行动。",
  },
  {
    id: "batch-genealogy",
    title: "批次谱系与 FEFO",
    decision: "风险批次流向了哪里，召回范围多大，哪个批次应先出？",
    owner: "仓储 / 品质",
    proven: ["收货行可绑定批次", "库存事件支持批次维度", "批次效期字段"],
    required: ["收货行可绑定批次", "库存事件支持批次维度", "批次效期字段", "期初库存批次补录", "所有出库按批次分配"],
    nextAction: "先补齐期初与快照库存的批次/效期，再以无批次事件数作为上线门禁。",
  },
  {
    id: "forecast-control",
    title: "预测学习与例外控制",
    decision: "哪些 SKU 的预测存在系统性偏差，哪些例外值得计划员介入？",
    owner: "PMC / 业务",
    proven: ["月度销量历史", "预测版本与实际对比", "WAPE/Bias 口径"],
    required: ["月度销量历史", "预测版本与实际对比", "WAPE/Bias 口径", "促销与断货标记", "稳定的预测冻结时点"],
    nextAction: "记录促销、断货和冻结版本；否则只能识别误差，不能解释误差来源。",
  },
  {
    id: "daily-demand",
    title: "日级需求、促销与断货归因",
    decision: "需求变化来自自然增长、促销还是断货，未来 7–28 天应如何调配？",
    owner: "电商 / 数据",
    proven: ["月度渠道销量"],
    required: ["月度渠道销量", "日级订单与退款", "活动日历与折扣", "缺货时段", "渠道可售库存"],
    nextAction: "按 SKU×渠道×日接入订单、退款、活动与缺货事实，并保留原始来源时间戳。",
  },
  {
    id: "external-demand-observation",
    title: "简道云外部需求观察",
    decision: "在不污染正式销量的前提下，哪些天猫需求变化和未映射 SKU 最值得先处理？",
    owner: "电商 / 数据 / PMC",
    proven: [
      "简道云日级支付与退款最新批次",
      "平台 SKU 身份覆盖与未映射优先队列",
      "来源截止日、非法行和观察权限披露",
    ],
    required: [
      "简道云日级支付与退款最新批次",
      "平台 SKU 身份覆盖与未映射优先队列",
      "来源截止日、非法行和观察权限披露",
      "平台导出控制总量与业务 UAT",
    ],
    nextAction: "先处理高支付件数的 Q1 可认领队列，同时在源端补齐 Q2 缺条码对照；再用同截止日平台导出完成总量 UAT。",
  },
  {
    id: "unit-economics",
    title: "收入、毛利与营运资金",
    decision: "增长是否创造利润，库存和付款条件占用了多少现金？",
    owner: "财务 / 业务",
    proven: ["手工单位成本", "供应商付款条件"],
    required: ["手工单位成本", "供应商付款条件", "净销售收入", "平台费用与退款", "应收应付实际日期"],
    nextAction: "确认财务口径 D2，并接入净售价、平台费用、退款及应收应付事实；缺售价时毛利必须留白。",
  },
  {
    id: "npd-learning",
    title: "新品上市学习闭环",
    decision: "哪些项目模式更容易按期且成功上市，下一代新品应复用或避免什么？",
    owner: "产品 / 业务 / PMC",
    proven: ["项目计划", "69 节点任务", "节点完成与逾期"],
    required: ["项目计划", "69 节点任务", "节点完成与逾期", "正式上市日与首发渠道", "上市后销量/毛利/退货与复盘标签"],
    nextAction: "建立上市里程碑和 30/60/90 天复盘事实，把交付进度与商业结果分开评价。",
  },
  {
    id: "enterprise-integrations",
    title: "企业系统自动对接",
    decision: "当前结论是否基于及时、完整、可追溯的数据，而不是过期文件？",
    owner: "IT / 数据",
    proven: ["受控文件导入与放行", "连接器契约与就绪状态"],
    required: ["受控文件导入与放行", "连接器契约与就绪状态", "聚水潭库存/销量接口", "用友财务/成本接口", "源系统 SLA 与失败补偿"],
    nextAction: "由 IT 提供凭据、租户和字段契约；先并行核对，再逐源切换并保留回滚。",
  },
  {
    id: "three-system-reconciliation",
    title: "简道云 × 聚水潭 × 用友三角对账",
    decision: "业务观察、实际履约与财务确认的差异在哪里，由谁说明并关闭？",
    owner: "数据 / 电商 / 仓储 / 财务",
    proven: ["简道云受控 observation staging"],
    required: [
      "简道云受控 observation staging",
      "聚水潭订单、出库、退货与库存只读 UAT",
      "用友组织、采购、库存、成本与凭证只读 UAT",
      "SKU、店铺、仓库、供应商和组织统一身份",
      "同时间窗、同单位、同状态的三方控制总量",
    ],
    nextAction: "聚水潭先解锁固定出口 IP 和只读 API，用友先授权 8 条白名单契约并读取 tenant/org；两边都完成小窗 UAT 后再开三角差异队列。",
  },
];

export function capabilityReadiness(capability: DecisionCapability): CapabilityReadiness {
  if (capability.proven.length === 0) return "blocked";
  if (capability.proven.length >= capability.required.length) return "ready";
  return "partial";
}
