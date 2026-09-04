import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  unique,
  uniqueIndex,
  numeric,
  date,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { batches, skus, suppliers, users, warehouses } from "./masters";
import { qcRecords } from "./docs";

/**
 * 质量与合规案件。
 *
 * 一个受控案件承载投诉/不良事件、内部召回和年度 GMP 自查；不同 kind 的字段由数据库
 * 存在性约束与 service 状态机共同约束。消费者医疗/身份信息不进入本表，只保存受控外部
 * 证据引用，避免把当前通用附件权限误当成医疗资料权限。
 */
export const qualityCases = pgTable("quality_cases", {
  id: serial("id").primaryKey(),
  caseNo: text("case_no").notNull().unique(),
  kind: text("kind").notNull(), // complaint | adverse_event | recall | self_inspection
  status: text("status").notNull().default("open"), // open | triaged | scoped | active | closed
  severity: text("severity").notNull().default("medium"),
  marketCode: text("market_code").notNull().default("CN"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  sourceChannel: text("source_channel").notNull().default("internal"),
  /** 外部工单/受限证据库引用；不得存消费者姓名、电话、病历正文。 */
  externalRef: text("external_ref"),
  skuId: integer("sku_id").references(() => skus.id),
  batchId: integer("batch_id").references(() => batches.id),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  warehouseId: integer("warehouse_id").references(() => warehouses.id),
  ownerId: integer("owner_id").notNull().references(() => users.id),
  receivedDate: date("received_date").notNull(),
  occurredDate: date("occurred_date"),
  /** 严重性/可报告性必须由人判断；unknown 不能被 false 吞掉。 */
  assessment: text("assessment").notNull().default("unassessed"),
  assessmentBasis: text("assessment_basis"),
  reportPolicy: text("report_policy"),
  reportDueDate: date("report_due_date"),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  regulatorRef: text("regulator_ref"),
  retentionUntil: date("retention_until"),
  rootCause: text("root_cause"),
  /** 召回启动时固化的已知范围、覆盖缺口与数量证据。 */
  scopeSnapshot: jsonb("scope_snapshot"),
  scopeDigest: text("scope_digest"),
  scopeFrozenAt: timestamp("scope_frozen_at", { withTimezone: true }),
  inspectionYear: integer("inspection_year"),
  inspectionSite: text("inspection_site"),
  /**
   * 生产场所的规范化稳定键。展示名允许保留大小写，但唯一性和年度连续性只认该键，
   * 防止空白/大小写变体绕过“一场所一年度一案”。
   */
  inspectionSiteKey: text("inspection_site_key"),
  inspectionReportRef: text("inspection_report_ref"),
  inspectionReportDate: date("inspection_report_date"),
  /**
   * W2 审计 3/4：由哪一次收货检验引发（反向链接；正向在 qc_records.quality_case_id）。
   * 两头都记，是因为只记一头的链接在实务里总有一头查不到：
   * 质量看案件问「这批货是哪次检验出的问题」，仓库看检验问「这次不合格最后怎么处理的」。
   */
  qcRecordId: integer("qc_record_id").references(() => qcRecords.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  version: integer("version").notNull().default(1),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  closedBy: integer("closed_by").references(() => users.id),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closureNote: text("closure_note"),
}, (t) => [
  index("ix_quality_case_kind_status").on(t.kind, t.status, t.createdAt),
  index("ix_quality_case_owner_due").on(t.ownerId, t.reportDueDate),
  index("ix_quality_case_sku_batch").on(t.skuId, t.batchId),
  uniqueIndex("uq_quality_self_inspection_site_year")
    .on(t.kind, t.inspectionSiteKey, t.inspectionYear)
    .where(sql`${t.kind} = 'self_inspection'`),
  check(
    "ck_quality_case_kind",
    sql`${t.kind} IN ('complaint', 'adverse_event', 'recall', 'self_inspection')`,
  ),
  check(
    "ck_quality_case_status",
    sql`${t.status} IN ('open', 'triaged', 'scoped', 'active', 'closed')`,
  ),
  check(
    "ck_quality_case_severity",
    sql`${t.severity} IN ('low', 'medium', 'high', 'critical')`,
  ),
  check(
    "ck_quality_case_market",
    sql`${t.marketCode} ~ '^[A-Z]{2,8}$'`,
  ),
  check(
    "ck_quality_case_source",
    sql`${t.sourceChannel} IN ('consumer', 'marketplace', 'retailer', 'internal', 'supplier', 'regulator', 'other')`,
  ),
  check(
    "ck_quality_case_assessment",
    sql`${t.assessment} IN ('unassessed', 'non_serious', 'serious_not_reportable', 'serious_reportable')`,
  ),
  check(
    "ck_quality_case_reportable_fields",
    sql`${t.assessment} <> 'serious_reportable'
      OR (${t.kind} = 'adverse_event' AND ${t.reportPolicy} IS NOT NULL
        AND ${t.reportDueDate} IS NOT NULL AND ${t.retentionUntil} IS NOT NULL
        AND length(trim(coalesce(${t.assessmentBasis}, ''))) >= 5)`,
  ),
  check(
    "ck_quality_case_reported",
    sql`${t.reportedAt} IS NULL OR (${t.assessment} = 'serious_reportable'
      AND length(trim(coalesce(${t.regulatorRef}, ''))) >= 3)`,
  ),
  check(
    "ck_quality_case_recall_anchor",
    sql`${t.kind} <> 'recall' OR ${t.batchId} IS NOT NULL`,
  ),
  check(
    "ck_quality_case_recall_scope",
    sql`${t.kind} <> 'recall' OR ${t.status} = 'open'
      OR (${t.scopeSnapshot} IS NOT NULL AND ${t.scopeDigest} IS NOT NULL
        AND ${t.scopeFrozenAt} IS NOT NULL)`,
  ),
  check(
    "ck_quality_case_self_inspection",
    sql`${t.kind} <> 'self_inspection'
      OR (${t.inspectionYear} IS NOT NULL AND ${t.inspectionYear} >= 2020
        AND length(trim(coalesce(${t.inspectionSite}, ''))) >= 2
        AND ${t.inspectionSiteKey} = upper(regexp_replace(trim(${t.inspectionSite}), '\\s+', ' ', 'g')))`,
  ),
  check(
    "ck_quality_case_non_inspection_fields",
    sql`${t.kind} = 'self_inspection'
      OR (${t.inspectionYear} IS NULL AND ${t.inspectionSite} IS NULL
        AND ${t.inspectionSiteKey} IS NULL AND ${t.inspectionReportRef} IS NULL
        AND ${t.inspectionReportDate} IS NULL)`,
  ),
  check(
    "ck_quality_case_self_inspection_report",
    sql`${t.kind} <> 'self_inspection'
      OR ((${t.inspectionReportRef} IS NULL AND ${t.inspectionReportDate} IS NULL)
        OR (${t.inspectionReportRef} IS NOT NULL AND ${t.inspectionReportDate} IS NOT NULL
          AND ${t.retentionUntil} IS NOT NULL))`,
  ),
  check(
    "ck_quality_case_close",
    sql`(${t.status} <> 'closed' AND ${t.closedBy} IS NULL AND ${t.closedAt} IS NULL AND ${t.closureNote} IS NULL)
      OR (${t.status} = 'closed' AND ${t.closedBy} IS NOT NULL AND ${t.closedAt} IS NOT NULL
        AND length(trim(coalesce(${t.closureNote}, ''))) >= 5)`,
  ),
  check("ck_quality_case_version", sql`${t.version} > 0`),
]);

/**
 * 质量行动统一承载围堵、CAPA、召回通知/有效性检查、数量核对与自查发现。
 * 完成人与验证人分离；无证据的“完成”不能升级为 verified。
 */
export const qualityActions = pgTable("quality_actions", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull().references(() => qualityCases.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  ownerId: integer("owner_id").notNull().references(() => users.id),
  dueDate: date("due_date").notNull(),
  status: text("status").notNull().default("open"),
  targetType: text("target_type"),
  targetRef: text("target_ref"),
  quantity: numeric("quantity", { precision: 14, scale: 4 }),
  outcome: text("outcome"),
  evidenceRef: text("evidence_ref"),
  verificationNote: text("verification_note"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedBy: integer("completed_by").references(() => users.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  verifiedBy: integer("verified_by").references(() => users.id),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
}, (t) => [
  index("ix_quality_action_case_status").on(t.caseId, t.status, t.dueDate),
  index("ix_quality_action_owner_due").on(t.ownerId, t.status, t.dueDate),
  check(
    "ck_quality_action_kind",
    sql`${t.kind} IN ('containment', 'corrective', 'preventive', 'effectiveness',
      'notification', 'reconciliation', 'finding', 'follow_up')`,
  ),
  check(
    "ck_quality_action_status",
    sql`${t.status} IN ('open', 'completed', 'verified', 'ineffective', 'waived')`,
  ),
  check(
    "ck_quality_action_completion",
    sql`(${t.status} = 'open'
        AND ${t.completedBy} IS NULL AND ${t.completedAt} IS NULL
        AND ${t.evidenceRef} IS NULL AND ${t.outcome} IS NULL)
      OR (${t.status} <> 'open'
        AND ${t.completedBy} IS NOT NULL AND ${t.completedAt} IS NOT NULL
        AND length(trim(coalesce(${t.evidenceRef}, ''))) >= 3
        AND length(trim(coalesce(${t.outcome}, ''))) >= 3)`,
  ),
  check(
    "ck_quality_action_verification",
    sql`(${t.status} IN ('open', 'completed')
        AND ${t.verifiedBy} IS NULL AND ${t.verifiedAt} IS NULL
        AND ${t.verificationNote} IS NULL)
      OR (${t.status} IN ('verified', 'ineffective', 'waived')
        AND ${t.verifiedBy} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL
        AND length(trim(coalesce(${t.verificationNote}, ''))) >= 5)`,
  ),
  check(
    "ck_quality_action_sod",
    sql`${t.verifiedBy} IS NULL OR ${t.completedBy} IS NULL OR ${t.verifiedBy} <> ${t.completedBy}`,
  ),
  check(
    "ck_quality_action_waiver",
    sql`${t.status} <> 'waived' OR length(trim(coalesce(${t.verificationNote}, ''))) >= 5`,
  ),
  check(
    "ck_quality_action_qty",
    sql`${t.quantity} IS NULL OR ${t.quantity} >= 0`,
  ),
]);

/**
 * 市场准入/备案/PIF/安全评估等证据的不可变版本。
 * 状态变化以新版本表示；历史版本禁止 UPDATE/DELETE。
 */
export const regulatoryRecords = pgTable("regulatory_records", {
  id: serial("id").primaryKey(),
  recordKey: text("record_key").notNull(),
  recordType: text("record_type").notNull(),
  marketCode: text("market_code").notNull(),
  skuId: integer("sku_id").references(() => skus.id),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  title: text("title").notNull(),
  authority: text("authority").notNull(),
  referenceNo: text("reference_no"),
  status: text("status").notNull(),
  effectiveDate: date("effective_date"),
  expiryDate: date("expiry_date"),
  renewalDueDate: date("renewal_due_date"),
  retentionUntil: date("retention_until"),
  payload: jsonb("payload").notNull(),
  payloadDigest: text("payload_digest").notNull(),
  version: integer("version").notNull(),
  previousId: integer("previous_id").references((): AnyPgColumn => regulatoryRecords.id),
  evidenceRef: text("evidence_ref"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_regulatory_record_version").on(t.recordKey, t.version),
  index("ix_regulatory_market_type").on(t.marketCode, t.recordType, t.createdAt),
  index("ix_regulatory_expiry").on(t.expiryDate, t.renewalDueDate),
  check(
    "ck_regulatory_type",
    sql`${t.recordType} IN ('nmpa_filing', 'nmpa_registration', 'fda_facility',
      'fda_product_listing', 'eu_pif', 'eu_cpnp', 'safety_assessment', 'other')`,
  ),
  check(
    "ck_regulatory_status",
    sql`${t.status} IN ('submitted', 'active', 'rejected', 'expired', 'superseded')`,
  ),
  check("ck_regulatory_market", sql`${t.marketCode} ~ '^[A-Z]{2,8}$'`),
  check("ck_regulatory_version", sql`${t.version} > 0`),
  check(
    "ck_regulatory_previous",
    sql`(${t.version} = 1 AND ${t.previousId} IS NULL) OR (${t.version} > 1 AND ${t.previousId} IS NOT NULL)`,
  ),
]);

/**
 * 已发布电子标签版本。每个 token 永久指向创建时的内容；修订只生成新版本，
 * 旧 token 会明确显示历史版本而不是静默重定向。
 */
export const electronicLabelVersions = pgTable("electronic_label_versions", {
  id: serial("id").primaryKey(),
  labelKey: text("label_key").notNull(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  marketCode: text("market_code").notNull(),
  locale: text("locale").notNull().default("zh-CN"),
  regulatoryRecordId: integer("regulatory_record_id").notNull().references(() => regulatoryRecords.id),
  version: integer("version").notNull(),
  previousId: integer("previous_id").references((): AnyPgColumn => electronicLabelVersions.id),
  publicToken: text("public_token").notNull().unique(),
  content: jsonb("content").notNull(),
  contentDigest: text("content_digest").notNull(),
  effectiveDate: date("effective_date").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_electronic_label_version").on(t.labelKey, t.version),
  index("ix_electronic_label_sku_market").on(t.skuId, t.marketCode, t.locale, t.createdAt),
  check("ck_electronic_label_market", sql`${t.marketCode} ~ '^[A-Z]{2,8}$'`),
  check("ck_electronic_label_locale", sql`${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
  check("ck_electronic_label_version", sql`${t.version} > 0`),
  check(
    "ck_electronic_label_previous",
    sql`(${t.version} = 1 AND ${t.previousId} IS NULL) OR (${t.version} > 1 AND ${t.previousId} IS NOT NULL)`,
  ),
]);
