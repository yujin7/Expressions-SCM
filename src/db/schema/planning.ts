import {
  boolean,
  check,
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
import { sql } from "drizzle-orm";

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
  envelopeVersion: text("envelope_version").notNull().default("decision-envelope/v1"),
  decisionEnvelope: jsonb("decision_envelope").notNull().default({}),
  evidenceDigest: text("evidence_digest").notNull().default("legacy"),
}, (t) => [
  unique("uq_planning_version_sku").on(t.versionId, t.skuId),
  index("ix_planning_line_sku_version").on(t.skuId, t.versionId),
]);

/**
 * E2-20 / C129: immutable supply-demand allocation evidence.
 *
 * A row connects one frozen planning demand bucket to one supply fact or
 * proposed recommendation. `availableQty` records what the source offered at
 * capture time; `peggedQty` records the deterministic allocation. Excluded or
 * excess supply therefore stays visible without being misrepresented as
 * coverage.
 */
export const supplyDemandLinks = pgTable("supply_demand_links", {
  id: serial("id").primaryKey(),
  versionId: integer("version_id").notNull().references(() => planningVersions.id),
  planningLineId: integer("planning_line_id").notNull().references(() => planningVersionLines.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  demandType: text("demand_type").notNull(),
  demandDate: date("demand_date").notNull(),
  demandQty: numeric("demand_qty", { precision: 14, scale: 4 }).notNull(),
  sourceType: text("source_type").notNull(),
  sourceRef: text("source_ref"),
  sourceDocId: integer("source_doc_id"),
  sourceLineId: integer("source_line_id"),
  supplyDate: date("supply_date"),
  availableQty: numeric("available_qty", { precision: 14, scale: 4 }).notNull(),
  peggedQty: numeric("pegged_qty", { precision: 14, scale: 4 }).notNull(),
  confidence: text("confidence").notNull(),
  status: text("status").notNull(),
  sequence: integer("sequence").notNull(),
  explanation: text("explanation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_supply_demand_link_sequence").on(t.planningLineId, t.sequence),
  index("ix_supply_demand_version_sku").on(t.versionId, t.skuId),
  index("ix_supply_demand_source").on(t.sourceType, t.sourceRef),
  check("ck_supply_demand_positive_demand", sql`${t.demandQty} > 0`),
  check("ck_supply_demand_positive_available", sql`${t.availableQty} > 0`),
  check("ck_supply_demand_pegged_range", sql`${t.peggedQty} >= 0 AND ${t.peggedQty} <= ${t.availableQty}`),
  check("ck_supply_demand_sequence", sql`${t.sequence} >= 0`),
  check("ck_supply_demand_confidence", sql`${t.confidence} IN ('booked', 'reference', 'proposed', 'suppressed')`),
  check(
    "ck_supply_demand_status",
    sql`${t.status} IN ('pegged', 'partial', 'excess', 'excluded_undated', 'excluded_late', 'suppressed')`,
  ),
]);

/**
 * E2-14 / C123：单 SKU what-if 情景快照。
 *
 * 输入和输出同时保存，确保以后并排比较的是当时看到的决策证据，而不是用今天的库存悄悄回算。
 */
export const projectionScenarios = pgTable("projection_scenarios", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  name: text("name").notNull(),
  horizonDays: integer("horizon_days").notNull(),
  inputs: jsonb("inputs").notNull(),
  baselineResult: jsonb("baseline_result").notNull(),
  scenarioResult: jsonb("scenario_result").notNull(),
  sourceDate: date("source_date").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_projection_scenario_idempotency").on(t.idempotencyKey),
  index("ix_projection_scenario_sku_created").on(t.skuId, t.createdAt),
  index("ix_projection_scenario_creator_created").on(t.createdBy, t.createdAt),
]);
