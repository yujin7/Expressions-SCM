/**
 * 契约 → 下游读模型 的**唯一登记处**（2026-09-04 审计 #13）。
 *
 * 事故形态：运维面板的连接器卡只说「已选 N 条契约」，不说这些契约拉回来的数据**有没有人读**。
 * 本表只证明代码登记了哪些下游读模型；它不读取运行配置、批次或 UAT，
 * 不能据此声称某条契约已启用、成功同步、消耗了配额或产生了业务成效。
 * 没有读模型的契约可能仍用于受控证据/字段画像，不能与「没有任何用途」混为一谈。
 * 这一列把「有契约定义」和「有下游读模型」分开，让没有消费者的契约显式变灰。
 *
 * 维护约定：本表是**人工登记的静态映射**，`tests/architecture/contract-consumers.test.ts`
 * 用 grep 逐条比对 `src/server/modules/**` 的真实引用——加了消费者不登记、
 * 或删了消费者不摘登记，门禁即红。不要在别处再写第二份映射。
 */

/** 消费者模块（相对 `src/server/modules/`）→ 中文名 */
export const READ_MODEL_LABELS: Readonly<Record<string, string>> = {
  "master/sales-amount.ts": "销售金额",
  "report/bonded-outbound.ts": "保税出库",
  "report/channel-observation.ts": "渠道观察",
  "report/commerce-identity-coverage.ts": "商品身份覆盖",
  "report/data-source-readiness.ts": "数据源就绪度",
  "report/external-demand-signal.ts": "外部需求信号",
  "report/external-velocity.ts": "外部销速",
  "report/jiandaoyun-supporting-observation.ts": "简道云辅助观察",
  "report/platform-fee-observation.ts": "平台费用观察",
  "report/platform-sku-identity-gap.ts": "平台身份缺口",
  "report/sales-consistency.ts": "销量一致性",
  "report/sales-spike.ts": "爆单侦测",
  "report/supplier-lead-history.ts": "供应商交期学习",
  "report/tmall-channel-contribution.ts": "天猫渠道贡献",
};

export interface ContractConsumerEntry {
  /** 连接器 key（与 `integrations/connector.ts` 同域） */
  connector: "jdy" | "yy" | "jst";
  /** 契约/数据流标识：简道云=表单契约 key，聚水潭=stream，用友=API path */
  key: string;
  label: string;
  /** 引用该 key 的读模型模块（相对 src/server/modules/）；空数组不代表同步成功或失败 */
  consumers: readonly string[];
}

/**
 * 逐条登记。`consumers` 必须与 `src/server/modules/**` 里出现该 key 字面量的文件集合完全相等。
 */
export const CONTRACT_CONSUMERS: readonly ContractConsumerEntry[] = [
  /* ── 简道云表单契约 ── */
  { connector: "jdy", key: "tmall-sku-crosswalk-observation", label: "天猫 SKU 对照表", consumers: ["report/channel-observation.ts", "report/commerce-identity-coverage.ts", "report/external-demand-signal.ts", "report/external-velocity.ts", "report/platform-sku-identity-gap.ts", "report/sales-consistency.ts", "report/sales-spike.ts"] },
  { connector: "jdy", key: "vip-product-crosswalk-observation", label: "唯品会商品对照表", consumers: ["report/commerce-identity-coverage.ts"] },
  { connector: "jdy", key: "pdd-sku-crosswalk-observation", label: "拼多多 SKU 对照表", consumers: ["report/channel-observation.ts", "report/commerce-identity-coverage.ts", "report/external-velocity.ts", "report/platform-sku-identity-gap.ts"] },
  { connector: "jdy", key: "tmall-sku-sales-observation", label: "天猫 SKU 销量", consumers: ["master/sales-amount.ts", "report/channel-observation.ts", "report/external-demand-signal.ts", "report/external-velocity.ts", "report/platform-sku-identity-gap.ts", "report/sales-consistency.ts", "report/sales-spike.ts", "report/tmall-channel-contribution.ts"] },
  { connector: "jdy", key: "tmall-sku-refund-observation", label: "天猫 SKU 退款", consumers: ["master/sales-amount.ts", "report/channel-observation.ts", "report/external-demand-signal.ts", "report/external-velocity.ts", "report/platform-sku-identity-gap.ts", "report/sales-consistency.ts", "report/tmall-channel-contribution.ts"] },
  { connector: "jdy", key: "platform-fee-observation", label: "平台费用", consumers: ["report/platform-fee-observation.ts", "report/tmall-channel-contribution.ts"] },
  { connector: "jdy", key: "product-master-observation", label: "产品主档", consumers: ["report/jiandaoyun-supporting-observation.ts"] },
  { connector: "jdy", key: "purchase-demand-observation", label: "采购需求", consumers: ["report/jiandaoyun-supporting-observation.ts"] },
  { connector: "jdy", key: "purchase-order-observation", label: "采购订单", consumers: ["report/supplier-lead-history.ts"] },
  { connector: "jdy", key: "purchase-receipt-observation", label: "采购入库", consumers: ["report/supplier-lead-history.ts"] },
  { connector: "jdy", key: "supplier-observation", label: "供应商", consumers: ["report/jiandaoyun-supporting-observation.ts"] },
  { connector: "jdy", key: "warehouse-observation", label: "仓库", consumers: ["report/jiandaoyun-supporting-observation.ts"] },
  { connector: "jdy", key: "warehouse-transfer-observation", label: "仓库调拨", consumers: ["report/jiandaoyun-supporting-observation.ts"] },
  { connector: "jdy", key: "inventory-count-observation", label: "库存盘点", consumers: ["report/jiandaoyun-supporting-observation.ts"] },
  { connector: "jdy", key: "sample-management-observation", label: "样品管理", consumers: ["report/jiandaoyun-supporting-observation.ts"] },
  { connector: "jdy", key: "tmall-unit-daily-observation", label: "天猫单品日报", consumers: ["report/platform-sku-identity-gap.ts"] },
  { connector: "jdy", key: "pdd-order-observation", label: "拼多多订单", consumers: ["report/external-velocity.ts"] },
  { connector: "jdy", key: "vip-shop-trading-observation", label: "唯品会店铺交易", consumers: ["master/sales-amount.ts", "report/channel-observation.ts"] },
  { connector: "jdy", key: "tmall-product-pnl-observation", label: "天猫商品损益", consumers: ["report/channel-observation.ts"] },
  { connector: "jdy", key: "jst-item-master-mirror-observation", label: "聚水潭商品镜像", consumers: ["report/platform-sku-identity-gap.ts"] },
  { connector: "jdy", key: "jst-bundle-bom-mirror-observation", label: "聚水潭组合装 BOM 镜像", consumers: [] },
  { connector: "jdy", key: "tmall-bundle-detail-observation", label: "天猫组合装明细", consumers: ["report/external-velocity.ts", "report/platform-sku-identity-gap.ts"] },
  { connector: "jdy", key: "pdd-sku-cost-standard-observation", label: "拼多多 SKU 标准成本", consumers: ["report/platform-sku-identity-gap.ts"] },
  { connector: "jdy", key: "vip-bundle-crosswalk-observation", label: "唯品会组合装对照", consumers: [] },
  { connector: "jdy", key: "finance-goods-master-observation", label: "财务货品主档", consumers: ["report/platform-sku-identity-gap.ts"] },
  { connector: "jdy", key: "finance-operating-cost-observation", label: "财务运营成本", consumers: [] },
  { connector: "jdy", key: "vip-sku-cost-observation", label: "唯品会 SKU 成本", consumers: [] },
  { connector: "jdy", key: "tmall-sku-cost-pnl-observation", label: "天猫 SKU 成本损益", consumers: ["report/channel-observation.ts"] },
  { connector: "jdy", key: "tmall-product-traffic-observation", label: "天猫商品流量", consumers: ["report/channel-observation.ts"] },
  { connector: "jdy", key: "pdd-product-daily-observation", label: "拼多多商品日报", consumers: ["report/channel-observation.ts"] },
  { connector: "jdy", key: "pdd-shop-daily-observation", label: "拼多多店铺日报", consumers: ["master/sales-amount.ts", "report/channel-observation.ts"] },
  { connector: "jdy", key: "shop-master-observation", label: "店铺主档", consumers: ["report/channel-observation.ts"] },
  { connector: "jdy", key: "brand-master-observation", label: "品牌主档", consumers: ["report/channel-observation.ts"] },
  { connector: "jdy", key: "bonded-warehouse-order-observation", label: "保税仓订单", consumers: ["report/bonded-outbound.ts"] },

  /* ── 聚水潭数据流 ── */
  { connector: "jst", key: "outbound-sales-daily", label: "T-1 出库日快照", consumers: ["report/data-source-readiness.ts", "report/external-demand-signal.ts"] },
  { connector: "jst", key: "inventory-total-delta", label: "全仓合计库存增量", consumers: ["report/data-source-readiness.ts"] },
  { connector: "jst", key: "item-master", label: "商品档案观察", consumers: [] },
  { connector: "jst", key: "inbound-receipts-daily", label: "入库单日观察", consumers: [] },

  /* ── 用友只读契约（按 API path 登记；全部尚无下游读模型） ── */
  { connector: "yy", key: "/yonbip/uspace/org/page_list", label: "组织架构分页查询", consumers: [] },
  { connector: "yy", key: "/yonbip/digitalModel/vendor/list", label: "供应商档案列表", consumers: [] },
  { connector: "yy", key: "/yonbip/digitalModel/product/listproductbycondition", label: "物料档案分页查询 V2", consumers: [] },
  { connector: "yy", key: "/yonbip/scm/purchaseorder/list", label: "采购订单列表", consumers: [] },
  { connector: "yy", key: "/yonbip/scm/purinrecord/list", label: "采购入库列表", consumers: [] },
  { connector: "yy", key: "/yonbip/scm/stock/QueryCurrentStocksByCondition", label: "现存量查询 V2", consumers: [] },
  { connector: "yy", key: "/yonbip/EFI/fieia/queryBalance", label: "科目余额查询", consumers: [] },
  { connector: "yy", key: "/yonbip/fi/ficloud/openapi/voucher/queryVouchers", label: "凭证查询", consumers: [] },
];

/** 未登记下游读模型的契约（页面据此把行变灰并标「无消费者」，不推断运行状态） */
export function contractsWithoutConsumer(): ContractConsumerEntry[] {
  return CONTRACT_CONSUMERS.filter((c) => c.consumers.length === 0);
}
