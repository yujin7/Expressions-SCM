/**
 * 数据产品指标血缘：公式仍以 components/metrics.ts 为唯一权威，本表只回答
 * “这个产品的该指标实际消费什么、怎样连接、缺数时怎么处理、计算器是否真实存在”。
 *
 * 它与来源/身份/语义门禁分开：即使数据全部就绪，没有可重放计算器的指标也不得进入 A1。
 */

export type MetricComputationState =
  | "implemented"
  | "partial"
  | "not_implemented"
  | "missing_contract";

export type MetricLineageInputKind = "stream" | "scm_evidence" | "upstream_product";

export interface MetricLineageInput {
  kind: MetricLineageInputKind;
  /** stream 必须携来源；SCM evidence / upstream product 不携来源。 */
  source?: "JIANDAOYUN" | "JST" | "YONYOU";
  ref: string;
  purpose: string;
}

export interface DataProductMetricLineageContract {
  productId: string;
  metricId: string;
  state: Exclude<MetricComputationState, "missing_contract">;
  outputGrain: string;
  inputs: MetricLineageInput[];
  joinKeys: string[];
  missingPolicy: "unknown_not_zero" | "exclude_with_coverage" | "not_applicable";
  evidence: string;
  nextAction: string;
}

export const DATA_PRODUCT_METRIC_LINEAGE_VERSION = "data-product-metric-lineage/v5" as const;

export const METRIC_COMPUTATION_STATE_LABEL: Record<MetricComputationState, string> = {
  implemented: "可重放计算",
  partial: "局部计算已有",
  not_implemented: "待实现",
  missing_contract: "缺计算契约",
};

const stream = (
  source: NonNullable<MetricLineageInput["source"]>,
  ref: string,
  purpose: string,
): MetricLineageInput => ({ kind: "stream", source, ref, purpose });
const scm = (ref: string, purpose: string): MetricLineageInput => ({
  kind: "scm_evidence",
  ref,
  purpose,
});
const product = (ref: string, purpose: string): MetricLineageInput => ({
  kind: "upstream_product",
  ref,
  purpose,
});

type ContractSeed = Omit<DataProductMetricLineageContract, "outputGrain" | "missingPolicy"> &
  Partial<Pick<DataProductMetricLineageContract, "outputGrain" | "missingPolicy">>;

function contract(seed: ContractSeed): DataProductMetricLineageContract {
  return {
    outputGrain: seed.outputGrain ?? "沿用数据产品粒度",
    missingPolicy: seed.missingPolicy ?? "unknown_not_zero",
    ...seed,
  };
}

const continuous = "持续用固定样本、控制总量和业务 UAT 验证计算结果";

export const DATA_PRODUCT_METRIC_LINEAGE_CONTRACTS: DataProductMetricLineageContract[] = [
  contract({
    productId: "commerce-identity-control", metricId: "platformIdentityCoverage", state: "partial",
    inputs: [
      stream("JIANDAOYUN", "tmall-sku-crosswalk-observation", "天猫平台身份分母与精确映射"),
      stream("JIANDAOYUN", "pdd-sku-crosswalk-observation", "拼多多平台身份分母与精确映射"),
      stream("JIANDAOYUN", "vip-product-crosswalk-observation", "唯品会平台身份分母与精确映射"),
      stream("JST", "item-master", "聚水潭 SKU 身份补充与交叉验证"),
      scm("sku-identifiers", "SCM SKU/条码权威身份"),
    ],
    joinKeys: ["来源作用域", "店铺", "平台商品/SKU", "条码", "SCM SKU"],
    missingPolicy: "exclude_with_coverage",
    evidence: "三平台简道云覆盖计算器已实现；聚水潭商品主档尚未进入同一覆盖计算",
    nextAction: "在 JST item-master 真实 UAT 后将其精确身份加入同一分来源覆盖计算",
  }),
  contract({
    productId: "commerce-identity-control", metricId: "identityConflictCount", state: "partial",
    inputs: [
      stream("JIANDAOYUN", "tmall-sku-crosswalk-observation", "天猫重复/冲突候选"),
      stream("JIANDAOYUN", "pdd-sku-crosswalk-observation", "拼多多重复/冲突候选"),
      stream("JIANDAOYUN", "vip-product-crosswalk-observation", "唯品会重复/冲突候选"),
      stream("JST", "item-master", "聚水潭 SKU 多值冲突候选"),
      scm("sku-identifiers", "已批准内部身份"),
    ],
    joinKeys: ["来源作用域", "身份类型", "原始值"],
    evidence: "简道云三平台冲突计数已实现；JST 端尚无真实候选样本",
    nextAction: "将 JST 作用域冲突加入计算，并保持各来源分列不抵销",
  }),

  contract({
    productId: "demand-pulse", metricId: "externalNetDemand", state: "implemented",
    inputs: [
      stream("JIANDAOYUN", "tmall-sku-sales-observation", "支付件数"),
      stream("JIANDAOYUN", "tmall-sku-refund-observation", "成功退款件数"),
      stream("JST", "outbound-sales-daily", "实际出库履约校验"),
      product("commerce-identity-control", "平台 SKU 精确身份"),
    ],
    joinKeys: ["业务日", "店铺", "平台 SKU", "SCM SKU"],
    missingPolicy: "exclude_with_coverage",
    evidence: "简道云支付减退款日级计算与 JST 同业务日×SCM SKU 独立出库对比均已实现；缺批次或缺身份时保持未知",
    nextAction: "用真实 JST 批次完成店铺/仓身份 UAT，并将跨店铺/仓汇总逐步下钻到产品目标粒度",
  }),
  contract({
    productId: "demand-pulse", metricId: "refundRate", state: "implemented",
    inputs: [
      stream("JIANDAOYUN", "tmall-sku-sales-observation", "支付件数分母"),
      stream("JIANDAOYUN", "tmall-sku-refund-observation", "成功退款件数分子"),
      stream("JST", "outbound-sales-daily", "履约窗口参照"),
    ],
    joinKeys: ["业务日", "店铺", "平台 SKU"],
    missingPolicy: "not_applicable",
    evidence: "支付与成功退款按固定业务日、店铺、平台 SKU 聚合，JST 出库以独立同窗对比呈现且不改写退款定义",
    nextAction: "用真实业务样本确认跨期退款观察窗口，并保留退款申请、成功退款和退货入库的事件差异",
  }),
  contract({
    productId: "demand-pulse", metricId: "mappedDemandCoverage", state: "implemented",
    inputs: [
      stream("JIANDAOYUN", "tmall-sku-sales-observation", "全部及已映射支付需求"),
      stream("JIANDAOYUN", "tmall-sku-refund-observation", "全部及已映射退款需求"),
      product("commerce-identity-control", "已批准平台身份"),
    ],
    joinKeys: ["业务日", "店铺", "平台 SKU"],
    missingPolicy: "exclude_with_coverage",
    evidence: "简道云映射需求覆盖、未映射高需求队列与 JST 可比 SKU日覆盖均可重放；上游身份放行仍由独立产品门禁控制",
    nextAction: "身份产品达到 A2 后重做覆盖 UAT；在此之前计算器可用但数据产品仍不得放行",
  }),

  contract({
    productId: "order-to-cash", metricId: "orderFulfillmentRate", state: "not_implemented",
    inputs: [
      stream("JST", "orders-daily", "有效订单需求"),
      stream("JST", "outbound-sales-daily", "有效出库履约"),
      stream("JST", "returns-daily", "退货与退款调整"),
      product("commerce-identity-control", "店铺与 SKU 身份"),
    ],
    joinKeys: ["来源订单", "订单行", "店铺", "SKU", "截止时点"],
    evidence: "指标公式已登记，但全渠道订单/退货读取与链路计算器均未实现",
    nextAction: "先确定可覆盖淘系/拼多多的官方契约，再实现订单行到出库行链接",
  }),
  contract({
    productId: "order-to-cash", metricId: "cashConversionDays", state: "not_implemented",
    inputs: [
      stream("JST", "orders-daily", "订单确认日"),
      stream("YONYOU", "yonbip-finance-receivables-settlement", "收款/核销确认日"),
      stream("YONYOU", "yonbip-fi-ficloud-openapi-voucher-queryvouchers", "凭证链路校验"),
    ],
    joinKeys: ["来源订单", "结算单/凭证", "租户", "组织", "币种"],
    missingPolicy: "exclude_with_coverage",
    evidence: "应收结算官方契约未确认，无可重放计算器",
    nextAction: "在目标 YonBIP 租户确认应收/收款/核销契约后实现链路覆盖与天数分布",
  }),
  contract({
    productId: "order-to-cash", metricId: "unreconciledOrderCount", state: "not_implemented",
    inputs: [
      stream("JST", "orders-daily", "订单边"), stream("JST", "outbound-sales-daily", "履约边"),
      stream("JST", "returns-daily", "退货边"),
      stream("YONYOU", "yonbip-fi-ficloud-openapi-voucher-queryvouchers", "凭证边"),
      stream("YONYOU", "yonbip-finance-receivables-settlement", "收款/核销边"),
    ],
    joinKeys: ["来源订单", "履约单", "退货单", "凭证", "收款/核销单"],
    evidence: "定义已登记，尚无五边链路差异计算器",
    nextAction: "实现不丢未匹配样本的链路左连接，差异按边分类而不自动定责",
  }),

  contract({
    productId: "unified-inventory", metricId: "onHandSystem", state: "implemented",
    inputs: [scm("stock-balances", "当前库存余额"), scm("stock-ledger", "可追溯变动与核对")],
    joinKeys: ["截止时点", "仓库", "SKU", "批次"],
    evidence: "SCM 库存余额与台账读模型已实现",
    nextAction: continuous,
  }),
  contract({
    productId: "unified-inventory", metricId: "inventoryReconciliationGap", state: "partial",
    inputs: [
      scm("stock-balances", "SCM 基准库存"),
      stream("JST", "inventory-total-delta", "聚水潭库存观察"),
      stream("YONYOU", "yonbip-scm-stock-querycurrentstocksbycondition", "用友现存量观察"),
    ],
    joinKeys: ["共同截止时点", "组织", "仓库", "SKU", "单位"],
    evidence: "SCM 与文件参考核对已有；JST 只有全仓增量目标，用友无真实响应映射",
    nextAction: "先固化仓库粒度、单位和共同截止，再实现两条外部差异边且禁止互相抵销",
  }),
  contract({
    productId: "unified-inventory", metricId: "coverageSku", state: "partial",
    inputs: [
      scm("stock-balances", "SCM 库存 SKU 分母"),
      stream("JST", "inventory-total-delta", "JST 可比 SKU"),
      stream("YONYOU", "yonbip-scm-stock-querycurrentstocksbycondition", "用友可比 SKU"),
    ],
    joinKeys: ["来源作用域", "仓库", "SKU"],
    missingPolicy: "exclude_with_coverage",
    evidence: "文件参考覆盖已有；JST/用友只登记目标输入",
    nextAction: "真实拉数后按来源分别计算已认领/总候选，无候选不写 100%",
  }),

  contract({
    productId: "supply-commitment", metricId: "openSupplyQty", state: "partial",
    inputs: [
      scm("purchase-order-lines", "SCM 已批准供应量"), scm("receipt-lines", "SCM 正常实收量"),
      stream("JIANDAOYUN", "purchase-order-observation", "历史采购订单参照"),
      stream("JIANDAOYUN", "purchase-receipt-observation", "历史收货参照"),
      stream("JST", "inbound-receipts-daily", "仓配实际入库观察"),
      stream("YONYOU", "yonbip-scm-purchaseorder-list", "财务/ERP PO 观察"),
      stream("YONYOU", "yonbip-scm-purinrecord-list", "财务/ERP 入库观察"),
    ],
    joinKeys: ["来源单号", "单行", "供应商", "SKU", "单位"],
    evidence: "SCM 未结供给已有读模型；三方单行尚未进入统一计算",
    nextAction: "在单号身份和单位完成 UAT 后实现分来源未结量与差异",
  }),
  contract({
    productId: "supply-commitment", metricId: "onTimeRate", state: "partial",
    inputs: [
      scm("purchase-order-lines", "原承诺日"), scm("receipt-lines", "实际收货日"),
      stream("JST", "inbound-receipts-daily", "外部入库日校验"),
      stream("YONYOU", "yonbip-scm-purchaseorder-list", "ERP 承诺日"),
      stream("YONYOU", "yonbip-scm-purinrecord-list", "ERP 入库日"),
    ],
    joinKeys: ["供应单行", "原承诺版本", "实收事件"],
    missingPolicy: "exclude_with_coverage",
    evidence: "SCM 供应商准时率已实现；外部承诺/收货链尚未并行核对",
    nextAction: "保留原承诺及改期版本，三边分列计算后做总量 UAT",
  }),
  contract({
    productId: "supply-commitment", metricId: "promiseReliability", state: "partial",
    inputs: [
      scm("purchase-order-lines", "承诺日与承诺数"), scm("receipt-lines", "实收日与实收数"),
      stream("JST", "inbound-receipts-daily", "仓配到货佐证"),
      stream("YONYOU", "yonbip-scm-purchaseorder-list", "ERP 承诺佐证"),
      stream("YONYOU", "yonbip-scm-purinrecord-list", "ERP 收货佐证"),
    ],
    joinKeys: ["供应单行", "承诺版本", "SKU", "单位"],
    missingPolicy: "exclude_with_coverage",
    evidence: "SCM 已实现已到期唯一 PO×SKU 行、基础单位、质检接收、采购退货回冲与控制量硬闸；供应商首承诺/改期进入不可变逐行版本链，原始承诺与当前承诺分列，迁移快照不冒充原始承诺；三条外部对照边尚未完成",
    nextAction: "待三方身份、单位、状态和 UAT 后分别加入简道云流程、JST 入库与用友 PO/入库对照，不互相抵销或覆盖 SCM 承诺版本",
  }),

  contract({
    productId: "net-margin-bridge", metricId: "netRevenue", state: "not_implemented",
    inputs: [
      product("demand-pulse", "净需求与退款口径"), product("order-to-cash", "订单、履约与结算口径"),
      stream("JIANDAOYUN", "platform-fee-observation", "可直接归属平台费用"),
      stream("YONYOU", "yonbip-efi-fieia-querybalance", "关账科目余额校验"),
    ],
    joinKeys: ["关账期间", "组织", "渠道", "店铺", "币种"],
    evidence: "尚无将销售、退款、折让和费用联合的关账计算器",
    nextAction: "待订单到现金与用友关账数据放行后，实现分币种净收入桥",
  }),
  contract({
    productId: "net-margin-bridge", metricId: "platformFeePaidAmount", state: "implemented",
    inputs: [stream("JIANDAOYUN", "platform-fee-observation", "天猫费用项目支付金额")],
    joinKeys: ["月份", "店铺", "费用项目", "币种"],
    evidence: "已按原币、原正负号及渠道粒度聚合，不无据分摊到 SKU",
    nextAction: continuous,
  }),
  contract({
    productId: "net-margin-bridge", metricId: "contributionMarginRate", state: "not_implemented",
    inputs: [product("order-to-cash", "净收入链路"), scm("sku-costs", "已放行成本版本"), stream("JIANDAOYUN", "platform-fee-observation", "可变平台费用")],
    joinKeys: ["关账期间", "渠道", "币种", "成本版本"],
    evidence: "只有公式与部分输入，无产品级计算器",
    nextAction: "实现关账期间的收入、成本和可变履约费用桥，缺成本时留白",
  }),
  contract({
    productId: "net-margin-bridge", metricId: "costCoverage", state: "not_implemented",
    inputs: [product("order-to-cash", "有效净收入分母"), scm("sku-costs", "同期有效成本分子")],
    joinKeys: ["期间", "SKU", "成本版本"],
    missingPolicy: "exclude_with_coverage",
    evidence: "成本上传门禁已有，但未实现净收入加权覆盖率",
    nextAction: "实现按净收入加权的成本覆盖，并将缺失成本样本单列",
  }),

  contract({
    productId: "supplier-360", metricId: "onTimeRate", state: "implemented",
    inputs: [product("supply-commitment", "已验收承诺与收货口径"), scm("supplier-master", "供应商身份")],
    joinKeys: ["供应商", "已到期供应行", "承诺日", "实收日"],
    missingPolicy: "exclude_with_coverage",
    evidence: "SCM 供应商评分卡已计算准时率并披露样本量",
    nextAction: continuous,
  }),
  contract({
    productId: "supplier-360", metricId: "qcPassRate", state: "implemented",
    inputs: [scm("quality-inspections", "已判定检验数量"), scm("supplier-master", "供应商归属")],
    joinKeys: ["供应商", "检验单", "判定结果"],
    missingPolicy: "exclude_with_coverage",
    evidence: "供应商评分卡已按已判定数量计算合格率",
    nextAction: continuous,
  }),
  contract({
    productId: "supplier-360", metricId: "supplierPriceVariance", state: "partial",
    inputs: [product("supply-commitment", "同物料供应单行实际价"), stream("YONYOU", "yonbip-digitalmodel-vendor-list", "供应商权威身份")],
    joinKeys: ["供应商", "物料", "规格", "单位", "币种", "税制", "期间"],
    missingPolicy: "exclude_with_coverage",
    evidence: "SCM 已生效 PO 行可按采购单位、换算系数和税率归一为基础单位未税价，并按供应商×SKU计算数量加权均价、最低可比价、偏差与覆盖；PO 行币种尚未显式记录且用友供应商身份未 UAT，故只作观察值",
    nextAction: "在 PO 行固化凭证币种并完成用友供应商/组织身份真实读取、映射例外清零与业务 UAT 后，升级为可用于正式采购复核的完整计算",
  }),

  contract({
    productId: "replenishment-evidence", metricId: "daysCover", state: "implemented",
    inputs: [scm("stock-balances", "当前在库"), scm("sales-history", "近期销速"), product("demand-pulse", "已验收需求修正"), product("unified-inventory", "已验收库存位置")],
    joinKeys: ["SKU", "仓/渠道", "建议日"],
    evidence: "可销天数已在补货规则与报表中实现",
    nextAction: continuous,
  }),
  contract({
    productId: "replenishment-evidence", metricId: "safetyQty", state: "implemented",
    inputs: [scm("sales-history", "需求均值与波动"), scm("sku-planning-params", "服务水平与交期参数")],
    joinKeys: ["SKU", "规则版本", "计算日"],
    evidence: "统计安全库存及样本不足降级口径已实现",
    nextAction: continuous,
  }),
  contract({
    productId: "replenishment-evidence", metricId: "suggestQty", state: "implemented",
    inputs: [scm("stock-balances", "库存"), scm("sales-history", "需求"), scm("sku-planning-params", "MOQ/倍数/周期"), scm("purchase-order-lines", "在途与未结量"), product("supply-commitment", "已验收供给承诺")],
    joinKeys: ["SKU", "仓/渠道", "建议日", "规则版本"],
    evidence: "逐日推演、MOQ/倍数与安全库存规则已实现",
    nextAction: continuous,
  }),
  contract({
    productId: "replenishment-evidence", metricId: "wape", state: "implemented",
    inputs: [scm("sales-history", "实际需求"), scm("planning-lines", "冻结预测版本")],
    joinKeys: ["SKU", "期间", "预测版本"],
    missingPolicy: "exclude_with_coverage",
    evidence: "WAPE 纯函数、预测版本对比与覆盖测试已实现",
    nextAction: continuous,
  }),

  contract({
    productId: "launch-readiness", metricId: "npdProgress", state: "implemented",
    inputs: [scm("npd-projects", "新品项目"), scm("npd-tasks", "已实例化与完成节点")],
    joinKeys: ["新品项目", "标准节点", "计划版本"],
    evidence: "69 节点进度读模型已实现",
    nextAction: continuous,
  }),
  contract({
    productId: "launch-readiness", metricId: "launchOnTimeRate", state: "not_implemented",
    inputs: [scm("npd-projects", "原承诺上市日"), scm("npd-tasks", "强制里程碑"), stream("JIANDAOYUN", "npd-milestone-observation", "外部节点佐证"), product("demand-pulse", "有效首销"), product("supply-commitment", "首单备货到货")],
    joinKeys: ["新品项目", "上市承诺版本", "首销日"],
    evidence: "进度已有，正式上市日与首销链路尚未实现",
    nextAction: "实现不可覆写的原承诺上市日、强制里程碑和首销事件链",
  }),
  contract({
    productId: "launch-readiness", metricId: "first90DayAchievement", state: "not_implemented",
    inputs: [scm("npd-projects", "获批 90 天目标与正式上市日"), product("demand-pulse", "上市后净需求"), stream("JIANDAOYUN", "product-master-observation", "新品/SKU 参照"), stream("YONYOU", "yonbip-digitalmodel-product-listproductbycondition", "ERP 产品身份佐证")],
    joinKeys: ["新品项目", "SKU", "正式上市日", "目标版本", "90 天窗口"],
    missingPolicy: "exclude_with_coverage",
    evidence: "无正式上市日、90 天目标版本和首销后计算器",
    nextAction: "建立上市基线和 30/60/90 天窗口，退款/断货分列解释",
  }),

  contract({
    productId: "exception-triangulation", metricId: "triangulationExceptionCount", state: "not_implemented",
    inputs: [scm("reconciliation-diffs", "差异受控台账"), product("demand-pulse", "简道云需求边"), product("unified-inventory", "库存边"), product("supply-commitment", "供给边"), product("order-to-cash", "订单到财务边")],
    joinKeys: ["业务日", "店铺/仓", "SKU", "差异类型"],
    evidence: "当前只有 SCM↔JST 日出库差异表，无三边通用异常计算器",
    nextAction: "四个上游产品 A2 后实现分边差异，禁止自动调平或自动定责",
  }),
  contract({
    productId: "exception-triangulation", metricId: "exceptionSlaRate", state: "not_implemented",
    inputs: [scm("reconciliation-diffs", "异常打开/关闭参考"), product("order-to-cash", "链路异常"), product("unified-inventory", "库存异常")],
    joinKeys: ["异常 ID", "Owner", "SLA 截止", "关闭证据"],
    missingPolicy: "exclude_with_coverage",
    evidence: "recon_diffs 尚无 owner、原因、SLA 和不可变关闭证据全链",
    nextAction: "建立跨系统异常责任与纠正事件链后再计算 SLA",
  }),
  contract({
    productId: "exception-triangulation", metricId: "inventoryReconciliationGap", state: "implemented",
    inputs: [product("unified-inventory", "已验收且分来源的库存差异")],
    joinKeys: ["业务日", "仓库", "SKU", "来源边"],
    evidence: "本产品只复用上游已放行差异，不重算原始库存",
    nextAction: continuous,
  }),

  contract({
    productId: "cash-sop", metricId: "salesQty", state: "implemented",
    inputs: [scm("sales-history", "正式历史销量"), product("demand-pulse", "已验收需求情景修正")],
    joinKeys: ["周", "品牌/渠道", "情景版本"],
    evidence: "销量历史聚合已实现；情景修正由上游放行控制",
    nextAction: continuous,
  }),
  contract({
    productId: "cash-sop", metricId: "onHandSystem", state: "implemented",
    inputs: [scm("stock-balances", "SCM 当前库存"), product("unified-inventory", "已验收库存位置与差异")],
    joinKeys: ["周", "品牌/渠道", "情景版本"],
    evidence: "SCM 当前库存已实现，外部差异只通过已放行上游进入",
    nextAction: continuous,
  }),
  contract({
    productId: "cash-sop", metricId: "cashGap13Week", state: "not_implemented",
    inputs: [scm("planning-lines", "13 周需求/供给计划"), scm("sop-cycles", "情景与期初现金假设"), scm("sku-costs", "产品成本"), product("demand-pulse", "需求基线"), product("supply-commitment", "支出时点与供给基线"), product("net-margin-bridge", "收入、费用与贡献基线")],
    joinKeys: ["周", "品牌/渠道", "情景版本", "币种"],
    evidence: "公式已固化为逐周累积路径最低点，但无可重放 13 周现金引擎",
    nextAction: "实现带版本的周流入/流出时间轴，缺失输入留白并禁止发布情景",
  }),
  contract({
    productId: "cash-sop", metricId: "scenarioCoverage", state: "not_implemented",
    inputs: [product("demand-pulse", "需求输入门禁"), product("unified-inventory", "库存输入门禁"), product("supply-commitment", "供给输入门禁"), product("net-margin-bridge", "收入/成本/现金输入门禁")],
    joinKeys: ["情景版本", "必需输入类型"],
    missingPolicy: "exclude_with_coverage",
    evidence: "上游产品门禁已有，尚无情景输入覆盖读模型",
    nextAction: "实现按情景版本的必需输入清单，任一缺失都显示缺口而非补零",
  }),
].sort((left, right) =>
  left.productId.localeCompare(right.productId) || left.metricId.localeCompare(right.metricId));

const CONTRACT_BY_KEY = new Map(
  DATA_PRODUCT_METRIC_LINEAGE_CONTRACTS.map((item) => [`${item.productId}\u0000${item.metricId}`, item]),
);

export function getDataProductMetricLineage(
  productId: string,
  metricId: string,
): DataProductMetricLineageContract | null {
  return CONTRACT_BY_KEY.get(`${productId}\u0000${metricId}`) ?? null;
}

/** Stable, non-secret scope bound into release approvals. */
export function dataProductMetricLineageScope(productId: string, metricIds: readonly string[]) {
  return [...metricIds].sort().map((metricId) => {
    const item = getDataProductMetricLineage(productId, metricId);
    return item
      ? {
          productId,
          metricId,
          state: item.state,
          outputGrain: item.outputGrain,
          inputs: [...item.inputs]
            .map((input) => ({ kind: input.kind, source: input.source ?? null, ref: input.ref }))
            .sort((a, b) => `${a.kind}:${a.source}:${a.ref}`.localeCompare(`${b.kind}:${b.source}:${b.ref}`)),
          joinKeys: [...item.joinKeys],
          missingPolicy: item.missingPolicy,
        }
      : { productId, metricId, state: "missing_contract" as const };
  });
}
