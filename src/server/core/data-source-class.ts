/**
 * D65 数据来源分类登记表（唯一权威，零依赖纯常量——客户端/服务端均可值导入）。
 *
 * 四类来源各自有目标准确率与度量口径；每个导入模板（人工上传 + 连接器自动产生的模板名）
 * 与每条简道云契约都必须在这里登记归类（`tests/core/data-source-class.test.ts` 钉住全覆盖）。
 * 分类只决定「准确率算在哪一栏」，不改变任何数据的权威层级：
 * 观察类（external_platform / reference_file）永远 observation_only，不进过账、不定量。
 *
 * - rpa_warehouse    RPA/电商部库存明细 → 快照仓（stock_snapshots）；目标 95%
 * - manual_po_chain  人工录入的采购单据链（BH→WO→PO→SH→RK，含简道云手工采购表单）；目标 90%
 * - external_platform 平台观察（天猫/拼多多/唯品会日销、退款、费用、流量…）；目标 90%（一致性口径）
 * - reference_file    参考文件/维表（BOM、成本、周期、对照表、店铺品牌档案…）；不度量准确率（只看及时/完整）
 * - manual_override   DQ-6：手工改写的指标（sales_amount_monthly 修正行），独立计数，不进准确率分子分母
 */

export type SourceClass = "rpa_warehouse" | "manual_po_chain" | "external_platform" | "reference_file";

export const SOURCE_CLASSES = ["rpa_warehouse", "manual_po_chain", "external_platform", "reference_file"] as const;

/** 进入 data_quality_reviews 周/月核对的三类（reference_file 只监控不核对，D65） */
export const REVIEWED_SOURCE_CLASSES = ["rpa_warehouse", "manual_po_chain", "external_platform"] as const;
export type ReviewedSourceClass = (typeof REVIEWED_SOURCE_CLASSES)[number];

export interface SourceClassDef {
  key: SourceClass;
  label: string;
  /** 目标准确率（%）；null = 不度量准确率 */
  targetAccuracyPct: number | null;
  /** 冲刺目标（%）；null = 无 */
  stretchAccuracyPct: number | null;
  /** 及时性：最新时点距今超过本值即「过期」（天） */
  freshnessMaxAgeDays: number;
  /** 准确率的度量口径（卡片必须原样显示） */
  accuracyBasis: string;
  description: string;
}

export const SOURCE_CLASS_DEFS: Record<SourceClass, SourceClassDef> = {
  rpa_warehouse: {
    key: "rpa_warehouse",
    label: "RPA 仓库快照",
    targetAccuracyPct: 95,
    stretchAccuracyPct: 98,
    freshnessMaxAgeDays: 3,
    accuracyBasis: "自有实时仓出库（stock_ledger sales_out）vs 聚水潭日销 SKU 日级一致率（recon_diffs，容差 dq_tolerance_pct），不是快照仓本身；并列已审批盘点命中率与快照相邻日跳变",
    description: "RPA/电商部导出的仓库库存明细，经 staging 放行为快照仓 stock_snapshots；时点权威、非实时账",
  },
  manual_po_chain: {
    key: "manual_po_chain",
    label: "人工采购单据链",
    targetAccuracyPct: 90,
    stretchAccuracyPct: 95,
    freshnessMaxAgeDays: 7,
    accuracyBasis: "人工导入模板首次通过率（staging 放行率）作为「首次正确率」代理；单据链本身以审批与红字冲销留痕",
    description: "备货/工单/采购/收货/入库等人工录入或人工上传的单据与模板，以及简道云里手工填写的采购类表单",
  },
  external_platform: {
    key: "external_platform",
    label: "外部平台观察",
    targetAccuracyPct: 90,
    stretchAccuracyPct: 95,
    freshnessMaxAgeDays: 2,
    accuracyBasis: "sales_monthly 与天猫日销观察按 SKU×月的一致率（三阈值；只比两侧都有数据的完整月，内部缺月不计）；目前仅覆盖天猫，拼多多/唯品会不度量；并列连接器 staging 放行率",
    description: "简道云同步的平台日销/退款/订单/费用/流量等观察数据；observation_only，不进过账、不定量",
  },
  reference_file: {
    key: "reference_file",
    label: "参考文件/维表",
    targetAccuracyPct: null,
    stretchAccuracyPct: null,
    freshnessMaxAgeDays: 45,
    accuracyBasis: "不度量准确率：维表/对照表只看及时性与完整性",
    description: "BOM、成本、周期、在途、对照表、店铺/品牌/货品档案等参考数据",
  },
};

export const SOURCE_CLASS_LABELS: Record<SourceClass, string> = {
  rpa_warehouse: SOURCE_CLASS_DEFS.rpa_warehouse.label,
  manual_po_chain: SOURCE_CLASS_DEFS.manual_po_chain.label,
  external_platform: SOURCE_CLASS_DEFS.external_platform.label,
  reference_file: SOURCE_CLASS_DEFS.reference_file.label,
};

/**
 * 导入模板 → 来源类。键 = import_jobs.template（人工上传模板 + 各连接器自动产生的模板名）。
 * 未登记的模板由 sourceClassForTemplate 按前缀兜底并在数据质量页标「未登记」。
 */
export const IMPORT_TEMPLATE_SOURCE_CLASS: Record<string, SourceClass> = {
  // 人工上传（template-contract.ts IMPORT_TEMPLATES）
  inventory: "rpa_warehouse",
  stock_summary: "rpa_warehouse",
  expiry: "rpa_warehouse",
  bom: "reference_file",
  sales: "manual_po_chain",
  leadtime: "reference_file",
  transit: "manual_po_chain",
  demand: "manual_po_chain",
  pallet: "manual_po_chain",
  sku_cost: "reference_file",
  // 适配器/历史模板名（import_jobs.template 实际出现过的值）
  npd: "reference_file",
  sku_leadtime: "reference_file",
  inventory_long_721: "rpa_warehouse",
  expiry_batch_202607: "rpa_warehouse",
  sales_monthly_summary: "manual_po_chain",
  // 聚水潭连接器
  jst_daily_sales: "external_platform",
  jst_inventory_observation: "rpa_warehouse",
  jst_item_master_observation: "reference_file",
  jst_inbound_receipts_observation: "manual_po_chain",
  // 用友
  yonyou_observation: "reference_file",
  // 简道云（模板名 = 契约 targetTable）
  jdy_product_observation: "reference_file",
  jdy_supplier_observation: "reference_file",
  jdy_warehouse_observation: "reference_file",
  jdy_purchase_demand_observation: "manual_po_chain",
  jdy_purchase_order_observation: "manual_po_chain",
  jdy_purchase_receipt_observation: "manual_po_chain",
  jdy_inventory_count_observation: "manual_po_chain",
  jdy_warehouse_transfer_observation: "manual_po_chain",
  jdy_sample_observation: "manual_po_chain",
  jdy_tmall_sku_sales_observation: "external_platform",
  jdy_tmall_sku_refund_observation: "external_platform",
  jdy_pdd_sku_crosswalk_observation: "reference_file",
  jdy_vip_product_crosswalk_observation: "reference_file",
  jdy_tmall_sku_crosswalk_observation: "reference_file",
  jdy_tmall_platform_fee_observation: "external_platform",
  jdy_tmall_unit_daily_observation: "external_platform",
  jdy_pdd_order_observation: "external_platform",
  jdy_vip_shop_trading_observation: "external_platform",
  jdy_tmall_product_pnl_observation: "external_platform",
  jdy_jst_item_master_mirror_observation: "reference_file",
  jdy_jst_bundle_bom_mirror_observation: "reference_file",
  jdy_tmall_bundle_detail_observation: "reference_file",
  jdy_pdd_sku_cost_standard_observation: "reference_file",
  jdy_vip_bundle_crosswalk_observation: "reference_file",
  jdy_finance_goods_master_observation: "reference_file",
  jdy_finance_operating_cost_observation: "reference_file",
  jdy_vip_sku_cost_observation: "reference_file",
  jdy_tmall_sku_cost_pnl_observation: "external_platform",
  jdy_tmall_product_traffic_observation: "external_platform",
  jdy_bonded_warehouse_order_observation: "external_platform",
  jdy_pdd_product_daily_observation: "external_platform",
  jdy_pdd_shop_daily_observation: "external_platform",
  jdy_shop_master_observation: "reference_file",
  jdy_brand_master_observation: "reference_file",
};

/** 简道云契约键 → 来源类（键 = JIANDAOYUN_FORM_CONTRACTS[].key；测试钉住全覆盖） */
export const JDY_CONTRACT_SOURCE_CLASS: Record<string, SourceClass> = {
  "tmall-sku-crosswalk-observation": "reference_file",
  "vip-product-crosswalk-observation": "reference_file",
  "pdd-sku-crosswalk-observation": "reference_file",
  "tmall-sku-sales-observation": "external_platform",
  "tmall-sku-refund-observation": "external_platform",
  "platform-fee-observation": "external_platform",
  "product-master-observation": "reference_file",
  "purchase-demand-observation": "manual_po_chain",
  "purchase-order-observation": "manual_po_chain",
  "purchase-receipt-observation": "manual_po_chain",
  "supplier-observation": "reference_file",
  "warehouse-observation": "reference_file",
  "warehouse-transfer-observation": "manual_po_chain",
  "inventory-count-observation": "manual_po_chain",
  "sample-management-observation": "manual_po_chain",
  "tmall-unit-daily-observation": "external_platform",
  "pdd-order-observation": "external_platform",
  "vip-shop-trading-observation": "external_platform",
  "tmall-product-pnl-observation": "external_platform",
  "jst-item-master-mirror-observation": "reference_file",
  "jst-bundle-bom-mirror-observation": "reference_file",
  "tmall-bundle-detail-observation": "reference_file",
  "pdd-sku-cost-standard-observation": "reference_file",
  "vip-bundle-crosswalk-observation": "reference_file",
  "finance-goods-master-observation": "reference_file",
  "finance-operating-cost-observation": "reference_file",
  "vip-sku-cost-observation": "reference_file",
  "tmall-sku-cost-pnl-observation": "external_platform",
  "tmall-product-traffic-observation": "external_platform",
  "bonded-warehouse-order-observation": "external_platform",
  "pdd-product-daily-observation": "external_platform",
  "pdd-shop-daily-observation": "external_platform",
  "shop-master-observation": "reference_file",
  "brand-master-observation": "reference_file",
};

/** DQ-6 手工改写指标：只在数据质量页独立列计数，不混入任何准确率分子分母 */
export const MANUAL_OVERRIDE_ENTITIES = ["sales_amount_monthly"] as const;

/** 模板 → 来源类；未登记按前缀兜底（jdy_/jst_/yonyou_ 观察 → external/reference），最终兜底 reference_file */
export function sourceClassForTemplate(template: string): { sourceClass: SourceClass; registered: boolean } {
  const hit = IMPORT_TEMPLATE_SOURCE_CLASS[template];
  if (hit) return { sourceClass: hit, registered: true };
  if (template.startsWith("jdy_") || template.startsWith("jst_")) {
    return { sourceClass: template.includes("master") || template.includes("crosswalk") ? "reference_file" : "external_platform", registered: false };
  }
  return { sourceClass: "reference_file", registered: false };
}

/** 契约键 → 来源类；未登记返回 null（测试保证注册表覆盖全部契约） */
export function sourceClassForContract(contractKey: string): SourceClass | null {
  return JDY_CONTRACT_SOURCE_CLASS[contractKey] ?? null;
}

/** 某类下登记的全部模板名 */
export function templatesOfClass(sourceClass: SourceClass): string[] {
  return Object.entries(IMPORT_TEMPLATE_SOURCE_CLASS)
    .filter(([, cls]) => cls === sourceClass)
    .map(([template]) => template)
    .sort();
}
