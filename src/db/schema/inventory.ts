import {
  pgTable, serial, integer, numeric, text, timestamp, date, unique, index,
} from "drizzle-orm/pg-core";
import { desc } from "drizzle-orm";
import { offsetPoolKindEnum } from "./enums";
import { skus, warehouses } from "./masters";

/**
 * 库存流水——唯一事实源，仅追加（禁止 UPDATE/DELETE）。
 * UNIQUE(来源类型,来源id,来源行id,动作) 防双重过账（R10 硬约束）。
 */
export const stockLedger = pgTable("stock_ledger", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  batchId: integer("batch_id"),
  qtyDelta: numeric("qty_delta", { precision: 14, scale: 4 }).notNull(),
  sourceDocType: text("source_doc_type").notNull(),
  sourceDocId: integer("source_doc_id").notNull(),
  sourceLineId: integer("source_line_id").notNull().default(0),
  action: text("action").notNull(), // post / reverse / writeoff …
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_ledger_source").on(t.sourceDocType, t.sourceDocId, t.sourceLineId, t.action, t.warehouseId),
  index("ix_ledger_sku_wh_time").on(t.skuId, t.warehouseId, t.occurredAt),
  // DoD-5 性能：无筛选流水默认视图 ORDER BY occurredAt DESC, id DESC LIMIT——
  // 无此降序索引时 1M 行需全表排序（实测 662ms）；有则走索引扫描（perf-smoke 复测）
  index("ix_ledger_time_desc").on(desc(t.occurredAt), desc(t.id)),
]);

/**
 * 库存余额——与流水同事务维护；事务内按(skuId,warehouseId,batchId)排序更新防死锁。
 * 负库存规则（R4）：实时仓≥0，委外仓可负（=加工厂垫料，对账页标红）——由过账引擎校验（跨表约束 DB 层无法表达）。
 */
export const stockBalances = pgTable("stock_balances", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  batchId: integer("batch_id"),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull().default("0"),
}, (t) => [
  unique("uq_balance_key").on(t.skuId, t.warehouseId, t.batchId).nullsNotDistinct(),
]);

/** 快照仓（保税/E/云）唯一数据源；1.1 启用；余额查询=实时仓 balance ∪ 快照仓最新 snapshot */
export const stockSnapshots = pgTable("stock_snapshots", {
  id: serial("id").primaryKey(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  bizDate: date("biz_date").notNull(),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
}, (t) => [unique("uq_snapshot_key").on(t.warehouseId, t.skuId, t.bizDate)]);

/** 对冲池台账（R7）：备品/损耗/补送，季度盘点后一张冲销调整单 */
export const offsetPools = pgTable("offset_pools", {
  id: serial("id").primaryKey(),
  kind: offsetPoolKindEnum("kind").notNull(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"), // 当月加权平均计价
  sourceDocType: text("source_doc_type").notNull(),
  sourceDocId: integer("source_doc_id").notNull(),
  writeoffDocId: integer("writeoff_doc_id"), // 季度冲销单
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
