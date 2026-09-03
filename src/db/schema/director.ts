/**
 * 总监需求实施计划（2026-09-03，D50–D66）共享基座：新表全部收在本文件，
 * 既有表增列在各自文件（stock_docs.transfer_type / suppliers 账期与产能 / sku_params.purchase_lead_days）。
 * 全部 schema 改动合并为一次迁移 `drizzle/0047_director_program.sql`（D66）。
 *
 * 写路径约定：所有表只能经 service 写入并在同事务 writeAudit；
 * 追加式表（transfer_fees 红字、sales_amount_monthly / ops_demand_submissions supersedes 链）不做 UPDATE 纠错。
 * 「当前有效行」（supersedes 链尾）由 service 保证，表上只放查询索引。
 */
import {
  pgTable, serial, integer, text, numeric, date, timestamp, boolean, jsonb, unique, uniqueIndex, index, check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, skus, spus } from "./masters";
import { stockDocs } from "./docs";
import { channels } from "./dimensions";

/** 'YYYY-MM' 月份键（与 sales_monthly.year_month 同形） */
const YEAR_MONTH_RE = sql.raw("'^[0-9]{4}-(0[1-9]|1[0-2])$'");

/* ────────────────────────── D60 调拨费用 ────────────────────────── */

/**
 * 调拨费用（单据粒度，不到行）。fee_type 四类；红字作废 = 插入 reversal_of_id 指向原行、amount 为负。
 * 成本基线 rules/transfer-cost.ts 只读已完成单据的净额（正+负）。
 */
export const transferFees = pgTable("transfer_fees", {
  id: serial("id").primaryKey(),
  stockDocId: integer("stock_doc_id").notNull().references(() => stockDocs.id),
  feeType: text("fee_type").notNull(), // freight 运费 | handling 装卸/操作 | customs 关税/报关 | other
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(), // 原行 ≥0；红字行 <0
  currency: text("currency").notNull().default("CNY"),
  carrier: text("carrier"), // 承运商（原文）
  bizDate: date("biz_date").notNull(), // 费用发生日
  source: text("source").notNull().default("manual"), // manual | import
  note: text("note"),
  reversalOfId: integer("reversal_of_id").references((): AnyPgColumn => transferFees.id),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_transfer_fees_doc").on(t.stockDocId),
  index("ix_transfer_fees_biz_date").on(t.bizDate),
  unique("uq_transfer_fees_reversal_of").on(t.reversalOfId), // 一行只能被红冲一次
  check("ck_transfer_fees_type", sql`${t.feeType} IN ('freight', 'handling', 'customs', 'other')`),
  check("ck_transfer_fees_source", sql`${t.source} IN ('manual', 'import')`),
  check(
    "ck_transfer_fees_sign",
    sql`(${t.reversalOfId} IS NULL AND ${t.amount} >= 0) OR (${t.reversalOfId} IS NOT NULL AND ${t.amount} < 0)`,
  ),
]);

/* ────────────────────────── D53 销售金额（月） ────────────────────────── */

/**
 * 月度销售金额（财务口径），append-only：修正 = 插入新行并 supersedes_id 指向旧行。
 * scope_kind=company 时 scope_id 必空；brand/channel 时 scope_id 必填（应用层 FK → brands.id / channels.id）。
 * source=prefill_observation 时 source_ref 记外部观察批次/契约键，供追溯。
 * DTO 键 salesAmount 已入 SENSITIVE_FIELDS：ops/warehouse/quality 不可见。
 */
export const salesAmountMonthly = pgTable("sales_amount_monthly", {
  id: serial("id").primaryKey(),
  yearMonth: text("year_month").notNull(), // 'YYYY-MM'
  scopeKind: text("scope_kind").notNull(), // company | brand | channel
  scopeId: integer("scope_id"),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("CNY"),
  source: text("source").notNull().default("manual"), // manual | prefill_observation
  sourceRef: text("source_ref"),
  note: text("note"),
  supersedesId: integer("supersedes_id").references((): AnyPgColumn => salesAmountMonthly.id),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_sales_amount_monthly_scope").on(t.yearMonth, t.scopeKind, t.scopeId),
  unique("uq_sales_amount_monthly_supersedes").on(t.supersedesId), // 链式单向：一行只能被替代一次
  // 审阅修复：每键只能有一个链头（supersedes_id IS NULL）；并发首提由 23505 → 409 兜住（company 的 scope_id 为 NULL，coalesce 归零参与唯一）
  uniqueIndex("uq_sales_amount_monthly_head").on(t.yearMonth, t.scopeKind, sql`coalesce(${t.scopeId}, 0)`).where(sql`${t.supersedesId} IS NULL`),
  check("ck_sales_amount_monthly_ym", sql`${t.yearMonth} ~ ${YEAR_MONTH_RE}`),
  check("ck_sales_amount_monthly_scope_kind", sql`${t.scopeKind} IN ('company', 'brand', 'channel')`),
  check(
    "ck_sales_amount_monthly_scope_id",
    sql`(${t.scopeKind} = 'company' AND ${t.scopeId} IS NULL) OR (${t.scopeKind} <> 'company' AND ${t.scopeId} IS NOT NULL)`,
  ),
  check("ck_sales_amount_monthly_source", sql`${t.source} IN ('manual', 'prefill_observation')`),
]);

/* ────────────────────────── D62 用户数据范围 ────────────────────────── */

/**
 * 受限用户（ops）的可见范围。target_id 为应用层 FK → channels.id（channels.kind 与 scope_kind 对应：
 * platform→channel、dept→dept）；admin 不受限，无行 = 无范围（fail closed 由 service 决定）。
 */
export const userDataScopes = pgTable("user_data_scopes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  scopeKind: text("scope_kind").notNull(), // channel | dept
  targetId: integer("target_id").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_user_data_scopes").on(t.userId, t.scopeKind, t.targetId),
  check("ck_user_data_scopes_kind", sql`${t.scopeKind} IN ('channel', 'dept')`),
]);

/* ────────────────────────── D61 待办 / 部门目标 ────────────────────────── */

/** 角色枚举（与 core/constants.ts ROLES 一致；测试钉住） */
const ROLE_LIST_SQL = sql`('ops', 'purchasing', 'warehouse', 'quality', 'pmc', 'finance', 'admin')`;

/**
 * 待办工作项（部门先=角色）。完成率/按时率只读统计，不打分。
 * source_kind=alert 时 source_ref 记 system_alerts.id；review 记 review_items.id。
 */
export const workItems = pgTable("work_items", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  detail: text("detail"),
  assigneeId: integer("assignee_id").notNull().references(() => users.id),
  assignerId: integer("assigner_id").notNull().references(() => users.id),
  ownerRole: text("owner_role"), // 责任角色（ROLES），空=按人不按部门
  priority: text("priority").notNull().default("normal"), // low | normal | high
  dueDate: date("due_date"),
  status: text("status").notNull().default("open"), // open | in_progress | done | cancelled
  sourceKind: text("source_kind"), // alert | manual | review
  sourceRef: text("source_ref"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_work_items_assignee_status").on(t.assigneeId, t.status),
  index("ix_work_items_due").on(t.dueDate),
  index("ix_work_items_source").on(t.sourceKind, t.sourceRef), // 指纹查找（todo-sync 每半小时按来源去重）
  check("ck_work_items_priority", sql`${t.priority} IN ('low', 'normal', 'high')`),
  check("ck_work_items_status", sql`${t.status} IN ('open', 'in_progress', 'done', 'cancelled')`),
  check("ck_work_items_source_kind", sql`${t.sourceKind} IS NULL OR ${t.sourceKind} IN ('alert', 'manual', 'review')`),
  check("ck_work_items_owner_role", sql`${t.ownerRole} IS NULL OR ${t.ownerRole} IN ${ROLE_LIST_SQL}`),
  check("ck_work_items_completed", sql`(${t.status} = 'done') = (${t.completedAt} IS NOT NULL)`),
]);

/**
 * 部门目标（dept_key=角色）。period 支持月 'YYYY-MM' 与季 'YYYY-Qn'；
 * actual_value 由 actual_source=auto 的指标任务回填或 manual 手工填报。
 */
export const departmentGoals = pgTable("department_goals", {
  id: serial("id").primaryKey(),
  deptKey: text("dept_key").notNull(),
  period: text("period").notNull(),
  metricKey: text("metric_key").notNull(), // 指标 id（metric registry）
  targetValue: numeric("target_value", { precision: 14, scale: 4 }).notNull(),
  direction: text("direction").notNull(), // up 越高越好 | down 越低越好
  actualValue: numeric("actual_value", { precision: 14, scale: 4 }),
  actualSource: text("actual_source"), // auto | manual
  note: text("note"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_department_goals").on(t.deptKey, t.period, t.metricKey),
  check("ck_department_goals_dept", sql`${t.deptKey} IN ${ROLE_LIST_SQL}`),
  check("ck_department_goals_period", sql`${t.period} ~ ${YEAR_MONTH_RE} OR ${t.period} ~ '^[0-9]{4}-Q[1-4]$'`),
  check("ck_department_goals_direction", sql`${t.direction} IN ('up', 'down')`),
  check("ck_department_goals_actual_source", sql`${t.actualSource} IS NULL OR ${t.actualSource} IN ('auto', 'manual')`),
  check(
    "ck_department_goals_actual_pair",
    // 有值必有来源；auto 必有值；manual 允许暂无值（"声明手工填报、待附证据登记"——审阅修复：否则声明会被 refresh 当 auto 行覆盖）
    sql`(${t.actualValue} IS NULL OR ${t.actualSource} IS NOT NULL) AND (${t.actualSource} IS DISTINCT FROM 'auto' OR ${t.actualValue} IS NOT NULL)`,
  ),
]);

/* ────────────────────────── D58/D59 SKU 月度计划策略 ────────────────────────── */

/**
 * 月度固化的分层与权责：tier 由 rules/abc.ts 四档参数化产出（S/A/B/C），abc 为兼容三档（tierToAbc：S→A），
 * xyz 为需求波动分级（可空=样本不足），ownership 由 rules/replenish-ownership.ts 判定。
 * 人工覆写只写 override_* 三列（审计），tier 原值保留。
 */
export const skuPlanningPolicy = pgTable("sku_planning_policy", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  period: text("period").notNull(), // 'YYYY-MM'
  tier: text("tier").notNull(), // S | A | B | C
  abc: text("abc").notNull(), // A | B | C
  xyz: text("xyz"), // X | Y | Z
  ownership: text("ownership").notNull(), // supply_chain_direct | joint_review | ops_fallback
  pilot: boolean("pilot").notNull().default(false),
  overrideTier: text("override_tier"),
  overrideBy: integer("override_by").references(() => users.id),
  overrideNote: text("override_note"),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_sku_planning_policy_period").on(t.skuId, t.period),
  index("ix_sku_planning_policy_period_tier").on(t.period, t.tier),
  check("ck_sku_planning_policy_period", sql`${t.period} ~ ${YEAR_MONTH_RE}`),
  check("ck_sku_planning_policy_tier", sql`${t.tier} IN ('S', 'A', 'B', 'C')`),
  check("ck_sku_planning_policy_abc", sql`${t.abc} IN ('A', 'B', 'C')`),
  check("ck_sku_planning_policy_xyz", sql`${t.xyz} IS NULL OR ${t.xyz} IN ('X', 'Y', 'Z')`),
  check(
    "ck_sku_planning_policy_ownership",
    sql`${t.ownership} IN ('supply_chain_direct', 'joint_review', 'ops_fallback')`,
  ),
  check("ck_sku_planning_policy_override_tier", sql`${t.overrideTier} IS NULL OR ${t.overrideTier} IN ('S', 'A', 'B', 'C')`),
  check(
    "ck_sku_planning_policy_override_pair",
    sql`(${t.overrideTier} IS NULL AND ${t.overrideBy} IS NULL) OR (${t.overrideTier} IS NOT NULL AND ${t.overrideBy} IS NOT NULL)`,
  ),
]);

/* ────────────────────────── D65 数据质量核对 ────────────────────────── */

/**
 * 周/月数据质量核对记录。period_key：week='YYYY-Www'（ISO 周），month='YYYY-MM'。
 * evidence 存核对样本与一致率明细（只读证据，不回算）。
 */
export const dataQualityReviews = pgTable("data_quality_reviews", {
  id: serial("id").primaryKey(),
  periodKind: text("period_kind").notNull(), // week | month
  periodKey: text("period_key").notNull(),
  sourceClass: text("source_class").notNull(), // rpa_warehouse | manual_po_chain | external_platform
  status: text("status").notNull().default("pending"), // pending | completed | waived
  evidence: jsonb("evidence").$type<unknown>(),
  note: text("note"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_data_quality_reviews").on(t.periodKind, t.periodKey, t.sourceClass),
  check("ck_data_quality_reviews_kind", sql`${t.periodKind} IN ('week', 'month')`),
  check(
    "ck_data_quality_reviews_key",
    sql`(${t.periodKind} = 'week' AND ${t.periodKey} ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') OR (${t.periodKind} = 'month' AND ${t.periodKey} ~ ${YEAR_MONTH_RE})`,
  ),
  check(
    "ck_data_quality_reviews_source",
    sql`${t.sourceClass} IN ('rpa_warehouse', 'manual_po_chain', 'external_platform')`,
  ),
  check("ck_data_quality_reviews_status", sql`${t.status} IN ('pending', 'completed', 'waived')`),
  check(
    "ck_data_quality_reviews_reviewed",
    sql`(${t.status} = 'pending' AND ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL) OR (${t.status} <> 'pending' AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
  ),
]);

/* ────────────────────────── 运营需求提报 / 计划事件 ────────────────────────── */

/**
 * 运营月度需求提报（append-only，修正 = 新行 supersedes 旧行）。
 * channel_id 空 = 不分渠道。只作计划输入，不驱动开单（D43/D55）。
 */
export const opsDemandSubmissions = pgTable("ops_demand_submissions", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  channelId: integer("channel_id").references(() => channels.id),
  period: text("period").notNull(), // 'YYYY-MM'
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  basis: text("basis"), // 提报依据（活动/历史/新品计划…）
  submittedBy: integer("submitted_by").notNull().references(() => users.id),
  supersedesId: integer("supersedes_id").references((): AnyPgColumn => opsDemandSubmissions.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_ops_demand_submissions_key").on(t.skuId, t.channelId, t.period),
  unique("uq_ops_demand_submissions_supersedes").on(t.supersedesId),
  // 审阅修复：每键只能有一个链头（channel_id 为 NULL = 全渠道，coalesce 归零参与唯一）
  uniqueIndex("uq_ops_demand_submissions_head").on(t.skuId, sql`coalesce(${t.channelId}, 0)`, t.period).where(sql`${t.supersedesId} IS NULL`),
  check("ck_ops_demand_submissions_period", sql`${t.period} ~ ${YEAR_MONTH_RE}`),
  check("ck_ops_demand_submissions_qty", sql`${t.qty} >= 0`),
]);

/**
 * 运营计划事件（大促/上新/下架/换链接/调价…）：预警与需求信号的上下文，sku 或 spu 至少一个。
 * expected_uplift_pct 允许负值（下架/调价降量）。
 */
export const opsPlanEvents = pgTable("ops_plan_events", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").references(() => skus.id),
  spuId: integer("spu_id").references(() => spus.id),
  channelId: integer("channel_id").references(() => channels.id),
  kind: text("kind").notNull(), // promo | launch | delist | relink | price | other
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  expectedUpliftPct: integer("expected_uplift_pct"),
  note: text("note"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_ops_plan_events_window").on(t.startDate, t.endDate),
  index("ix_ops_plan_events_sku").on(t.skuId),
  check("ck_ops_plan_events_target", sql`${t.skuId} IS NOT NULL OR ${t.spuId} IS NOT NULL`),
  check("ck_ops_plan_events_kind", sql`${t.kind} IN ('promo', 'launch', 'delist', 'relink', 'price', 'other')`),
  check("ck_ops_plan_events_window", sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  check(
    "ck_ops_plan_events_uplift",
    sql`${t.expectedUpliftPct} IS NULL OR (${t.expectedUpliftPct} >= -100 AND ${t.expectedUpliftPct} <= 1000)`,
  ),
]);
