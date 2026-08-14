/**
 * 三方数据产品目录：定义“要回答什么”和“什么时候才允许放行”。
 *
 * 这是目标契约，不是当前就绪清单。界面不得因为目录中有某产品，
 * 就宣称聚水潭或用友数据已经可用。当前就绪度仍以运行时连接器、身份、对账和 UAT 证据为准。
 */
import { SCM_EVIDENCE_LABEL, type ScmEvidenceKey } from "@/lib/scm-evidence";
import type { CrossSystemIdentityDomain } from "@/lib/cross-system-identity";
import type {
  CrossSystemSemanticDomain,
  CrossSystemSemanticSource,
} from "@/lib/cross-system-semantics";
import type { Role } from "@/server/core/constants";

export type DataProductSource = "SCM" | "JIANDAOYUN" | "JST" | "YONYOU";
export type DataProductAuthority = "observation" | "operational" | "financial";
export type DataProductCadence = "intraday" | "daily" | "weekly" | "monthly";
export type DataProductAutomationLevel = "A0" | "A1" | "A2" | "A3";

export interface DataProductDependency {
  productId: string;
  /** 下游产品可申请放行前，上游至少需要达到的产品级放行。 */
  minimumLevel: Extract<DataProductAutomationLevel, "A2" | "A3">;
  purpose: string;
}

export interface DataProductDefinition {
  id: string;
  title: string;
  decision: string;
  grain: string;
  owner: string;
  /** 可发起并会签该产品放行的业务责任角色；admin 仅作受控兜底。 */
  ownerRoles: Role[];
  contractVersion: string;
  cadence: DataProductCadence;
  /** 数据满足契约后，从异常出现到 owner 作出决定的目标时限。 */
  decisionSlaHours: number;
  /** 只引用全局指标注册表，不在产品目录复制公式。 */
  metricIds: string[];
  /** 完整放行并通过产品级 UAT 后仍不得越过的自动化上限。 */
  maxAutomation: DataProductAutomationLevel;
  automationGuardrail: string;
  sources: DataProductSource[];
  /** SCM 也必须提供产品专属的非空受控事实，不能用全局健康标志代替。 */
  requiredScmEvidence: ScmEvidenceKey[];
  /** 每个外部来源必须有过最新成功证据的具体流；不能用同连接器的无关流替代。 */
  requiredStreams: Partial<Record<DataProductSource, string[]>>;
  /**
   * 该产品直接消费的外部流必须具备的身份维度。身份门禁与流成功、
   * 控制总量和 UAT 分开；“字段存在”或“名称相同”不等于已统一身份。
   */
  requiredIdentities: Partial<Record<DataProductSource, CrossSystemIdentityDomain[]>>;
  /**
   * 每条必需外部流在本产品中真正使用的业务语义。只检查这里声明的语义，避免一条流中
   * 未使用的字段阻塞产品；但每条 requiredStreams 必须至少声明粒度及实际使用的口径。
   */
  requiredSemantics: Partial<Record<
    CrossSystemSemanticSource,
    Record<string, CrossSystemSemanticDomain[]>
  >>;
  /**
   * 可补充解释、身份或回查路径，但不参与 A2/A3 放行判定的参考流。
   * 过期或缺失的辅助流不得阻塞核心产品，也不得替代 requiredStreams。
   */
  supportingStreams?: Partial<Record<DataProductSource, string[]>>;
  /**
   * 真正的产品级嵌套，而不是重复读取同一批原始流。上游放行记录或证据范围失效时，
   * 下游放行必须自动失效；仅有 A1 观察证据不能满足该依赖。
   */
  requiredProducts?: DataProductDependency[];
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

export const DATA_PRODUCT_CADENCE_LABEL: Record<DataProductCadence, string> = {
  intraday: "日内",
  daily: "每日",
  weekly: "每周",
  monthly: "每月/关账",
};

/** 业务界面使用中文流名；原始契约键仍保留在证据、日志和展开详情中。 */
export const DATA_PRODUCT_STREAM_LABEL: Record<string, string> = {
  "tmall-sku-crosswalk-observation": "天猫 SKU 对照",
  "pdd-sku-crosswalk-observation": "拼多多 SKU 对照",
  "vip-product-crosswalk-observation": "唯品会商品对照",
  "item-master": "聚水潭商品主档",
  "tmall-sku-sales-observation": "天猫日销量",
  "tmall-sku-refund-observation": "天猫退款",
  "outbound-sales-daily": "聚水潭日出库销量",
  "orders-daily": "聚水潭全渠道日订单（含淘系/拼多多）",
  "returns-daily": "聚水潭全渠道日退货（含淘系/拼多多）",
  "inventory-total-delta": "聚水潭库存总量增量",
  "inbound-receipts-daily": "聚水潭日入库",
  "purchase-order-observation": "简道云采购订单",
  "purchase-receipt-observation": "简道云采购入库",
  "platform-fee-observation": "天猫费用项目汇总（渠道级）",
  "purchase-demand-observation": "简道云采购需求",
  "inventory-count-observation": "简道云库存盘点记录",
  "warehouse-observation": "简道云仓库资料",
  "warehouse-transfer-observation": "简道云调拨记录",
  "supplier-observation": "简道云供应商资料",
  "sample-management-observation": "简道云样品管理",
  "npd-milestone-observation": "新品里程碑",
  "product-master-observation": "简道云产品主档",
  "yonbip-fi-ficloud-openapi-voucher-queryvouchers": "用友财务凭证",
  "yonbip-finance-receivables-settlement": "用友应收结算",
  "yonbip-scm-stock-querycurrentstocksbycondition": "用友现存量",
  "yonbip-scm-purchaseorder-list": "用友采购订单",
  "yonbip-scm-purinrecord-list": "用友采购入库",
  "yonbip-efi-fieia-querybalance": "用友科目余额",
  "yonbip-digitalmodel-vendor-list": "用友供应商主档",
  "yonbip-digitalmodel-product-listproductbycondition": "用友物料/产品主档",
};

/**
 * 只有目标定义、尚未实现的流所必须保留的语义边界。
 * 这些说明会直接进入数据资产行动队列，防止用覆盖更窄的现成 API 冒充目标契约。
 */
export const DATA_PRODUCT_STREAM_IMPLEMENTATION_NOTE: Partial<Record<string, string>> = {
  "orders-daily": "必须覆盖淘系与拼多多；聚水潭标准订单查询明确不返回这两类订单，不能用窄接口冒充全渠道事实",
  "returns-daily": "必须覆盖淘系与拼多多售后；聚水潭标准售后查询只返回自有商城单据，不能用它冒充全渠道退货",
  "yonbip-finance-receivables-settlement": "必须先在目标 YonBIP 租户官方 API 目录确认应收、收款与核销的只读契约，再冻结路径和字段映射",
};

export function dataProductStreamLabel(source: DataProductSource, stream: string): string {
  return source === "SCM"
    ? SCM_EVIDENCE_LABEL[stream as ScmEvidenceKey] ?? stream
    : DATA_PRODUCT_STREAM_LABEL[stream] ?? stream;
}

export const DATA_PRODUCT_AUTOMATION_LABEL: Record<DataProductAutomationLevel, string> = {
  A0: "观察",
  A1: "解释",
  A2: "建议",
  A3: "草稿",
};

export const DATA_PRODUCTS: DataProductDefinition[] = [
  {
    id: "commerce-identity-control",
    title: "平台身份控制塔",
    decision: "哪些天猫、拼多多、唯品会商品身份阻塞跨系统对账与自动化？",
    grain: "平台 × 店铺 × 平台商品/SKU 身份",
    owner: "商品 / 电商 / 数据",
    ownerRoles: ["ops", "pmc"],
    contractVersion: "1.2.0",
    cadence: "daily",
    decisionSlaHours: 24,
    metricIds: ["platformIdentityCoverage", "identityConflictCount"],
    maxAutomation: "A2",
    automationGuardrail: "只排序并解释身份修复建议；禁止模糊匹配或自动认领 SKU。",
    sources: ["JIANDAOYUN", "SCM", "JST"],
    requiredScmEvidence: ["sku-master", "sku-identifiers"],
    requiredStreams: {
      JIANDAOYUN: [
        "tmall-sku-crosswalk-observation",
        "pdd-sku-crosswalk-observation",
        "vip-product-crosswalk-observation",
      ],
      JST: ["item-master"],
    },
    requiredIdentities: {
      JIANDAOYUN: ["sku", "shop"],
      JST: ["sku"],
    },
    requiredSemantics: {
      JIANDAOYUN: {
        "tmall-sku-crosswalk-observation": ["grain", "identifier_namespace"],
        "pdd-sku-crosswalk-observation": ["grain", "identifier_namespace"],
        "vip-product-crosswalk-observation": ["grain", "identifier_namespace"],
      },
      JST: { "item-master": ["grain", "identifier_namespace", "status_semantics"] },
    },
    targetAuthority: "operational",
    releaseGate: "最新批次、唯一业务键、精确条码/别名、冲突清零、覆盖阈值与业务 UAT",
  },
  {
    id: "demand-pulse",
    title: "需求脉搏",
    decision: "哪些 SKU/渠道是真增长、退款上升或履约落差？",
    grain: "日 × 店铺 × 平台 SKU",
    owner: "电商 / PMC",
    ownerRoles: ["ops", "pmc"],
    contractVersion: "1.3.1",
    cadence: "daily",
    decisionSlaHours: 24,
    metricIds: ["externalNetDemand", "refundRate", "mappedDemandCoverage"],
    maxAutomation: "A2",
    automationGuardrail: "观察需求只生成解释和建议；不得直接改写正式销量、预测或补货量。",
    sources: ["JIANDAOYUN", "JST", "SCM"],
    requiredScmEvidence: ["sku-master", "sku-identifiers"],
    requiredStreams: {
      JIANDAOYUN: [
        "tmall-sku-sales-observation",
        "tmall-sku-refund-observation",
      ],
      JST: ["outbound-sales-daily"],
    },
    requiredIdentities: {
      JIANDAOYUN: ["sku", "shop"],
      JST: ["sku", "shop", "document"],
    },
    requiredSemantics: {
      JIANDAOYUN: {
        "tmall-sku-sales-observation": ["grain", "business_time", "quantity_unit", "sign_convention", "correction_semantics"],
        "tmall-sku-refund-observation": ["grain", "business_time", "quantity_unit", "sign_convention", "correction_semantics"],
      },
      JST: {
        "outbound-sales-daily": ["grain", "business_time", "quantity_unit", "sign_convention", "status_semantics", "correction_semantics"],
      },
    },
    requiredProducts: [
      { productId: "commerce-identity-control", minimumLevel: "A2", purpose: "复用已验收的平台 SKU、条码与别名身份口径" },
    ],
    targetAuthority: "operational",
    releaseGate: "身份覆盖、时间窗、退款状态与 JST 订单/出库总量对账",
  },
  {
    id: "order-to-cash",
    title: "订单到现金",
    decision: "销售、履约、开票、收款在哪个环节卡住？",
    grain: "来源订单 × 收款/凭证",
    owner: "财务 / 电商",
    ownerRoles: ["finance", "ops"],
    contractVersion: "1.3.0",
    cadence: "daily",
    decisionSlaHours: 48,
    metricIds: ["orderFulfillmentRate", "cashConversionDays", "unreconciledOrderCount"],
    maxAutomation: "A2",
    automationGuardrail: "只生成差异和催办建议；禁止自动开票、认款、核销或生成正式凭证。",
    sources: ["JST", "YONYOU", "SCM"],
    requiredScmEvidence: ["sku-identifiers", "stock-ledger"],
    requiredStreams: {
      JST: ["orders-daily", "outbound-sales-daily", "returns-daily"],
      YONYOU: [
        "yonbip-fi-ficloud-openapi-voucher-queryvouchers",
        "yonbip-finance-receivables-settlement",
      ],
    },
    requiredIdentities: {
      JST: ["sku", "shop", "document"],
      YONYOU: ["organization", "document"],
    },
    requiredSemantics: {
      JST: {
        "orders-daily": ["grain", "business_time", "identifier_namespace", "quantity_unit", "currency", "amount_scale", "sign_convention", "status_semantics", "correction_semantics"],
        "outbound-sales-daily": ["grain", "business_time", "identifier_namespace", "quantity_unit", "sign_convention", "status_semantics", "correction_semantics"],
        "returns-daily": ["grain", "business_time", "identifier_namespace", "quantity_unit", "currency", "amount_scale", "sign_convention", "status_semantics", "correction_semantics"],
      },
      YONYOU: {
        "yonbip-fi-ficloud-openapi-voucher-queryvouchers": ["grain", "business_time", "identifier_namespace", "currency", "amount_scale", "sign_convention", "status_semantics", "correction_semantics"],
        "yonbip-finance-receivables-settlement": ["grain", "business_time", "identifier_namespace", "currency", "amount_scale", "sign_convention", "status_semantics", "correction_semantics"],
      },
    },
    requiredProducts: [
      { productId: "commerce-identity-control", minimumLevel: "A2", purpose: "复用已验收的平台商品与 SKU 身份口径" },
    ],
    targetAuthority: "financial",
    releaseGate: "订单、退款、发票/凭证和收款一对一/一对多链路对账",
  },
  {
    id: "unified-inventory",
    title: "统一库存位置",
    decision: "货在哪里、哪些可用、哪些是账实差异或未知？",
    grain: "截止时点 × 仓库 × SKU × 批次",
    owner: "仓储 / PMC / 财务",
    ownerRoles: ["warehouse", "pmc", "finance"],
    contractVersion: "1.3.0",
    cadence: "intraday",
    decisionSlaHours: 4,
    metricIds: ["onHandSystem", "inventoryReconciliationGap", "coverageSku"],
    maxAutomation: "A2",
    automationGuardrail: "差异只进入核对队列；不得自动调平、补零或绕过库存过账。",
    sources: ["SCM", "JST", "YONYOU"],
    requiredScmEvidence: ["stock-balances", "stock-ledger"],
    requiredStreams: {
      JST: ["inventory-total-delta"],
      YONYOU: ["yonbip-scm-stock-querycurrentstocksbycondition"],
    },
    requiredIdentities: {
      JST: ["sku", "warehouse"],
      YONYOU: ["sku", "warehouse", "organization"],
    },
    requiredSemantics: {
      JST: {
        "inventory-total-delta": ["grain", "business_time", "identifier_namespace", "quantity_unit", "inventory_scope", "correction_semantics"],
      },
      YONYOU: {
        "yonbip-scm-stock-querycurrentstocksbycondition": ["grain", "business_time", "identifier_namespace", "quantity_unit", "inventory_scope", "status_semantics"],
      },
    },
    supportingStreams: {
      JIANDAOYUN: [
        "inventory-count-observation",
        "warehouse-observation",
        "warehouse-transfer-observation",
      ],
    },
    targetAuthority: "operational",
    releaseGate: "仓库与 SKU 精确映射、相同截止时点、缺失不补零、差异超阈停止",
  },
  {
    id: "supply-commitment",
    title: "供给承诺",
    decision: "PO/加工/在途何时可用，承诺日是否可信？",
    grain: "供应单行 × 承诺日 × 实际到货",
    owner: "采购 / PMC",
    ownerRoles: ["purchasing", "pmc"],
    contractVersion: "1.2.2",
    cadence: "daily",
    decisionSlaHours: 24,
    metricIds: ["openSupplyQty", "onTimeRate", "promiseReliability"],
    maxAutomation: "A3",
    automationGuardrail: "最多生成催交、改期或补单草稿；任何单据变更仍须 owner 审批。",
    sources: ["SCM", "JIANDAOYUN", "JST", "YONYOU"],
    requiredScmEvidence: ["purchase-order-lines", "receipt-lines"],
    requiredStreams: {
      JIANDAOYUN: ["purchase-order-observation", "purchase-receipt-observation"],
      JST: ["inbound-receipts-daily"],
      YONYOU: ["yonbip-scm-purchaseorder-list", "yonbip-scm-purinrecord-list"],
    },
    requiredIdentities: {
      JIANDAOYUN: ["sku", "supplier", "document"],
      JST: ["sku", "warehouse", "document"],
      YONYOU: ["sku", "supplier", "warehouse", "organization", "document"],
    },
    requiredSemantics: {
      JIANDAOYUN: {
        "purchase-order-observation": ["grain", "business_time", "quantity_unit", "amount_scale", "status_semantics", "correction_semantics"],
        "purchase-receipt-observation": ["grain", "business_time", "quantity_unit", "amount_scale", "status_semantics", "correction_semantics"],
      },
      JST: {
        "inbound-receipts-daily": ["grain", "business_time", "identifier_namespace", "quantity_unit", "status_semantics", "correction_semantics"],
      },
      YONYOU: {
        "yonbip-scm-purchaseorder-list": ["grain", "business_time", "identifier_namespace", "quantity_unit", "currency", "amount_scale", "status_semantics", "correction_semantics"],
        "yonbip-scm-purinrecord-list": ["grain", "business_time", "identifier_namespace", "quantity_unit", "currency", "amount_scale", "status_semantics", "correction_semantics"],
      },
    },
    supportingStreams: {
      JIANDAOYUN: ["purchase-demand-observation"],
    },
    targetAuthority: "operational",
    releaseGate: "单号复合身份、数量/单位、承诺日与收货状态映射可重放",
  },
  {
    id: "net-margin-bridge",
    title: "净毛利桥",
    decision: "销量增长扣除退款、平台费、物流和成本后还剩多少？",
    grain: "期间 × 渠道（SKU 仅在可直接归属时下钻）",
    owner: "财务 / 业务",
    ownerRoles: ["finance", "ops"],
    contractVersion: "1.4.0",
    cadence: "monthly",
    decisionSlaHours: 72,
    metricIds: ["netRevenue", "platformFeePaidAmount", "channelContributionBeforeProductCost", "contributionMarginRate", "costCoverage"],
    maxAutomation: "A2",
    automationGuardrail: "未关账期间只解释差异；天猫渠道费用不得冒充全渠道，无 SKU 直接归属时禁止按销量自动分摊，也不得改成本或形成财务凭证。",
    sources: ["JIANDAOYUN", "YONYOU", "SCM"],
    requiredScmEvidence: ["sku-costs"],
    requiredStreams: {
      JIANDAOYUN: ["platform-fee-observation"],
      YONYOU: ["yonbip-efi-fieia-querybalance"],
    },
    requiredIdentities: {
      JIANDAOYUN: ["channel", "shop"],
      YONYOU: ["organization"],
    },
    requiredSemantics: {
      JIANDAOYUN: {
        "platform-fee-observation": ["grain", "business_time", "currency", "amount_scale", "sign_convention", "correction_semantics"],
      },
      YONYOU: {
        "yonbip-efi-fieia-querybalance": ["grain", "business_time", "identifier_namespace", "currency", "amount_scale", "sign_convention", "correction_semantics"],
      },
    },
    requiredProducts: [
      { productId: "demand-pulse", minimumLevel: "A2", purpose: "复用已验收的渠道净需求、退款与身份口径" },
      { productId: "order-to-cash", minimumLevel: "A2", purpose: "复用已验收的订单履约、凭证与收款链路" },
    ],
    targetAuthority: "financial",
    releaseGate: "净收入、退款、平台费、存货成本和期间口径均已关账",
  },
  {
    id: "supplier-360",
    title: "供应商 360",
    decision: "哪些供应商交期、质量、价格或资金风险最高？",
    grain: "供应商 × 期间 × 产品/物料",
    owner: "采购 / 品质 / 财务",
    ownerRoles: ["purchasing", "quality", "finance"],
    contractVersion: "1.4.0",
    cadence: "weekly",
    decisionSlaHours: 72,
    metricIds: ["onTimeRate", "qcPassRate", "supplierPriceVariance"],
    maxAutomation: "A2",
    automationGuardrail: "评分只生成复核建议；不得自动停用供应商、改等级或变更付款条件。",
    sources: ["SCM", "YONYOU"],
    requiredScmEvidence: ["supplier-master", "quality-inspections"],
    requiredStreams: {
      YONYOU: ["yonbip-digitalmodel-vendor-list"],
    },
    requiredIdentities: {
      YONYOU: ["supplier", "organization"],
    },
    requiredSemantics: {
      YONYOU: {
        "yonbip-digitalmodel-vendor-list": ["grain", "business_time", "identifier_namespace", "status_semantics"],
      },
    },
    supportingStreams: {
      JIANDAOYUN: ["supplier-observation", "sample-management-observation"],
    },
    requiredProducts: [
      { productId: "supply-commitment", minimumLevel: "A2", purpose: "复用已验收的采购行、价格、承诺与收货口径" },
    ],
    targetAuthority: "operational",
    releaseGate: "供应商身份、承诺交期、收货、检验、价格和样本量同口径",
  },
  {
    id: "replenishment-evidence",
    title: "补货证据包",
    decision: "什么时候、补多少、哪个假设会使建议失效？",
    grain: "SKU × 仓/渠道 × 建议日",
    owner: "PMC / 采购",
    ownerRoles: ["pmc", "purchasing"],
    contractVersion: "1.2.1",
    cadence: "daily",
    decisionSlaHours: 24,
    metricIds: ["daysCover", "safetyQty", "suggestQty", "wape"],
    maxAutomation: "A3",
    automationGuardrail: "最多生成补货/调拨草稿；金额、数量、MOQ、交期与库存事实仍需审批。",
    sources: ["SCM"],
    requiredScmEvidence: ["stock-balances", "sales-history", "planning-lines", "sku-planning-params", "purchase-order-lines"],
    requiredStreams: {},
    requiredIdentities: {},
    requiredSemantics: {},
    requiredProducts: [
      { productId: "demand-pulse", minimumLevel: "A2", purpose: "复用已验收的净需求、退款与身份口径" },
      { productId: "unified-inventory", minimumLevel: "A2", purpose: "复用已验收的可用库存与账实差异口径" },
      { productId: "supply-commitment", minimumLevel: "A2", purpose: "复用已验收的在途、承诺日与到货可信度" },
    ],
    targetAuthority: "operational",
    releaseGate: "正式库存优先；观察需求不能单独下单；MOQ/周期/在途均可追溯",
  },
  {
    id: "launch-readiness",
    title: "新品上市雷达",
    decision: "上市前还缺什么，首销后 30/60/90 天是否达到假设？",
    grain: "新品项目 × 里程碑/上市窗口",
    owner: "产品 / PMC / 电商",
    ownerRoles: ["pmc", "ops"],
    contractVersion: "1.3.0",
    cadence: "daily",
    decisionSlaHours: 24,
    metricIds: ["npdProgress", "launchOnTimeRate", "first90DayAchievement"],
    maxAutomation: "A3",
    automationGuardrail: "最多生成任务、提醒和补救草稿；不得自动移动正式里程碑或上市日。",
    sources: ["SCM", "JIANDAOYUN", "YONYOU"],
    requiredScmEvidence: ["npd-projects", "npd-tasks", "sku-master"],
    requiredStreams: {
      JIANDAOYUN: ["npd-milestone-observation", "product-master-observation"],
      YONYOU: ["yonbip-digitalmodel-product-listproductbycondition"],
    },
    requiredIdentities: {
      JIANDAOYUN: ["sku"],
      YONYOU: ["sku", "organization"],
    },
    requiredSemantics: {
      JIANDAOYUN: {
        "npd-milestone-observation": ["grain", "business_time", "identifier_namespace", "status_semantics", "correction_semantics"],
        "product-master-observation": ["grain", "identifier_namespace", "quantity_unit"],
      },
      YONYOU: {
        "yonbip-digitalmodel-product-listproductbycondition": ["grain", "business_time", "identifier_namespace", "quantity_unit", "status_semantics"],
      },
    },
    supportingStreams: {
      JIANDAOYUN: ["sample-management-observation"],
    },
    requiredProducts: [
      { productId: "commerce-identity-control", minimumLevel: "A2", purpose: "复用已验收的新品 SKU 与平台身份口径" },
      { productId: "demand-pulse", minimumLevel: "A2", purpose: "复用已验收的首销、退款与渠道需求口径" },
      { productId: "supply-commitment", minimumLevel: "A2", purpose: "复用已验收的首单、在途与到货承诺口径" },
    ],
    targetAuthority: "operational",
    releaseGate: "标准里程碑、首单、备货、正式上市日和首销口径一致",
  },
  {
    id: "exception-triangulation",
    title: "异常三角核对",
    decision: "简道云观察、聚水潭履约和用友财务为什么不一致？",
    grain: "业务日 × 店铺/仓 × SKU × 差异类型",
    owner: "数据 / 财务 / 运营",
    ownerRoles: ["finance", "ops"],
    contractVersion: "1.1.0",
    cadence: "intraday",
    decisionSlaHours: 4,
    metricIds: ["triangulationExceptionCount", "exceptionSlaRate", "inventoryReconciliationGap"],
    maxAutomation: "A2",
    automationGuardrail: "只定位、归因和分派异常；三边事实保持独立，禁止自动调平。",
    sources: ["SCM"],
    requiredScmEvidence: ["reconciliation-diffs", "sku-identifiers"],
    requiredStreams: {},
    requiredIdentities: {},
    requiredSemantics: {},
    requiredProducts: [
      { productId: "demand-pulse", minimumLevel: "A2", purpose: "复用已验收的需求、退款与履约口径" },
      { productId: "unified-inventory", minimumLevel: "A2", purpose: "复用已验收的库存位置与账实差异口径" },
      { productId: "supply-commitment", minimumLevel: "A2", purpose: "复用已验收的采购、承诺与到货口径" },
      { productId: "order-to-cash", minimumLevel: "A2", purpose: "复用已验收的订单、凭证与收款口径" },
    ],
    targetAuthority: "operational",
    releaseGate: "三边独立显示、统一时间/身份/单位，差异有 owner、原因和 SLA，禁止自动调平",
  },
  {
    id: "cash-sop",
    title: "经营/现金 S&OP",
    decision: "13 周销量、供给、库存和现金在什么情景下会失衡？",
    grain: "周 × 品牌/渠道 × 情景版本",
    owner: "经营层 / PMC / 财务",
    ownerRoles: ["pmc", "finance", "ops"],
    contractVersion: "1.2.1",
    cadence: "weekly",
    decisionSlaHours: 48,
    metricIds: ["salesQty", "onHandSystem", "cashGap13Week", "scenarioCoverage"],
    maxAutomation: "A2",
    automationGuardrail: "情景只生成决策建议；不得覆盖预算、关账事实、正式预测或资金指令。",
    sources: ["SCM"],
    requiredScmEvidence: ["planning-lines", "sop-cycles", "stock-balances", "sales-history", "sku-costs"],
    requiredStreams: {},
    requiredIdentities: {},
    requiredSemantics: {},
    requiredProducts: [
      { productId: "demand-pulse", minimumLevel: "A2", purpose: "需求与退款情景基线" },
      { productId: "unified-inventory", minimumLevel: "A2", purpose: "库存位置、可用量与差异基线" },
      { productId: "supply-commitment", minimumLevel: "A2", purpose: "采购、在途与到货承诺基线" },
      { productId: "net-margin-bridge", minimumLevel: "A2", purpose: "收入、费用、成本与贡献毛利基线" },
    ],
    targetAuthority: "financial",
    releaseGate: "上游数据产品已放行，指标版本/owner/关账状态完整，情景不覆盖正式事实",
  },
];
