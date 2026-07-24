import {
  pgTable, serial, integer, numeric, text, date, timestamp, unique, index, jsonb } from "drizzle-orm/pg-core";
import { skus, suppliers, warehouses } from "./masters";

/**
 * 加工费参考价（《04》§2）：承接 BOM 文件的 815 条加工费行（复核值 525+206+84）。
 * feeds woDocs.feeRatePlan；不复用 price_lists（语义/脱敏路径不同）；feeRate 属 R9 敏感字段。
 */
export const processingFeeRefs = pgTable("processing_fee_refs", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  feeRate: numeric("fee_rate", { precision: 14, scale: 2 }), // BOM 文件常缺价——可空，待采购补录
  effectiveDate: date("effective_date").notNull(),
  source: text("source"), // bom_import / manual
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_fee_sku_sup_date").on(t.skuId, t.supplierId, t.effectiveDate)]);

/**
 * 批次库存参考层（《04》§2 batch_stocks）：效期盘点数量的载体——1.0 账本批次列为哨兵（00-B7 不变），
 * R15 效期七段视图由本表+快照计算；1.1 批次入账后降级为核对参考。**非账本，不参与过账。**
 */
export const batchStocks = pgTable("batch_stocks", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id), // 逻辑仓
  batchNo: text("batch_no"),
  prodDate: date("prod_date"),
  expiryDate: date("expiry_date"),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  stocktakeDate: date("stocktake_date").notNull(), // 盘点所属期间
  source: text("source"), // expiry_import 等
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_batch_stocks_sku_wh").on(t.skuId, t.warehouseId),
  // RT4-F7：自然幂等键——staging 行状态之外的第二道防线（重复行整套重插=效期视图翻倍）
  unique("uq_batch_stock_key").on(t.skuId, t.warehouseId, t.stocktakeDate, t.prodDate, t.expiryDate, t.batchNo).nullsNotDistinct(),
]);

/**
 * 外部单号对照（《04》§2）：用友 CGDD-* / 钉钉审批号 / 聚水潭单号 ↔ 系统单据。
 * 覆盖 WO/JG/PO 及迁移登记（04 §6 新旧划断的存量单查询入口）；一单可挂多外部号。
 */
export const externalDocRefs = pgTable("external_doc_refs", {
  id: serial("id").primaryKey(),
  docType: text("doc_type").notNull(), // wo/jg/po/migration_registry…
  docId: integer("doc_id"), // 迁移登记项可为空（无系统单据，仅登记）
  system: text("system").notNull(), // yonyou/dingtalk/jst
  refNo: text("ref_no").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_ext_system_ref").on(t.system, t.refNo)]);

/**
 * 在途/备料参考层（D16 新旧划断的执行面）：存量单在旧流程收尾，本表只读登记——
 * 绝不入账本；每次重导整类替换（replace-by-kind，语义同快照）。
 * kind: fg_order 成品在途 / pkg_order 包材在途 / pkg_stock 包材备料 / oem_map OEM归属
 */
export const transitRefs = pgTable("transit_refs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  brandRaw: text("brand_raw"),
  skuCode: text("sku_code"), // 成品编码（原文保真）
  skuId: integer("sku_id"), // 解析命中则填（别名优先），未命中留空仍展示
  materialCode: text("material_code"),
  materialName: text("material_name"),
  oemRaw: text("oem_raw"),
  supplierId: integer("supplier_id"),
  externalNo: text("external_no"), // 用友订单号
  approvalNo: text("approval_no"), // 钉钉审批号
  feishuNo: text("feishu_no"),
  orderType: text("order_type"),
  qty: numeric("qty", { precision: 14, scale: 4 }),
  doneQty: numeric("done_qty", { precision: 14, scale: 4 }),
  inboundQty: numeric("inbound_qty", { precision: 14, scale: 4 }),
  closedQty: numeric("closed_qty", { precision: 14, scale: 4 }),
  usedQty: numeric("used_qty", { precision: 14, scale: 4 }),
  remainQty: numeric("remain_qty", { precision: 14, scale: 4 }),
  orderDate: date("order_date"),
  needDate: date("need_date"),
  replyDate: date("reply_date"),
  revisedDate: date("revised_date"),
  expectDate: date("expect_date"), // 预计入仓/结束时间
  startDate: date("start_date"), // oem_map 生效起
  progress: text("progress"), // 订单实时进度（11 态词表）/包材进度
  urgentDept: text("urgent_dept"),
  follower: text("follower"), // 跟进人/备货部门
  exception: text("exception"), // 异常情况/原因
  extra: jsonb("extra"),
  sourceJobId: integer("source_job_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_transit_kind").on(t.kind),
  index("ix_transit_sku").on(t.skuCode),
  index("ix_transit_approval").on(t.approvalNo),
]);
