import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync, schema } from "@/db";
import { writeAudit } from "@/server/core/audit";
import { dAdd, dCmp, dNeg } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { latestStocktakeRows } from "@/server/core/stock-view";
import type { AnyDb } from "@/server/core/svc";
import { nextDocNo } from "@/server/docflow/doc-no";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import {
  adverseEventFollowUpThrough,
  adverseEventRetentionThrough,
  canonicalJsonSha256,
  classifyDueState,
  gmpSelfInspectionRetentionThrough,
  add15UsFederalBusinessDays,
  isRealIsoDate,
  type CanonicalJsonValue,
} from "@/server/rules/quality-compliance";

const dateString = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
  .refine(isRealIsoDate, "日期必须是真实存在的日历日期");
const marketCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2,8}$/, "市场编码应为 2–8 位大写字母");
const idempotencyKey = z.string().uuid();

const caseKind = z.enum(["complaint", "adverse_event", "recall", "self_inspection"]);
const caseSeverity = z.enum(["low", "medium", "high", "critical"]);
const sourceChannel = z.enum([
  "consumer",
  "marketplace",
  "retailer",
  "internal",
  "supplier",
  "regulator",
  "other",
]);
const caseAssessment = z.enum([
  "non_serious",
  "serious_not_reportable",
  "serious_reportable",
]);
const actionKind = z.enum([
  "containment",
  "corrective",
  "preventive",
  "effectiveness",
  "notification",
  "reconciliation",
  "finding",
  "follow_up",
]);

const createCaseSchema = z.object({
  kind: caseKind,
  severity: caseSeverity.default("medium"),
  marketCode: marketCode.default("CN"),
  title: z.string().trim().min(3).max(160),
  summary: z.string().trim().min(5).max(4000),
  sourceChannel: sourceChannel.default("internal"),
  externalRef: z.string().trim().min(3).max(300).optional(),
  skuId: z.number().int().positive().optional(),
  batchId: z.number().int().positive().optional(),
  supplierId: z.number().int().positive().optional(),
  warehouseId: z.number().int().positive().optional(),
  ownerId: z.number().int().positive(),
  receivedDate: dateString,
  occurredDate: dateString.optional(),
  inspectionYear: z.number().int().min(2020).max(2200).optional(),
  inspectionSite: z.string().trim().min(2).max(160).optional(),
  inspectionReportRef: z.string().trim().min(3).max(300).optional(),
  inspectionReportDate: dateString.optional(),
  idempotencyKey,
});

const assessCaseSchema = z.object({
  operation: z.literal("assess"),
  expectedVersion: z.number().int().positive(),
  assessment: caseAssessment,
  basis: z.string().trim().min(5).max(2000),
  /** 非美国市场的可报告案件由合规负责人提供当前政策与日期，不由软件猜法。 */
  policy: z.string().trim().min(3).max(120).optional(),
  reportDueDate: dateString.optional(),
  retentionUntil: dateString.optional(),
});

const reportCaseSchema = z.object({
  operation: z.literal("report"),
  expectedVersion: z.number().int().positive(),
  regulatorRef: z.string().trim().min(3).max(300),
  reportedAt: z.string().datetime({ offset: true }).optional(),
});

const freezeRecallSchema = z.object({
  operation: z.literal("freeze_scope"),
  expectedVersion: z.number().int().positive(),
  limitationNote: z.string().trim().min(5).max(1000).optional(),
});

const activateRecallSchema = z.object({
  operation: z.literal("activate"),
  expectedVersion: z.number().int().positive(),
});

const documentInspectionSchema = z.object({
  operation: z.literal("document_inspection"),
  expectedVersion: z.number().int().positive(),
  inspectionReportRef: z.string().trim().min(3).max(300),
  reportDate: dateString,
  rootCause: z.string().trim().min(5).max(3000).optional(),
});

const closeCaseSchema = z.object({
  operation: z.literal("close"),
  expectedVersion: z.number().int().positive(),
  rootCause: z.string().trim().min(5).max(3000).optional(),
  closureNote: z.string().trim().min(5).max(3000),
});

const caseOperationSchema = z.discriminatedUnion("operation", [
  assessCaseSchema,
  reportCaseSchema,
  freezeRecallSchema,
  activateRecallSchema,
  documentInspectionSchema,
  closeCaseSchema,
]);

const createActionSchema = z.object({
  kind: actionKind,
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(5).max(3000),
  ownerId: z.number().int().positive(),
  dueDate: dateString,
  targetType: z.string().trim().min(2).max(80).optional(),
  targetRef: z.string().trim().min(2).max(300).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, "数量最多 4 位小数").optional(),
  idempotencyKey,
});

const completeActionSchema = z.object({
  operation: z.literal("complete"),
  evidenceRef: z.string().trim().min(3).max(500),
  outcome: z.string().trim().min(3).max(1000),
});

const verifyActionSchema = z.object({
  operation: z.literal("verify"),
  result: z.enum(["verified", "ineffective", "waived"]),
  verificationNote: z.string().trim().min(5).max(2000),
});

const actionOperationSchema = z.discriminatedUnion("operation", [
  completeActionSchema,
  verifyActionSchema,
]);

const regulatoryRecordType = z.enum([
  "nmpa_filing",
  "nmpa_registration",
  "fda_facility",
  "fda_product_listing",
  "eu_pif",
  "eu_cpnp",
  "safety_assessment",
  "other",
]);

const ELECTRONIC_LABEL_SUPPORT_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  CN: new Set(["nmpa_filing", "nmpa_registration"]),
  US: new Set(["fda_product_listing"]),
  EU: new Set(["eu_cpnp"]),
};

function isElectronicLabelSupportType(market: string, recordType: string): boolean {
  return ELECTRONIC_LABEL_SUPPORT_TYPES[market]?.has(recordType) ?? false;
}

const createRegulatorySchema = z.object({
  recordKey: z.string().trim().min(3).max(160),
  recordType: regulatoryRecordType,
  marketCode,
  skuId: z.number().int().positive().optional(),
  supplierId: z.number().int().positive().optional(),
  title: z.string().trim().min(3).max(200),
  authority: z.string().trim().min(2).max(160),
  referenceNo: z.string().trim().min(2).max(200).optional(),
  status: z.enum(["submitted", "active", "rejected", "expired", "superseded"]),
  effectiveDate: dateString.optional(),
  expiryDate: dateString.optional(),
  renewalDueDate: dateString.optional(),
  retentionUntil: dateString.optional(),
  payload: z.record(z.string(), z.unknown()),
  evidenceRef: z.string().trim().min(3).max(500).optional(),
  idempotencyKey,
});

export const electronicLabelContentSchema = z.object({
  productName: z.string().trim().min(2).max(200),
  responsibleEntity: z.string().trim().min(2).max(200),
  responsibleAddress: z.string().trim().min(5).max(500),
  netContent: z.string().trim().min(1).max(80),
  ingredients: z.array(z.string().trim().min(1).max(200)).min(1).max(300),
  usage: z.string().trim().max(2000).optional(),
  precautions: z.string().trim().min(3).max(3000),
  batchStatement: z.string().trim().min(2).max(500),
  durabilityStatement: z.string().trim().min(2).max(500),
  origin: z.string().trim().max(160).optional(),
  registrationRef: z.string().trim().min(2).max(200),
  otherMandatoryText: z.string().trim().max(5000).optional(),
});

const electronicLabelStoredContentSchema = electronicLabelContentSchema.extend({
  schemaVersion: z.literal("cosmetics-electronic-label/v1"),
  skuSnapshot: z.object({
    code: z.string().min(1),
    name: z.string(),
  }),
});

const publishElectronicLabelSchema = z.object({
  skuId: z.number().int().positive(),
  marketCode,
  locale: z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "语言格式如 zh-CN"),
  regulatoryRecordId: z.number().int().positive(),
  effectiveDate: dateString,
  content: electronicLabelContentSchema,
  idempotencyKey,
});

function requireQualityRead(user: SessionUser): void {
  requireAnyRole(user, "quality", "purchasing", "warehouse", "pmc", "ops");
}

function requireQualityWrite(user: SessionUser): void {
  requireAnyRole(user, "quality");
}

function canActForOwner(user: SessionUser, ownerId: number): boolean {
  return user.id === ownerId || user.roles.includes("quality") || user.roles.includes("admin");
}

function digestQualityEvidence(value: unknown): string {
  return canonicalJsonSha256(value as CanonicalJsonValue);
}

function assertIdempotentReplay(
  entityLabel: string,
  existing: unknown,
  requested: unknown,
): void {
  if (digestQualityEvidence(existing) !== digestQualityEvidence(requested)) {
    throw new ApiError(409, `${entityLabel}幂等键已用于不同请求`);
  }
}

function addCalendarDays(dateValue: string, days: number): string {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeReference(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeInspectionSite(value: string): { label: string; key: string } {
  const label = value.trim().replace(/\s+/g, " ");
  return { label, key: label.toUpperCase() };
}

function normalizeQuantity4(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}

const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateInShanghai(value: Date): string {
  return SHANGHAI_DATE.format(value);
}

async function assertActiveUser(db: AnyDb, id: number): Promise<void> {
  const [row] = await db
    .select({ id: schema.users.id, active: schema.users.active })
    .from(schema.users)
    .where(eq(schema.users.id, id));
  if (!row?.active) throw new ApiError(400, "责任人不存在或已停用");
}

async function validateCaseReferences(
  db: AnyDb,
  value: z.infer<typeof createCaseSchema>,
): Promise<{ skuId: number | null; batchId: number | null }> {
  let skuId = value.skuId ?? null;
  if (value.batchId) {
    const [batch] = await db
      .select({ id: schema.batches.id, skuId: schema.batches.skuId })
      .from(schema.batches)
      .where(eq(schema.batches.id, value.batchId));
    if (!batch) throw new ApiError(400, "批次不存在");
    if (skuId != null && skuId !== batch.skuId) throw new ApiError(400, "批次不属于所选 SKU");
    skuId = batch.skuId;
  }
  if (skuId != null) {
    const [sku] = await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.id, skuId));
    if (!sku) throw new ApiError(400, "SKU 不存在");
  }
  if (value.supplierId) {
    const [supplier] = await db
      .select({ id: schema.suppliers.id })
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, value.supplierId));
    if (!supplier) throw new ApiError(400, "供应商不存在");
  }
  if (value.warehouseId) {
    const [warehouse] = await db
      .select({ id: schema.warehouses.id })
      .from(schema.warehouses)
      .where(eq(schema.warehouses.id, value.warehouseId));
    if (!warehouse) throw new ApiError(400, "仓库不存在");
  }
  return { skuId, batchId: value.batchId ?? null };
}

function casePrefix(kind: z.infer<typeof caseKind>): string {
  if (kind === "recall") return "RC";
  if (kind === "self_inspection") return "GA";
  return "QI";
}

export async function listQualityCases(
  user: SessionUser,
  query: {
    q?: string;
    page?: number;
    pageSize?: number;
    kind?: string;
    status?: string;
  },
  dbArg?: AnyDb,
) {
  requireQualityRead(user);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 20));
  const conditions = [];
  const q = (query.q ?? "").trim();
  const canReadRestrictedEvidence = user.roles.includes("quality") || user.roles.includes("admin");
  if (q) {
    conditions.push(canReadRestrictedEvidence
      ? or(
        ilike(schema.qualityCases.caseNo, `%${q}%`),
        ilike(schema.qualityCases.title, `%${q}%`),
        ilike(schema.qualityCases.summary, `%${q}%`),
        ilike(schema.skus.code, `%${q}%`),
      )
      : or(
        ilike(schema.qualityCases.caseNo, `%${q}%`),
        ilike(schema.skus.code, `%${q}%`),
        and(
          sql`${schema.qualityCases.kind} NOT IN ('complaint', 'adverse_event')`,
          or(
            ilike(schema.qualityCases.title, `%${q}%`),
            ilike(schema.qualityCases.summary, `%${q}%`),
          ),
        ),
      ));
  }
  if (caseKind.safeParse(query.kind).success) {
    conditions.push(eq(schema.qualityCases.kind, query.kind!));
  }
  if (["open", "triaged", "scoped", "active", "closed"].includes(query.status ?? "")) {
    conditions.push(eq(schema.qualityCases.status, query.status!));
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const fields = {
    id: schema.qualityCases.id,
    caseNo: schema.qualityCases.caseNo,
    kind: schema.qualityCases.kind,
    status: schema.qualityCases.status,
    severity: schema.qualityCases.severity,
    marketCode: schema.qualityCases.marketCode,
    title: schema.qualityCases.title,
    summary: schema.qualityCases.summary,
    sourceChannel: schema.qualityCases.sourceChannel,
    externalRef: schema.qualityCases.externalRef,
    skuId: schema.qualityCases.skuId,
    skuCode: schema.skus.code,
    skuName: schema.skus.name,
    batchId: schema.qualityCases.batchId,
    batchNo: schema.batches.batchNo,
    supplierId: schema.qualityCases.supplierId,
    supplierName: schema.suppliers.name,
    ownerId: schema.qualityCases.ownerId,
    ownerName: schema.users.name,
    receivedDate: schema.qualityCases.receivedDate,
    occurredDate: schema.qualityCases.occurredDate,
    assessment: schema.qualityCases.assessment,
    assessmentBasis: schema.qualityCases.assessmentBasis,
    reportPolicy: schema.qualityCases.reportPolicy,
    reportDueDate: schema.qualityCases.reportDueDate,
    reportedAt: schema.qualityCases.reportedAt,
    regulatorRef: schema.qualityCases.regulatorRef,
    retentionUntil: schema.qualityCases.retentionUntil,
    rootCause: schema.qualityCases.rootCause,
    scopeDigest: schema.qualityCases.scopeDigest,
    scopeSnapshot: schema.qualityCases.scopeSnapshot,
    scopeFrozenAt: schema.qualityCases.scopeFrozenAt,
    inspectionYear: schema.qualityCases.inspectionYear,
    inspectionSite: schema.qualityCases.inspectionSite,
    inspectionReportRef: schema.qualityCases.inspectionReportRef,
    inspectionReportDate: schema.qualityCases.inspectionReportDate,
    version: schema.qualityCases.version,
    createdAt: schema.qualityCases.createdAt,
    closedAt: schema.qualityCases.closedAt,
    closureNote: schema.qualityCases.closureNote,
  };
  const [rows, totalRows, summaryRows] = await Promise.all([
    db
      .select(fields)
      .from(schema.qualityCases)
      .leftJoin(schema.skus, eq(schema.qualityCases.skuId, schema.skus.id))
      .leftJoin(schema.batches, eq(schema.qualityCases.batchId, schema.batches.id))
      .leftJoin(schema.suppliers, eq(schema.qualityCases.supplierId, schema.suppliers.id))
      .innerJoin(schema.users, eq(schema.qualityCases.ownerId, schema.users.id))
      .where(where)
      .orderBy(
        sql`CASE ${schema.qualityCases.severity} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
        desc(schema.qualityCases.createdAt),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.qualityCases)
      .leftJoin(schema.skus, eq(schema.qualityCases.skuId, schema.skus.id))
      .where(where),
    db
      .select({
        open: sql<number>`count(*) filter (where ${schema.qualityCases.status} <> 'closed')::int`,
        adverseDue: sql<number>`count(*) filter (
          where ${schema.qualityCases.assessment} = 'serious_reportable'
            and ${schema.qualityCases.reportedAt} is null
        )::int`,
        recalls: sql<number>`count(*) filter (
          where ${schema.qualityCases.kind} = 'recall'
            and ${schema.qualityCases.status} <> 'closed'
        )::int`,
        inspections: sql<number>`count(*) filter (
          where ${schema.qualityCases.kind} = 'self_inspection'
            and ${schema.qualityCases.inspectionYear} = ${Number(todayShanghai().slice(0, 4))}
        )::int`,
      })
      .from(schema.qualityCases),
  ]);
  const today = todayShanghai();
  return {
    rows: rows.map((row: typeof rows[number]) => ({
      ...row,
      ...(canReadRestrictedEvidence || !["complaint", "adverse_event"].includes(row.kind)
        ? {}
        : {
          title: "受限投诉/不良事件案件",
          summary: "受限投诉/不良事件案件；详细叙述仅质量合规角色可见。",
          externalRef: null,
          assessmentBasis: null,
          regulatorRef: null,
          rootCause: null,
        }),
      reportDueState: row.reportDueDate
        ? classifyDueState({
          dueDate: row.reportDueDate,
          asOfDate: today,
          dueSoonThroughDate: addCalendarDays(today, 30),
          completedDate: row.reportedAt ? today : null,
        })
        : null,
    })),
    total: Number(totalRows[0]?.total ?? 0),
    summary: {
      open: Number(summaryRows[0]?.open ?? 0),
      adverseDue: Number(summaryRows[0]?.adverseDue ?? 0),
      recalls: Number(summaryRows[0]?.recalls ?? 0),
      inspectionsThisYear: Number(summaryRows[0]?.inspections ?? 0),
    },
  };
}

export async function createQualityCase(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
) {
  requireAnyRole(user, "quality", "ops", "warehouse", "purchasing");
  const value = createCaseSchema.parse(input);
  if (value.receivedDate > todayShanghai()) throw new ApiError(400, "接收日期不能晚于今天");
  if (value.occurredDate && value.occurredDate > value.receivedDate) {
    throw new ApiError(400, "发生日期不能晚于接收日期");
  }
  if (value.kind === "recall" && !value.batchId) throw new ApiError(400, "召回案件必须绑定真实批次");
  if (value.kind === "self_inspection") {
    if (!value.inspectionYear || !value.inspectionSite) {
      throw new ApiError(400, "年度 GMP 自查必须填写年度与生产场所");
    }
    if (value.inspectionYear !== Number(value.receivedDate.slice(0, 4))) {
      throw new ApiError(400, "自查年度必须与报告接收日期年份一致");
    }
    if ((value.inspectionReportRef == null) !== (value.inspectionReportDate == null)) {
      throw new ApiError(400, "创建时登记自查报告必须同时填写报告引用与报告日期");
    }
    if (value.inspectionReportDate && value.inspectionReportDate > todayShanghai()) {
      throw new ApiError(400, "自查报告日期不能晚于今天");
    }
  } else if (
    value.inspectionYear != null
    || value.inspectionSite != null
    || value.inspectionReportRef != null
    || value.inspectionReportDate != null
  ) {
    throw new ApiError(400, "只有年度 GMP 自查案件可填写自查字段");
  }
  const inspectionSite = value.kind === "self_inspection"
    ? normalizeInspectionSite(value.inspectionSite!)
    : null;
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    await assertActiveUser(tx, value.ownerId);
    const refs = await validateCaseReferences(tx, value);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${value.idempotencyKey}))`);
    const [replayed] = await tx
      .select()
      .from(schema.qualityCases)
      .where(eq(schema.qualityCases.idempotencyKey, value.idempotencyKey));
    if (replayed) {
      assertIdempotentReplay("质量案件", {
        kind: replayed.kind,
        severity: replayed.severity,
        marketCode: replayed.marketCode,
        title: replayed.title,
        summary: replayed.summary,
        sourceChannel: replayed.sourceChannel,
        externalRef: replayed.externalRef,
        skuId: replayed.skuId,
        batchId: replayed.batchId,
        supplierId: replayed.supplierId,
        warehouseId: replayed.warehouseId,
        ownerId: replayed.ownerId,
        receivedDate: replayed.receivedDate,
        occurredDate: replayed.occurredDate,
        inspectionYear: replayed.inspectionYear,
        inspectionSite: replayed.inspectionSite,
        inspectionReportRef: replayed.inspectionReportRef,
        inspectionReportDate: replayed.inspectionReportDate,
      }, {
        kind: value.kind,
        severity: value.severity,
        marketCode: value.marketCode,
        title: value.title,
        summary: value.summary,
        sourceChannel: value.sourceChannel,
        externalRef: value.externalRef ?? null,
        skuId: refs.skuId,
        batchId: refs.batchId,
        supplierId: value.supplierId ?? null,
        warehouseId: value.warehouseId ?? null,
        ownerId: value.ownerId,
        receivedDate: value.receivedDate,
        occurredDate: value.occurredDate ?? null,
        inspectionYear: value.inspectionYear ?? null,
        inspectionSite: inspectionSite?.label ?? null,
        inspectionReportRef: value.inspectionReportRef ?? null,
        inspectionReportDate: value.inspectionReportDate ?? null,
      });
      return replayed;
    }
    if (value.kind === "self_inspection") {
      const inspectionIdentity = `${inspectionSite!.key}:${value.inspectionYear}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${inspectionIdentity}))`);
      const [existingInspection] = await tx
        .select({ id: schema.qualityCases.id })
        .from(schema.qualityCases)
        .where(and(
          eq(schema.qualityCases.kind, "self_inspection"),
          eq(schema.qualityCases.inspectionSiteKey, inspectionSite!.key),
          eq(schema.qualityCases.inspectionYear, value.inspectionYear!),
        ));
      if (existingInspection) throw new ApiError(409, "同一生产场所同一年度只能建立一个 GMP 自查案件");
    }
    const caseNo = await nextDocNo(tx, casePrefix(value.kind));
    const retentionUntil = value.kind === "self_inspection" && value.inspectionReportDate
      ? gmpSelfInspectionRetentionThrough(value.inspectionReportDate)
      : null;
    const [created] = await tx
      .insert(schema.qualityCases)
      .values({
        caseNo,
        kind: value.kind,
        severity: value.severity,
        marketCode: value.marketCode,
        title: value.title,
        summary: value.summary,
        sourceChannel: value.sourceChannel,
        externalRef: value.externalRef ?? null,
        skuId: refs.skuId,
        batchId: refs.batchId,
        supplierId: value.supplierId ?? null,
        warehouseId: value.warehouseId ?? null,
        ownerId: value.ownerId,
        receivedDate: value.receivedDate,
        occurredDate: value.occurredDate ?? null,
        retentionUntil,
        inspectionYear: value.inspectionYear ?? null,
        inspectionSite: inspectionSite?.label ?? null,
        inspectionSiteKey: inspectionSite?.key ?? null,
        inspectionReportRef: value.inspectionReportRef ?? null,
        inspectionReportDate: value.inspectionReportDate ?? null,
        idempotencyKey: value.idempotencyKey,
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "quality_case",
      entityId: created.id,
      action: "create",
      after: created,
    });
    return created;
  });
}

async function lockQualityCase(tx: AnyDb, caseId: number) {
  await tx.execute(sql`SELECT id FROM quality_cases WHERE id = ${caseId} FOR UPDATE`);
  const [current] = await tx
    .select()
    .from(schema.qualityCases)
    .where(eq(schema.qualityCases.id, caseId));
  if (!current) throw new ApiError(404, "质量案件不存在");
  return current;
}

function assertVersion(current: { version: number }, expectedVersion: number): void {
  if (current.version !== expectedVersion) throw new ApiError(409, "案件已被他人更新，请刷新后重试");
}

async function buildRecallScope(tx: AnyDb, batchId: number, limitationNote?: string) {
  const [batch] = await tx
    .select({
      id: schema.batches.id,
      batchNo: schema.batches.batchNo,
      skuId: schema.batches.skuId,
      prodDate: schema.batches.prodDate,
      expiryDate: schema.batches.expiryDate,
      sourceDocType: schema.batches.sourceDocType,
      sourceDocId: schema.batches.sourceDocId,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
    })
    .from(schema.batches)
    .innerJoin(schema.skus, eq(schema.batches.skuId, schema.skus.id))
    .where(eq(schema.batches.id, batchId));
  if (!batch) throw new ApiError(404, "召回批次不存在");

  const [balances, ledger, referenceRows, unbatched, snapshotRows, gateRows] = await Promise.all([
    tx
      .select({
        warehouseId: schema.stockBalances.warehouseId,
        warehouseCode: schema.warehouses.code,
        warehouseName: schema.warehouses.name,
        qty: schema.stockBalances.qty,
      })
      .from(schema.stockBalances)
      .innerJoin(schema.warehouses, eq(schema.stockBalances.warehouseId, schema.warehouses.id))
      .where(and(
        eq(schema.stockBalances.batchId, batchId),
        sql`${schema.stockBalances.qty} <> 0`,
      ))
      .orderBy(schema.warehouses.code),
    tx
      .select({
        warehouseId: schema.stockLedger.warehouseId,
        warehouseCode: schema.warehouses.code,
        sourceDocType: schema.stockLedger.sourceDocType,
        qtyDelta: sql<string>`sum(${schema.stockLedger.qtyDelta})`,
        movementCount: sql<number>`count(*)::int`,
        firstAt: sql<string>`min(${schema.stockLedger.occurredAt})`,
        lastAt: sql<string>`max(${schema.stockLedger.occurredAt})`,
      })
      .from(schema.stockLedger)
      .innerJoin(schema.warehouses, eq(schema.stockLedger.warehouseId, schema.warehouses.id))
      .where(eq(schema.stockLedger.batchId, batchId))
      .groupBy(
        schema.stockLedger.warehouseId,
        schema.warehouses.code,
        schema.stockLedger.sourceDocType,
      )
      .orderBy(schema.warehouses.code, schema.stockLedger.sourceDocType),
    tx
      .select({
        warehouseId: schema.batchStocks.warehouseId,
        warehouseCode: schema.warehouses.code,
        warehouseName: schema.warehouses.name,
        qty: schema.batchStocks.qty,
        stocktakeDate: schema.batchStocks.stocktakeDate,
        source: schema.batchStocks.source,
      })
      .from(schema.batchStocks)
      .innerJoin(schema.warehouses, eq(schema.batchStocks.warehouseId, schema.warehouses.id))
      .where(and(
        eq(schema.batchStocks.skuId, batch.skuId),
        eq(schema.batchStocks.batchNo, batch.batchNo),
      ))
      .orderBy(schema.warehouses.code, desc(schema.batchStocks.stocktakeDate)),
    tx
      .select({
        grossPositiveQty: sql<string>`coalesce(sum(
          case when ${schema.stockBalances.qty} > 0 then ${schema.stockBalances.qty} else 0 end
        ), 0)`,
        grossNegativeQty: sql<string>`coalesce(sum(
          case when ${schema.stockBalances.qty} < 0 then -${schema.stockBalances.qty} else 0 end
        ), 0)`,
        netQty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), 0)`,
      })
      .from(schema.stockBalances)
      .where(and(
        eq(schema.stockBalances.skuId, batch.skuId),
        sql`${schema.stockBalances.batchId} is null`,
        sql`${schema.stockBalances.qty} <> 0`,
      )),
    tx
      .select({
        warehouseId: schema.stockSnapshots.warehouseId,
        warehouseCode: schema.warehouses.code,
        qty: schema.stockSnapshots.qty,
        bizDate: schema.stockSnapshots.bizDate,
      })
      .from(schema.stockSnapshots)
      .innerJoin(schema.warehouses, eq(schema.stockSnapshots.warehouseId, schema.warehouses.id))
      .where(eq(schema.stockSnapshots.skuId, batch.skuId))
      .orderBy(schema.warehouses.code, desc(schema.stockSnapshots.bizDate)),
    tx
      .select({ value: schema.sysParams.value })
      .from(schema.sysParams)
      .where(and(
        eq(schema.sysParams.scope, "global"),
        eq(schema.sysParams.key, "batch_posting_enabled"),
      )),
  ]);

  /* 盘点期间收口走 core/stock-view 唯一实现（风险工作台 / R15 临期 / 调拨建议同源）。
     tx 是 AnyDb，查询结果推不出行类型，故在此显式标注行形状供泛型推断。 */
  type ReferenceRow = { warehouseId: number; warehouseCode: string; warehouseName: string; qty: string; stocktakeDate: string; source: string | null };
  const latestReferenceRows = latestStocktakeRows<ReferenceRow>(referenceRows as ReferenceRow[]);
  const latestSnapshots = new Map<number, typeof snapshotRows[number]>();
  for (const row of snapshotRows) if (!latestSnapshots.has(row.warehouseId)) latestSnapshots.set(row.warehouseId, row);
  const addQty = (rows: Array<{ qty: string }>) => rows.reduce((sum, row) => dAdd(sum, row.qty, 4), "0.0000");
  const positiveBalances = balances.filter((row: { qty: string }) => dCmp(row.qty, "0") > 0);
  const negativeBalances = balances.filter((row: { qty: string }) => dCmp(row.qty, "0") < 0);
  const grossPositiveQty = addQty(positiveBalances);
  const grossNegativeQty = negativeBalances.reduce(
    (sum: string, row: { qty: string }) => dAdd(sum, dNeg(row.qty, 4), 4),
    "0.0000",
  );
  const netQty = addQty(balances);
  const integrityWarnings = negativeBalances.length
    ? [
      `发现 ${negativeBalances.length} 个负批次仓余额（绝对量 ${grossNegativeQty}）；`
        + "召回受影响量按正余额毛额计算，负数仅作账实完整性异常，不得抵减暴露量。",
    ]
    : [];

  const limitations = [
    "系统尚无完整客户/渠道发运事实，不能证明所有下游收货方；范围不会因缺失事实而缩小。",
    "外部仓快照没有可靠批次维度，只作为该 SKU 的潜在未知暴露量，不与内部批次余额相加。",
  ];
  if (gateRows[0]?.value !== "1") {
    limitations.push("批次过账闸门当前未开启，历史无批次余额可能包含本批次，需人工扩大召回边界。");
  }
  if (limitationNote) limitations.push(limitationNote);
  const scope = {
    schemaVersion: "recall-scope/v1",
    capturedAt: new Date().toISOString(),
    batch: {
      id: batch.id,
      batchNo: batch.batchNo,
      skuId: batch.skuId,
      skuCode: batch.skuCode,
      skuName: batch.skuName,
      prodDate: batch.prodDate,
      expiryDate: batch.expiryDate,
      sourceDocType: batch.sourceDocType,
      sourceDocId: batch.sourceDocId,
    },
    authoritativeInternal: {
      balances,
      /** 召回受影响量不得让负余额抵减其他仓的正余额。 */
      totalQty: grossPositiveQty,
      grossPositiveQty,
      grossNegativeQty,
      netQty,
      integrityWarnings,
      ledger,
    },
    referenceOnly: {
      batchSnapshots: latestReferenceRows,
      batchSnapshotTotalQty: addQty(latestReferenceRows),
      externalSkuSnapshots: [...latestSnapshots.values()],
      externalSkuSnapshotTotalQty: addQty([...latestSnapshots.values()]),
    },
    unknownCoverage: {
      /** 无批次正余额同样按毛额披露，负余额只能成为完整性异常，不能抵减潜在暴露。 */
      unbatchedInternalSkuQty: String(unbatched[0]?.grossPositiveQty ?? "0.0000"),
      unbatchedGrossPositiveQty: String(unbatched[0]?.grossPositiveQty ?? "0.0000"),
      unbatchedGrossNegativeQty: String(unbatched[0]?.grossNegativeQty ?? "0.0000"),
      unbatchedNetQty: String(unbatched[0]?.netQty ?? "0.0000"),
      customerDestinations: "unavailable",
      batchPostingEnabled: gateRows[0]?.value === "1",
      limitations,
    },
  };
  return { scope, digest: digestQualityEvidence(scope), skuId: batch.skuId };
}

async function listCaseActionsForClose(tx: AnyDb, caseId: number) {
  return tx.select().from(schema.qualityActions).where(eq(schema.qualityActions.caseId, caseId));
}

function assertActionsResolved(
  actions: Array<{ kind: string; status: string }>,
  kinds: string[],
  options?: { requireEach?: boolean },
): void {
  const relevant = actions.filter((row) => kinds.includes(row.kind));
  if (options?.requireEach) {
    for (const kind of kinds) {
      if (!relevant.some((row) =>
        row.kind === kind && ["verified", "waived"].includes(row.status))) {
        throw new ApiError(409, `关闭前必须至少有一项${kind}行动`);
      }
    }
  }
  for (const kind of new Set(relevant.map((row) => row.kind))) {
    if (!relevant.some((row) =>
      row.kind === kind && ["verified", "waived"].includes(row.status))) {
      throw new ApiError(409, "质量行动尚无已验证或有理由豁免的有效结果，不能关闭案件");
    }
  }
  const unresolved = relevant.filter((row) => ["open", "completed"].includes(row.status));
  if (unresolved.length) throw new ApiError(409, "仍有未完成或未验证的质量行动，不能关闭案件");
}

export async function transitionQualityCase(
  user: SessionUser,
  caseId: number,
  input: unknown,
  dbArg?: AnyDb,
) {
  requireQualityWrite(user);
  const value = caseOperationSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    if (value.operation === "freeze_scope") {
      // The immutable scope is assembled by several queries. One repeatable-read snapshot prevents
      // balances, ledger and external-reference rows from coming from different commit horizons.
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    }
    const current = await lockQualityCase(tx, caseId);
    assertVersion(current, value.expectedVersion);
    if (current.status === "closed") throw new ApiError(409, "案件已关闭，不能改写历史结果");

    let patch: Record<string, unknown>;
    let auditAction: string;
    if (value.operation === "assess") {
      if (current.kind !== "adverse_event" && current.kind !== "complaint") {
        throw new ApiError(409, "只有投诉/不良事件可做严重性评估");
      }
      if (current.assessment !== "unassessed") {
        throw new ApiError(409, "人工严重性评估已固化；更正须建立受控后续案件，不能覆盖原证据");
      }
      if (current.reportedAt) throw new ApiError(409, "监管报告已登记，不能覆盖原始严重性评估");
      let reportPolicy: string | null = null;
      let reportDueDate: string | null = null;
      let retentionUntil: string | null = current.retentionUntil;
      if (value.assessment === "serious_reportable") {
        if (current.marketCode === "US") {
          reportPolicy = "FDA_MOCRA_2022";
          reportDueDate = add15UsFederalBusinessDays(current.receivedDate);
          retentionUntil = adverseEventRetentionThrough(current.receivedDate);
        } else {
          if (!value.policy || !value.reportDueDate || !value.retentionUntil) {
            throw new ApiError(400, "非美国市场的可报告事件必须由合规负责人填写政策、截止日和保留期");
          }
          if (value.reportDueDate < current.receivedDate) {
            throw new ApiError(400, "监管报告截止日不能早于案件接收日");
          }
          if (value.retentionUntil < current.receivedDate) {
            throw new ApiError(400, "记录保留期不能早于案件接收日");
          }
          reportPolicy = value.policy;
          reportDueDate = value.reportDueDate;
          retentionUntil = value.retentionUntil;
        }
      }
      patch = {
        kind: current.kind === "complaint" && value.assessment === "serious_reportable"
          ? "adverse_event"
          : current.kind,
        assessment: value.assessment,
        assessmentBasis: value.basis,
        reportPolicy,
        reportDueDate,
        retentionUntil,
        status: "triaged",
      };
      auditAction = "quality_assess";
    } else if (value.operation === "report") {
      if (current.assessment !== "serious_reportable") throw new ApiError(409, "案件未被评估为可报告严重事件");
      if (current.reportedAt) {
        if (current.regulatorRef === value.regulatorRef) return current;
        throw new ApiError(409, "监管报告已登记，不能覆盖原始提交证据");
      }
      const reportedAt = value.reportedAt ? new Date(value.reportedAt) : new Date();
      if (reportedAt.getTime() > Date.now()) throw new ApiError(400, "监管提交时间不能晚于当前时间");
      if (dateInShanghai(reportedAt) < current.receivedDate) {
        throw new ApiError(400, "监管提交时间不能早于案件接收日");
      }
      patch = {
        reportedAt,
        regulatorRef: value.regulatorRef,
      };
      auditAction = "quality_report";
    } else if (value.operation === "freeze_scope") {
      if (current.kind !== "recall" || current.status !== "open" || !current.batchId) {
        throw new ApiError(409, "只有未冻结的召回案件可固化范围");
      }
      const frozen = await buildRecallScope(tx, current.batchId, value.limitationNote);
      if (current.skuId != null && current.skuId !== frozen.skuId) {
        throw new ApiError(409, "召回案件的 SKU 与批次不一致");
      }
      patch = {
        skuId: frozen.skuId,
        scopeSnapshot: frozen.scope,
        scopeDigest: frozen.digest,
        scopeFrozenAt: new Date(),
        status: "scoped",
      };
      auditAction = "recall_scope_freeze";
    } else if (value.operation === "activate") {
      if (current.kind !== "recall" || current.status !== "scoped" || !current.scopeFrozenAt) {
        throw new ApiError(409, "召回必须先固化范围后再启动");
      }
      const actions = await listCaseActionsForClose(tx, caseId);
      for (const required of ["containment", "notification", "effectiveness", "reconciliation"]) {
        if (!actions.some((row: { kind: string }) => row.kind === required)) {
          throw new ApiError(409, `启动召回前必须建立${required}行动`);
        }
      }
      patch = { status: "active" };
      auditAction = "recall_activate";
    } else if (value.operation === "document_inspection") {
      if (current.kind !== "self_inspection") throw new ApiError(409, "只有年度自查可登记自查报告");
      if (value.reportDate > todayShanghai()) throw new ApiError(400, "自查报告日期不能晚于今天");
      if (current.inspectionReportRef || current.inspectionReportDate) {
        if (
          current.inspectionReportRef === value.inspectionReportRef
          && current.inspectionReportDate === value.reportDate
        ) {
          return current;
        }
        throw new ApiError(409, "年度自查报告证据已固化，不能覆盖；更正须建立受控后续案件");
      }
      patch = {
        inspectionReportRef: value.inspectionReportRef,
        inspectionReportDate: value.reportDate,
        retentionUntil: gmpSelfInspectionRetentionThrough(value.reportDate),
        rootCause: value.rootCause ?? current.rootCause,
        status: "triaged",
      };
      auditAction = "gmp_inspection_document";
    } else {
      const actions = await listCaseActionsForClose(tx, caseId);
      if (
        (current.kind === "complaint" || current.kind === "adverse_event")
        && current.assessment === "unassessed"
      ) {
        throw new ApiError(409, "投诉/不良事件必须完成人工严重性与可报告性评估后才能关闭");
      }
      if (current.assessment === "serious_reportable" && !current.reportedAt) {
        throw new ApiError(409, "可报告严重事件尚未登记监管提交证据");
      }
      if (actions.some((row: { status: string }) => ["open", "completed"].includes(row.status))) {
        throw new ApiError(409, "案件仍有未完成或未验证的行动，不能关闭");
      }
      if (current.kind === "recall") {
        if (current.status !== "active") throw new ApiError(409, "召回必须启动后才能关闭");
        assertActionsResolved(
          actions,
          ["containment", "notification", "effectiveness", "reconciliation"],
          { requireEach: true },
        );
      } else if (current.kind === "self_inspection") {
        if (!current.inspectionReportRef || !current.inspectionReportDate) {
          throw new ApiError(409, "年度自查报告与报告日期尚未完整登记");
        }
        assertActionsResolved(actions, ["finding", "corrective", "preventive", "effectiveness"]);
      } else if (["high", "critical"].includes(current.severity)) {
        if (!value.rootCause && !current.rootCause) throw new ApiError(409, "高/严重案件关闭前必须记录根因");
        const resolvedCapa = actions.filter((row: { kind: string; status: string }) =>
          ["corrective", "preventive"].includes(row.kind)
          && ["verified", "waived"].includes(row.status));
        if (!resolvedCapa.length) throw new ApiError(409, "高/严重案件关闭前必须完成并验证纠正或预防行动");
        const resolvedEffectiveness = actions.some((row: { kind: string; status: string }) =>
          row.kind === "effectiveness" && ["verified", "waived"].includes(row.status));
        if (!resolvedEffectiveness) throw new ApiError(409, "高/严重案件关闭前必须独立验证 CAPA 有效性");
        assertActionsResolved(actions, ["corrective", "preventive", "effectiveness"]);
      } else {
        assertActionsResolved(actions, ["corrective", "preventive", "effectiveness"]);
      }
      patch = {
        status: "closed",
        rootCause: value.rootCause ?? current.rootCause,
        closureNote: value.closureNote,
        closedBy: user.id,
        closedAt: new Date(),
      };
      auditAction = "quality_close";
    }

    const [updated] = await tx
      .update(schema.qualityCases)
      .set({ ...patch, version: current.version + 1, updatedAt: new Date() })
      .where(and(
        eq(schema.qualityCases.id, caseId),
        eq(schema.qualityCases.version, current.version),
      ))
      .returning();
    if (!updated) throw new ApiError(409, "案件已被他人更新，请刷新后重试");
    if (
      value.operation === "assess"
      && value.assessment === "serious_reportable"
      && current.marketCode === "US"
    ) {
      const [followUp] = await tx
        .insert(schema.qualityActions)
        .values({
          caseId,
          kind: "follow_up",
          title: "美国严重不良事件一年补充报告监测",
          description: "持续监测案件接收日起一年内取得的新医疗或其他重大信息；出现新信息时按当前 FDA 时限提交补充报告并留存证据。",
          ownerId: current.ownerId,
          dueDate: adverseEventFollowUpThrough(current.receivedDate),
          targetType: "regulatory_case",
          targetRef: updated.caseNo,
          idempotencyKey: randomUUID(),
          createdBy: user.id,
        })
        .returning();
      await writeAudit(tx, {
        userId: user.id,
        entity: "quality_action",
        entityId: followUp.id,
        action: "create_follow_up",
        after: followUp,
      });
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "quality_case",
      entityId: caseId,
      action: auditAction,
      before: current,
      after: updated,
    });
    return updated;
  });
}

export async function listQualityActions(
  user: SessionUser,
  caseId: number,
  dbArg?: AnyDb,
) {
  requireQualityRead(user);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [parent] = await db
    .select({ kind: schema.qualityCases.kind })
    .from(schema.qualityCases)
    .where(eq(schema.qualityCases.id, caseId));
  if (!parent) throw new ApiError(404, "质量案件不存在");
  const rows = await db
    .select({
      id: schema.qualityActions.id,
      caseId: schema.qualityActions.caseId,
      kind: schema.qualityActions.kind,
      title: schema.qualityActions.title,
      description: schema.qualityActions.description,
      ownerId: schema.qualityActions.ownerId,
      ownerName: schema.users.name,
      dueDate: schema.qualityActions.dueDate,
      status: schema.qualityActions.status,
      targetType: schema.qualityActions.targetType,
      targetRef: schema.qualityActions.targetRef,
      quantity: schema.qualityActions.quantity,
      outcome: schema.qualityActions.outcome,
      evidenceRef: schema.qualityActions.evidenceRef,
      verificationNote: schema.qualityActions.verificationNote,
      createdAt: schema.qualityActions.createdAt,
      completedAt: schema.qualityActions.completedAt,
      verifiedAt: schema.qualityActions.verifiedAt,
    })
    .from(schema.qualityActions)
    .innerJoin(schema.users, eq(schema.qualityActions.ownerId, schema.users.id))
    .where(eq(schema.qualityActions.caseId, caseId))
    .orderBy(
      sql`CASE ${schema.qualityActions.status} WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END`,
      schema.qualityActions.dueDate,
      schema.qualityActions.id,
    );
  if (user.roles.includes("quality") || user.roles.includes("admin")) return rows;
  const restrictedCase = ["complaint", "adverse_event"].includes(parent.kind);
  return rows.map((row: typeof rows[number]) => ({
    ...row,
    ...(restrictedCase
      ? {
        title: "受限投诉/不良事件行动",
        description: "行动说明仅质量合规角色可见。",
      }
      : {}),
    targetRef: null,
    outcome: null,
    evidenceRef: null,
    verificationNote: null,
  }));
}

export async function createQualityAction(
  user: SessionUser,
  caseId: number,
  input: unknown,
  dbArg?: AnyDb,
) {
  requireAnyRole(user, "quality", "purchasing", "warehouse", "pmc");
  const value = createActionSchema.parse(input);
  if (value.kind === "notification" && (!value.targetType || !value.targetRef)) {
    throw new ApiError(400, "召回通知必须填写目标类型与目标");
  }
  if (value.kind === "reconciliation" && value.quantity == null) {
    throw new ApiError(400, "数量核对行动必须填写数量");
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    await assertActiveUser(tx, value.ownerId);
    const current = await lockQualityCase(tx, caseId);
    if (current.status === "closed") throw new ApiError(409, "案件已关闭，不能新增行动");
    let targetType = value.targetType ?? null;
    let targetRef = value.targetRef ?? null;
    if (value.kind === "reconciliation") {
      const scope = current.scopeSnapshot as {
        authoritativeInternal?: { totalQty?: unknown };
      } | null;
      const affectedQty = scope?.authoritativeInternal?.totalQty;
      if (
        current.kind !== "recall"
        || !current.scopeDigest
        || typeof affectedQty !== "string"
      ) {
        throw new ApiError(409, "数量核对行动必须绑定已固化的召回范围");
      }
      if (dCmp(value.quantity!, affectedQty) !== 0) {
        throw new ApiError(409, `数量核对必须使用固化范围受影响量 ${affectedQty}`);
      }
      targetType = "recall_scope_digest";
      targetRef = current.scopeDigest;
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${value.idempotencyKey}))`);
    const [replayed] = await tx
      .select()
      .from(schema.qualityActions)
      .where(eq(schema.qualityActions.idempotencyKey, value.idempotencyKey));
    if (replayed) {
      assertIdempotentReplay("质量行动", {
        caseId: replayed.caseId,
        kind: replayed.kind,
        title: replayed.title,
        description: replayed.description,
        ownerId: replayed.ownerId,
        dueDate: replayed.dueDate,
        targetType: replayed.targetType,
        targetRef: replayed.targetRef,
        quantity: replayed.quantity,
      }, {
        caseId,
        kind: value.kind,
        title: value.title,
        description: value.description,
        ownerId: value.ownerId,
        dueDate: value.dueDate,
        targetType,
        targetRef,
        quantity: value.quantity == null ? null : normalizeQuantity4(value.quantity),
      });
      return replayed;
    }
    const [created] = await tx
      .insert(schema.qualityActions)
      .values({
        caseId,
        kind: value.kind,
        title: value.title,
        description: value.description,
        ownerId: value.ownerId,
        dueDate: value.dueDate,
        targetType,
        targetRef,
        quantity: value.quantity ?? null,
        idempotencyKey: value.idempotencyKey,
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "quality_action",
      entityId: created.id,
      action: "create",
      after: created,
    });
    return created;
  });
}

export async function transitionQualityAction(
  user: SessionUser,
  actionId: number,
  input: unknown,
  dbArg?: AnyDb,
) {
  const value = actionOperationSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    await tx.execute(sql`SELECT id FROM quality_actions WHERE id = ${actionId} FOR UPDATE`);
    const [current] = await tx
      .select()
      .from(schema.qualityActions)
      .where(eq(schema.qualityActions.id, actionId));
    if (!current) throw new ApiError(404, "质量行动不存在");
    const [parent] = await tx
      .select({ status: schema.qualityCases.status, kind: schema.qualityCases.kind })
      .from(schema.qualityCases)
      .where(eq(schema.qualityCases.id, current.caseId));
    if (!parent || parent.status === "closed") throw new ApiError(409, "案件已关闭，不能改写行动");

    let patch: Record<string, unknown>;
    if (value.operation === "complete") {
      if (!canActForOwner(user, current.ownerId)) throw new ApiError(403, "只有责任人或质量角色可完成行动");
      if (current.kind === "follow_up" && current.dueDate > todayShanghai()) {
        throw new ApiError(409, `一年补充报告监测窗口至 ${current.dueDate}，到期前不能完成`);
      }
      if (current.status !== "open") {
        if (current.evidenceRef === value.evidenceRef && current.outcome === value.outcome) return current;
        throw new ApiError(409, "行动已完成，不能覆盖原始完成证据");
      }
      patch = {
        status: "completed",
        evidenceRef: value.evidenceRef,
        outcome: value.outcome,
        completedBy: user.id,
        completedAt: new Date(),
      };
    } else {
      requireQualityWrite(user);
      if (current.status !== "completed") throw new ApiError(409, "行动必须先完成再验证");
      if (current.completedBy === user.id) throw new ApiError(409, "完成人不能验证自己的行动");
      if (value.result === "waived" && !user.roles.includes("admin")) {
        throw new ApiError(403, "只有管理员可带理由豁免行动");
      }
      if (
        value.result === "waived"
        && parent.kind === "recall"
        && ["containment", "notification", "effectiveness", "reconciliation"].includes(current.kind)
      ) {
        throw new ApiError(409, "召回围堵、通知、有效性检查和数量核对属于强制行动，不得豁免");
      }
      patch = {
        status: value.result,
        verificationNote: value.verificationNote,
        verifiedBy: user.id,
        verifiedAt: new Date(),
      };
    }
    const [updated] = await tx
      .update(schema.qualityActions)
      .set(patch)
      .where(eq(schema.qualityActions.id, actionId))
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "quality_action",
      entityId: actionId,
      action: value.operation === "complete" ? "quality_action_complete" : `quality_action_${value.result}`,
      before: current,
      after: updated,
    });
    return updated;
  });
}

export async function listRegulatoryRecords(
  user: SessionUser,
  query: { q?: string; marketCode?: string; recordType?: string },
  dbArg?: AnyDb,
) {
  requireQualityRead(user);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const conditions = [];
  const q = (query.q ?? "").trim();
  if (q) {
    conditions.push(or(
      ilike(schema.regulatoryRecords.recordKey, `%${q}%`),
      ilike(schema.regulatoryRecords.title, `%${q}%`),
      ilike(schema.regulatoryRecords.referenceNo, `%${q}%`),
      ilike(schema.skus.code, `%${q}%`),
    ));
  }
  if (query.marketCode && marketCode.safeParse(query.marketCode).success) {
    conditions.push(eq(schema.regulatoryRecords.marketCode, query.marketCode.toUpperCase()));
  }
  if (query.recordType && regulatoryRecordType.safeParse(query.recordType).success) {
    conditions.push(eq(schema.regulatoryRecords.recordType, query.recordType));
  }
  const today = todayShanghai();
  const rows = await db
    .select({
      id: schema.regulatoryRecords.id,
      recordKey: schema.regulatoryRecords.recordKey,
      recordType: schema.regulatoryRecords.recordType,
      marketCode: schema.regulatoryRecords.marketCode,
      skuId: schema.regulatoryRecords.skuId,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      supplierId: schema.regulatoryRecords.supplierId,
      supplierName: schema.suppliers.name,
      title: schema.regulatoryRecords.title,
      authority: schema.regulatoryRecords.authority,
      referenceNo: schema.regulatoryRecords.referenceNo,
      status: schema.regulatoryRecords.status,
      effectiveDate: schema.regulatoryRecords.effectiveDate,
      expiryDate: schema.regulatoryRecords.expiryDate,
      renewalDueDate: schema.regulatoryRecords.renewalDueDate,
      retentionUntil: schema.regulatoryRecords.retentionUntil,
      payload: schema.regulatoryRecords.payload,
      payloadDigest: schema.regulatoryRecords.payloadDigest,
      version: schema.regulatoryRecords.version,
      previousId: schema.regulatoryRecords.previousId,
      evidenceRef: schema.regulatoryRecords.evidenceRef,
      createdAt: schema.regulatoryRecords.createdAt,
      isLatestRevision: sql<boolean>`${schema.regulatoryRecords.version} = (
        select max(rr.version) from regulatory_records rr
        where rr.record_key = ${schema.regulatoryRecords.recordKey}
      )`,
      isOperative: sql<boolean>`(
        ${schema.regulatoryRecords.status} = 'active'
        and coalesce(
          ${schema.regulatoryRecords.effectiveDate},
          (${schema.regulatoryRecords.createdAt} at time zone 'Asia/Shanghai')::date
        ) <= ${today}
        and (${schema.regulatoryRecords.expiryDate} is null
          or ${schema.regulatoryRecords.expiryDate} >= ${today})
        and ${schema.regulatoryRecords.version} = (
          select max(rr.version) from regulatory_records rr
          where rr.record_key = ${schema.regulatoryRecords.recordKey}
            and rr.status <> 'submitted'
            and coalesce(
              rr.effective_date,
              (rr.created_at at time zone 'Asia/Shanghai')::date
            ) <= ${today}
        )
      )`,
    })
    .from(schema.regulatoryRecords)
    .leftJoin(schema.skus, eq(schema.regulatoryRecords.skuId, schema.skus.id))
    .leftJoin(schema.suppliers, eq(schema.regulatoryRecords.supplierId, schema.suppliers.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(schema.regulatoryRecords.recordKey, desc(schema.regulatoryRecords.version));
  const canReadRegulatoryEvidence = user.roles.includes("quality") || user.roles.includes("admin");
  return rows.map((row: typeof rows[number]) => ({
    ...row,
    payload: canReadRegulatoryEvidence ? row.payload : null,
    evidenceRef: canReadRegulatoryEvidence ? row.evidenceRef : null,
    isLatest: row.isLatestRevision,
    renewalState: row.renewalDueDate
      ? classifyDueState({
        dueDate: row.renewalDueDate,
        asOfDate: today,
        dueSoonThroughDate: addCalendarDays(today, 30),
      })
      : null,
  }));
}

export async function createRegulatoryRecord(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
) {
  requireQualityWrite(user);
  const value = createRegulatorySchema.parse(input);
  if (value.effectiveDate && value.expiryDate && value.expiryDate < value.effectiveDate) {
    throw new ApiError(400, "监管证据失效日不能早于生效日");
  }
  if (value.renewalDueDate && value.expiryDate && value.renewalDueDate > value.expiryDate) {
    throw new ApiError(400, "续期截止日不能晚于证据失效日");
  }
  const key = value.recordKey.toUpperCase();
  const payload = {
    schemaVersion: "regulatory-record/v1",
    marketCode: value.marketCode,
    recordType: value.recordType,
    facts: value.payload,
  };
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${value.idempotencyKey}))`);
    const [replayed] = await tx
      .select()
      .from(schema.regulatoryRecords)
      .where(eq(schema.regulatoryRecords.idempotencyKey, value.idempotencyKey));
    if (replayed) {
      assertIdempotentReplay("监管证据", {
        recordKey: replayed.recordKey,
        recordType: replayed.recordType,
        marketCode: replayed.marketCode,
        skuId: replayed.skuId,
        supplierId: replayed.supplierId,
        title: replayed.title,
        authority: replayed.authority,
        referenceNo: replayed.referenceNo,
        status: replayed.status,
        effectiveDate: replayed.effectiveDate,
        expiryDate: replayed.expiryDate,
        renewalDueDate: replayed.renewalDueDate,
        retentionUntil: replayed.retentionUntil,
        payload: replayed.payload,
        evidenceRef: replayed.evidenceRef,
      }, {
        recordKey: key,
        recordType: value.recordType,
        marketCode: value.marketCode,
        skuId: value.skuId ?? null,
        supplierId: value.supplierId ?? null,
        title: value.title,
        authority: value.authority,
        referenceNo: value.referenceNo ?? null,
        status: value.status,
        effectiveDate: value.effectiveDate ?? null,
        expiryDate: value.expiryDate ?? null,
        renewalDueDate: value.renewalDueDate ?? null,
        retentionUntil: value.retentionUntil ?? null,
        payload,
        evidenceRef: value.evidenceRef ?? null,
      });
      return replayed;
    }
    if (value.skuId) {
      const [sku] = await tx.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.id, value.skuId));
      if (!sku) throw new ApiError(400, "SKU 不存在");
    }
    if (value.supplierId) {
      const [supplier] = await tx
        .select({ id: schema.suppliers.id })
        .from(schema.suppliers)
        .where(eq(schema.suppliers.id, value.supplierId));
      if (!supplier) throw new ApiError(400, "供应商不存在");
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    await tx.execute(sql`SELECT id FROM regulatory_records WHERE record_key = ${key} ORDER BY version DESC LIMIT 1 FOR UPDATE`);
    const [previous] = await tx
      .select()
      .from(schema.regulatoryRecords)
      .where(eq(schema.regulatoryRecords.recordKey, key))
      .orderBy(desc(schema.regulatoryRecords.version))
      .limit(1);
    if (
      previous
      && (
        previous.recordType !== value.recordType
        || previous.marketCode !== value.marketCode
        || previous.skuId !== (value.skuId ?? null)
        || previous.supplierId !== (value.supplierId ?? null)
        || normalizeReference(previous.authority) !== normalizeReference(value.authority)
      )
    ) {
      throw new ApiError(409, "同一监管证据键的市场、类型、主体和主管机构身份不可跨版本改变");
    }
    const [created] = await tx
      .insert(schema.regulatoryRecords)
      .values({
        recordKey: key,
        recordType: value.recordType,
        marketCode: value.marketCode,
        skuId: value.skuId ?? null,
        supplierId: value.supplierId ?? null,
        title: value.title,
        authority: value.authority,
        referenceNo: value.referenceNo ?? null,
        status: value.status,
        effectiveDate: value.effectiveDate ?? null,
        expiryDate: value.expiryDate ?? null,
        renewalDueDate: value.renewalDueDate ?? null,
        retentionUntil: value.retentionUntil ?? null,
        payload,
        payloadDigest: digestQualityEvidence(payload),
        version: (previous?.version ?? 0) + 1,
        previousId: previous?.id ?? null,
        evidenceRef: value.evidenceRef ?? null,
        idempotencyKey: value.idempotencyKey,
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "regulatory_record",
      entityId: created.id,
      action: "publish_version",
      after: created,
    });
    return created;
  });
}

export async function listElectronicLabels(
  user: SessionUser,
  query: { skuId?: number; marketCode?: string },
  dbArg?: AnyDb,
) {
  requireQualityRead(user);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const conditions = [];
  if (query.skuId) conditions.push(eq(schema.electronicLabelVersions.skuId, query.skuId));
  if (query.marketCode && marketCode.safeParse(query.marketCode).success) {
    conditions.push(eq(schema.electronicLabelVersions.marketCode, query.marketCode.toUpperCase()));
  }
  const today = todayShanghai();
  const rows = await db
    .select({
      id: schema.electronicLabelVersions.id,
      labelKey: schema.electronicLabelVersions.labelKey,
      skuId: schema.electronicLabelVersions.skuId,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      marketCode: schema.electronicLabelVersions.marketCode,
      locale: schema.electronicLabelVersions.locale,
      regulatoryRecordId: schema.electronicLabelVersions.regulatoryRecordId,
      version: schema.electronicLabelVersions.version,
      publicToken: schema.electronicLabelVersions.publicToken,
      contentDigest: schema.electronicLabelVersions.contentDigest,
      effectiveDate: schema.electronicLabelVersions.effectiveDate,
      createdAt: schema.electronicLabelVersions.createdAt,
      regulatoryStatus: schema.regulatoryRecords.status,
      regulatoryEffectiveDate: schema.regulatoryRecords.effectiveDate,
      regulatoryExpiryDate: schema.regulatoryRecords.expiryDate,
      regulatoryRecordKey: schema.regulatoryRecords.recordKey,
      regulatoryRecordVersion: schema.regulatoryRecords.version,
      regulatoryEligibleAtLabelEffective: sql<boolean>`(
        ${schema.regulatoryRecords.status} = 'active'
        and coalesce(
          ${schema.regulatoryRecords.effectiveDate},
          (${schema.regulatoryRecords.createdAt} at time zone 'Asia/Shanghai')::date
        ) <= ${schema.electronicLabelVersions.effectiveDate}
        and (${schema.regulatoryRecords.expiryDate} is null
          or ${schema.regulatoryRecords.expiryDate} >= ${schema.electronicLabelVersions.effectiveDate})
        and ${schema.regulatoryRecords.skuId} = ${schema.electronicLabelVersions.skuId}
        and ${schema.regulatoryRecords.marketCode} = ${schema.electronicLabelVersions.marketCode}
        and ${schema.regulatoryRecords.referenceNo} is not null
        and upper(regexp_replace(trim(${schema.regulatoryRecords.referenceNo}), '\s+', ' ', 'g'))
          = upper(regexp_replace(
            trim(${schema.electronicLabelVersions.content}->>'registrationRef'),
            '\s+',
            ' ',
            'g'
          ))
        and (
          (${schema.regulatoryRecords.marketCode} = 'CN'
            and ${schema.regulatoryRecords.recordType} in ('nmpa_filing', 'nmpa_registration'))
          or (${schema.regulatoryRecords.marketCode} = 'US'
            and ${schema.regulatoryRecords.recordType} = 'fda_product_listing')
          or (${schema.regulatoryRecords.marketCode} = 'EU'
            and ${schema.regulatoryRecords.recordType} = 'eu_cpnp')
        )
        and ${schema.regulatoryRecords.version} = (
          select max(rr.version) from regulatory_records rr
          where rr.record_key = ${schema.regulatoryRecords.recordKey}
            and rr.status <> 'submitted'
            and coalesce(
              rr.effective_date,
              (rr.created_at at time zone 'Asia/Shanghai')::date
            ) <= ${schema.electronicLabelVersions.effectiveDate}
        )
      )`,
      regulatoryEligibleNow: sql<boolean>`(
        ${schema.regulatoryRecords.status} = 'active'
        and coalesce(
          ${schema.regulatoryRecords.effectiveDate},
          (${schema.regulatoryRecords.createdAt} at time zone 'Asia/Shanghai')::date
        ) <= ${today}
        and (${schema.regulatoryRecords.expiryDate} is null
          or ${schema.regulatoryRecords.expiryDate} >= ${today})
        and ${schema.regulatoryRecords.skuId} = ${schema.electronicLabelVersions.skuId}
        and ${schema.regulatoryRecords.marketCode} = ${schema.electronicLabelVersions.marketCode}
        and ${schema.regulatoryRecords.referenceNo} is not null
        and upper(regexp_replace(trim(${schema.regulatoryRecords.referenceNo}), '\s+', ' ', 'g'))
          = upper(regexp_replace(
            trim(${schema.electronicLabelVersions.content}->>'registrationRef'),
            '\s+',
            ' ',
            'g'
          ))
        and (
          (${schema.regulatoryRecords.marketCode} = 'CN'
            and ${schema.regulatoryRecords.recordType} in ('nmpa_filing', 'nmpa_registration'))
          or (${schema.regulatoryRecords.marketCode} = 'US'
            and ${schema.regulatoryRecords.recordType} = 'fda_product_listing')
          or (${schema.regulatoryRecords.marketCode} = 'EU'
            and ${schema.regulatoryRecords.recordType} = 'eu_cpnp')
        )
        and ${schema.regulatoryRecords.version} = (
          select max(rr.version) from regulatory_records rr
          where rr.record_key = ${schema.regulatoryRecords.recordKey}
            and rr.status <> 'submitted'
            and coalesce(
              rr.effective_date,
              (rr.created_at at time zone 'Asia/Shanghai')::date
            ) <= ${today}
        )
      )`,
    })
    .from(schema.electronicLabelVersions)
    .innerJoin(schema.skus, eq(schema.electronicLabelVersions.skuId, schema.skus.id))
    .innerJoin(
      schema.regulatoryRecords,
      eq(schema.electronicLabelVersions.regulatoryRecordId, schema.regulatoryRecords.id),
    )
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(schema.electronicLabelVersions.labelKey, desc(schema.electronicLabelVersions.version));
  const latestScheduled = new Map<string, number>();
  const currentEffective = new Map<string, number>();
  for (const row of rows) {
    if (
      row.effectiveDate > today
      && row.regulatoryEligibleAtLabelEffective
      && !latestScheduled.has(row.labelKey)
    ) {
      latestScheduled.set(row.labelKey, row.version);
    }
    if (row.effectiveDate <= today && row.regulatoryEligibleNow && !currentEffective.has(row.labelKey)) {
      currentEffective.set(row.labelKey, row.version);
    }
  }
  return rows.map((row: typeof rows[number]) => ({
    ...row,
    lifecycleState: row.effectiveDate > today && !row.regulatoryEligibleAtLabelEffective
      ? "blocked"
      : row.effectiveDate <= today && !row.regulatoryEligibleNow
        ? "blocked"
        : row.effectiveDate > today && latestScheduled.get(row.labelKey) === row.version
          ? "scheduled"
          : currentEffective.get(row.labelKey) === row.version
            ? "current"
            : "historical",
    isCurrent: row.effectiveDate <= today && currentEffective.get(row.labelKey) === row.version,
    publicPath: `/e-label/${row.publicToken}`,
  }));
}

export async function publishElectronicLabel(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
) {
  requireQualityWrite(user);
  const value = publishElectronicLabelSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    const labelKey = `${value.skuId}:${value.marketCode}:${value.locale}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${value.idempotencyKey}))`);
    const [replayed] = await tx
      .select()
      .from(schema.electronicLabelVersions)
      .where(eq(schema.electronicLabelVersions.idempotencyKey, value.idempotencyKey));
    if (replayed) {
      const storedContent = electronicLabelStoredContentSchema.parse(replayed.content);
      assertIdempotentReplay("电子标签", {
        labelKey: replayed.labelKey,
        skuId: replayed.skuId,
        marketCode: replayed.marketCode,
        locale: replayed.locale,
        regulatoryRecordId: replayed.regulatoryRecordId,
        effectiveDate: replayed.effectiveDate,
        content: electronicLabelContentSchema.parse(storedContent),
      }, {
        labelKey,
        skuId: value.skuId,
        marketCode: value.marketCode,
        locale: value.locale,
        regulatoryRecordId: value.regulatoryRecordId,
        effectiveDate: value.effectiveDate,
        content: value.content,
      });
      return {
        ...replayed,
        publicPath: `/e-label/${replayed.publicToken}`,
      };
    }
    const [sku] = await tx
      .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name })
      .from(schema.skus)
      .where(eq(schema.skus.id, value.skuId));
    if (!sku) throw new ApiError(400, "SKU 不存在");
    const content = {
      schemaVersion: "cosmetics-electronic-label/v1",
      skuSnapshot: { code: sku.code, name: sku.name },
      ...value.content,
    };
    const [regulatory] = await tx
      .select()
      .from(schema.regulatoryRecords)
      .where(eq(schema.regulatoryRecords.id, value.regulatoryRecordId));
    if (!regulatory) throw new ApiError(400, "监管证据版本不存在");
    if (regulatory.marketCode !== value.marketCode) throw new ApiError(400, "电子标签市场与监管证据市场不一致");
    if (!isElectronicLabelSupportType(value.marketCode, regulatory.recordType)) {
      throw new ApiError(409, "该市场的监管证据类型不能作为产品电子标签的合规支撑");
    }
    if (regulatory.skuId !== value.skuId) {
      throw new ApiError(409, "电子标签必须绑定同一 SKU 的产品级监管证据");
    }
    if (!regulatory.referenceNo) throw new ApiError(409, "电子标签监管证据缺少产品备案/注册编号");
    if (regulatory.status !== "active") throw new ApiError(409, "只有 active 的监管证据版本可支撑发布");
    const [governingRegulatory] = await tx
      .select({ id: schema.regulatoryRecords.id })
      .from(schema.regulatoryRecords)
      .where(and(
        eq(schema.regulatoryRecords.recordKey, regulatory.recordKey),
        sql`${schema.regulatoryRecords.status} <> 'submitted'`,
        sql`coalesce(
          ${schema.regulatoryRecords.effectiveDate},
          (${schema.regulatoryRecords.createdAt} at time zone 'Asia/Shanghai')::date
        ) <= ${value.effectiveDate}`,
      ))
      .orderBy(desc(schema.regulatoryRecords.version))
      .limit(1);
    if (governingRegulatory?.id !== regulatory.id) {
      throw new ApiError(409, "只能使用标签生效日适用的当前监管证据版本");
    }
    if (regulatory.effectiveDate && value.effectiveDate < regulatory.effectiveDate) {
      throw new ApiError(400, "电子标签生效日不能早于监管证据生效日");
    }
    if (regulatory.expiryDate && value.effectiveDate > regulatory.expiryDate) {
      throw new ApiError(409, "电子标签生效日已超出监管证据有效期");
    }
    if (
      regulatory.referenceNo
      && normalizeReference(value.content.registrationRef) !== normalizeReference(regulatory.referenceNo)
    ) {
      throw new ApiError(400, "电子标签备案/注册编号与所选监管证据不一致");
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${labelKey}))`);
    await tx.execute(sql`SELECT id FROM electronic_label_versions WHERE label_key = ${labelKey} ORDER BY version DESC LIMIT 1 FOR UPDATE`);
    const [previous] = await tx
      .select()
      .from(schema.electronicLabelVersions)
      .where(eq(schema.electronicLabelVersions.labelKey, labelKey))
      .orderBy(desc(schema.electronicLabelVersions.version))
      .limit(1);
    if (previous && value.effectiveDate < previous.effectiveDate) {
      throw new ApiError(400, "新电子标签版本的生效日不能早于上一版本");
    }
    const [created] = await tx
      .insert(schema.electronicLabelVersions)
      .values({
        labelKey,
        skuId: value.skuId,
        marketCode: value.marketCode,
        locale: value.locale,
        regulatoryRecordId: value.regulatoryRecordId,
        version: (previous?.version ?? 0) + 1,
        previousId: previous?.id ?? null,
        publicToken: randomUUID().replaceAll("-", ""),
        content,
        contentDigest: digestQualityEvidence(content),
        effectiveDate: value.effectiveDate,
        idempotencyKey: value.idempotencyKey,
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "electronic_label",
      entityId: created.id,
      action: "publish_version",
      after: {
        id: created.id,
        labelKey: created.labelKey,
        version: created.version,
        digest: created.contentDigest,
        regulatoryRecordId: created.regulatoryRecordId,
      },
    });
    return {
      ...created,
      publicPath: `/e-label/${created.publicToken}`,
    };
  });
}

export async function getPublicElectronicLabel(token: string, dbArg?: AnyDb) {
  const clean = token.trim();
  if (!/^[0-9a-f]{32}$/i.test(clean)) throw new ApiError(404, "电子标签不存在");
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = todayShanghai();
  const [row] = await db
    .select({
      id: schema.electronicLabelVersions.id,
      labelKey: schema.electronicLabelVersions.labelKey,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      marketCode: schema.electronicLabelVersions.marketCode,
      locale: schema.electronicLabelVersions.locale,
      version: schema.electronicLabelVersions.version,
      content: schema.electronicLabelVersions.content,
      contentDigest: schema.electronicLabelVersions.contentDigest,
      effectiveDate: schema.electronicLabelVersions.effectiveDate,
      createdAt: schema.electronicLabelVersions.createdAt,
      regulatoryStatus: schema.regulatoryRecords.status,
      regulatoryEffectiveDate: schema.regulatoryRecords.effectiveDate,
      regulatoryExpiryDate: schema.regulatoryRecords.expiryDate,
      regulatoryEligibleAtLabelEffective: sql<boolean>`(
        ${schema.regulatoryRecords.status} = 'active'
        and coalesce(
          ${schema.regulatoryRecords.effectiveDate},
          (${schema.regulatoryRecords.createdAt} at time zone 'Asia/Shanghai')::date
        ) <= ${schema.electronicLabelVersions.effectiveDate}
        and (${schema.regulatoryRecords.expiryDate} is null
          or ${schema.regulatoryRecords.expiryDate} >= ${schema.electronicLabelVersions.effectiveDate})
        and ${schema.regulatoryRecords.skuId} = ${schema.electronicLabelVersions.skuId}
        and ${schema.regulatoryRecords.marketCode} = ${schema.electronicLabelVersions.marketCode}
        and ${schema.regulatoryRecords.referenceNo} is not null
        and upper(regexp_replace(trim(${schema.regulatoryRecords.referenceNo}), '\s+', ' ', 'g'))
          = upper(regexp_replace(
            trim(${schema.electronicLabelVersions.content}->>'registrationRef'),
            '\s+',
            ' ',
            'g'
          ))
        and (
          (${schema.regulatoryRecords.marketCode} = 'CN'
            and ${schema.regulatoryRecords.recordType} in ('nmpa_filing', 'nmpa_registration'))
          or (${schema.regulatoryRecords.marketCode} = 'US'
            and ${schema.regulatoryRecords.recordType} = 'fda_product_listing')
          or (${schema.regulatoryRecords.marketCode} = 'EU'
            and ${schema.regulatoryRecords.recordType} = 'eu_cpnp')
        )
        and ${schema.regulatoryRecords.version} = (
          select max(rr.version) from regulatory_records rr
          where rr.record_key = ${schema.regulatoryRecords.recordKey}
            and rr.status <> 'submitted'
            and coalesce(
              rr.effective_date,
              (rr.created_at at time zone 'Asia/Shanghai')::date
            ) <= ${schema.electronicLabelVersions.effectiveDate}
        )
      )`,
      regulatoryEligibleNow: sql<boolean>`(
        ${schema.regulatoryRecords.status} = 'active'
        and coalesce(
          ${schema.regulatoryRecords.effectiveDate},
          (${schema.regulatoryRecords.createdAt} at time zone 'Asia/Shanghai')::date
        ) <= ${today}
        and (${schema.regulatoryRecords.expiryDate} is null
          or ${schema.regulatoryRecords.expiryDate} >= ${today})
        and ${schema.regulatoryRecords.skuId} = ${schema.electronicLabelVersions.skuId}
        and ${schema.regulatoryRecords.marketCode} = ${schema.electronicLabelVersions.marketCode}
        and ${schema.regulatoryRecords.referenceNo} is not null
        and upper(regexp_replace(trim(${schema.regulatoryRecords.referenceNo}), '\s+', ' ', 'g'))
          = upper(regexp_replace(
            trim(${schema.electronicLabelVersions.content}->>'registrationRef'),
            '\s+',
            ' ',
            'g'
          ))
        and (
          (${schema.regulatoryRecords.marketCode} = 'CN'
            and ${schema.regulatoryRecords.recordType} in ('nmpa_filing', 'nmpa_registration'))
          or (${schema.regulatoryRecords.marketCode} = 'US'
            and ${schema.regulatoryRecords.recordType} = 'fda_product_listing')
          or (${schema.regulatoryRecords.marketCode} = 'EU'
            and ${schema.regulatoryRecords.recordType} = 'eu_cpnp')
        )
        and ${schema.regulatoryRecords.version} = (
          select max(rr.version) from regulatory_records rr
          where rr.record_key = ${schema.regulatoryRecords.recordKey}
            and rr.status <> 'submitted'
            and coalesce(
              rr.effective_date,
              (rr.created_at at time zone 'Asia/Shanghai')::date
            ) <= ${today}
        )
      )`,
    })
    .from(schema.electronicLabelVersions)
    .innerJoin(schema.skus, eq(schema.electronicLabelVersions.skuId, schema.skus.id))
    .innerJoin(
      schema.regulatoryRecords,
      eq(schema.electronicLabelVersions.regulatoryRecordId, schema.regulatoryRecords.id),
    )
    .where(eq(schema.electronicLabelVersions.publicToken, clean));
  if (!row) throw new ApiError(404, "电子标签不存在");
  const [versions] = await db
    .select({
      latestVersion: sql<number>`max(${schema.electronicLabelVersions.version})::int`,
      currentVersion: sql<number>`max(${schema.electronicLabelVersions.version}) filter (
        where ${schema.electronicLabelVersions.effectiveDate} <= ${today}
          and exists (
            select 1 from regulatory_records rr
            where rr.id = ${schema.electronicLabelVersions.regulatoryRecordId}
              and rr.status = 'active'
              and coalesce(
                rr.effective_date,
                (rr.created_at at time zone 'Asia/Shanghai')::date
              ) <= ${today}
              and (rr.expiry_date is null or rr.expiry_date >= ${today})
              and rr.sku_id = ${schema.electronicLabelVersions.skuId}
              and rr.market_code = ${schema.electronicLabelVersions.marketCode}
              and rr.reference_no is not null
              and upper(regexp_replace(trim(rr.reference_no), '\s+', ' ', 'g'))
                = upper(regexp_replace(
                  trim(${schema.electronicLabelVersions.content}->>'registrationRef'),
                  '\s+',
                  ' ',
                  'g'
                ))
              and (
                (rr.market_code = 'CN' and rr.record_type in ('nmpa_filing', 'nmpa_registration'))
                or (rr.market_code = 'US' and rr.record_type = 'fda_product_listing')
                or (rr.market_code = 'EU' and rr.record_type = 'eu_cpnp')
              )
              and rr.version = (
                select max(rr2.version) from regulatory_records rr2
                where rr2.record_key = rr.record_key
                  and rr2.status <> 'submitted'
                  and coalesce(
                    rr2.effective_date,
                    (rr2.created_at at time zone 'Asia/Shanghai')::date
                  ) <= ${today}
              )
          )
      )::int`,
      scheduledVersion: sql<number>`max(${schema.electronicLabelVersions.version}) filter (
        where ${schema.electronicLabelVersions.effectiveDate} > ${today}
          and exists (
            select 1 from regulatory_records rr
            where rr.id = ${schema.electronicLabelVersions.regulatoryRecordId}
              and rr.status = 'active'
              and coalesce(
                rr.effective_date,
                (rr.created_at at time zone 'Asia/Shanghai')::date
              ) <= ${schema.electronicLabelVersions.effectiveDate}
              and (rr.expiry_date is null
                or rr.expiry_date >= ${schema.electronicLabelVersions.effectiveDate})
              and rr.sku_id = ${schema.electronicLabelVersions.skuId}
              and rr.market_code = ${schema.electronicLabelVersions.marketCode}
              and rr.reference_no is not null
              and upper(regexp_replace(trim(rr.reference_no), '\s+', ' ', 'g'))
                = upper(regexp_replace(
                  trim(${schema.electronicLabelVersions.content}->>'registrationRef'),
                  '\s+',
                  ' ',
                  'g'
                ))
              and (
                (rr.market_code = 'CN' and rr.record_type in ('nmpa_filing', 'nmpa_registration'))
                or (rr.market_code = 'US' and rr.record_type = 'fda_product_listing')
                or (rr.market_code = 'EU' and rr.record_type = 'eu_cpnp')
              )
              and rr.version = (
                select max(rr2.version) from regulatory_records rr2
                where rr2.record_key = rr.record_key
                  and rr2.status <> 'submitted'
                  and coalesce(
                    rr2.effective_date,
                    (rr2.created_at at time zone 'Asia/Shanghai')::date
                  ) <= ${schema.electronicLabelVersions.effectiveDate}
              )
          )
      )::int`,
    })
    .from(schema.electronicLabelVersions)
    .where(eq(schema.electronicLabelVersions.labelKey, row.labelKey));
  // `version` keeps narrow fake/read-adapter compatibility while production returns both aggregates.
  const compatibleVersions = versions as typeof versions & { version?: number };
  const latestVersion = compatibleVersions?.latestVersion ?? compatibleVersions?.version;
  const currentVersion = compatibleVersions?.currentVersion ?? compatibleVersions?.version;
  const scheduledVersion = compatibleVersions?.scheduledVersion ?? latestVersion;
  const eligibleAtEffective = row.regulatoryEligibleAtLabelEffective !== false;
  const eligibleNow = row.regulatoryEligibleNow !== false;
  const lifecycleState = row.effectiveDate > today && !eligibleAtEffective
    ? "blocked"
    : row.effectiveDate <= today && !eligibleNow
      ? "blocked"
      : row.effectiveDate > today && row.version === scheduledVersion
        ? "scheduled"
        : row.version === currentVersion
          ? "current"
          : "historical";
  const storedContent = electronicLabelStoredContentSchema.safeParse(row.content);
  const regulatorySupportState = eligibleNow
    ? "active"
    : row.regulatoryStatus !== "active"
      ? "inactive"
      : row.regulatoryEffectiveDate != null && row.regulatoryEffectiveDate > today
        ? "scheduled"
        : row.regulatoryExpiryDate != null && row.regulatoryExpiryDate < today
          ? "expired"
          : "not_operative";
  return {
    schemaVersion: "public-cosmetics-electronic-label/v1",
    sku: storedContent.success
      ? storedContent.data.skuSnapshot
      : { code: row.skuCode, name: row.skuName },
    marketCode: row.marketCode,
    locale: row.locale,
    version: row.version,
    lifecycleState,
    isCurrent: lifecycleState === "current",
    regulatorySupportState,
    effectiveDate: row.effectiveDate,
    content: electronicLabelContentSchema.parse(row.content),
    digest: row.contentDigest,
    publishedAt: row.createdAt,
    notice: row.marketCode === "CN"
      ? "化妆品电子标签试点内容；是否可替代实体标签须以企业试点资格和当前监管要求为准。"
      : "电子产品信息补充页；不自动替代目的市场要求的实体标签。",
  };
}
