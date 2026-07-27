import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { skus, users } from "./masters";

/**
 * E2-13 / C122：周度计划版本。
 *
 * 版本与行均为捕获时点的不可变证据；历史比较不得回算当前建议引擎。
 */
export const planningVersions = pgTable("planning_versions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  weekStart: date("week_start").notNull(),
  engineVersion: text("engine_version").notNull(),
  parameters: jsonb("parameters").notNull(),
  sourceMeta: jsonb("source_meta").notNull(),
  lineCount: integer("line_count").notNull(),
  suggestedCount: integer("suggested_count").notNull(),
  suppressedCount: integer("suppressed_count").notNull(),
  digest: text("digest").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_planning_version_idempotency").on(t.idempotencyKey),
  index("ix_planning_version_created").on(t.createdAt),
  index("ix_planning_version_week").on(t.weekStart),
]);

export const planningVersionLines = pgTable("planning_version_lines", {
  id: serial("id").primaryKey(),
  versionId: integer("version_id").notNull().references(() => planningVersions.id, { onDelete: "cascade" }),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  skuCode: text("sku_code").notNull(),
  skuName: text("sku_name").notNull(),
  brand: text("brand"),
  baseUom: text("base_uom").notNull(),
  suggestedQty: numeric("suggested_qty", { precision: 14, scale: 4 }).notNull(),
  suppressed: boolean("suppressed").notNull().default(false),
  shortageDate: date("shortage_date"),
  orderByDate: date("order_by_date"),
  orderWindowMissed: boolean("order_window_missed").notNull().default(false),
  coverFull: numeric("cover_full", { precision: 14, scale: 2 }),
  onHand: numeric("on_hand", { precision: 14, scale: 4 }).notNull(),
  inTransit: numeric("in_transit", { precision: 14, scale: 4 }).notNull(),
  daily: numeric("daily", { precision: 14, scale: 4 }).notNull(),
  safetyQty: numeric("safety_qty", { precision: 14, scale: 4 }).notNull(),
  leadDays: integer("lead_days"),
  explanation: jsonb("explanation").notNull(),
}, (t) => [
  unique("uq_planning_version_sku").on(t.versionId, t.skuId),
  index("ix_planning_line_sku_version").on(t.skuId, t.versionId),
]);
