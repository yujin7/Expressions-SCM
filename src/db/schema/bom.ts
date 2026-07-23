import {
  pgTable, serial, integer, numeric, date, timestamp, uniqueIndex, text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bomStatusEnum } from "./enums";
import { skus } from "./masters";

/**
 * BOM：每成品同一时间仅一个生效版本（部分唯一索引）；
 * 生效即冻结行——改动=新版本；WO 审批时向 wo_line 复制快照，此后改版不影响历史单据。
 */
export const boms = pgTable("boms", {
  id: serial("id").primaryKey(),
  productSkuId: integer("product_sku_id").notNull().references(() => skus.id),
  versionNo: text("version_no").notNull(),
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
  lossRatePct: numeric("loss_rate_pct", { precision: 5, scale: 2 }).notNull().default("0"), // 仅计划/发料预填用，不参与结算（R2）
  leadTimeDays: integer("lead_time_days"),
  substituteSkuId: integer("substitute_sku_id").references(() => skus.id), // P0 预留字段
});
