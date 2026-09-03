import { boolean, check, date, index, integer, jsonb, numeric, pgTable, primaryKey, serial, text, timestamp, type AnyPgColumn, unique, uniqueIndex } from "drizzle-orm/pg-core";
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

/**
 * 外部系统同步运行史。每次 API 拉取先建 running 行，成功/失败后仅补齐结果字段；
 * 供应链事实仍必须进入 import_jobs/staging_rows，不能由连接器直接写正式表。
 *
 * evidencePath 指向 FILE_STORAGE_DIR 下的最小化源信封（去除非业务 PII），evidenceHash
 * 用于校验恢复/重放证据未被改写。idempotencyKey 防止调度重试制造重复批次。
 */
export const integrationRuns = pgTable("integration_runs", {
  id: serial("id").primaryKey(),
  connector: text("connector").notNull(),
  stream: text("stream").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").notNull().default("running"), // running | succeeded | failed
  cursorStart: text("cursor_start"),
  cursorEnd: text("cursor_end"),
  requestScope: jsonb("request_scope"),
  evidencePath: text("evidence_path"),
  evidenceHash: text("evidence_hash"),
  sourceRows: integer("source_rows").notNull().default(0),
  stagedRows: integer("staged_rows").notNull().default(0),
  rejectedRows: integer("rejected_rows").notNull().default(0),
  importJobId: integer("import_job_id").references(() => importJobs.id),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("ix_integration_runs_stream_time").on(t.connector, t.stream, t.startedAt),
  check("ck_integration_run_status", sql`${t.status} IN ('running', 'succeeded', 'failed')`),
  check(
    "ck_integration_run_terminal",
    sql`(${t.status} = 'running' AND ${t.finishedAt} IS NULL)
      OR (${t.status} IN ('succeeded', 'failed') AND ${t.finishedAt} IS NOT NULL)`,
  ),
]);

/**
 * 每个连接器数据流的单一游标。更新只在 staging 与运行史成功落库的同一事务末尾发生；
 * 失败保留旧游标，因此重试从最后一个已证明成功的位置继续。
 */
export const integrationCheckpoints = pgTable("integration_checkpoints", {
  connector: text("connector").notNull(),
  stream: text("stream").notNull(),
  cursor: text("cursor").notNull(),
  version: integer("version").notNull().default(1),
  lastRunId: integer("last_run_id").notNull().references(() => integrationRuns.id),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.connector, t.stream] }),
  check("ck_integration_checkpoint_version", sql`${t.version} > 0`),
]);

/**
 * 数据产品放行台账：把 A2/A3 从口头许可变成可验证、可失效、可撤回的产品级证据。
 *
 * sourceEvidenceDigest 绑定产品契约、必需流和连接配置范围；应用、租户、组织、契约或能力
 * 范围变化会令批准失效。每次运行的失败、过期、拒收或空源由实时门禁另行自动退回 A0/A1，
 * 正常日常刷新无需反复人工审批。批准记录本身不覆盖来源事实，也不直接触发写业务单据。
 */
export const dataProductReleases = pgTable("data_product_releases", {
  id: serial("id").primaryKey(),
  productId: text("product_id").notNull(),
  contractVersion: text("contract_version").notNull(),
  targetLevel: text("target_level").notNull(), // A2 | A3
  sourceEvidenceDigest: text("source_evidence_digest").notNull(),
  sourceEvidence: jsonb("source_evidence").notNull(),
  controlTotalRef: text("control_total_ref").notNull(),
  uatRef: text("uat_ref").notNull(),
  rollbackPlan: text("rollback_plan").notNull(),
  scopeNote: text("scope_note"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | revoked
  idempotencyKey: text("idempotency_key").notNull().unique(),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedBy: integer("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  revokedBy: integer("revoked_by").references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_data_product_release_product_time").on(t.productId, t.requestedAt),
  uniqueIndex("uq_data_product_release_open").on(t.productId).where(sql`${t.status} IN ('pending', 'approved')`),
  check("ck_data_product_release_level", sql`${t.targetLevel} IN ('A2', 'A3')`),
  check("ck_data_product_release_status", sql`${t.status} IN ('pending', 'approved', 'rejected', 'revoked')`),
  check("ck_data_product_release_version", sql`${t.version} > 0`),
  check(
    "ck_data_product_release_decision",
    sql`(${t.status} = 'pending' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)
      OR (${t.status} IN ('approved', 'rejected', 'revoked') AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
  ),
  check(
    "ck_data_product_release_revocation",
    sql`(${t.status} <> 'revoked' AND ${t.revokedBy} IS NULL AND ${t.revokedAt} IS NULL)
      OR (${t.status} = 'revoked' AND ${t.revokedBy} IS NOT NULL AND ${t.revokedAt} IS NOT NULL)`,
  ),
]);

/**
 * 数据产品真实结果台账：把“系统给了什么建议、业务如何决定、后来结果如何”固化为可学习证据。
 *
 * 台账只追加。录错时新增 supersedesId 纠正记录，不 UPDATE/DELETE 原事实；每条记录绑定当时的
 * 产品契约、有效放行和来源范围指纹，防止把后来变化的模型/数据范围倒灌到历史绩效。
 * 它只用于采用率、误报率、处理时长、节省工时与现金影响复盘，不会自动提升 A2/A3 或过账。
 */
export const dataProductOutcomeEvents = pgTable("data_product_outcome_events", {
  id: serial("id").primaryKey(),
  productId: text("product_id").notNull(),
  contractVersion: text("contract_version").notNull(),
  releaseId: integer("release_id").notNull().references(() => dataProductReleases.id),
  sourceEvidenceDigest: text("source_evidence_digest").notNull(),
  decisionRef: text("decision_ref").notNull(),
  businessDate: date("business_date").notNull(),
  decision: text("decision").notNull(), // accepted | modified | rejected | deferred
  result: text("result").notNull(), // pending | positive | neutral | negative | false_positive
  handlingMinutes: integer("handling_minutes"),
  savedHours: numeric("saved_hours", { precision: 12, scale: 2 }),
  cashImpact: numeric("cash_impact", { precision: 18, scale: 2 }),
  currency: text("currency"),
  reasonCode: text("reason_code"),
  evidenceRef: text("evidence_ref"),
  note: text("note").notNull(),
  supersedesId: integer("supersedes_id").references((): AnyPgColumn => dataProductOutcomeEvents.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  recordedBy: integer("recorded_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_data_product_outcome_product_date").on(t.productId, t.businessDate),
  uniqueIndex("uq_data_product_outcome_root")
    .on(t.productId, t.decisionRef)
    .where(sql`${t.supersedesId} IS NULL`),
  uniqueIndex("uq_data_product_outcome_supersedes")
    .on(t.supersedesId)
    .where(sql`${t.supersedesId} IS NOT NULL`),
  check("ck_data_product_outcome_decision", sql`${t.decision} IN ('accepted', 'modified', 'rejected', 'deferred')`),
  check("ck_data_product_outcome_result", sql`${t.result} IN ('pending', 'positive', 'neutral', 'negative', 'false_positive')`),
  check("ck_data_product_outcome_handling", sql`${t.handlingMinutes} IS NULL OR (${t.handlingMinutes} >= 0 AND ${t.handlingMinutes} <= 525600)`),
  check("ck_data_product_outcome_saved_hours", sql`${t.savedHours} IS NULL OR ${t.savedHours} >= 0`),
  check("ck_data_product_outcome_currency", sql`(${t.cashImpact} IS NULL AND ${t.currency} IS NULL) OR (${t.cashImpact} IS NOT NULL AND ${t.currency} = 'CNY')`),
  check(
    "ck_data_product_outcome_reason",
    sql`${t.reasonCode} IS NULL OR ${t.reasonCode} IN ('data_quality', 'identity_gap', 'timing', 'business_constraint', 'duplicate', 'low_confidence', 'other')`,
  ),
  check(
    "ck_data_product_outcome_reason_required",
    sql`${t.decision} NOT IN ('modified', 'rejected') AND ${t.result} NOT IN ('negative', 'false_positive') OR ${t.reasonCode} IS NOT NULL`,
  ),
  check(
    "ck_data_product_outcome_evidence_required",
    sql`${t.result} = 'pending' OR ${t.evidenceRef} IS NOT NULL`,
  ),
  check("ck_data_product_outcome_no_self_supersede", sql`${t.supersedesId} IS NULL OR ${t.supersedesId} <> ${t.id}`),
]);

/** #8 通知发件箱（outbox 模式）：应用内产生通知 → 排队 → 分发任务按渠道推送。
 *  渠道 feishu=飞书自定义机器人 webhook（URL 存 env FEISHU_WEBHOOK_URL，无则跳过）；
 *  in_app=站内。幂等键 dedupeKey 防重复入队。sending 是带租约的原子认领态，避免多实例重复发送。 */
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(), // feishu | in_app
  title: text("title").notNull(),
  body: text("body").notNull(),
  href: text("href"),
  severity: text("severity"), // critical/high/medium/info
  status: text("status").notNull().default("pending"), // pending/sending/sent/skipped/failed
  dedupeKey: text("dedupe_key"),
  // func#12 收件人：userId=定向个人（null=广播）；targetRole=定向角色（null=全员）
  userId: integer("user_id"),
  targetRole: text("target_role"),
  // 站内已读（null=未读）
  readAt: timestamp("read_at", { withTimezone: true }),
  error: text("error"),
  dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  // struct#1 修复：dedupeKey 唯一但 NULL 相异（多条无键通知可共存，不再被静默吞掉）
  unique("uq_notify_dedupe").on(t.dedupeKey),
  index("ix_notify_status").on(t.status, t.createdAt),
  check("ck_notify_attempt_count", sql`${t.attemptCount} >= 0`),
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
  // ── 预警引擎扩列（D56/D57，迁移 0048）：责任角色、动作链接、去重键、规则来源、参数快照、最近命中、已知悉 ──
  ownerRole: text("owner_role"),
  actionHref: text("action_href"),
  dedupeKey: text("dedupe_key"),
  sourceRule: text("source_rule"),
  paramsSnapshot: jsonb("params_snapshot"),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
  ackedBy: integer("acked_by"),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
}, (t) => [
  index("ix_alert_status_cat").on(t.status, t.category),
  index("ix_alert_dedupe").on(t.dedupeKey, t.status),
  // 审阅修复：引擎"同 category+dedupeKey 只保留一条 open"由数据库保证（并发/重叠运行不再双开）
  uniqueIndex("uq_alert_open_dedupe").on(t.category, t.dedupeKey).where(sql`${t.status} = 'open'`),
]);
