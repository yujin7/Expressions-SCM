import {
  pgTable, serial, integer, numeric, date, timestamp, uniqueIndex, text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bomStatusEnum } from "./enums";
import { skus, suppliers } from "./masters";

/**
 * BOM：每成品同一时间仅一个生效版本（部分唯一索引）；
 * 生效即冻结行——改动=新版本；WO 审批时向 wo_line 复制快照，此后改版不影响历史单据。
 */
export const boms = pgTable("boms", {
  id: serial("id").primaryKey(),
  productSkuId: integer("product_sku_id").notNull().references(() => skus.id),
  versionNo: text("version_no").notNull(),
  bomCode: text("bom_code"), // 业务侧 BOM 编码（字典 bom_code；可空，UNIQUE 由业务补码后加）
  expiryDate: date("expiry_date"), // 失效日期（04 §2；空=长期有效）
  approvedBy: integer("approved_by"), // 生效审批人（approvals 表为准，此列冗余便查）
  status: bomStatusEnum("status").notNull().default("draft"),
  effectiveDate: date("effective_date"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_bom_one_active")
    .on(t.productSkuId)
    .where(sql`${t.status} = 'active'`),
  uniqueIndex("uq_bom_product_version").on(t.productSkuId, t.versionNo),
]);

export const bomLines = pgTable("bom_lines", {
  id: serial("id").primaryKey(),
  bomId: integer("bom_id").notNull().references(() => boms.id),
  materialSkuId: integer("material_sku_id").notNull().references(() => skus.id),
  qtyPer: numeric("qty_per", { precision: 14, scale: 4 }).notNull(), // 单位用量（净）
  lossRatePct: numeric("loss_rate_pct", { precision: 5, scale: 2 }).notNull().default("0"), // 兼容旧读；新口径=下两列（04 §2 双损耗）
  incomingLossPct: numeric("incoming_loss_pct", { precision: 5, scale: 2 }).notNull().default("0"), // 来料损耗（计划毛需求：净×(1+来料)×(1+生产)）
  productionLossPct: numeric("production_loss_pct", { precision: 5, scale: 2 }).notNull().default("0"), // 生产损耗；均不参与结算（R2 品类容差独立）
  leadTimeDays: integer("lead_time_days"),
  substituteSkuId: integer("substitute_sku_id").references(() => skus.id), // P0 预留字段
  // 《04》§2 增列（BOM 文件每行带供应商——数据审计最大缺口）；双损耗率按第三轮商业审计建议暂缓 1.1
  preferredSupplierId: integer("preferred_supplier_id").references(() => suppliers.id),
  uom: text("uom"), // 计数/克/毫升/%（化解「单位用量」混装）
  remark: text("remark"),
});
