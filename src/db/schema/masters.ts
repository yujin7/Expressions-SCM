import {
  pgTable, serial, text, integer, boolean, date, timestamp, numeric, jsonb, unique,
} from "drizzle-orm/pg-core";
import { skuTypeEnum, skuLifecycleEnum, supplierStatusEnum, warehouseKindEnum, accountingModeEnum } from "./enums";

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
  mustChangePassword: boolean("must_change_password").notNull().default(false), // 初始密码首登强制修改

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
  // ---- DW1 增列（《04》§2.2，均可空、纯增量）----
  // brandId 为应用层外键（指向 dimensions.brands.id）：dimensions.ts 已 import 本文件，
  // 此处若 .references(() => brands.id) 需回环 import dimensions → 循环依赖，故不加 DB 级 FK。
  brandId: integer("brand_id"),
  barcode: text("barcode"), // EAN13；真实数据存在畸形重复，故不 UNIQUE——规范唯一性由 aliases(sku_barcode) 承载
  barcodeStatus: text("barcode_status"), // 04 §3 裁决：valid/malformed/duplicate/null（backfill 脚本回填）
  productType: text("product_type"), // 跨境品/一般贸易/国内品牌/TK版/亚马逊版/北美版
  lifecycle: skuLifecycleEnum("lifecycle").notNull().default("on_sale"), // 四态（04 §2.A）；行为门当前仍以 active 为准，DW2 切换
  remark: text("remark"),
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
  // ---- DW1 增列（《04》§2.3，均可空、纯增量）----
  shortName: text("short_name"), // OEM 简码惯用名（ZYT/SF/MLLJ/XZ…，归一走 aliases(supplier_oem)）
  level: text("level"), // S/A/B/C/D 分级
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // ── 合规审计补落：D11 承诺字段 + 字典联系明细 ──
  bankAccount: text("bank_account"), // 银行账户（敏感：入 SENSITIVE_FIELDS）
  paymentTerm: text("payment_term"), // 结算方式（款到发货/月结30/月结60…）
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
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
  parentId: integer("parent_id"), // D32 树状层级（0724：保税分中转/发货上下级）；空=顶级
  supplierId: integer("supplier_id").references(() => suppliers.id), // 委外仓专用
  active: boolean("active").notNull().default(true),
});

/** 供应商价格表（R1 基准兜底）：取生效日≤今日的最新行 */
export const priceLists = pgTable("price_lists", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  price: numeric("price", { precision: 14, scale: 2 }).notNull(), // 基础单位未税价
  channelId: integer("channel_id"), // D11 渠道价字段（空=默认价；应用层 FK→channels，避免循环 import）
  effectiveDate: date("effective_date").notNull(),
}, (t) => [unique("uq_price_sku_sup_chan_date").on(t.skuId, t.supplierId, t.channelId, t.effectiveDate).nullsNotDistinct()]);

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
