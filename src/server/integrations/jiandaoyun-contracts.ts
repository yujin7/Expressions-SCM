export interface JiandaoyunFieldRule {
  source: string;
  target: string;
}

export interface JiandaoyunSubformRule extends JiandaoyunFieldRule {
  items: JiandaoyunFieldRule[];
}

export interface JiandaoyunFormContract {
  key: string;
  label: string;
  appId: string;
  entryId: string;
  targetTable: string;
  fields: JiandaoyunFieldRule[];
  subforms?: JiandaoyunSubformRule[];
}

const field = (target: string, source: string): JiandaoyunFieldRule => ({ target, source });

/**
 * Explicit, field-minimized contracts for the currently populated operational views.
 *
 * Contacts, phone numbers, addresses, bank accounts, tax IDs, attachments, user/dept objects and
 * images are intentionally excluded. These records remain observations in staging; no contract
 * grants authority to update SCM masters, prices, stock or documents.
 */
export const JIANDAOYUN_FORM_CONTRACTS: JiandaoyunFormContract[] = [
  {
    key: "product-master-observation",
    label: "进销存/产品信息",
    appId: "6a1fbeeac2ea65ea6099f422",
    entryId: "5c6a555e2ce076490e9e0595",
    targetTable: "jdy_product_observation",
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
