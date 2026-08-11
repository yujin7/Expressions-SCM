/**
 * 三方数据产品目录：定义“要回答什么”和“什么时候才允许放行”。
 *
 * 这是目标契约，不是当前就绪清单。界面不得因为目录中有某产品，
 * 就宣称聚水潭或用友数据已经可用。当前就绪度仍以运行时连接器、身份、对账和 UAT 证据为准。
 */

export type DataProductSource = "SCM" | "JIANDAOYUN" | "JST" | "YONYOU";
export type DataProductAuthority = "observation" | "operational" | "financial";

export interface DataProductDefinition {
  id: string;
  title: string;
  decision: string;
  grain: string;
  owner: string;
  sources: DataProductSource[];
  targetAuthority: DataProductAuthority;
  releaseGate: string;
}

export const DATA_PRODUCT_SOURCE_LABEL: Record<DataProductSource, string> = {
  SCM: "SCM 受控事实",
  JIANDAOYUN: "简道云",
  JST: "聚水潭",
  YONYOU: "用友",
};

export const DATA_PRODUCT_AUTHORITY_LABEL: Record<DataProductAuthority, string> = {
  observation: "观察信号",
  operational: "运营事实",
  financial: "财务/关账",
};

export const DATA_PRODUCTS: DataProductDefinition[] = [
  {
    id: "demand-pulse",
    title: "需求脉搏",
    decision: "哪些 SKU/渠道是真增长、退款上升或履约落差？",
    grain: "日 × 店铺 × 平台 SKU",
    owner: "电商 / PMC",
    sources: ["JIANDAOYUN", "JST", "SCM"],
    targetAuthority: "operational",
    releaseGate: "身份覆盖、时间窗、退款状态与 JST 订单/出库总量对账",
  },
  {
    id: "order-to-cash",
    title: "订单到现金",
    decision: "销售、履约、开票、收款在哪个环节卡住？",
    grain: "来源订单 × 收款/凭证",
    owner: "财务 / 电商",
    sources: ["JST", "YONYOU", "SCM"],
    targetAuthority: "financial",
    releaseGate: "订单、退款、发票/凭证和收款一对一/一对多链路对账",
  },
  {
    id: "unified-inventory",
    title: "统一库存位置",
    decision: "货在哪里、哪些可用、哪些是账实差异或未知？",
    grain: "截止时点 × 仓库 × SKU × 批次",
    owner: "仓储 / PMC / 财务",
    sources: ["SCM", "JST", "YONYOU"],
    targetAuthority: "operational",
    releaseGate: "仓库与 SKU 精确映射、相同截止时点、缺失不补零、差异超阈停止",
  },
  {
    id: "supply-commitment",
    title: "供给承诺",
    decision: "PO/加工/在途何时可用，承诺日是否可信？",
    grain: "供应单行 × 承诺日 × 实际到货",
    owner: "采购 / PMC",
    sources: ["SCM", "JIANDAOYUN", "JST", "YONYOU"],
    targetAuthority: "operational",
    releaseGate: "单号复合身份、数量/单位、承诺日与收货状态映射可重放",
  },
  {
    id: "net-margin-bridge",
    title: "净毛利桥",
    decision: "销量增长扣除退款、平台费、物流和成本后还剩多少？",
    grain: "期间 × 渠道 × SKU",
    owner: "财务 / 业务",
    sources: ["JIANDAOYUN", "JST", "YONYOU", "SCM"],
    targetAuthority: "financial",
    releaseGate: "净收入、退款、平台费、存货成本和期间口径均已关账",
  },
  {
    id: "supplier-360",
    title: "供应商 360",
    decision: "哪些供应商交期、质量、价格或资金风险最高？",
    grain: "供应商 × 期间 × 产品/物料",
    owner: "采购 / 品质 / 财务",
    sources: ["SCM", "YONYOU"],
    targetAuthority: "operational",
    releaseGate: "供应商身份、承诺交期、收货、检验、价格和样本量同口径",
  },
  {
    id: "replenishment-evidence",
    title: "补货证据包",
    decision: "什么时候、补多少、哪个假设会使建议失效？",
    grain: "SKU × 仓/渠道 × 建议日",
    owner: "PMC / 采购",
    sources: ["SCM", "JIANDAOYUN", "JST", "YONYOU"],
    targetAuthority: "operational",
    releaseGate: "正式库存优先；观察需求不能单独下单；MOQ/周期/在途均可追溯",
  },
  {
    id: "launch-readiness",
    title: "新品上市雷达",
    decision: "上市前还缺什么，首销后 30/60/90 天是否达到假设？",
    grain: "新品项目 × 里程碑/上市窗口",
    owner: "产品 / PMC / 电商",
    sources: ["SCM", "JIANDAOYUN", "YONYOU", "JST"],
    targetAuthority: "operational",
    releaseGate: "标准里程碑、首单、备货、正式上市日和首销口径一致",
  },
  {
    id: "exception-triangulation",
    title: "异常三角核对",
    decision: "简道云观察、聚水潭履约和用友财务为什么不一致？",
    grain: "业务日 × 店铺/仓 × SKU × 差异类型",
    owner: "数据 / 财务 / 运营",
    sources: ["JIANDAOYUN", "JST", "YONYOU", "SCM"],
    targetAuthority: "operational",
    releaseGate: "三边独立显示、统一时间/身份/单位，差异有 owner、原因和 SLA，禁止自动调平",
  },
  {
    id: "cash-sop",
    title: "经营/现金 S&OP",
    decision: "13 周销量、供给、库存和现金在什么情景下会失衡？",
    grain: "周 × 品牌/渠道 × 情景版本",
    owner: "经营层 / PMC / 财务",
    sources: ["SCM", "JIANDAOYUN", "JST", "YONYOU"],
    targetAuthority: "financial",
    releaseGate: "上游数据产品已放行，指标版本/owner/关账状态完整，情景不覆盖正式事实",
  },
];
