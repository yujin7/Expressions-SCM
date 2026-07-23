import {
  pgTable, serial, text, integer, boolean, date, timestamp, numeric, jsonb, unique,
} from "drizzle-orm/pg-core";
import { skuTypeEnum, supplierStatusEnum, warehouseKindEnum, accountingModeEnum } from "./enums";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  feishuUnionId: text("feishu_union_id").unique(),
  username: text("username").unique(), // 本地账号兜底
  passwordHash: text("password_hash"), // argon2id
  name: text("name").notNull(),
  roles: text("roles").array().notNull().default([]), // Role[]（constants.ts）
  isApprover: boolean("is_approver").notNull().default(false),
  active: boolean("active").notNull().default(true),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  parentId: integer("parent_id"),
  name: text("name").notNull(),
  level: integer("level").notNull().default(1), // ≤3
});

/** SPU=产品（报表/库存归集口径，R3）；SKU 必挂唯一 SPU，改名不断历史 */
export const spus = pgTable("spus", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // P+5位流水
  nameCn: text("name_cn").notNull(),
  nameEn: text("name_en"),
  categoryId: integer("category_id").references(() => categories.id),
});

export const skus = pgTable("skus", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // 品类2位+5位流水
  name: text("name").notNull().default(""), // 货品名称（红队集成修正：原 schema 遗漏）
  spuId: integer("spu_id").notNull().references(() => spus.id),
  spec: text("spec"), // 规格
  version: text("version"),
  prodMode: text("prod_mode"), // 生产模式
  baseUom: text("base_uom").notNull(), // 基础单位
  skuType: skuTypeEnum("sku_type").notNull(),
  lossCategory: text("loss_category"), // 品类允许损耗率参数键（R2；包材=packaging 默认5%）
  shelfLifeDays: integer("shelf_life_days"),
  nearExpiryDays: integer("near_expiry_days"), // 临期预警阈值（1.1 启用）
  active: boolean("active").notNull().default(true), // 停用=禁新单引用，在途走完
  attrs: jsonb("attrs"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const uomConvs = pgTable("uom_convs", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  purchaseUom: text("purchase_uom").notNull(),
  factor: numeric("factor", { precision: 14, scale: 4 }).notNull(), // 1采购单位=factor基础单位
  moq: numeric("moq", { precision: 14, scale: 4 }), // R11
  orderMultiple: numeric("order_multiple", { precision: 14, scale: 4 }), // R11 订货倍数
}, (t) => [unique("uq_uom_sku_uom").on(t.skuId, t.purchaseUom)]);

export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  kinds: text("kinds").array().notNull().default([]), // raw/packaging/processor 可多选
  contact: text("contact"),
  licenseExpiry: date("license_expiry"), // 资质预警数据源
  status: supplierStatusEnum("status").notNull().default("pending"), // 黑名单：禁新PO，存量JG可收尾
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  channel: text("channel"), // P1 启用
});

export const warehouses = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  kind: warehouseKindEnum("kind").notNull(),
  accountingMode: accountingModeEnum("accounting_mode").notNull().default("realtime"),
  supplierId: integer("supplier_id").references(() => suppliers.id), // 委外仓专用
  active: boolean("active").notNull().default(true),
});

/** 供应商价格表（R1 基准兜底）：取生效日≤今日的最新行 */
export const priceLists = pgTable("price_lists", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  price: numeric("price", { precision: 14, scale: 2 }).notNull(), // 基础单位未税价
  effectiveDate: date("effective_date").notNull(),
}, (t) => [unique("uq_price_sku_sup_date").on(t.skuId, t.supplierId, t.effectiveDate)]);

/** 批次主档（1.0 建表关功能，1.1 开启） */
export const batches = pgTable("batches", {
  id: serial("id").primaryKey(),
  batchNo: text("batch_no").notNull(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  prodDate: date("prod_date"),
  expiryDate: date("expiry_date"),
  sourceDocType: text("source_doc_type"),
  sourceDocId: integer("source_doc_id"),
}, (t) => [unique("uq_batch_sku_no").on(t.skuId, t.batchNo)]);

/** 附件（检验照片=扣款争议证据链；纳入备份；仅经鉴权路由下载） */
export const fileMetas = pgTable("file_metas", {
  id: serial("id").primaryKey(),
  bizType: text("biz_type").notNull(),
  bizId: integer("biz_id").notNull(),
  filename: text("filename").notNull(),
  path: text("path").notNull(),
  hash: text("hash"),
  uploadedBy: integer("uploaded_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
