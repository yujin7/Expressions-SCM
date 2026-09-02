/**
 * 三方数据逐流业务语义契约。
 *
 * “接口能读到”与“字段能被 BI 正确解释”是两件事。本注册表只记录稳定、可审计的
 * 业务语义：粒度、业务时间、编码命名空间、数量单位、币种/精度、正负号、状态、
 * 库存范围与纠错方式。未知语义保持阻断，不从字段名或一次样本猜测。
 */

export type CrossSystemSemanticSource = "JIANDAOYUN" | "JST" | "YONYOU";

export type CrossSystemSemanticDomain =
  | "grain"
  | "business_time"
  | "identifier_namespace"
  | "quantity_unit"
  | "currency"
  | "amount_scale"
  | "sign_convention"
  | "status_semantics"
  | "inventory_scope"
  | "correction_semantics";

export type CrossSystemSemanticState =
  | "implemented"
  | "business_review_pending"
  | "schema_profile_pending"
  | "not_implemented"
  | "not_available"
  | "missing_contract";

export interface CrossSystemSemanticControl {
  state: Exclude<CrossSystemSemanticState, "missing_contract">;
  evidence: string;
  nextAction: string;
}

export interface CrossSystemSemanticStreamContract {
  source: CrossSystemSemanticSource;
  stream: string;
  grain: string;
  controls: Partial<Record<CrossSystemSemanticDomain, CrossSystemSemanticControl>>;
}

export type CrossSystemSemanticRequirements = Partial<Record<
  CrossSystemSemanticSource,
  Record<string, CrossSystemSemanticDomain[]>
>>;

export const CROSS_SYSTEM_SEMANTIC_CONTRACT_VERSION = "cross-system-semantic/v1" as const;

export const CROSS_SYSTEM_SEMANTIC_LABEL: Record<CrossSystemSemanticDomain, string> = {
  grain: "业务粒度",
  business_time: "业务时间",
  identifier_namespace: "编码命名空间",
  quantity_unit: "数量单位",
  currency: "币种",
  amount_scale: "金额精度",
  sign_convention: "正负号口径",
  status_semantics: "状态语义",
  inventory_scope: "库存范围",
  correction_semantics: "纠错/冲销语义",
};

export const CROSS_SYSTEM_SEMANTIC_STATE_LABEL: Record<CrossSystemSemanticState, string> = {
  implemented: "语义已固化",
  business_review_pending: "待业务复核",
  schema_profile_pending: "待真实结构画像",
  not_implemented: "尚未实现",
  not_available: "当前契约不提供",
  missing_contract: "缺少语义契约",
};

const implemented = (evidence: string): CrossSystemSemanticControl => ({
  state: "implemented",
  evidence,
  nextAction: "持续以控制总量和业务 UAT 监测语义漂移",
});

const reviewPending = (evidence: string, nextAction: string): CrossSystemSemanticControl => ({
  state: "business_review_pending",
  evidence,
  nextAction,
});

const schemaPending = (evidence: string, nextAction: string): CrossSystemSemanticControl => ({
  state: "schema_profile_pending",
  evidence,
  nextAction,
});

const notImplemented = (evidence: string, nextAction: string): CrossSystemSemanticControl => ({
  state: "not_implemented",
  evidence,
  nextAction,
});

const notAvailable = (evidence: string, nextAction: string): CrossSystemSemanticControl => ({
  state: "not_available",
  evidence,
  nextAction,
});

const yonyouProfilePending = (
  stream: string,
  grain: string,
): CrossSystemSemanticStreamContract => ({
  source: "YONYOU",
  stream,
  grain,
  controls: Object.fromEntries(([
    "grain",
    "business_time",
    "identifier_namespace",
    "quantity_unit",
    "currency",
    "amount_scale",
    "sign_convention",
    "status_semantics",
    "inventory_scope",
    "correction_semantics",
  ] satisfies CrossSystemSemanticDomain[]).map((domain) => [
    domain,
    schemaPending(
      "当前只有受控原始响应与无值结构画像能力，目标租户真实字段尚未授权读取",
      `授权并读取 ${stream} 后，依据真实字段画像评审该语义；禁止从接口名称猜测`,
    ),
  ])) as Partial<Record<CrossSystemSemanticDomain, CrossSystemSemanticControl>>,
});

export const CROSS_SYSTEM_SEMANTIC_STREAM_CONTRACTS: CrossSystemSemanticStreamContract[] = [
  {
    source: "JIANDAOYUN",
    stream: "tmall-sku-crosswalk-observation",
    grain: "店铺 × 天猫平台 SKU",
    controls: {
      grain: implemented("业务键固定为 shopName + platformSkuId"),
      identifier_namespace: implemented("平台 SKU、商家编码、条码分列保存；只有条码进入精确身份治理"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "pdd-sku-crosswalk-observation",
    grain: "店铺 × 拼多多平台 SKU",
    controls: {
      grain: implemented("业务键固定为 shopName + platformSkuId"),
      identifier_namespace: reviewPending(
        "商家 SKU 编码与 SCM 编码已证实不是同一命名空间，当前只作观察",
        "由电商/商品团队确认拼多多商家编码命名空间及权威桥，不得按同名自动映射",
      ),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "vip-product-crosswalk-observation",
    grain: "唯品会平台商品",
    controls: {
      grain: implemented("业务键固定为 platformProductId"),
      identifier_namespace: implemented("平台商品/SKU、货号与条码分列；仅唯一条码进入精确身份治理"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "tmall-sku-sales-observation",
    grain: "统计日 × 店铺 × 天猫 SKU",
    controls: {
      grain: implemented("业务键固定为 statisticalDate + shopName + skuId"),
      business_time: implemented("statisticalDate 是平台统计业务日，不用同步时间替代"),
      quantity_unit: implemented("paidNumber/placedOrdersNumber 为平台订单件数，保持原始件数口径"),
      currency: implemented("金额仅保留平台原币观察；未与其他币种混加"),
      amount_scale: implemented("金额按两位小数验证并以十进制字符串处理"),
      sign_convention: implemented("销售件数与金额为正向规模，退款在独立退款流扣减"),
      correction_semantics: implemented("净需求固定由支付件数减成功退款件数；跨月退款保留在退款业务日"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "tmall-sku-refund-observation",
    grain: "统计日 × 店铺 × 天猫 SKU",
    controls: {
      grain: implemented("业务键固定为 statisticalDate + shopName + skuId"),
      business_time: implemented("statisticalDate 是退款统计业务日，允许与原销售跨期"),
      quantity_unit: implemented("successRefundSuborderNumber 为成功退款子订单件数"),
      currency: implemented("successRefundAmount 保留平台原币观察；未与其他币种混加"),
      amount_scale: implemented("退款金额按两位小数验证并以十进制字符串处理"),
      sign_convention: implemented("源端退款量/额保留正向绝对量，净需求计算时显式相减"),
      correction_semantics: implemented("跨月退款不回写旧销售批次，按退款业务日形成独立不可变事实"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "platform-fee-observation",
    grain: "统计日 × 店铺 × 费用项 × 源记录",
    controls: {
      grain: implemented("源表同一业务维度可多行，不伪造聚合唯一键；以不可变源记录保留"),
      business_time: implemented("统计日期与源更新时间分开披露，BI 期间使用统计日期"),
      currency: implemented("计费币种与支付币种分列；只允许同币种聚合"),
      amount_scale: implemented("计费/支付金额按两位小数验证并以十进制字符串处理"),
      sign_convention: implemented("负数是冲销/退回，原样保留，禁止取绝对值"),
      correction_semantics: implemented("冲销作为同期间/后续期间独立行累加，不覆盖原始费用行"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "product-master-observation",
    grain: "简道云产品编码",
    controls: {
      grain: implemented("业务键固定为 productCode"),
      identifier_namespace: implemented("简道云产品编码保留为来源作用域编码，通过受控别名映射到 SCM"),
      quantity_unit: implemented("unit 仅作为来源产品单位属性，不自动换算 SCM 基础单位"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "purchase-demand-observation",
    grain: "采购需求单号 × 产品编码",
    controls: {
      grain: implemented("业务键固定为 requestNo + productCode"),
      business_time: implemented("申请时间与计划到货时间分列，不用同步时间替代"),
      quantity_unit: reviewPending("需求量/已采购量携带来源单位，但尚无逐 SKU 基础单位换算契约", "冻结来源单位到 SCM 基础单位的逐 SKU 换算并完成控制总量 UAT"),
      status_semantics: reviewPending("报价、收货、采购与付款状态原样观察，尚未冻结跨系统状态枚举", "由采购/财务确认状态映射与终态/撤销语义"),
      correction_semantics: notImplemented("当前为历史只读观察，未形成取消/改单版本链", "确认源端改单与取消机制后建立不覆盖旧证据的版本语义"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "purchase-order-observation",
    grain: "采购订单 × 明细行",
    controls: {
      grain: implemented("表头 orderNo 与 lines 明细保持父子结构并执行表头/明细对账"),
      business_time: implemented("签订日、交期、审批日分列，承诺分析使用交期"),
      quantity_unit: reviewPending("明细单位与数量已保留，但尚无逐 SKU 基础单位换算契约", "冻结采购单位到 SCM 基础单位的逐 SKU 换算并完成控制总量 UAT"),
      amount_scale: implemented("价格/金额按两位小数验证并使用十进制运算"),
      status_semantics: reviewPending("收货、开票、付款、审批状态仍是来源枚举", "冻结跨系统状态映射，明确草稿、取消、驳回与终态"),
      correction_semantics: notImplemented("观察层尚未建立改单/取消版本链", "确认源端修改与删除语义后建立只追加版本和撤销标记"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "purchase-receipt-observation",
    grain: "采购入库单 × 明细行",
    controls: {
      grain: implemented("表头 receiptNo 与 lines 明细保持父子结构并执行表头/明细对账"),
      business_time: implemented("收货、验收与确认时间分列；到货分析使用 receivedAt"),
      quantity_unit: reviewPending("订购/到货/不合格/实收量携带来源单位，但尚无基础单位换算", "冻结采购单位到 SCM 基础单位的逐 SKU 换算并完成数量对账"),
      amount_scale: implemented("入库金额与含税单价按两位小数验证并使用十进制运算"),
      status_semantics: reviewPending("确认与不合格状态仍是来源枚举", "由采购/质量确认入库确认、退货和不合格终态映射"),
      correction_semantics: notImplemented("观察层尚未建立红冲/退货版本链", "取得源端冲销/退货标识后建立只追加纠错语义"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "supplier-observation",
    grain: "简道云供应商编码",
    controls: {
      grain: implemented("业务键固定为 supplierCode"),
      identifier_namespace: implemented("供应商编码保留在 JIANDAOYUN 作用域，通过人工裁决映射"),
      currency: reviewPending("授信额度没有固化币种字段", "确认授信额度币种；未确认前不得跨供应商或与财务余额合并"),
      status_semantics: reviewPending("等级、类别、结算条款为来源枚举", "冻结供应商等级、类别和结算条款映射"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "warehouse-observation",
    grain: "简道云仓库编码",
    controls: {
      grain: implemented("业务键固定为 warehouseCode"),
      identifier_namespace: implemented("仓库编码保留在 JIANDAOYUN 作用域，通过人工裁决映射"),
      quantity_unit: implemented("capacityM3 明确为立方米，仅作登记容量观察"),
      status_semantics: reviewPending("仓库状态尚未冻结到 SCM 启用/停用语义", "由仓储确认状态映射，禁止自动停用 SCM 仓库"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "warehouse-transfer-observation",
    grain: "调拨单 × 明细行",
    controls: {
      grain: implemented("表头 transferNo 与 lines 明细保持父子结构"),
      business_time: implemented("申请、预计到货、出库和入库时间分列"),
      quantity_unit: reviewPending("调拨数量携带来源单位，但尚无逐 SKU 基础单位换算", "冻结来源单位换算后再与 SCM 调拨数量对账"),
      status_semantics: reviewPending("出入库确认是来源布尔/枚举观察", "冻结在途、已出、已入、取消状态映射"),
      correction_semantics: notImplemented("尚未取得取消或逆向调拨版本语义", "确认源端取消/逆向流程并建立只追加纠错契约"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "inventory-count-observation",
    grain: "盘点单 × 明细行",
    controls: {
      grain: implemented("表头 countNo 与 lines 明细保持父子结构"),
      business_time: implemented("盘点开始和完成时间分列，差异归属完成日"),
      quantity_unit: reviewPending("账面/实盘/盘盈盘亏量携带来源单位，尚无基础单位换算", "冻结逐 SKU 单位换算后再做账实数量对账"),
      sign_convention: implemented("盘亏与盘盈分列为正向绝对量，不互相轧差"),
      correction_semantics: notImplemented("历史观察未取得复盘/重盘版本链", "确认重盘与作废语义后保留版本并禁止覆盖旧盘点"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "sample-management-observation",
    grain: "样品批次 × 新/老产品明细",
    controls: {
      grain: implemented("新产品与现有产品明细分列并保留父批次"),
      business_time: implemented("寄出、批准和批次截止分列"),
      quantity_unit: reviewPending("样品数量携带来源单位，尚无逐 SKU/物料单位换算", "冻结样品单位换算并核对收货总量"),
      amount_scale: implemented("样品总值保留两位小数观察"),
      status_semantics: reviewPending("收货、检验、批准、入库状态尚未冻结枚举", "由质量/新品团队确认状态与终态语义"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "npd-milestone-observation",
    grain: "新品项目 × 里程碑",
    controls: {
      grain: notAvailable("尚未取得新品里程碑读取契约", "确认真实简道云表单、业务键与里程碑子表后实现受控读取"),
      business_time: notAvailable("尚未取得计划/实际里程碑字段", "取得真实表单后区分计划日、实际日与修改时间"),
      identifier_namespace: notAvailable("尚未取得新品项目与 SKU/SPU 对照字段", "取得真实字段后建立来源作用域项目/SKU 身份治理"),
      status_semantics: notAvailable("尚未取得里程碑状态枚举", "由新品团队冻结阶段、跳过、取消与重开语义"),
      correction_semantics: notAvailable("尚未取得改期与重开历史", "确认源端版本/审计能力后建立不可变变更链"),
    },
  },
  {
    source: "JST",
    stream: "item-master",
    grain: "聚水潭商品 SKU",
    controls: {
      grain: implemented("每行以 skuCode 为来源商品粒度"),
      business_time: implemented("按 modified_at 日窗口读取，sourceAsOf 与同步时间分开"),
      identifier_namespace: implemented("skuCode/itemId 保留为 JST 来源标识，skuCode 进入 JST 作用域精确认领"),
      status_semantics: reviewPending("enabled 原值已保留但尚未冻结启停枚举", "确认 enabled 值域与下架/删除语义"),
    },
  },
  {
    source: "JST",
    stream: "outbound-sales-daily",
    grain: "业务日 × 聚水潭仓库 × SKU",
    controls: {
      grain: implemented("按 bizDate + warehouseCode + skuCode 聚合，并保留源出库单数量"),
      business_time: implemented("使用 io_date 完整自然日快照，不用 modified_at 替代业务日"),
      identifier_namespace: implemented("skuCode/warehouseCode/orderId 分列并进入 JST 作用域治理"),
      quantity_unit: reviewPending("qty 按四位小数保留，但尚未证明与 SCM SKU 基础单位一致", "取得聚水潭商品单位/换算关系并完成逐 SKU 数量控制总量 UAT"),
      sign_convention: implemented("只聚合非负出库量；负数拒收并要求人工判定退货/冲销"),
      status_semantics: implemented("只将 Confirmed/Archive 计入已出库，其他状态不聚合"),
      correction_semantics: reviewPending("负数不进入销量，退货/红冲尚未与全渠道退货契约闭环", "取得全渠道退货及冲销契约，冻结净出库计算与跨日更正规则"),
    },
  },
  {
    source: "JST",
    stream: "inventory-total-delta",
    grain: "观察时点 × SKU × 聚水潭全仓合计（变更增量）",
    controls: {
      grain: implemented("每行是 sku-all-jst-warehouses 的变更记录，不是逐仓快照"),
      business_time: implemented("observedAt 是观察时点，sourceAsOf 是上海业务日"),
      identifier_namespace: implemented("skuCode 进入 JST 作用域精确认领"),
      quantity_unit: reviewPending("库存相关数量按 API 原单位保留，尚未证明与 SCM 基础单位一致", "取得商品单位/换算关系并做逐 SKU 数量控制总量 UAT"),
      inventory_scope: notAvailable("当前官方契约不带 wms_co_id 时只返回全仓合计，缺失行也不等于零", "取得逐仓库存授权/契约；在此之前只作全仓差异观察，禁止替代仓库库存"),
      correction_semantics: implemented("游标增量只表示发生变化；必须通过最新值折叠，不将各批次 qty 相加"),
    },
  },
  {
    source: "JST",
    stream: "inbound-receipts-daily",
    grain: "采购入库单 × 明细/批次",
    controls: {
      grain: implemented("receiptId 为表头，items/batches 保留明细与批次父子关系"),
      business_time: implemented("receiptDate 与 modifiedAt 分列，业务截止使用收货日窗口"),
      identifier_namespace: implemented("SKU、仓库、供应商与单号保留来源标识；SKU/仓库进入 JST 作用域治理"),
      quantity_unit: reviewPending("入库数量按 API 原单位保留，尚未证明与 SCM 基础单位一致", "取得商品/采购单位换算并完成表头、明细、批次数量对账"),
      status_semantics: reviewPending("receiptType/status 原值已保留但尚未冻结可计入状态", "由采购/仓储确认完成、取消、退货和红冲状态"),
      correction_semantics: reviewPending("批次/明细保留但退货与冲销链尚未冻结", "取得退货/红冲标识并建立只追加纠错与原单关联"),
    },
  },
  {
    source: "JST",
    stream: "orders-daily",
    grain: "业务日 × 店铺 × 来源订单 × SKU",
    controls: Object.fromEntries(([
      "grain", "business_time", "identifier_namespace", "quantity_unit", "currency",
      "amount_scale", "sign_convention", "status_semantics", "correction_semantics",
    ] satisfies CrossSystemSemanticDomain[]).map((domain) => [
      domain,
      notAvailable(
        "覆盖淘系/拼多多的全渠道订单读取契约尚未取得，标准订单接口不能冒充目标",
        "由聚水潭确认全渠道授权、商家路由、店铺覆盖、字段与状态后冻结语义契约",
      ),
    ])) as Partial<Record<CrossSystemSemanticDomain, CrossSystemSemanticControl>>,
  },
  {
    source: "JST",
    stream: "returns-daily",
    grain: "业务日 × 店铺 × 来源退货/售后单 × SKU",
    controls: Object.fromEntries(([
      "grain", "business_time", "identifier_namespace", "quantity_unit", "currency",
      "amount_scale", "sign_convention", "status_semantics", "correction_semantics",
    ] satisfies CrossSystemSemanticDomain[]).map((domain) => [
      domain,
      notAvailable(
        "覆盖淘系/拼多多的全渠道退货契约尚未取得，标准售后接口只覆盖自有商城",
        "由聚水潭确认全渠道售后授权、原订单关联、退款/退货状态与字段后冻结语义契约",
      ),
    ])) as Partial<Record<CrossSystemSemanticDomain, CrossSystemSemanticControl>>,
  },
  yonyouProfilePending("yonbip-uspace-org-page-list", "租户 × 组织"),
  yonyouProfilePending("yonbip-digitalmodel-vendor-list", "租户/组织 × 供应商"),
  yonyouProfilePending("yonbip-digitalmodel-product-listproductbycondition", "租户/组织 × 物料/产品"),
  yonyouProfilePending("yonbip-scm-purchaseorder-list", "租户/组织 × 采购订单 × 明细"),
  yonyouProfilePending("yonbip-scm-purinrecord-list", "租户/组织 × 采购入库单 × 明细"),
  yonyouProfilePending("yonbip-scm-stock-querycurrentstocksbycondition", "租户/组织 × 库存组织/仓 × 物料 × 批次"),
  yonyouProfilePending("yonbip-efi-fieia-querybalance", "租户/组织 × 会计期间 × 科目/存货维度"),
  yonyouProfilePending("yonbip-fi-ficloud-openapi-voucher-queryvouchers", "租户/组织 × 会计期间 × 凭证 × 分录"),
  {
    source: "YONYOU",
    stream: "yonbip-finance-receivables-settlement",
    grain: "租户/组织 × 应收/收款/核销链",
    controls: Object.fromEntries(([
      "grain", "business_time", "identifier_namespace", "currency", "amount_scale",
      "sign_convention", "status_semantics", "correction_semantics",
    ] satisfies CrossSystemSemanticDomain[]).map((domain) => [
      domain,
      notAvailable(
        "目标租户官方 API 目录尚未确认应收、收款与核销只读契约",
        "先确认官方契约与授权，再用真实响应建立字段画像和业务语义；禁止猜路径",
      ),
    ])) as Partial<Record<CrossSystemSemanticDomain, CrossSystemSemanticControl>>,
  },
];

const CONTRACT_BY_KEY = new Map(
  CROSS_SYSTEM_SEMANTIC_STREAM_CONTRACTS.map((contract) => [
    `${contract.source}\u0000${contract.stream}`,
    contract,
  ]),
);

export function getCrossSystemSemanticStreamContract(
  source: CrossSystemSemanticSource,
  stream: string,
): CrossSystemSemanticStreamContract | null {
  return CONTRACT_BY_KEY.get(`${source}\u0000${stream}`) ?? null;
}

/**
 * 稳定、无凭据的放行范围；只绑定“产品要求什么”和“当前静态契约允许什么”。
 * 说明文案调整不使旧放行失效，控制状态或适用范围变化会失效。
 */
export function crossSystemSemanticScope(requirements: CrossSystemSemanticRequirements) {
  return (Object.entries(requirements) as [CrossSystemSemanticSource, Record<string, CrossSystemSemanticDomain[]>][])
    .flatMap(([source, streams]) => Object.entries(streams).flatMap(([stream, domains]) => {
      const contract = getCrossSystemSemanticStreamContract(source, stream);
      return [...domains].sort().map((domain) => ({
        source,
        stream,
        domain,
        state: contract?.controls[domain]?.state ?? "missing_contract",
      }));
    }))
    .sort((left, right) =>
      left.source.localeCompare(right.source)
      || left.stream.localeCompare(right.stream)
      || left.domain.localeCompare(right.domain)
    );
}
