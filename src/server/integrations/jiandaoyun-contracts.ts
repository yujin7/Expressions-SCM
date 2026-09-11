import { createHash } from "node:crypto";
import type { JiandaoyunWidget } from "./jiandaoyun";

const CONTRACT_SET_BINDING_PREFIX = "JDY1_";

export interface JiandaoyunFieldRule {
  source: string;
  target: string;
}

export interface JiandaoyunNumericControlRule {
  target: string;
  scale: 2 | 4;
}

export interface JiandaoyunReconciliationRule {
  key: string;
  headerTarget: string;
  lineTargets: Array<{ subformTarget: string; fieldTarget: string }>;
  scale: 2 | 4;
  tolerance: string;
}

export interface JiandaoyunSubformRule extends JiandaoyunFieldRule {
  items: JiandaoyunFieldRule[];
  numericControls?: JiandaoyunNumericControlRule[];
}

export interface JiandaoyunFormContract {
  key: string;
  label: string;
  appId: string;
  entryId: string;
  targetTable: string;
  fields: JiandaoyunFieldRule[];
  subforms?: JiandaoyunSubformRule[];
  businessKey?: string[];
  numericControls?: JiandaoyunNumericControlRule[];
  freshnessMaxAgeDays?: number;
  reconciliations?: JiandaoyunReconciliationRule[];
  /**
   * 服务端时间窗：只拉最近 N 天（按该日期字段，简道云 data/list filter）。
   * 用于订单级大表——拼多多订单全量超过 1,000 页安全上限；30/90 天需求窗口只需要最近几个月。
   * 每批只观察窗口内数据（不是全量替代，也不是增量）；同步保留历史窗口批次，
   * 不套用全量快照的旧记录连续性/替代规则。读模型按各自契约筛选可用批次并去重，
   * 不能统一理解为「只取最新批次」或将空窗口视为历史事实归零。
   */
  window?: { field: string; days: number; includeUpdatedSince?: boolean };
}

const field = (target: string, source: string): JiandaoyunFieldRule => ({ target, source });
const JIANDAOYUN_SYSTEM_FIELDS = ["createTime", "updateTime", "deleteTime"] as const;

/**
 * Explicit, field-minimized contracts for the currently populated operational views.
 *
 * Contacts, phone numbers, addresses, bank accounts, tax IDs, attachments, user/dept objects and
 * images are intentionally excluded. These records remain observations in staging; no contract
 * grants authority to update SCM masters, prices, stock or documents.
 */
export const JIANDAOYUN_FORM_CONTRACTS: JiandaoyunFormContract[] = [
  /*
   * 数据中台的平台销量观察（2026-08-04 加入）。
   *
   * 背景：原有 9 条契约全部指向「采购供应链」，那批表全量拉数后 sourceAsOf 停在
   * 2024-12-11。而用服务端 filter 按 statistical_date 逐月探针查实，
   * 数据中台的这两张表 **2026 年 5~8 月每月都有数据，包括当月**——
   * 是一条活的、日级、SKU 级的销量事实来源，且当前 API key 本来就读得到。
   *
   * 字段最小化：只取统计日期/店铺/商品与 SKU 标识/件数与金额。
   * 这两张表本身不含 PII（对比 `Pdd_C.01_订单查询列表` 有消费者资料与买家留言，
   * 故**刻意不纳入**）。
   *
   * 与其余契约同样只进 staging、releaseBlocked——**不授予任何更新主档/销量正式表的权限**。
   *
   * ⚠ **净销量口径（实测 2026-07）**：退款率件数 14.7%、金额 14.5%，
   * 两张表按 `(统计日, 店铺, SKU)` 可对上（退款行 69% 找到同键销量行，其余多为跨月退款）。
   * **拿 `paid_number` 直接当销速会高估约 15% 的真实需求**，接入时必须用
   * `C.01 支付件数 − C.02 成功退款子订单数`。是否用它喂销速仍属业务裁决；
   * 契约进注册表不等于启用，仍需在 `JIANDAOYUN_SYNC_CONTRACTS` 里显式选中。
   */
  /*
   * 天猫 SKU 详情观察（2026-08-04 加入）——条码桥的第二个来源。
   *
   * 实测填充率：条形码 45%、商家编码 48%、关联货品 100%、skuId 100%。
   * **只用条形码解析**：商家编码与系统 SKU 编码是两套命名空间（已在拼多多侧证实），
   * 拿它喂 sku_code 只会造出解析不到的认领项。
   * `关联货品` 虽 100% 填充，但那是天猫店内的商品别名（形如 `maonangyfangtuo`），
   * 与主档的对应关系未经业务确认，故只作观察字段。
   *
   * 天猫条形码只填了 45%，意味着约一半天猫 SKU 落不到主档——
   * 这部分要靠业务在平台侧补条码，代码这边无法弥补。
   */
  {
    key: "tmall-sku-crosswalk-observation",
    label: "数据中台/天猫 SKU 对照",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69a7aca01406712eef7abdba",
    targetTable: "jdy_tmall_sku_crosswalk_observation",
    businessKey: ["shopName", "platformSkuId"],
    freshnessMaxAgeDays: 45,
    fields: [
      field("shopName", "shop_name"),
      field("platformProductId", "product_id"),
      field("specification", "net_content"),
      field("price", "price"),
      // 条码：落到系统 SKU 的桥（填充率 45%）
      field("barcode", "bar_code"),
      // 商家编码与关联货品只作观察，不参与解析
      field("merchantSkuCode", "merchant_id"),
      field("relatedGoods", "related_goods"),
      field("skuClassification", "sku_classification"),
      field("platformSkuId", "sku_id"),
    ],
  },
  /*
   * 唯品会商品列表观察（2026-08-04 加入）——**条码桥的主力来源**。
   *
   * 实测：405 个唯一条码里 169 个命中 `skus.barcode`、163 个命中 `sku_identifiers`
   * （约四成），而条码/货号命中 `skus.code` 为 0 —— 印证了"编码体系不通、条码通"。
   * 唯品会的货号与条码同值，故只映射一次。
   *
   * `barcode` 交给条码桥解析（精确、唯一命中才算；歧义与未命中进认领队列）。
   * 供应商编码只作观察，不参与解析——它是唯品会侧的供应商编号，与本系统供应商主档
   * 未经确认对应关系，映了会造出错误的认领候选。
   */
  {
    key: "vip-product-crosswalk-observation",
    label: "数据中台/唯品会商品对照",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69d5bd25c0c89899fec1c3eb",
    targetTable: "jdy_vip_product_crosswalk_observation",
    businessKey: ["platformProductId"],
    freshnessMaxAgeDays: 45,
    fields: [
      field("platformProductId", "product_id"),
      field("productName", "product_name"),
      // 条码：落到系统 SKU 的桥
      field("barcode", "barcode"),
      field("goodsCode", "goods_code"),
      field("platformSkuId", "v_sku"),
      field("platformSpuId", "v_spu"),
      field("brandName", "brand_name"),
      field("supplierCode", "supplier_code"),
    ],
  },
  /*
   * 拼多多 SKU 主数据观察（2026-08-04 加入）——**平台 SKU ↔ 系统 SKU 的对照来源**。
   *
   * 为什么需要它：销量表里的 `sku_id` 是平台 SKU（如 `1567203177846`），不是系统编码；
   * 不做对照，销量行落不到主档，就只是一堆躺在 staging 的数字。
   *
   * 这里把 `SKU外部编码`（平台上"商家自己的 SKU 编码"，实测填充率 95%）映射到
   * `productCode`，从而走既有的 `resolveKnownOrQueue`：能对上的直接解析，
   * 对不上的进人工认领队列（scope=JIANDAOYUN），**不猜、不自动改主档**。
   *
   * 另两个平台的对照现状（各取 3000 行实测）：
   *   唯品会 Vip_X.01：条码/货号/供应商编码/V_SKU 均 100% —— 可用，但"哪个字段是权威
   *     系统编码"需业务确认，故暂不映射 productCode，避免造出错误的认领候选；
   *   天猫 Tmall_X.02：商家编码仅 48%、条形码 45% —— 约一半对不上，需业务补编码。
   */
  {
    key: "pdd-sku-crosswalk-observation",
    label: "数据中台/拼多多 SKU 对照",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69b8cc2549504b2026c15fa2",
    targetTable: "jdy_pdd_sku_crosswalk_observation",
    businessKey: ["shopName", "platformSkuId"],
    freshnessMaxAgeDays: 45,
    fields: [
      field("shopName", "shop_name"),
      field("platformProductId", "product_id"),
      field("productName", "product_name"),
      field("productSpecification", "product_specification"),
      // 平台侧「商家自己的 SKU 编码」。实测与系统编码是两套命名空间（SW1557 vs N006-001），
      // 故**只作观察字段**，不再喂给 sku_code 解析——喂了只会造出一堆解析不到的认领项。
      field("merchantSkuCode", "sku_external_code"),
      field("platformSkuId", "sku_id"),
      field("productStatus", "product_status"),
      field("inventory", "inventory"),
    ],
  },
  {
    key: "tmall-sku-sales-observation",
    label: "数据中台/天猫 SKU 日销量",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69a79b2c29154c9870ddaf00",
    targetTable: "jdy_tmall_sku_sales_observation",
    businessKey: ["statisticalDate", "shopName", "skuId"],
    freshnessMaxAgeDays: 45,
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("productId", "product_id"),
      field("productName", "product_name"),
      field("skuId", "sku_id"),
      field("skuName", "sku_name"),
      field("placedOrdersNumber", "placed_orders_number"),
      field("placedOrdersAmount", "placed_orders_amount"),
      field("paidNumber", "paid_number"),
      field("paidAmount", "paid_amount"),
    ],
  },
  {
    key: "tmall-sku-refund-observation",
    label: "数据中台/天猫 SKU 退款分布",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69a79cf5180dcc9f36294d4a",
    targetTable: "jdy_tmall_sku_refund_observation",
    businessKey: ["statisticalDate", "shopName", "skuId"],
    freshnessMaxAgeDays: 45,
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("productId", "product_id"),
      field("skuId", "sku_id"),
      field("skuName", "sku_name"),
      field("timeType", "time_type"),
      field("paidAmount", "paid_amount"),
      field("paidSuborderNumber", "paid_suborder_number"),
      field("successRefundSuborderNumber", "success_refund_suborders_number"),
      field("successRefundAmount", "success_refund_amount"),
    ],
  },
  /*
   * 天猫费用项目汇总观察（2026-08-14 加入）。
   *
   * 实时只读画像：12,624 行，统计日期 2026-01-01～2026-08-12；日期、店铺、
   * 计费金额和支付金额均无缺失。753 行负数是冲销/退回语义，必须原样保留，
   * 禁止取绝对值或自动抵消。
   *
   * 这是「天猫 × 店铺 × 费用项」的渠道级费用观察，不含 SKU 归属。
   * 因此它可以支撑净毛利桥的渠道费用侧，但不允许按销量或名称自动分摊到 SKU，
   * 也不能代表拼多多/唯品会/其他渠道。源表同一业务维度可以出现多条汇总行，
   * 故只用简道云不变 `_id` 作源记录身份，不伪造业务唯一键。
   */
  {
    key: "platform-fee-observation",
    label: "数据中台/天猫账单费用项目汇总（仅天猫）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69bca8af197da6e6ce36cbd5",
    targetTable: "jdy_tmall_platform_fee_observation",
    freshnessMaxAgeDays: 7,
    numericControls: [
      { target: "billingAmount", scale: 2 },
      { target: "paidAmount", scale: 2 },
      { target: "mainLineCount", scale: 4 },
    ],
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("feeItem", "fee_item"),
      field("billingType", "billing_type"),
      field("billingCurrency", "billing_currency"),
      field("billingAmount", "billing_amount"),
      field("paidCurrency", "paid_currency"),
      field("paidAmount", "paid_amount"),
      field("serviceProduct", "service_product"),
      field("logisticsProduct", "logistics_product"),
      field("mainLineCount", "main_single_items_num"),
      field("deductionType", "deduction_type"),
      field("expenseType", "expense_type"),
    ],
  },
  {
    key: "product-master-observation",
    label: "进销存/产品信息",
    appId: "6a1fbeeac2ea65ea6099f422",
    entryId: "5c6a555e2ce076490e9e0595",
    targetTable: "jdy_product_observation",
    businessKey: ["productCode"],
    freshnessMaxAgeDays: 90,
    fields: [
      field("productCode", "_widget_1679316712691"),
      field("productAttribute", "_widget_1679316712692"),
      field("productType", "_widget_1550472542785"),
      field("productName", "_widget_1550472542769"),
      field("brand", "_widget_1679318386623"),
      field("specification", "_widget_1550556533919"),
      field("unit", "_widget_1550472542830"),
    ],
  },
  {
    key: "purchase-demand-observation",
    label: "采购供应链/采购需求池",
    appId: "6a342085a29b2e80efcf176f",
    entryId: "65de8e6c4c47385168ce372e",
    targetTable: "jdy_purchase_demand_observation",
    businessKey: ["requestNo", "productCode"],
    freshnessMaxAgeDays: 90,
    numericControls: [
      { target: "requestedQty", scale: 4 },
      { target: "purchasedQty", scale: 4 },
    ],
    fields: [
      field("requestNo", "_widget_1699602665231"),
      field("requestedAt", "_widget_1550480795548"),
      field("plannedArrivalAt", "_widget_1679385588171"),
      field("source", "_widget_1699602665233"),
      field("warehouse", "_widget_1699602665232"),
      field("supplier", "_widget_1709084276342"),
      field("productName", "_widget_1699602665225"),
      field("productCode", "_widget_1699602665226"),
      field("brand", "_widget_1699602665227"),
      field("specification", "_widget_1699602665228"),
      field("unit", "_widget_1699602665229"),
      field("requestedQty", "_widget_1699602665230"),
      field("purchasedQty", "_widget_1709124475334"),
      field("quotationStatus", "_widget_1714975219829"),
      field("receiptStatus", "_widget_1716362443964"),
      field("purchaseStatus", "_widget_1709012280541"),
      field("paymentStatus", "_widget_1714975219831"),
    ],
  },
  {
    key: "purchase-order-observation",
    label: "采购供应链/采购订单",
    appId: "6a342085a29b2e80efcf176f",
    entryId: "5c6a74eccd36f97062560699",
    targetTable: "jdy_purchase_order_observation",
    businessKey: ["orderNo"],
    freshnessMaxAgeDays: 90,
    numericControls: [
      { target: "totalQty", scale: 4 },
      { target: "grossAmount", scale: 2 },
      { target: "discountAmount", scale: 2 },
      { target: "orderAmount", scale: 2 },
      { target: "receivedQty", scale: 4 },
      { target: "receivedAmount", scale: 2 },
      { target: "invoicedAmount", scale: 2 },
      { target: "paidAmount", scale: 2 },
    ],
    reconciliations: [
      {
        key: "purchase-order-quantity",
        headerTarget: "totalQty",
        lineTargets: [{ subformTarget: "lines", fieldTarget: "purchaseQty" }],
        scale: 4,
        tolerance: "0.0000",
      },
      {
        key: "purchase-order-amount",
        headerTarget: "orderAmount",
        lineTargets: [{ subformTarget: "lines", fieldTarget: "lineAmountTaxed" }],
        scale: 2,
        tolerance: "0.01",
      },
    ],
    fields: [
      field("supplierName", "_widget_1550480795762"),
      field("supplierCode", "_widget_1679388823284"),
      field("orderName", "_widget_1679390839300"),
      field("signedAt", "_widget_1550480795548"),
      field("deliveryAt", "_widget_1679388823276"),
      field("orderNo", "_widget_1679388823274"),
      field("receiptStatus", "_widget_1714962836763"),
      field("invoiceStatus", "_widget_1714962836765"),
      field("paymentStatus", "_widget_1714962836767"),
      field("warehouse", "_widget_1679388823278"),
      field("totalQty", "_widget_1714966450129"),
      field("grossAmount", "_widget_1550568862894"),
      field("discountAmount", "_widget_1682064790115"),
      field("discountPct", "_widget_1682064790116"),
      field("orderAmount", "_widget_1682064790117"),
      field("receivedQty", "_widget_1714962836769"),
      field("receivedAmount", "_widget_1714962836770"),
      field("invoicedAmount", "_widget_1714975852930"),
      field("paidAmount", "_widget_1714962836771"),
      field("approvalResult", "_widget_1645098588409"),
      field("approvedAt", "_widget_1550804587512"),
    ],
    subforms: [{
      source: "_widget_1550480795863",
      target: "lines",
      numericControls: [
        { target: "requestedQty", scale: 4 },
        { target: "alreadyPurchasedQty", scale: 4 },
        { target: "purchaseQty", scale: 4 },
        { target: "lineAmountTaxed", scale: 2 },
      ],
      items: [
        field("requestNo", "_widget_1709124659703"),
        field("productName", "_widget_1679390839302"),
        field("productCode", "_widget_1679390839310"),
        field("brand", "_widget_1679390839303"),
        field("specification", "_widget_1679390839304"),
        field("unit", "_widget_1679390839305"),
        field("availableQty", "_widget_1679390839311"),
        field("requestedQty", "_widget_1709124659700"),
        field("alreadyPurchasedQty", "_widget_1709124659701"),
        field("purchaseQty", "_widget_1550568862551"),
        field("unitPriceTaxed", "_widget_1679390839307"),
        field("actualUnitPriceTaxed", "_widget_1682064790118"),
        field("lineAmountTaxed", "_widget_1682064790120"),
      ],
    }],
  },
  {
    key: "purchase-receipt-observation",
    label: "采购供应链/采购入库",
    appId: "6a342085a29b2e80efcf176f",
    entryId: "5c6b97a6fcc7fc6f03143d42",
    targetTable: "jdy_purchase_receipt_observation",
    businessKey: ["receiptNo"],
    freshnessMaxAgeDays: 90,
    numericControls: [
      { target: "totalOrderedQty", scale: 4 },
      { target: "totalReceivedQty", scale: 4 },
      { target: "receiptAmount", scale: 2 },
    ],
    reconciliations: [
      {
        key: "purchase-receipt-ordered-quantity",
        headerTarget: "totalOrderedQty",
        lineTargets: [{ subformTarget: "lines", fieldTarget: "orderedQty" }],
        scale: 4,
        tolerance: "0.0000",
      },
      {
        key: "purchase-receipt-received-quantity",
        headerTarget: "totalReceivedQty",
        lineTargets: [{ subformTarget: "lines", fieldTarget: "receivedQty" }],
        scale: 4,
        tolerance: "0.0000",
      },
      {
        key: "purchase-receipt-amount",
        headerTarget: "receiptAmount",
        lineTargets: [{ subformTarget: "lines", fieldTarget: "lineAmountTaxed" }],
        scale: 2,
        tolerance: "0.01",
      },
    ],
    fields: [
      field("purchaseOrderName", "_widget_1679406754663"),
      field("purchaseOrderNo", "_widget_1679406754664"),
      field("supplierName", "_widget_1679406754657"),
      field("supplierCode", "_widget_1679406754658"),
      field("receiptNo", "_widget_1679886188554"),
      field("warehouse", "_widget_1550559292085"),
      field("totalOrderedQty", "_widget_1714963679821"),
      field("totalReceivedQty", "_widget_1681099107598"),
      field("receiptAmount", "_widget_1550652678422"),
      field("hasNonconforming", "_widget_1679406754677"),
      field("inspectedAt", "_widget_1679408126049"),
      field("receiptConfirmed", "_widget_1679406754683"),
      field("receivedAt", "_widget_1679408126050"),
    ],
    subforms: [{
      source: "_widget_1550559559766",
      target: "lines",
      numericControls: [
        { target: "orderedQty", scale: 4 },
        { target: "openQty", scale: 4 },
        { target: "arrivedQty", scale: 4 },
        { target: "nonconformingQty", scale: 4 },
        { target: "receivedQty", scale: 4 },
        { target: "lineAmountTaxed", scale: 2 },
      ],
      items: [
        field("requestNo", "_widget_1715923996969"),
        field("productName", "_widget_1550559559778"),
        field("productCode", "_widget_1550559559880"),
        field("brand", "_widget_1550560951175"),
        field("specification", "_widget_1550559559850"),
        field("unit", "_widget_1550559560033"),
        field("orderedQty", "_widget_1550649200911"),
        field("openQty", "_widget_1679406754668"),
        field("arrivedQty", "_widget_1692761214229"),
        field("nonconformingQty", "_widget_1692761214230"),
        field("receivedQty", "_widget_1550559560078"),
        field("actualUnitPriceTaxed", "_widget_1550559560802"),
        field("lineAmountTaxed", "_widget_1550559560653"),
      ],
    }],
  },
  {
    key: "supplier-observation",
    label: "采购供应链/供应商档案",
    appId: "6a342085a29b2e80efcf176f",
    entryId: "64190a45d97a4200089c3048",
    targetTable: "jdy_supplier_observation",
    businessKey: ["supplierCode"],
    freshnessMaxAgeDays: 90,
    numericControls: [{ target: "creditLimit", scale: 2 }],
    fields: [
      field("supplierCode", "_widget_1716278712458"),
      field("supplierName", "_widget_1550470841596"),
      field("category", "_widget_1679333188760"),
      field("level", "_widget_1679333188762"),
      field("contractStart", "_widget_1550470841863"),
      field("contractEnd", "_widget_1550470841875"),
      field("settlementTerm", "_widget_1679362635712"),
      field("creditLimit", "_widget_1679362635714"),
      field("taxType", "_widget_1550470842259"),
      field("vatRatePct", "_widget_1679334973517"),
    ],
  },
  {
    key: "warehouse-observation",
    label: "仓库管理/仓库信息",
    appId: "6a341f76a29b2e80efce4700",
    entryId: "5c6ba8b32c9c1b24e1faffce",
    targetTable: "jdy_warehouse_observation",
    businessKey: ["warehouseCode"],
    freshnessMaxAgeDays: 90,
    numericControls: [{ target: "capacityM3", scale: 4 }],
    fields: [
      field("warehouseName", "_widget_1550559411499"),
      field("warehouseCode", "_widget_1679321080626"),
      field("capacityM3", "_widget_1679381481244"),
      field("status", "_widget_1679320778339"),
    ],
  },
  {
    key: "warehouse-transfer-observation",
    label: "仓库管理/库存调拨",
    appId: "6a341f76a29b2e80efce4700",
    entryId: "641bbf6425f917000739f52a",
    targetTable: "jdy_warehouse_transfer_observation",
    businessKey: ["transferNo"],
    freshnessMaxAgeDays: 90,
    numericControls: [{ target: "totalQty", scale: 4 }],
    reconciliations: [{
      key: "warehouse-transfer-quantity",
      headerTarget: "totalQty",
      lineTargets: [{ subformTarget: "lines", fieldTarget: "transferQty" }],
      scale: 4,
      tolerance: "0.0000",
    }],
    fields: [
      field("transferType", "_widget_1679536925339"),
      field("requestedAt", "_widget_1550559292052"),
      field("expectedArrivalAt", "_widget_1680852617764"),
      field("transferNo", "_widget_1679541900774"),
      field("outboundConfirmed", "_widget_1680852617767"),
      field("fromWarehouse", "_widget_1679540321759"),
      field("outboundAt", "_widget_1679540321771"),
      field("inboundConfirmed", "_widget_1680852617771"),
      field("toWarehouse", "_widget_1679540321761"),
      field("inboundAt", "_widget_1679540321772"),
      field("totalQty", "_widget_1679540321777"),
    ],
    subforms: [{
      source: "_widget_1550559559766",
      target: "lines",
      numericControls: [
        { target: "fromOnHandQty", scale: 4 },
        { target: "toOnHandQty", scale: 4 },
        { target: "transferQty", scale: 4 },
      ],
      items: [
        field("productName", "_widget_1550559559778"),
        field("productCode", "_widget_1550559559880"),
        field("brand", "_widget_1550560951175"),
        field("specification", "_widget_1550559559850"),
        field("unit", "_widget_1550559560033"),
        field("fromOnHandQty", "_widget_1679897447803"),
        field("toOnHandQty", "_widget_1679897927074"),
        field("transferQty", "_widget_1550559560078"),
      ],
    }],
  },
  {
    key: "inventory-count-observation",
    label: "仓库管理/库存盘点",
    appId: "6a341f76a29b2e80efce4700",
    entryId: "641bc6be42813d00071d5c79",
    targetTable: "jdy_inventory_count_observation",
    businessKey: ["countNo"],
    freshnessMaxAgeDays: 90,
    numericControls: [
      { target: "lossQty", scale: 4 },
      { target: "gainQty", scale: 4 },
    ],
    reconciliations: [
      {
        key: "inventory-count-loss-quantity",
        headerTarget: "lossQty",
        lineTargets: [{ subformTarget: "lines", fieldTarget: "lossQty" }],
        scale: 4,
        tolerance: "0.0000",
      },
      {
        key: "inventory-count-gain-quantity",
        headerTarget: "gainQty",
        lineTargets: [{ subformTarget: "lines", fieldTarget: "gainQty" }],
        scale: 4,
        tolerance: "0.0000",
      },
    ],
    fields: [
      field("countType", "_widget_1679536925339"),
      field("countNo", "_widget_1679541900774"),
      field("startedAt", "_widget_1550559292052"),
      field("finishedAt", "_widget_1679540321771"),
      field("warehouse", "_widget_1679540321759"),
      field("lossQty", "_widget_1679541952639"),
      field("gainQty", "_widget_1679540321777"),
    ],
    subforms: [{
      source: "_widget_1550559559766",
      target: "lines",
      numericControls: [
        { target: "bookQty", scale: 4 },
        { target: "countedQty", scale: 4 },
        { target: "lossQty", scale: 4 },
        { target: "gainQty", scale: 4 },
      ],
      items: [
        field("productName", "_widget_1550559559778"),
        field("productCode", "_widget_1550559559880"),
        field("brand", "_widget_1550560951175"),
        field("specification", "_widget_1550559559850"),
        field("unit", "_widget_1550559560033"),
        field("bookQty", "_widget_1679541952633"),
        field("countedQty", "_widget_1550559560078"),
        field("lossQty", "_widget_1679541952635"),
        field("gainQty", "_widget_1679541952634"),
      ],
    }],
  },
  {
    key: "sample-management-observation",
    label: "采购供应链/样品管理",
    appId: "6a342085a29b2e80efcf176f",
    entryId: "664c58588d045de5949710ec",
    targetTable: "jdy_sample_observation",
    freshnessMaxAgeDays: 90,
    numericControls: [
      { target: "totalQty", scale: 4 },
      { target: "totalValue", scale: 2 },
    ],
    reconciliations: [{
      key: "sample-quantity",
      headerTarget: "totalQty",
      lineTargets: [
        { subformTarget: "existingProductLines", fieldTarget: "sampleQty" },
        { subformTarget: "newProductLines", fieldTarget: "sampleQty" },
      ],
      scale: 4,
      tolerance: "0.0000",
    }],
    fields: [
      field("supplierCode", "_widget_1703818211448"),
      field("supplierName", "_widget_1703818211449"),
      field("isNewCategory", "_widget_1709118014330"),
      field("totalQty", "_widget_1703818211486"),
      field("totalValue", "_widget_1703818211487"),
      field("mailedAt", "_widget_1703818211471"),
      field("received", "_widget_1703818211474"),
      field("inspectionResult", "_widget_1703818211476"),
      field("approvedAt", "_widget_1703818211481"),
      field("stocked", "_widget_1703818211482"),
      field("warehouse", "_widget_1703818211490"),
    ],
    subforms: [
      {
        source: "_widget_1703818211453",
        target: "existingProductLines",
        numericControls: [{ target: "sampleQty", scale: 4 }],
        items: [
          field("productName", "_widget_1703818211462"),
          field("productCode", "_widget_1703822182120"),
          field("productAttribute", "_widget_1703818211458"),
          field("productType", "_widget_1703818211460"),
          field("brand", "_widget_1703818211463"),
          field("specification", "_widget_1703818211464"),
          field("unit", "_widget_1703818211465"),
          field("sampleQty", "_widget_1703818211469"),
        ],
      },
      {
        source: "_widget_1709118014316",
        target: "newProductLines",
        numericControls: [{ target: "sampleQty", scale: 4 }],
        items: [
          field("productName", "_widget_1709118014318"),
          field("productCode", "_widget_1709118014319"),
          field("productAttribute", "_widget_1709118014320"),
          field("productType", "_widget_1709118014321"),
          field("brand", "_widget_1709118014322"),
          field("specification", "_widget_1709118014323"),
          field("unit", "_widget_1709118014324"),
          field("sampleQty", "_widget_1709118014325"),
        ],
      },
    ],
  },
  /*
   * 2026-09-02 第三阶段：把「全渠道」补齐（数据中台，appId 同天猫日销）。
   * 选表依据是 /app/entry/widget/list 实核字段 + 服务端按统计日期过滤的时效探针，不是表名。
   * 全部只进观察 staging、releaseBlocked；不含消费者资料、买家留言、商家备注等 PII 字段。
   */
  {
    // 天猫单品日汇总：带「子货品编码」= 系统 SKU 编码 与 商品SKUID。
    // 实测 2026 年 1 月有值、8~9 月无行（已停更），但平台 SKU ID 不会变——
    // 它是平台 SKU → 系统编码的**第三条身份线索**（对照表只覆盖 859/2,076）。
    key: "tmall-unit-daily-observation",
    label: "数据中台/天猫单品日汇总（子货品编码桥）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69cb668276cf12d2a35a1449",
    targetTable: "jdy_tmall_unit_daily_observation",
    businessKey: ["statisticalDate", "shopName", "platformSkuId"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("statisticalDate", "_widget_1774937730433"),
      field("shopName", "_widget_1774937730434"),
      field("unitCode", "_widget_1774937730432"),
      field("platformProductId", "_widget_1774937730435"),
      field("platformSkuId", "_widget_1774937730436"),
      field("paidSuborderNumber", "_widget_1774937730437"),
      field("paidNumber", "_widget_1774937730439"),
      field("successRefundSuborderNumber", "_widget_1774937730440"),
      field("unitQty", "_widget_1774937730442"),
      field("relatedGoods", "_widget_1774937730443"),
      field("paidAmount", "_widget_1774937730448"),
      field("successRefundAmount", "_widget_1774937730449"),
      field("isBundle", "_widget_1774937730450"),
      field("systemProductName", "_widget_1774937730452"),
      field("barcode", "_widget_1774937730460"),
    ],
  },
  {
    // 拼多多订单查询列表：订单级、带「商家编码-规格维度」。106 个字段只取需求测算所需的 12 个，
    // 消费者资料 / 买家留言 / 商家备注 / 赠品明细一律不取。
    key: "pdd-order-observation",
    label: "数据中台/拼多多订单（字段最小化）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69b2195752dfffff3fcd5da1",
    targetTable: "jdy_pdd_order_observation",
    businessKey: ["orderNumber", "productId", "merchantSkuCode"],
    freshnessMaxAgeDays: 45,
    numericControls: [{ target: "productQuantity", scale: 4 }],
    // 实测每天 3,000~6,000 行订单明细，60 天就超 1,000 页安全上限；每次只拉最近 3 天（约 1~2 万行），
    // 读模型把最近 90 天内各批次按业务键去重后累加——滚动快照随每日同步自然累积成 90 天窗口
    window: { field: "statistical_date", days: 3, includeUpdatedSince: true },
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("orderNumber", "order_number"),
      field("orderStatus", "order_status"),
      field("productQuantity", "product_quantity"),
      field("paymentTime", "payment_time"),
      field("shipTime", "ship_time"),
      field("productId", "product_id"),
      field("productName", "product"),
      field("productSpecification", "product_specification"),
      field("merchantSkuCode", "merchant_code_specification_dimension"),
      field("merchantProductCode", "merchant_code_product_dimension"),
      field("afterSalesStatus", "after_sales_status"),
    ],
  },
  {
    // 唯品会店铺交易：店铺 × 品牌 × 日，销售额/销售量/转化率——品牌级，不到 SKU。
    key: "vip-shop-trading-observation",
    label: "数据中台/唯品会店铺交易",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69d5be62308e25ac8ec1d754",
    targetTable: "jdy_vip_shop_trading_observation",
    businessKey: ["statisticalDate", "shopName", "brandName"],
    freshnessMaxAgeDays: 45,
    numericControls: [
      { target: "salesAmount", scale: 2 },
      { target: "salesQuantity", scale: 4 },
    ],
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("brandName", "brand_name"),
      field("salesAmount", "sales_amount"),
      field("salesQuantity", "sales_quantity"),
      field("customerNumber", "customer_number"),
      field("subOrderNumber", "sub_order_number"),
      field("productDetailUv", "product_detail_uv"),
      field("purchaseConversionRate", "purchase_conversion_rate"),
      field("couponAmount", "coupon_amount"),
    ],
  },
  {
    // 天猫宝贝日汇总：商品 × 日 的真实成交、销售费用、预估毛利/净利——渠道贡献与毛利视角的产品级旁证。
    key: "tmall-product-pnl-observation",
    label: "数据中台/天猫宝贝日汇总（产品级损益观察）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69aa70f3b0231cb3399b7a77",
    targetTable: "jdy_tmall_product_pnl_observation",
    businessKey: ["statisticalDate", "shopName", "platformProductId"],
    freshnessMaxAgeDays: 45,
    numericControls: [
      { target: "actualTransactionAmount", scale: 2 },
      { target: "totalSalesCost", scale: 2 },
      { target: "estimatedGrossProfit", scale: 2 },
      { target: "estimatedNetProfit", scale: 2 },
      { target: "paidAmount", scale: 2 },
      { target: "successRefundAmount", scale: 2 },
      { target: "paidNumber", scale: 4 },
    ],
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("platformProductId", "product_id"),
      field("productName", "product_display_name"),
      field("categoryName", "category_name"),
      field("actualTransactionAmount", "actual_transaction_amount"),
      field("totalSalesCost", "total_sales_cost"),
      field("estimatedGrossProfit", "estimated_gross_profit"),
      field("estimatedNetProfit", "estimated_net_profit"),
      field("paidAmount", "payment_amount"),
      field("successRefundAmount", "successful_refund_amount"),
      field("paidNumber", "paid_quantity_count"),
      field("successRefundOrderCount", "successful_refund_order_count"),
      field("productVisitorCount", "product_visitor_count"),
    ],
  },

  /*
   * 2026-09-03 第四阶段：把「已经镜像在简道云里的聚水潭/财务/平台主数据」接进来。
   *
   * 背景：聚水潭 OpenAPI 仍卡在 IP 白名单与逐接口权限（110/190），但数据中台早已把聚水潭的
   * 商品资料、组合装 BOM、店铺档案镜像成表单；财务把系统编码↔条码↔成本标准维护在这里；
   * 运营把天猫组合装明细、拼多多商家编码成本标准、唯品会组合对照维护在这里。
   * 这些表直接命中当前最大瓶颈——平台身份桥接（天猫按销售额 71%，拼多多 1,281 个商家编码
   * 落在另一命名空间）——以及成本/毛利与流量先行指标。
   *
   * 口径不变：全部 observation_only；外部编码只进 exactHits 供人确认，不自动认领；
   * 字段最小化——成员/部门/图片/备注/其它属性 1–5 等一律不取。
   * 字段名以 2026-09-03 `/app/entry/widget/list` 实核为准。
   */
  {
    key: "jst-item-master-mirror-observation",
    label: "数据中台/商品资料（聚水潭镜像）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69ba2eab517df35c037aadf6",
    targetTable: "jdy_jst_item_master_mirror_observation",
    businessKey: ["skuCode"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("styleCode", "_widget_1773809323590"),
      field("skuCode", "_widget_1773809323591"),
      field("skuName", "_widget_1773809323592"),
      field("shortName", "_widget_1773809323593"),
      field("colorSpec", "_widget_1773809323594"),
      field("brand", "_widget_1773809323597"),
      field("category", "_widget_1773809323598"),
      field("barcode", "_widget_1773809323599"),
      field("itemStatus", "_widget_1773809323600"),
      field("stockSync", "_widget_1773809323601"),
      field("createdAt", "_widget_1773809323602"),
      field("modifiedAt", "_widget_1773809323604"),
      field("shopLinkCount", "_widget_1773809323605"),
    ],
  },
  {
    key: "jst-bundle-bom-mirror-observation",
    label: "数据中台/组合明细（聚水潭组合装 BOM 镜像）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69b7bf55a7789ed77a15a4a9",
    targetTable: "jdy_jst_bundle_bom_mirror_observation",
    businessKey: ["bundleCode", "componentCode"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("bundleCode", "_widget_1773649749746"),
      field("bundleBarcode", "_widget_1773649749748"),
      field("bundleStyleCode", "_widget_1773649749749"),
      field("bundleName", "_widget_1773649749750"),
      field("basePrice", "_widget_1773649749756"),
      field("bundleCost", "_widget_1773649749757"),
      field("brand", "_widget_1773649749765"),
      field("itemStatus", "_widget_1773649749768"),
      field("componentCode", "_widget_1773649749784"),
      field("componentName", "_widget_1773649749785"),
      field("componentSpec", "_widget_1773649749786"),
      field("componentQty", "_widget_1773649749787"),
      field("allocatedPrice", "_widget_1773649749788"),
      field("componentCost", "_widget_1773649749789"),
    ],
  },
  {
    key: "tmall-bundle-detail-observation",
    label: "数据中台/天猫组合详情列表（子货品→系统编码）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69a7adbc46d882981bec6d0c",
    targetTable: "jdy_tmall_bundle_detail_observation",
    businessKey: ["shopName", "productId", "subproductId"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("subproductId", "subproduct_id"),
      field("subproductName", "subproduct_name"),
      field("subproductBarcode", "subproduct_barcode"),
      field("subproductCode", "subproduct_code"),
      field("reviewStatus", "review_status"),
      field("quantity", "quantity"),
      field("bundleUnitPrice", "combine_unitprice"),
      field("productId", "product_id"),
      field("productName", "product_name"),
      field("bundleCode", "combine_code"),
      field("shopName", "shop_name"),
      field("subproductCodeCorrected", "_widget_1772596668492"),
      field("systemSkuCode", "_widget_1772596668493"),
      field("unitCost", "_widget_1772596668495"),
      field("costSubtotal", "_widget_1772596668496"),
    ],
  },
  {
    key: "pdd-sku-cost-standard-observation",
    label: "数据中台/拼多多商品成本标准（商家编码→聚水潭编码）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69ba4cc7efe98cfd84569874",
    targetTable: "jdy_pdd_sku_cost_standard_observation",
    businessKey: ["merchantSkuCode"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("merchantSkuCode", "_widget_1773817031635"),
      field("matchProductCode", "_widget_1773817031636"),
      field("jstSkuCode", "_widget_1773817031637"),
      field("jstSkuName", "_widget_1773817031638"),
      field("jstBarcode", "_widget_1773817031639"),
      field("operatingCost", "_widget_1773817031640"),
      field("shipWarehouse", "_widget_1773817031641"),
      field("mainItemQty", "_widget_1776497404191"),
      field("expressFeePerOrder", "_widget_1773817031642"),
      field("taxRatePerOrder", "_widget_1773817031643"),
      field("mark", "_widget_1773918983951"),
    ],
  },
  {
    key: "vip-bundle-crosswalk-observation",
    label: "数据中台/唯品会组合对照（上架条码→系统编码）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69dc5e7ad3476f9c36af557c",
    targetTable: "jdy_vip_bundle_crosswalk_observation",
    businessKey: ["vipBarcode", "systemSkuCode"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("vipBarcode", "_widget_1776049786308"),
      field("jstUnitBarcode", "_widget_1776050741764"),
      field("unitName", "_widget_1776049786310"),
      field("systemSkuCode", "_widget_1776049786311"),
      field("bundleType", "_widget_1776049786312"),
      field("unitQty", "_widget_1776049786313"),
    ],
  },
  {
    key: "finance-goods-master-observation",
    label: "数据中台/货品档案（财务内部：系统编码↔条码）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "699fb4dc735f9813a9e0aa4b",
    targetTable: "jdy_finance_goods_master_observation",
    businessKey: ["systemSkuCode"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("productType", "_widget_1774338740427"),
      field("brand", "_widget_1772074204506"),
      field("category", "_widget_1772074204507"),
      field("systemSkuCode", "_widget_1772074204508"),
      field("barcode", "_widget_1778578738590"),
      field("systemName", "_widget_1772074204509"),
      field("specName", "_widget_1772074204510"),
    ],
  },
  {
    key: "finance-operating-cost-observation",
    label: "数据中台/运营成本（财务内部：按系统编码×适用月份）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69a7d917add9e38160bdc632",
    targetTable: "jdy_finance_operating_cost_observation",
    businessKey: ["productCode", "useMonth", "usage"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("productCode", "product_code"),
      field("productName", "product_name"),
      field("barcode", "_widget_1778578805856"),
      field("preferentialCost", "preferential_cost"),
      field("chineseLabelingCost", "chinese_labeling_cost"),
      field("normalCost", "normal_cost"),
      field("operatingCost", "operating_cost"),
      field("usage", "usage"),
      field("useMonth", "use_month"),
    ],
  },
  {
    key: "vip-sku-cost-observation",
    label: "数据中台/唯品会商品成本（系统编码×适用月份）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69df304558992e7e3b2a366a",
    targetTable: "jdy_vip_sku_cost_observation",
    businessKey: ["productId", "vipBarcode", "systemSkuCode", "useMonth"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("systemSkuCode", "_widget_1776234565716"),
      field("productId", "_widget_1776234565717"),
      field("productName", "_widget_1776234565718"),
      field("vipBarcode", "_widget_1776234565719"),
      field("systemName", "_widget_1776234565720"),
      field("styleBarcode", "_widget_1776234565721"),
      field("unitQty", "_widget_1776234565722"),
      field("unitCost", "_widget_1776234565724"),
      field("operatingCost", "_widget_1776234565727"),
      field("useMonth", "_widget_1776234565729"),
    ],
  },
  {
    key: "tmall-sku-cost-pnl-observation",
    label: "数据中台/天猫 SKU 销售成本核算（SKU 级损益，90 天时间窗）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69a9924a864a8cb10ee57df1",
    targetTable: "jdy_tmall_sku_cost_pnl_observation",
    businessKey: ["statisticalDate", "shopName", "skuId"],
    freshnessMaxAgeDays: 400,
    // 全量超过 1,000 页安全上限（2026-09-03 实测拒绝），SKU 级损益只需近 90 天
    window: { field: "_widget_1772720714164", days: 90 },
    fields: [
      field("statMonth", "_widget_1774431255983"),
      field("statisticalDate", "_widget_1772720714164"),
      field("shopName", "_widget_1773021072818"),
      field("productId", "_widget_1772720714165"),
      field("skuId", "_widget_1772720714166"),
      field("relatedGoods", "_widget_1774431255984"),
      field("operatingUnitCost", "_widget_1774431255985"),
      field("salesGoodsCost", "_widget_1772720714167"),
      field("returnGoodsCost", "_widget_1772720714168"),
      field("goodsCostSubtotal", "_widget_1772720714169"),
      field("paidSuborders", "_widget_1772720714170"),
      field("paidAmount", "_widget_1774431255986"),
      field("paidBuyers", "_widget_1774431255987"),
      field("paidNumber", "_widget_1774431255988"),
      field("refundSuborders", "_widget_1772720714171"),
      field("refundAmount", "_widget_1774431255989"),
      field("refundBuyers", "_widget_1774431255990"),
    ],
  },
  {
    key: "tmall-product-traffic-observation",
    label: "数据中台/天猫商品整体（流量/转化先行指标，90 天时间窗）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69a794d97fc9ee50b5523669",
    targetTable: "jdy_tmall_product_traffic_observation",
    businessKey: ["statisticalDate", "shopName", "productId"],
    freshnessMaxAgeDays: 400,
    window: { field: "statistical_date", days: 90 },
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("productId", "product_id"),
      field("productName", "product_name"),
      field("productStatus", "product_status"),
      field("leafCategory", "leaf_class_name"),
      field("visitors", "product_visitors_number"),
      field("views", "product_views"),
      field("placedBuyers", "placed_orders_buyers_number"),
      field("placedNumber", "placed_orders_number"),
      field("placedAmount", "placed_orders_amount"),
      field("paidAmount", "paid_amount"),
      field("refundAmount", "success_refund_amount"),
      field("paidNumber", "paid_number"),
      field("paidBuyers", "paid_buyers_number"),
      field("paymentConversionRate", "payment_conversion_rate"),
      field("addonNumber", "addon_number"),
      field("addonPeople", "addon_people"),
      field("collections", "product_collections_people"),
      field("customerUnitPrice", "customer_unit_price"),
      field("uvValue", "uv_value"),
      field("searchVisitors", "search_leads_visitors_number"),
    ],
  },
  {
    key: "pdd-product-daily-observation",
    label: "数据中台/拼多多商品数据（商品日级流量/成交，90 天时间窗）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69b2189f7910fb9b804e8ea4",
    targetTable: "jdy_pdd_product_daily_observation",
    businessKey: ["statisticalDate", "shopName", "productId"],
    freshnessMaxAgeDays: 400,
    window: { field: "statistical_date", days: 90 },
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("productId", "product_id"),
      field("productName", "product_name"),
      field("visitors", "product_visitors"),
      field("views", "product_views"),
      field("transactionAmount", "transaction_amount"),
      field("transactionNumber", "transaction_number"),
      field("transactionOrders", "transaction_order_number"),
      field("transactionBuyers", "transaction_buyer_number"),
      field("conversionRate", "conversion_rate"),
      field("collectUsers", "product_collect_user_number"),
    ],
  },
  {
    key: "pdd-shop-daily-observation",
    label: "数据中台/拼多多店铺交易数据（店铺日级）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69c2044615159d8dfdf82897",
    targetTable: "jdy_pdd_shop_daily_observation",
    businessKey: ["statisticalDate", "shopName"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("statisticalDate", "statistical_date"),
      field("shopName", "shop_name"),
      field("transactionAmount", "transaction_amount"),
      field("transactionOrders", "transaction_order_count"),
      field("transactionBuyers", "transaction_buyer_count"),
      field("conversionRate", "transaction_conversion_rate"),
      field("customerUnitPrice", "customer_unit_price"),
      field("oldBuyers", "transaction_old_buyer_count"),
      field("followers", "followed_user_count"),
      field("refundAmount", "success_refund_amount"),
      field("refundCount", "success_refund_count"),
      field("averageVisitorValue", "average_visitor_value"),
    ],
  },
  {
    key: "shop-master-observation",
    label: "数据中台/店铺档案（平台/品牌/聚水潭店铺编号）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "699faed10aff533139ef58c4",
    targetTable: "jdy_shop_master_observation",
    businessKey: ["shopName"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("shopName", "_widget_1772446920394"),
      field("shopEnabled", "_widget_1772072657347"),
      field("platformName", "_widget_1772446920392"),
      field("platformCode", "_widget_1772446920393"),
      field("brandId", "_widget_1774923958275"),
      field("brandName", "_widget_1774923958276"),
      field("jstShopId", "_widget_1772072657349"),
      field("jstStatus", "_widget_1772072657351"),
    ],
  },
  {
    key: "brand-master-observation",
    label: "数据中台/品牌档案",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "699fad33709b533604fa8557",
    targetTable: "jdy_brand_master_observation",
    businessKey: ["brandId"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("brandId", "_widget_1772072243196"),
      field("brandName", "_widget_1772072243197"),
      field("enabled", "_widget_1772072243198"),
    ],
  },
  /*
   * 保税仓保税订单（2026-09-03 W2-J 加入）：数据中台「CW_A.05_绍兴保税仓_保税订单」。
   *
   * 字段以 `/app/entry/widget/list` 实核（2026-09-03）：46 个顶层字段，本契约只取
   * 统计日期/系统单号/平台名称/订单状态/创建·清关·入库·发货时间/商品编码/效期/批次/条形码/
   * 发货数量/仓库名称/店铺名称 15 个。**刻意不取**收货人、联系电话、省市区与地址、身份证姓名/号码、
   * 快递单号、报关单号、金额与税费——保税订单是消费者订单，PII 不得进入本系统任何一层。
   *
   * 用途：保税仓（快照仓，无流水）的「日出库」旁证——按 SKU/批次/效期汇总发货数量，
   * 供驾驶舱第 3 屏各仓库存明细的「出库」列；observation_only，不过账、不改库存。
   * 当前契约为全量归档观察：2026-09-04 已移除服务端时间窗，本对象没有 window。
   * 读模型从可用、未被 supersede 的批次按 sourceRecordId 去重取最新状态；
   * 报表的 7/30 天发货统计窗口不是此处的拉取时间窗。
   * `productCode` / `barcode` / `warehouseName` 走同步期身份解析（`_identity.skuId` / `warehouseId`），
   * 未命中进认领队列，绝不自动认领。
   */
  {
    key: "bonded-warehouse-order-observation",
    label: "数据中台/绍兴保税仓保税订单（全量归档，出库观察）",
    appId: "699ebeac318154b4f6d3dda6",
    entryId: "69bcf6dbbe2cb5ce06c1b827",
    targetTable: "jdy_bonded_warehouse_order_observation",
    businessKey: ["systemOrderNumber", "productCode", "batch"],
    freshnessMaxAgeDays: 400,
    fields: [
      field("statisticalDate", "statistical_date"),
      field("systemOrderNumber", "system_order_number"),
      field("platformName", "platform_name"),
      field("orderStatus", "order_status"),
      field("createTime", "create_time"),
      field("customsClearanceTime", "customs_clearance_time"),
      field("warehousingTime", "warehousing_time"),
      field("shipmentTime", "shipment_time"),
      field("productCode", "product_code"),
      field("validityPeriod", "validity_period"),
      field("batch", "batch"),
      field("barcode", "barcode"),
      field("shipmentQuantity", "shipment_quantity"),
      field("warehouseName", "warehouse_name"),
      field("shopName", "shop_name"),
    ],
    numericControls: [{ target: "shipmentQuantity", scale: 4 }],
  },
];

export function jiandaoyunContract(key: string): JiandaoyunFormContract | null {
  return JIANDAOYUN_FORM_CONTRACTS.find((contract) => contract.key === key) ?? null;
}

/**
 * Jiandaoyun can project top-level fields, but requesting a subform returns every child field.
 * Keep the server request as narrow as the API permits; child-field minimization still happens
 * before immutable evidence and staging are written.
 */
export function jiandaoyunContractProjection(
  contract: JiandaoyunFormContract,
): string[] {
  return [...new Set([
    ...JIANDAOYUN_SYSTEM_FIELDS,
    ...contract.fields.map((rule) => rule.source),
    ...(contract.subforms ?? []).map((rule) => rule.source),
  ])];
}

function widgetMap(widgets: JiandaoyunWidget[]): Map<string, JiandaoyunWidget> {
  return new Map(widgets.map((widget) => [widget.name, widget]));
}

export function jiandaoyunContractWidgets(
  contract: JiandaoyunFormContract,
  widgets: JiandaoyunWidget[],
): JiandaoyunWidget[] {
  const top = widgetMap(widgets);
  const missing = contract.fields
    .filter((rule) => !top.has(rule.source))
    .map((rule) => rule.source);
  for (const subform of contract.subforms ?? []) {
    const widget = top.get(subform.source);
    if (!widget || widget.type !== "subform") {
      missing.push(subform.source);
      continue;
    }
    const children = widgetMap(widget.items);
    missing.push(...subform.items.filter((rule) => !children.has(rule.source)).map((rule) =>
      `${subform.source}.${rule.source}`));
  }
  if (missing.length > 0) {
    throw new Error(`简道云字段契约漂移，缺少 ${missing.join(", ")}`);
  }
  return [
    ...contract.fields.map((rule) => top.get(rule.source)!),
    ...(contract.subforms ?? []).map((rule) => {
      const widget = top.get(rule.source)!;
      const children = widgetMap(widget.items);
      return {
        ...widget,
        items: rule.items.map((item) => children.get(item.source)!),
      };
    }),
  ];
}

export function configuredJiandaoyunContracts(
  env: NodeJS.ProcessEnv = process.env,
): JiandaoyunFormContract[] {
  const raw = env.JIANDAOYUN_SYNC_CONTRACTS?.trim();
  if (!raw) return [];
  const requested = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  return requested.map((key) => {
    const contract = jiandaoyunContract(key);
    if (!contract) throw new Error(`未知 JIANDAOYUN_SYNC_CONTRACTS: ${key}`);
    return contract;
  });
}

/**
 * Non-secret marker binding UAT evidence to the exact selected contract set.
 * Sorting makes the marker independent of environment-variable ordering while any add/remove
 * invalidates prior evidence.
 */
export function jiandaoyunContractSetEvidenceBinding(
  contracts: readonly JiandaoyunFormContract[],
): string {
  const selected = [...new Map(contracts.map((contract) => [contract.key, contract])).values()]
    .sort((left, right) => left.key.localeCompare(right.key));
  const contractMaterial = selected.map((contract) => ({
    key: contract.key,
    appId: contract.appId,
    entryId: contract.entryId,
    targetTable: contract.targetTable,
    fields: contract.fields,
    subforms: contract.subforms ?? [],
    businessKey: contract.businessKey ?? [],
    numericControls: contract.numericControls ?? [],
    freshnessMaxAgeDays: contract.freshnessMaxAgeDays ?? null,
    reconciliations: contract.reconciliations ?? [],
    window: contract.window ?? null,
  }));
  const digest = createHash("sha256")
    .update(`jiandaoyun-contract-set-v1\0${JSON.stringify(contractMaterial)}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `${CONTRACT_SET_BINDING_PREFIX}${digest}`;
}

export function jiandaoyunEvidenceRefHasContractSetBinding(
  reference: string | null,
  contracts: readonly JiandaoyunFormContract[],
): boolean {
  if (!reference || contracts.length === 0) return false;
  const binding = jiandaoyunContractSetEvidenceBinding(contracts);
  return reference === binding || reference.endsWith(`-${binding}`);
}
