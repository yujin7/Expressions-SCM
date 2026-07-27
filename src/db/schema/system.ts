import {
  pgTable, serial, integer, text, timestamp, jsonb, unique, numeric, date, primaryKey, index, boolean, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { approvalActionEnum, importStatusEnum, reconStatusEnum } from "./enums";
import { users, skus } from "./masters";

/** 审批记录：UNIQUE(单据,节点,动作,轮次) 幂等（R10）
 *  cycle=审批时的单据版本号——红队 M1 修复：驳回→重提→再驳回属于新轮次（新 key），
 *  同轮次重试仍幂等。 */
export const approvals = pgTable("approvals", {
  id: serial("id").primaryKey(),
  docType: text("doc_type").notNull(),
  docId: integer("doc_id").notNull(),
  node: integer("node").notNull().default(1), // MVP 单级=1
  cycle: integer("cycle").notNull().default(0), // = 审批时点的单据 version
  approverId: integer("approver_id").notNull().references(() => users.id),
  action: approvalActionEnum("action").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_approval_idem").on(t.docType, t.docId, t.node, t.action, t.cycle)]);

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
  /** E8-05：写入时固化的规范事件身份；历史行为空，读模型按原 action 兼容分类。 */
  canonicalEvent: text("canonical_event"),
  eventDomain: text("event_domain"),
  eventVersion: text("event_version"),
  isStateChange: boolean("is_state_change"),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_audit_entity").on(t.entity, t.entityId),
  index("ix_audit_time").on(t.createdAt),
  index("ix_audit_canonical_time").on(t.canonicalEvent, t.createdAt),
]);

export const importJobs = pgTable("import_jobs", {
  id: serial("id").primaryKey(),
  template: text("template").notNull(),
  filename: text("filename").notNull(),
  fileHash: text("file_hash"),
  /** 外部事实的业务截止日；不同于系统收到文件的 createdAt。 */
  sourceAsOf: date("source_as_of"),
  /** 解析契约版本，支持规则升级后的可重放与解释。 */
  schemaVersion: text("schema_version").notNull().default("staging-v1"),
  /** 本次放行声明的范围（目标、full/delta、仓库集合等）。 */
  scope: jsonb("scope"),
  controlRows: integer("control_rows"),
  controlQty: numeric("control_qty", { precision: 18, scale: 4 }),
  /** 目标级放行摘要：输入摘要、规则版本、结果计数与 digest。 */
  releaseManifest: jsonb("release_manifest"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  status: importStatusEnum("status").notNull().default("pending"),
  okRows: integer("ok_rows").notNull().default(0),
  failRows: integer("fail_rows").notNull().default(0),
  errorFile: text("error_file"),
  idempotencyKey: text("idempotency_key"), // 快照/汇总=模板+业务日期，覆盖重导
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 月结六项检查单的人工作业状态。系统证据每次读取实时重算；完成/例外关闭时把当时证据
 * 固化进 evidence，避免后来事实变化后无法解释当时为何关账。
 */
export const monthCloseChecks = pgTable("month_close_checks", {
  id: serial("id").primaryKey(),
  month: text("month").notNull(), // YYYY-MM，Asia/Shanghai
  checkKey: text("check_key").notNull(),
  status: text("status").notNull().default("pending"), // pending/completed/waived
  note: text("note"),
  evidence: jsonb("evidence"),
  completedBy: integer("completed_by").references(() => users.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_month_close_month_key").on(t.month, t.checkKey),
  index("ix_month_close_month").on(t.month),
  check("ck_month_close_month", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check("ck_month_close_key", sql`${t.checkKey} IN ('data_release', 'operational_docs', 'inventory_count', 'jst_reconciliation', 'borrow_reconciliation', 'settlement_close')`),
  check("ck_month_close_status", sql`${t.status} IN ('pending', 'completed', 'waived')`),
  check(
    "ck_month_close_completion",
    sql`(${t.status} = 'pending' AND ${t.completedBy} IS NULL AND ${t.completedAt} IS NULL) OR (${t.status} IN ('completed', 'waived') AND ${t.completedBy} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
  ),
  check("ck_month_close_waiver_note", sql`${t.status} <> 'waived' OR length(trim(coalesce(${t.note}, ''))) > 0`),
]);

/** 取号器（R8/B5）：行锁 UPDATE…RETURNING；doc_no UNIQUE 兜底 */
export const docCounters = pgTable("doc_counters", {
  prefix: text("prefix").notNull(),
  bizDate: text("biz_date").notNull(), // YYYYMMDD
  lastNo: integer("last_no").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.prefix, t.bizDate] })]);

/* ── RT5 建设波（top-20 改进）共享基座 ─────────────── */

/** 复核清单（原 reports/复核清单-*.md 落库）：代决事项的在案审阅工作流 */
export const reviewItems = pgTable("review_items", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(), // spu_cluster/bom_version/segment/shell_brand/blocked/...
  refType: text("ref_type"), // sku/bom/spu/staging_row（可空=纯文字项）
  refKey: text("ref_key"), // 编码或 id 字符串，用于跳转
  title: text("title").notNull(),
  detail: text("detail"),
  status: text("status").notNull().default("open"), // open/done/overruled
  note: text("note"), // 复核意见
  decidedBy: integer("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ix_review_status_cat").on(t.status, t.category)]);

/** 异步导出任务（DoD：>5000 行走异步；进程内 worker 轮询，PGlite/PG 通用） */
export const exportJobs = pgTable("export_jobs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // balance/ledger/bom/settlement-summary/...
  params: jsonb("params"),
  status: text("status").notNull().default("pending"), // pending/running/done/failed
  filePath: text("file_path"),
  rowCount: integer("row_count"),
  error: text("error"),
  requestedBy: integer("requested_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("ix_export_status").on(t.status, t.createdAt)]);

/** 运行错误留档（errorId 可查——errorResponse 500 时写入） */
export const errorLogs = pgTable("error_logs", {
  id: serial("id").primaryKey(),
  errorId: text("error_id").notNull(),
  path: text("path"),
  method: text("method"),
  userId: integer("user_id"),
  message: text("message").notNull(),
  stack: text("stack"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ix_error_logs_time").on(t.createdAt)]);

/** 任务运行史（进程内调度回退 + 运维面板数据源） */
export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  job: text("job").notNull(),
  ok: boolean("ok").notNull(),
  message: text("message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ix_job_runs").on(t.job, t.finishedAt)]);

/** #8 通知发件箱（outbox 模式）：应用内产生通知 → 排队 → 分发任务按渠道推送。
 *  渠道 feishu=飞书自定义机器人 webhook（URL 存 env FEISHU_WEBHOOK_URL，无则跳过）；
 *  in_app=站内。幂等键 dedupeKey 防重复入队。状态 pending/sent/skipped/failed。 */
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(), // feishu | in_app
  title: text("title").notNull(),
  body: text("body").notNull(),
  href: text("href"),
  severity: text("severity"), // critical/high/medium/info
  status: text("status").notNull().default("pending"), // pending/sent/skipped/failed
  dedupeKey: text("dedupe_key"),
  // func#12 收件人：userId=定向个人（null=广播）；targetRole=定向角色（null=全员）
  userId: integer("user_id"),
  targetRole: text("target_role"),
  // 站内已读（null=未读）
  readAt: timestamp("read_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  // struct#1 修复：dedupeKey 唯一但 NULL 相异（多条无键通知可共存，不再被静默吞掉）
  unique("uq_notify_dedupe").on(t.dedupeKey),
  index("ix_notify_status").on(t.status, t.createdAt),
]);

/** struct#4/#15：系统告警（看门狗产出，与人工裁决 review_items 分家——生命周期不同）。
 *  data_freshness/doc_aging 迁入本表；status open/resolved；autoResolved=系统自动关闭。 */
export const systemAlerts = pgTable("system_alerts", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(), // data_freshness | doc_aging
  refKey: text("ref_key"),
  title: text("title").notNull(),
  detail: text("detail"),
  severity: text("severity"), // high/medium
  status: text("status").notNull().default("open"), // open | resolved
  autoResolved: boolean("auto_resolved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("ix_alert_status_cat").on(t.status, t.category)]);
