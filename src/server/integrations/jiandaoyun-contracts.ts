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
   * 是否用它喂销速、以及净销量口径（支付件数 减 退款子订单数）属业务裁决；
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
