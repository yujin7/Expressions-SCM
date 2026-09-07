/**
 * NPD 1.x 项目跟踪（D19 激活，spec/13 §三 D）+ SKU 供应参数正式表（E 项）。
 *
 * npd_projects/npd_tasks：以 transit_refs kind=npd_node 的 69 节点标准为模板实例化；
 * 计划排程 = rules/npd-schedule.ts 拓扑推算（上一节点链，自然日）。非记账实体，
 * 无审批流（1.x 轻量跟踪）；全部写路径 writeAudit。
 *
 * sku_params：sku_leadtime staging 的转正载体（常规/紧急周期）；MOQ 仍以 uom_convs.moq
 * 为权威（releaseFinishedMoq 既有路径），此表不重复存 MOQ——单一权威原则。
 */
import {
  pgTable, serial, integer, text, timestamp, date, unique, index, check, numeric,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { skus, users } from "./masters";
import { bhDocs } from "./docs";

export const npdProjects = pgTable("npd_projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  skuCode: text("sku_code"), // 目标新品编码（可后补）
  brand: text("brand"),
  startDate: date("start_date").notNull(),
  status: text("status").notNull().default("active"), // active/done/cancelled
  version: integer("version").notNull().default(1), // aggregate version: includes node and first-order mutations
  remark: text("remark"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ix_npd_project_status").on(t.status), check("ck_npd_project_version", sql`${t.version} > 0`)]);

/** Immutable request receipt and typed project→BH lineage; a new request is not a project-level uniqueness rule. */
export const npdFirstOrders = pgTable("npd_first_orders", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => npdProjects.id),
  projectVersion: integer("project_version").notNull(),
  bhId: integer("bh_id").notNull().references(() => bhDocs.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  requestKey: text("request_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("uq_npd_first_order_request").on(t.requestedBy, t.requestKey),
  unique("uq_npd_first_order_bh").on(t.bhId),
  index("ix_npd_first_order_project").on(t.projectId, t.createdAt),
  check("ck_npd_first_order_qty", sql`${t.qty} > 0`),
  check("ck_npd_first_order_version", sql`${t.projectVersion} > 0`),
]);

export const npdTasks = pgTable("npd_tasks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => npdProjects.id),
  seq: integer("seq").notNull(), // 拓扑序
  nodeNo: text("node_no"), // 节点编号（a.1 等）
  name: text("name").notNull(),
  stage: text("stage"),
  dept: text("dept"), // 责任部门/岗位
  days: integer("days").notNull().default(0), // 标准天数（模板 qty 槽）
  planStart: date("plan_start"),
  planEnd: date("plan_end"),
  status: text("status").notNull().default("pending"), // pending/doing/done/skipped
  doneAt: date("done_at"),
  note: text("note"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_npd_task_seq").on(t.projectId, t.seq), index("ix_npd_task_project").on(t.projectId, t.status)]);

export const skuParams = pgTable("sku_params", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id).unique(),
  normalLeadDays: integer("normal_lead_days"),
  urgentLeadDays: integer("urgent_lead_days"),
  /** 生产完成后至可售仓的物流/调拨周期；与生产周期分开维护。 */
  logisticsLeadDays: integer("logistics_lead_days"),
  /** D57：原料/包材采购周期（下单→到料），与加工周期分开；缺省走 sys_params default_* */
  purchaseLeadDays: integer("purchase_lead_days"),
  updatedBy: integer("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check(
    "ck_sku_params_logistics_lead_days",
    sql`${t.logisticsLeadDays} IS NULL OR (${t.logisticsLeadDays} >= 0 AND ${t.logisticsLeadDays} <= 365)`,
  ),
  check(
    "ck_sku_params_purchase_lead_days",
    sql`${t.purchaseLeadDays} IS NULL OR (${t.purchaseLeadDays} >= 0 AND ${t.purchaseLeadDays} <= 365)`,
  ),
]);
