import {
  pgTable, serial, integer, numeric, text, date, timestamp, unique, index,
} from "drizzle-orm/pg-core";
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
