/**
 * 跨系统统一身份维度。
 *
 * 这里只定义业务语义与可用状态，不承载外部原值。外部原值仍留在
 * scoped aliases / sku identifiers / external document references / immutable staging 中。
 */

export type CrossSystemIdentityDomain =
  | "sku"
  | "warehouse"
  | "supplier"
  | "channel"
  | "shop"
  | "organization"
  | "document";

export type CrossSystemIdentityState =
  | "ready"
  | "partial"
  | "missing"
  | "not_implemented";

export type CrossSystemIdentityGovernance =
  | "scoped_alias"
  | "external_reference"
  | "planned_master";

export const CROSS_SYSTEM_IDENTITY_LABEL: Record<CrossSystemIdentityDomain, string> = {
  sku: "SKU / 条码",
  warehouse: "仓库",
  supplier: "供应商",
  channel: "渠道",
  shop: "店铺",
  organization: "组织",
  document: "业务单号",
};

export const CROSS_SYSTEM_IDENTITY_ORDER: CrossSystemIdentityDomain[] = [
  "sku",
  "warehouse",
  "supplier",
  "channel",
  "shop",
  "organization",
  "document",
];

export interface CrossSystemIdentityCoverage {
  domain: CrossSystemIdentityDomain;
  label: string;
  governance: CrossSystemIdentityGovernance;
  state: CrossSystemIdentityState;
  /** 去重后外部身份候选数；没有候选证据时为 0，不表示业务真实为零。 */
  observed: number;
  /** 已由当前来源 scope 精确认领的身份数。 */
  governed: number;
  open: number;
  ignored: number;
  coveragePct: number | null;
  reason: string;
  nextAction: string;
}

/**
 * 逐数据流身份提取契约。
 *
 * 来源级覆盖只回答“这个来源曾出现多少身份候选、认领了多少”；这里进一步回答
 * “本数据产品依赖的这一条流，是否真的把该身份送进受控治理”。两层必须同时通过。
 * 未登记的流/维度默认拒绝，不能用同来源另一条流的候选数代打通行证明。
 */
export type CrossSystemIdentityExtractionState =
  | "implemented"
  | "not_implemented"
  | "schema_profile_pending"
  | "not_available"
  | "missing_contract";

export type CrossSystemIdentitySource = "JIANDAOYUN" | "JST" | "YONYOU";

export interface CrossSystemIdentityExtractionControl {
  state: Exclude<CrossSystemIdentityExtractionState, "missing_contract">;
  evidence: string;
  nextAction: string;
}

export interface CrossSystemIdentityStreamContract {
  source: CrossSystemIdentitySource;
  stream: string;
  identities: Partial<Record<CrossSystemIdentityDomain, CrossSystemIdentityExtractionControl>>;
}

export const CROSS_SYSTEM_IDENTITY_EXTRACTION_CONTRACT_VERSION =
  "cross-system-identity-extraction/v1" as const;

export const CROSS_SYSTEM_IDENTITY_EXTRACTION_STATE_LABEL: Record<
  CrossSystemIdentityExtractionState,
  string
> = {
  implemented: "已进入治理",
  not_implemented: "尚未提取",
  schema_profile_pending: "待真实结构画像",
  not_available: "当前契约不可提供",
  missing_contract: "缺少提取契约",
};

const implemented = (
  evidence: string,
  nextAction = "持续监测逐流候选、未认领与结构漂移",
): CrossSystemIdentityExtractionControl => ({ state: "implemented", evidence, nextAction });

const notImplemented = (
  evidence: string,
  nextAction: string,
): CrossSystemIdentityExtractionControl => ({ state: "not_implemented", evidence, nextAction });

const schemaProfilePending = (
  evidence: string,
  nextAction = "先取得已授权的真实只读响应样本，冻结字段画像后实现精确映射与候选入队",
): CrossSystemIdentityExtractionControl => ({ state: "schema_profile_pending", evidence, nextAction });

const notAvailable = (
  evidence: string,
  nextAction: string,
): CrossSystemIdentityExtractionControl => ({ state: "not_available", evidence, nextAction });

/**
 * 当前实现事实的静态登记表；只记录字段到受控身份治理的可达性，不记录任何外部原值或凭据。
 * identities 中未出现的维度表示该流不提供该维度，而不是已经实现。
 */
export const CROSS_SYSTEM_IDENTITY_STREAM_CONTRACTS: readonly CrossSystemIdentityStreamContract[] = [
  {
    source: "JIANDAOYUN",
    stream: "tmall-sku-crosswalk-observation",
    identities: {
      sku: implemented("条码字段已按 JIANDAOYUN 作用域进入 SKU 精确解析/人工认领队列"),
      shop: notImplemented("店铺字段尚未进入受控店铺主档/别名治理", "建立来源作用域店铺主档并将天猫店铺身份逐值入队"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "pdd-sku-crosswalk-observation",
    identities: {
      sku: notImplemented("商家编码属于另一外部命名空间，当前仅作观察，不允许冒充 SCM SKU", "冻结拼多多商家编码命名空间并建立精确、人工确认的 SKU 对照"),
      shop: notImplemented("店铺字段尚未进入受控店铺主档/别名治理", "建立来源作用域店铺主档并将拼多多店铺身份逐值入队"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "vip-product-crosswalk-observation",
    identities: {
      sku: implemented("产品条码已按 JIANDAOYUN 作用域进入 SKU 精确解析/人工认领队列"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "tmall-sku-sales-observation",
    identities: {
      sku: notImplemented("当前只有平台 SKU 标识，尚未形成受控跨系统 SKU 对照分母", "复用已验收的天猫 SKU 对照，并把未匹配平台 SKU 逐值入队"),
      shop: notImplemented("销量流店铺身份尚未进入受控店铺治理", "建立店铺主档并固化销量流店铺映射"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "tmall-sku-refund-observation",
    identities: {
      sku: notImplemented("退款流平台 SKU 尚未进入受控跨系统对照", "复用已验收的天猫 SKU 对照，并把退款流未匹配值逐值入队"),
      shop: notImplemented("退款流店铺身份尚未进入受控店铺治理", "建立店铺主档并固化退款流店铺映射"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "platform-fee-observation",
    identities: {
      channel: notImplemented("渠道目前由表单语义隐含，尚无受控渠道主档/别名", "建立渠道主档并将费用流渠道身份显式入队"),
      shop: notImplemented("费用流店铺身份尚未进入受控店铺治理", "建立店铺主档并冻结费用归属口径"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "product-master-observation",
    identities: { sku: implemented("产品编码已按 JIANDAOYUN 作用域进入 SKU 精确解析/人工认领队列") },
  },
  {
    source: "JIANDAOYUN",
    stream: "purchase-demand-observation",
    identities: {
      sku: implemented("产品编码已进入 SKU 精确解析/认领"),
      supplier: implemented("供应商编码/名称已进入来源作用域精确解析/认领"),
      warehouse: implemented("仓库编码/名称已进入来源作用域精确解析/认领"),
      document: notImplemented("需求单号尚未进入外部单据引用表", "以来源+单据类型+单号登记不可变外部单据引用"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "purchase-order-observation",
    identities: {
      sku: implemented("产品编码已进入 SKU 精确解析/认领"),
      supplier: implemented("供应商编码/名称已进入来源作用域精确解析/认领"),
      warehouse: implemented("仓库编码/名称已进入来源作用域精确解析/认领"),
      document: notImplemented("采购单号尚未进入外部单据引用表", "以来源+单据类型+单号登记不可变外部单据引用"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "purchase-receipt-observation",
    identities: {
      sku: implemented("产品编码已进入 SKU 精确解析/认领"),
      supplier: implemented("供应商编码/名称已进入来源作用域精确解析/认领"),
      warehouse: implemented("仓库编码/名称已进入来源作用域精确解析/认领"),
      document: notImplemented("入库单号尚未进入外部单据引用表", "以来源+单据类型+单号登记不可变外部单据引用"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "supplier-observation",
    identities: { supplier: implemented("供应商编码/名称已进入来源作用域精确解析/认领") },
  },
  {
    source: "JIANDAOYUN",
    stream: "warehouse-observation",
    identities: { warehouse: implemented("仓库编码/名称已进入来源作用域精确解析/认领") },
  },
  {
    source: "JIANDAOYUN",
    stream: "warehouse-transfer-observation",
    identities: {
      sku: implemented("产品编码已进入 SKU 精确解析/认领"),
      warehouse: implemented("调出/调入仓已分别进入来源作用域精确解析/认领"),
      document: notImplemented("调拨单号尚未进入外部单据引用表", "以来源+单据类型+单号登记不可变外部单据引用"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "inventory-count-observation",
    identities: {
      sku: implemented("产品编码已进入 SKU 精确解析/认领"),
      warehouse: implemented("仓库编码/名称已进入来源作用域精确解析/认领"),
      document: notImplemented("盘点单号尚未进入外部单据引用表", "以来源+单据类型+单号登记不可变外部单据引用"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "sample-management-observation",
    identities: {
      sku: implemented("产品编码已进入 SKU 精确解析/认领"),
      supplier: implemented("供应商编码/名称已进入来源作用域精确解析/认领"),
      warehouse: implemented("仓库编码/名称已进入来源作用域精确解析/认领"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "tmall-unit-daily-observation",
    identities: {
      sku: implemented("条码已进入 JIANDAOYUN 作用域精确解析/人工认领；子货品编码只作精确候选线索，不自动认领"),
      shop: notImplemented("店铺字段已保留但尚未进入受控店铺治理", "建立来源作用域店铺主档并逐值认领"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "pdd-order-observation",
    identities: {
      sku: notImplemented("商家 SKU 编码已保留，但与 SCM SKU 不是已证实的同一命名空间", "通过已验收的拼多多对照表精确映射，冲突和缺失值进人工认领"),
      shop: notImplemented("店铺字段已保留但尚未进入受控店铺治理", "建立来源作用域店铺主档并逐值认领"),
      document: notImplemented("订单号已保留在不可变观察行，尚未登记为外部单据引用", "以来源+订单类型+单号登记外部单据引用"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "vip-shop-trading-observation",
    identities: {
      shop: notImplemented("店铺与品牌只保留在品牌级观察中，尚未进入店铺主档", "建立唯品会店铺主档并完成品牌归属 UAT"),
      channel: notImplemented("渠道由表单语义隐含，尚未用受控渠道身份显式标识", "绑定唯品会渠道主档并冻结店铺归属"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "tmall-product-pnl-observation",
    identities: {
      sku: notAvailable("当前粒度只到平台商品，没有可唯一归属的 SKU 字段", "仅作商品级损益观察；取得商品→SKU 受控关系前不下沉到 SKU"),
      shop: notImplemented("店铺字段已保留但尚未进入受控店铺治理", "建立来源作用域店铺主档并逐值认领"),
      channel: notImplemented("渠道由表单语义隐含，尚未用受控渠道身份显式标识", "绑定天猫渠道主档并冻结店铺归属"),
    },
  },
  {
    source: "JIANDAOYUN",
    stream: "npd-milestone-observation",
    identities: {
      sku: notImplemented("目标流尚未实现，里程碑产品身份未进入治理", "先冻结新品里程碑读取契约，再将产品编码精确映射到 SCM SKU"),
    },
  },
  {
    source: "JST",
    stream: "item-master",
    identities: { sku: implemented("聚水潭商品编码已按 JST 作用域进入 SKU 精确解析/人工认领队列") },
  },
  {
    source: "JST",
    stream: "outbound-sales-daily",
    identities: {
      sku: implemented("出库明细 SKU 已按 JST 作用域进入精确解析/人工认领队列"),
      warehouse: implemented("出库仓已按 JST 作用域进入精确解析/人工认领队列"),
      shop: notImplemented("源响应含店铺标识，但当前聚合暂存未送入店铺治理", "建立店铺主档并在出库聚合前保留、认领店铺身份"),
      document: notImplemented("源响应含出库单号，但当前未登记为外部单据引用", "在聚合前以来源+单据类型+单号登记外部单据引用"),
    },
  },
  {
    source: "JST",
    stream: "inventory-total-delta",
    identities: {
      sku: implemented("库存 SKU 已按 JST 作用域进入精确解析/人工认领队列"),
      warehouse: notAvailable("当前官方读取按全仓汇总，不能提供可核对的仓库粒度", "取得并冻结可按仓库读取/拆分的官方契约；此前不得宣称统一仓库库存"),
    },
  },
  {
    source: "JST",
    stream: "inbound-receipts-daily",
    identities: {
      sku: implemented("入库明细 SKU 已按 JST 作用域进入精确解析/人工认领队列"),
      warehouse: implemented("入库仓已按 JST 作用域进入精确解析/人工认领队列"),
      document: notImplemented("入库单号尚未登记为外部单据引用", "以来源+单据类型+单号登记外部单据引用"),
    },
  },
  {
    source: "JST",
    stream: "orders-daily",
    identities: {
      sku: notAvailable("目标全渠道订单读取契约尚未取得，当前标准接口明确缺少部分平台订单", "取得覆盖目标平台的授权读取契约后实现 SKU 精确解析"),
      shop: notAvailable("目标全渠道订单读取契约尚未取得", "取得覆盖目标平台的授权读取契约后建立店铺治理"),
      document: notAvailable("目标全渠道订单读取契约尚未取得", "取得覆盖目标平台的授权读取契约后登记订单引用"),
    },
  },
  {
    source: "JST",
    stream: "returns-daily",
    identities: {
      sku: notAvailable("目标全渠道退货读取契约尚未取得，当前标准接口覆盖不足", "取得覆盖目标平台的授权读取契约后实现 SKU 精确解析"),
      shop: notAvailable("目标全渠道退货读取契约尚未取得", "取得覆盖目标平台的授权读取契约后建立店铺治理"),
      document: notAvailable("目标全渠道退货读取契约尚未取得", "取得覆盖目标平台的授权读取契约后登记退货单引用"),
    },
  },
  ...[
    ["yonbip-uspace-org-page-list", ["organization"]],
    ["yonbip-digitalmodel-vendor-list", ["supplier", "organization"]],
    ["yonbip-digitalmodel-product-listproductbycondition", ["sku", "organization"]],
    ["yonbip-scm-purchaseorder-list", ["sku", "supplier", "warehouse", "organization", "document"]],
    ["yonbip-scm-purinrecord-list", ["sku", "supplier", "warehouse", "organization", "document"]],
    ["yonbip-scm-stock-querycurrentstocksbycondition", ["sku", "warehouse", "organization"]],
    ["yonbip-efi-fieia-querybalance", ["organization"]],
    ["yonbip-fi-ficloud-openapi-voucher-queryvouchers", ["organization", "document"]],
  ].map(([stream, domains]) => ({
    source: "YONYOU" as const,
    stream: stream as string,
    identities: Object.fromEntries((domains as CrossSystemIdentityDomain[]).map((domain) => [
      domain,
      schemaProfilePending("当前只保存不可变原始响应；在获得授权真实样本前刻意不猜测字段含义"),
    ])),
  })),
  {
    source: "YONYOU",
    stream: "yonbip-finance-receivables-settlement",
    identities: {
      organization: notAvailable("应收/收款/核销的准确只读契约尚未在目标租户冻结", "先在目标租户官方 API 目录确认并冻结组织字段"),
      document: notAvailable("应收/收款/核销的准确只读契约尚未在目标租户冻结", "先冻结业务单号与核销引用字段，再实现外部单据引用"),
    },
  },
];

const EXTRACTION_CONTRACT_BY_KEY = new Map(
  CROSS_SYSTEM_IDENTITY_STREAM_CONTRACTS.map((contract) => [
    `${contract.source}\u0000${contract.stream}`,
    contract,
  ]),
);

export function getCrossSystemIdentityStreamContract(
  source: CrossSystemIdentitySource,
  stream: string,
): CrossSystemIdentityStreamContract | null {
  return EXTRACTION_CONTRACT_BY_KEY.get(`${source}\u0000${stream}`) ?? null;
}

/** 稳定、无外部原值的发布范围片段；契约状态或说明变化会使旧放行自动失效。 */
export function crossSystemIdentityExtractionScope(
  requiredStreams: Partial<Record<CrossSystemIdentitySource, string[]>>,
  requiredIdentities: Partial<Record<CrossSystemIdentitySource, CrossSystemIdentityDomain[]>>,
) {
  return (Object.entries(requiredStreams) as [CrossSystemIdentitySource, string[]][])
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([source, streams]) => [...streams].sort().map((stream) => {
      const contract = getCrossSystemIdentityStreamContract(source, stream);
      const required = [...(requiredIdentities[source] ?? [])].sort();
      return {
        source,
        stream,
        identities: required.map((domain) => {
          const control = contract?.identities[domain];
          return {
            domain,
            applicable: control != null,
            state: control?.state ?? (contract ? null : "missing_contract"),
          };
        }),
      };
    }));
}
