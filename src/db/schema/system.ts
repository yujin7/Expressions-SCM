import {
  pgTable, serial, integer, text, timestamp, jsonb, unique, numeric, date, primaryKey, index,
} from "drizzle-orm/pg-core";
import { approvalActionEnum, importStatusEnum, reconStatusEnum } from "./enums";
import { users, skus } from "./masters";

/** 审批记录：UNIQUE(单据,节点,动作) 幂等（R10） */
export const approvals = pgTable("approvals", {
  id: serial("id").primaryKey(),
  docType: text("doc_type").notNull(),
  docId: integer("doc_id").notNull(),
  node: integer("node").notNull().default(1), // MVP 单级=1
  approverId: integer("approver_id").notNull().references(() => users.id),
  action: approvalActionEnum("action").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_approval_idem").on(t.docType, t.docId, t.node, t.action)]);

/** 审批配置——单一权威（《01》§6 默认表由 seed 写入）；系统强制审批人≠制单人 */
export const approvalConfigs = pgTable("approval_configs", {
  id: serial("id").primaryKey(),
  docType: text("doc_type").notNull().unique(),
  approverRole: text("approver_role").notNull(), // Role；审批人=该角色中 is_approver=true 且非制单人
});

/** 系统参数：scope=global | category:<品类> | docType:<单据> */
export const sysParams = pgTable("sys_params", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull().default("global"),
  key: text("key").notNull(),
  value: text("value").notNull(),
  note: text("note"),
}, (t) => [unique("uq_param_scope_key").on(t.scope, t.key)]);

/** 聚水潭对账差异（reconcile-jst 每日写入；差异页数据源；DoD-2 出数口径） */
export const reconDiffs = pgTable("recon_diffs", {
  id: serial("id").primaryKey(),
  bizDate: date("biz_date").notNull(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  sysQty: numeric("sys_qty", { precision: 14, scale: 4 }).notNull(),
  jstQty: numeric("jst_qty", { precision: 14, scale: 4 }).notNull(),
  diffQty: numeric("diff_qty", { precision: 14, scale: 4 }).notNull(),
  status: reconStatusEnum("status").notNull().default("open"),
  note: text("note"),
}, (t) => [unique("uq_recon_date_sku").on(t.bizDate, t.skuId)]);

/** 审计日志——仅追加；批量导入记 1 行/任务（文件hash+行数），不逐行存前后JSON */
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  entity: text("entity").notNull(),
  entityId: integer("entity_id"),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ix_audit_entity").on(t.entity, t.entityId), index("ix_audit_time").on(t.createdAt)]);

export const importJobs = pgTable("import_jobs", {
  id: serial("id").primaryKey(),
  template: text("template").notNull(),
  filename: text("filename").notNull(),
  fileHash: text("file_hash"),
  status: importStatusEnum("status").notNull().default("pending"),
  okRows: integer("ok_rows").notNull().default(0),
  failRows: integer("fail_rows").notNull().default(0),
  errorFile: text("error_file"),
  idempotencyKey: text("idempotency_key"), // 快照/汇总=模板+业务日期，覆盖重导
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 取号器（R8/B5）：行锁 UPDATE…RETURNING；doc_no UNIQUE 兜底 */
export const docCounters = pgTable("doc_counters", {
  prefix: text("prefix").notNull(),
  bizDate: text("biz_date").notNull(), // YYYYMMDD
  lastNo: integer("last_no").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.prefix, t.bizDate] })]);
