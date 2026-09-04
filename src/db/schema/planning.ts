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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { bhDocs } from "./docs";
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
 * E2-16 / C125：精益 S&OP 数量计划周期。
 *
 * 周期只引用不可变 planningVersions；当前版本号同时是共识轮次。更换源计划会开启新一轮，
 * 旧签认保留为历史但不再满足冻结条件。
 */
export const sopCycles = pgTable("sop_cycles", {
  id: serial("id").primaryKey(),
  month: text("month").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("consensus"),
  planningVersionId: integer("planning_version_id").notNull().references(() => planningVersions.id),
  planDigest: text("plan_digest").notNull(),
  version: integer("version").notNull().default(1),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  frozenBy: integer("frozen_by").references(() => users.id),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  executingBy: integer("executing_by").references(() => users.id),
  executingAt: timestamp("executing_at", { withTimezone: true }),
  closedBy: integer("closed_by").references(() => users.id),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [
  unique("uq_sop_cycle_month").on(t.month),
  unique("uq_sop_cycle_idempotency").on(t.idempotencyKey),
  index("ix_sop_cycle_status_month").on(t.status, t.month),
  check("ck_sop_cycle_month", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check("ck_sop_cycle_status", sql`${t.status} IN ('consensus', 'frozen', 'executing', 'closed')`),
  check("ck_sop_cycle_version", sql`${t.version} > 0`),
  check(
    "ck_sop_cycle_lifecycle",
    sql`(${t.status} = 'consensus' AND ${t.frozenBy} IS NULL AND ${t.frozenAt} IS NULL AND ${t.executingBy} IS NULL AND ${t.executingAt} IS NULL AND ${t.closedBy} IS NULL AND ${t.closedAt} IS NULL)
      OR (${t.status} = 'frozen' AND ${t.frozenBy} IS NOT NULL AND ${t.frozenAt} IS NOT NULL AND ${t.executingBy} IS NULL AND ${t.executingAt} IS NULL AND ${t.closedBy} IS NULL AND ${t.closedAt} IS NULL)
      OR (${t.status} = 'executing' AND ${t.frozenBy} IS NOT NULL AND ${t.frozenAt} IS NOT NULL AND ${t.executingBy} IS NOT NULL AND ${t.executingAt} IS NOT NULL AND ${t.closedBy} IS NULL AND ${t.closedAt} IS NULL)
      OR (${t.status} = 'closed' AND ${t.frozenBy} IS NOT NULL AND ${t.frozenAt} IS NOT NULL AND ${t.executingBy} IS NOT NULL AND ${t.executingAt} IS NOT NULL AND ${t.closedBy} IS NOT NULL AND ${t.closedAt} IS NOT NULL)`,
  ),
]);

/**
 * 共识签认是只增事件，不更新、不删除；同一角色可用后一条决定纠正前一条。
 *
 * 两个数据库背书（2026-09-04 安全审计 S1/S7）——应用层已各自拦一道，这里再钉一次，
 * 避免下一次改动把闸门挪走后无人察觉：
 *  · `uq_sop_agree_one_per_signer`：**一轮里一个人只能持有一份「同意」**。
 *    此前只校验「每个角色的最新决定是 agree 且摘要一致」，没有任何「三个人」的要求；
 *    而角色是叠加的，一个同时持有 pmc/ops/finance 的人（小组织里很常见）
 *    可以一个人签完三方共识并冻结当月——冻结会让全系统实时建议转只读、
 *    所有下单改走他冻结的那个版本。三方共识必须是三个人。
 *    代价：同一轮「同意→驳回→再同意」被一并挡住（同一人的第二条 agree 落不进来）。
 *    这是刻意的：本轮计划没变而本人反复改主意，应当走「更换源计划开新一轮」，
 *    应用层会给出这句中文提示，不会让用户吃 23505。
 *  · `uq_sop_reject_one_per_role_round`：**一轮里一个角色只能驳回一次**。
 *    驳回不改状态也不改轮次，此前可以无限次重复，每次都插一条决定、一条审计
 *    和一条 severity=high 的新通知给发起人（配置了飞书就是一条飞书消息）——
 *    一个未计量的通知放大器。
 */
export const sopDecisions = pgTable("sop_decisions", {
  id: serial("id").primaryKey(),
  cycleId: integer("cycle_id").notNull().references(() => sopCycles.id),
  cycleVersion: integer("cycle_version").notNull(),
  role: text("role").notNull(),
  decision: text("decision").notNull(),
  note: text("note"),
  planDigest: text("plan_digest").notNull(),
  decidedBy: integer("decided_by").notNull().references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ix_sop_decision_cycle_round").on(t.cycleId, t.cycleVersion, t.role, t.id),
  uniqueIndex("uq_sop_agree_one_per_signer")
    .on(t.cycleId, t.cycleVersion, t.decidedBy)
    .where(sql`${t.decision} = 'agree'`),
  uniqueIndex("uq_sop_reject_one_per_role_round")
    .on(t.cycleId, t.cycleVersion, t.role)
    .where(sql`${t.decision} = 'reject'`),
  check("ck_sop_decision_round", sql`${t.cycleVersion} > 0`),
  check("ck_sop_decision_role", sql`${t.role} IN ('ops', 'pmc', 'finance')`),
  check("ck_sop_decision_value", sql`${t.decision} IN ('agree', 'reject')`),
  check("ck_sop_reject_note", sql`${t.decision} <> 'reject' OR length(trim(coalesce(${t.note}, ''))) >= 5`),
]);

/**
 * 「按冻结计划开单」的单据链接（2026-09-04 安全审计 S2）。
 *
 * 为什么不能继续从 `audit_logs` 反推：执行页的「本行已开过单」原本是读
 * `audit_logs(entity=sop_cycle, action=execute_draft).after.skuIds` 算出来的，
 * 于是审计写失败＝页面认为这些行没开过＝同样的量被再开一张 BH 草稿进审批链。
 * audit_logs 是「谁做了什么」的只增账本，不是业务索引：它的 payload 形状可以变、
 * 有保留期、也不该被业务读路径依赖。链接关系是业务事实，给它自己的表。
 *
 * 幂等键让「双击开单」只产生一张草稿（与 createSopCycle 同型）；本表与 BH 主单
 * 在**同一个事务**里写（createBh 的 inTx 钩子），要么都在，要么都不在。
 */
export const sopExecutionDrafts = pgTable("sop_execution_drafts", {
  id: serial("id").primaryKey(),
  cycleId: integer("cycle_id").notNull().references(() => sopCycles.id),
  /** 开单时的共识轮次（换源计划后重开的单与旧轮次分得开） */
  cycleVersion: integer("cycle_version").notNull(),
  bhId: integer("bh_id").notNull().references(() => bhDocs.id),
  docNo: text("doc_no").notNull(),
  planningVersionId: integer("planning_version_id").notNull().references(() => planningVersions.id),
  planDigest: text("plan_digest").notNull(),
  /** 本次开单覆盖的冻结计划行（planning_version_lines.sku_id） */
  skuIds: jsonb("sku_ids").$type<number[]>().notNull(),
  includeSuppressed: boolean("include_suppressed").notNull().default(false),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_sop_execution_draft_idempotency").on(t.idempotencyKey),
  unique("uq_sop_execution_draft_bh").on(t.bhId),
  index("ix_sop_execution_draft_cycle").on(t.cycleId, t.id),
  check("ck_sop_execution_draft_round", sql`${t.cycleVersion} > 0`),
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

/**
 * W2-#6 建议放弃后的抑制窗口（replenish_suppressions）。
 *
 * 事故形状：`replenish/decline.ts` 只写一条审计，**下一次运行照旧建议同一个 SKU**——
 * 计划员每天对同一条建议重复做同一个判断，「已复核并放弃」等于一张当天有效的便签。
 * 抑制窗口按放弃原因取不同长度（`rules/replenish-suppression.ts` 纯函数定义）：
 *  - supply_already_arranged：等**那批供应真的落库**或 N 天到期，两者先到先解除
 *    （放弃当时的管道量存进 pipeline_baseline，管道量超过它即视为供应已到）；
 *  - demand_overstated：窗口最短——需求判断比供应事实更容易错，压得久了就成了漏补。
 * 纪律：抑制**绝不静默**——被抑制的行仍然出现在列表里，标着「已抑制」、原因与到期日，任何人可一键解除。
 * 同一 SKU 同时最多一条有效抑制（部分唯一索引保证）；解除 = 写 cleared_at，不删行（留痕）。
 */
export const replenishSuppressions = pgTable("replenish_suppressions", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  /** 与 lib/replenish-decline-reasons.ts 的原因码同集合 */
  reasonCode: text("reason_code").notNull(),
  reason: text("reason").notNull(),
  /** 放弃当天的业务日（Asia/Shanghai） */
  businessDate: date("business_date").notNull(),
  /** 抑制到期日（含当天）；过期即自动失效，不需要任何任务去清 */
  untilDate: date("until_date").notNull(),
  /** true = 管道量回升（供应落库）即提前解除 */
  releaseOnArrival: boolean("release_on_arrival").notNull().default(false),
  /** 放弃当时的全管道量（在库 + PO 在途 + 在制 + 存量在途），releaseOnArrival 的比较基线 */
  pipelineBaseline: numeric("pipeline_baseline", { precision: 14, scale: 4 }).notNull().default("0"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  clearedBy: integer("cleared_by").references(() => users.id),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  clearNote: text("clear_note"),
}, (t) => [
  uniqueIndex("uq_replenish_suppression_active").on(t.skuId).where(sql`${t.clearedAt} IS NULL`),
  index("ix_replenish_suppression_until").on(t.untilDate),
  check("ck_replenish_suppression_window", sql`${t.untilDate} >= ${t.businessDate}`),
]);

/**
 * W2-#7 运营提报的处置（ops_demand_dispositions）。
 *
 * 事故形状：`replenish/reconcile.ts` 把提报与基线并排、标出「需核对」，然后**什么也不发生**——
 * 没有接受/驳回、没有责任人、对下游没有任何影响，一块只读看板。
 * 处置口径（D55 不变）：
 *  - accepted 记录运营数字为该 SKU×渠道×月的**已达成一致的需求**，仍**不自动驱动建议量**，
 *    只是从此成为计划员看得见、可据以行动的输入；
 *  - rejected 必须写原因（否则驳回等于沉默）。
 * 每条提报（supersedes 链尾）最多一条处置；提报被新行 supersede 后，新行是新的待处置对象。
 */
export const opsDemandDispositions = pgTable("ops_demand_dispositions", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  channelId: integer("channel_id"),
  period: text("period").notNull(),
  decision: text("decision").notNull(), // accepted | rejected
  /** accepted：记为该期已达成一致的需求量（不自动驱动数量） */
  agreedQty: numeric("agreed_qty", { precision: 14, scale: 4 }),
  reason: text("reason"),
  decidedBy: integer("decided_by").notNull().references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_ops_demand_disposition_submission").on(t.submissionId),
  index("ix_ops_demand_disposition_period").on(t.period),
  check("ck_ops_demand_disposition_decision", sql`${t.decision} IN ('accepted', 'rejected')`),
  check("ck_ops_demand_disposition_accepted_qty", sql`${t.decision} <> 'accepted' OR ${t.agreedQty} IS NOT NULL`),
  check("ck_ops_demand_disposition_rejected_reason", sql`${t.decision} <> 'rejected' OR (${t.reason} IS NOT NULL AND length(btrim(${t.reason})) >= 5)`),
]);
