import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { businessDateSchema } from "@/server/core/business-date-schema";

import { DATA_PRODUCTS, type DataProductDefinition } from "@/components/data-products";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dAdd, dDiv, dMoney, dMul } from "@/server/core/decimal";
import { canSeePrices, type SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import {
  loadDataProductReleaseReadiness,
  type DataProductReleaseReadiness,
} from "@/server/modules/report/data-product-release";
import {
  loadDataSourceReadiness,
  type DataSourceReadiness,
} from "@/server/modules/report/data-source-readiness";
import { shanghaiDayOf } from "@/server/core/business-day";

export type DataProductOutcomeDecision = "accepted" | "modified" | "rejected" | "deferred";
export type DataProductOutcomeResult = "pending" | "positive" | "neutral" | "negative" | "false_positive";
export type DataProductOutcomeReason =
  | "data_quality"
  | "identity_gap"
  | "timing"
  | "business_constraint"
  | "duplicate"
  | "low_confidence"
  | "other";

export interface DataProductOutcomeDto {
  id: number;
  productId: string;
  contractVersion: string;
  releaseId: number;
  sourceEvidenceDigest: string;
  decisionRef: string;
  businessDate: string;
  decision: DataProductOutcomeDecision;
  result: DataProductOutcomeResult;
  handlingMinutes: number | null;
  savedHours: string | null;
  cashImpact: string | null;
  currency: "CNY" | null;
  cashVisible: boolean;
  reasonCode: DataProductOutcomeReason | null;
  evidenceRef: string | null;
  note: string;
  supersedesId: number | null;
  recordedBy: number;
  recordedByName: string | null;
  createdAt: string;
}

export interface DataProductOutcomeReadiness {
  productId: string;
  canRecord: boolean;
  canCorrect: boolean;
  gate: string;
  cashVisible: boolean;
  outcomeCount: number;
  evaluatedDecisionCount: number;
  adoptedCount: number;
  pendingCount: number;
  terminalResultCount: number;
  falsePositiveCount: number;
  adoptionRatePct: string | null;
  falsePositiveRatePct: string | null;
  avgHandlingMinutes: string | null;
  savedHoursTotal: string | null;
  cashImpactTotal: string | null;
  latest: DataProductOutcomeDto[];
}

const decimalString = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const normalized = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    ctx.addIssue({ code: "custom", message: "必须是十进制数" });
    return z.NEVER;
  }
  return normalized;
});

const inputSchema = z.object({
  productId: z.string().trim().min(1).max(80),
  decisionRef: z.string().trim().min(3, "请填写建议/决策编号").max(200),
  businessDate: businessDateSchema,
  decision: z.enum(["accepted", "modified", "rejected", "deferred"]),
  result: z.enum(["pending", "positive", "neutral", "negative", "false_positive"]),
  handlingMinutes: z.number().int().min(0).max(525_600).optional().nullable(),
  savedHours: decimalString.optional().nullable(),
  cashImpact: decimalString.optional().nullable(),
  reasonCode: z.enum(["data_quality", "identity_gap", "timing", "business_constraint", "duplicate", "low_confidence", "other"]).optional().nullable(),
  evidenceRef: z.string().trim().max(300).optional().nullable(),
  note: z.string().trim().min(3, "结果说明至少 3 个字").max(1_000),
  supersedesId: z.number().int().positive().optional().nullable(),
  idempotencyKey: z.string().uuid(),
}).superRefine((value, ctx) => {
  const needsReason = value.decision === "modified"
    || value.decision === "rejected"
    || value.result === "negative"
    || value.result === "false_positive";
  if (needsReason && !value.reasonCode) {
    ctx.addIssue({ code: "custom", path: ["reasonCode"], message: "修改、拒绝、负面或误报结果必须选择原因" });
  }
  if (value.result !== "pending" && !value.evidenceRef) {
    ctx.addIssue({ code: "custom", path: ["evidenceRef"], message: "已形成结果时必须填写证据编号或链接" });
  }
  if (value.savedHours != null && Number(value.savedHours) < 0) {
    ctx.addIssue({ code: "custom", path: ["savedHours"], message: "节省工时不能为负数" });
  }
  const savedIntegerDigits = value.savedHours == null
    ? 0
    : value.savedHours.replace(/^-/, "").split(".")[0].replace(/^0+/, "").length;
  if (savedIntegerDigits > 10) {
    ctx.addIssue({ code: "custom", path: ["savedHours"], message: "节省工时超出可登记范围" });
  }
  const cashIntegerDigits = value.cashImpact == null
    ? 0
    : value.cashImpact.replace(/^-/, "").split(".")[0].replace(/^0+/, "").length;
  if (cashIntegerDigits > 16) {
    ctx.addIssue({ code: "custom", path: ["cashImpact"], message: "现金影响超出可登记范围" });
  }
  const parsed = new Date(`${value.businessDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.businessDate) {
    ctx.addIssue({ code: "custom", path: ["businessDate"], message: "业务日期无效" });
  } else if (value.businessDate > todayShanghai()) {
    ctx.addIssue({ code: "custom", path: ["businessDate"], message: "真实结果不能登记未来业务日期" });
  }
});

type OutcomeInput = z.infer<typeof inputSchema>;
type OutcomeRow = typeof schema.dataProductOutcomeEvents.$inferSelect;

function getProduct(productId: string): DataProductDefinition {
  const product = DATA_PRODUCTS.find((item) => item.id === productId);
  if (!product) throw new ApiError(404, "数据产品不存在或已下线");
  return product;
}

function isOwner(user: SessionUser, product: DataProductDefinition): boolean {
  return user.roles.includes("admin") || product.ownerRoles.some((role) => user.roles.includes(role));
}

function normalizeInput(value: OutcomeInput) {
  return {
    ...value,
    handlingMinutes: value.handlingMinutes ?? null,
    savedHours: value.savedHours == null ? null : dMoney(value.savedHours),
    cashImpact: value.cashImpact == null ? null : dMoney(value.cashImpact),
    currency: value.cashImpact == null ? null : "CNY" as const,
    reasonCode: value.reasonCode ?? null,
    evidenceRef: value.evidenceRef || null,
    supersedesId: value.supersedesId ?? null,
  };
}

function semanticallyMatches(
  row: OutcomeRow,
  value: ReturnType<typeof normalizeInput>,
  ignoreProtectedCash = false,
): boolean {
  return row.productId === value.productId
    && row.decisionRef === value.decisionRef
    && row.businessDate === value.businessDate
    && row.decision === value.decision
    && row.result === value.result
    && row.handlingMinutes === value.handlingMinutes
    && (row.savedHours == null ? null : dMoney(row.savedHours)) === value.savedHours
    && (ignoreProtectedCash || (
      (row.cashImpact == null ? null : dMoney(row.cashImpact)) === value.cashImpact
      && row.currency === value.currency
    ))
    && row.reasonCode === value.reasonCode
    && row.evidenceRef === value.evidenceRef
    && row.note === value.note
    && row.supersedesId === value.supersedesId;
}

function toDto(row: OutcomeRow, cashVisible: boolean, names: Map<number, string> = new Map()): DataProductOutcomeDto {
  return {
    id: row.id,
    productId: row.productId,
    contractVersion: row.contractVersion,
    releaseId: row.releaseId,
    sourceEvidenceDigest: row.sourceEvidenceDigest,
    decisionRef: row.decisionRef,
    businessDate: row.businessDate,
    decision: row.decision as DataProductOutcomeDecision,
    result: row.result as DataProductOutcomeResult,
    handlingMinutes: row.handlingMinutes,
    savedHours: row.savedHours == null ? null : dMoney(row.savedHours),
    cashImpact: cashVisible && row.cashImpact != null ? dMoney(row.cashImpact) : null,
    currency: cashVisible && row.currency === "CNY" ? "CNY" : null,
    cashVisible,
    reasonCode: row.reasonCode as DataProductOutcomeReason | null,
    evidenceRef: row.evidenceRef,
    note: row.note,
    supersedesId: row.supersedesId,
    recordedBy: row.recordedBy,
    recordedByName: names.get(row.recordedBy) ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

async function findByIdempotency(db: AnyDb, idempotencyKey: string): Promise<OutcomeRow | undefined> {
  const [row]: OutcomeRow[] = await db
    .select()
    .from(schema.dataProductOutcomeEvents)
    .where(eq(schema.dataProductOutcomeEvents.idempotencyKey, idempotencyKey))
    .limit(1);
  return row;
}

/**
 * 登记真实结果。dataSourcesArg 只为隔离数据库契约测试提供已构造的实时证据；HTTP 路径总是现场读取。
 */
export async function recordDataProductOutcome(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
  dataSourcesArg?: readonly DataSourceReadiness[],
): Promise<DataProductOutcomeDto> {
  const value = normalizeInput(inputSchema.parse(input));
  const product = getProduct(value.productId);
  requireAnyRole(user, ...product.ownerRoles);
  if (value.cashImpact != null && !canSeePrices(user.roles)) {
    throw new ApiError(403, "当前角色无权登记或查看现金影响");
  }
  const db = await resolveDb(dbArg);
  const cashVisible = canSeePrices(user.roles);
  const replay = await findByIdempotency(db, value.idempotencyKey);
  if (replay) {
    if (replay.recordedBy !== user.id || !semanticallyMatches(
      replay,
      value,
      !cashVisible && value.supersedesId != null,
    )) {
      throw new ApiError(409, "幂等键已用于另一条结果记录");
    }
    return toDto(replay, cashVisible);
  }

  return db.transaction(async (tx: AnyDb) => {
    let binding: Pick<OutcomeRow, "contractVersion" | "releaseId" | "sourceEvidenceDigest">;
    if (value.supersedesId != null) {
      const [previous]: OutcomeRow[] = await tx
        .select()
        .from(schema.dataProductOutcomeEvents)
        .where(eq(schema.dataProductOutcomeEvents.id, value.supersedesId))
        .limit(1)
        .for("update");
      if (!previous) throw new ApiError(404, "待纠正的结果记录不存在");
      if (previous.productId !== product.id || previous.decisionRef !== value.decisionRef) {
        throw new ApiError(409, "纠正记录必须保持原数据产品和决策编号");
      }
      // 无金额权限的责任人看不到原值，也不得借“纠正”把受保护金额静默清空。
      if (!cashVisible) {
        value.cashImpact = previous.cashImpact == null ? null : dMoney(previous.cashImpact);
        value.currency = previous.currency === "CNY" ? "CNY" : null;
      }
      binding = {
        contractVersion: previous.contractVersion,
        releaseId: previous.releaseId,
        sourceEvidenceDigest: previous.sourceEvidenceDigest,
      };
      const [child] = await tx
        .select({ id: schema.dataProductOutcomeEvents.id })
        .from(schema.dataProductOutcomeEvents)
        .where(eq(schema.dataProductOutcomeEvents.supersedesId, value.supersedesId))
        .limit(1);
      if (child) throw new ApiError(409, "该记录已经被纠正；请刷新后纠正最新版本");
    } else {
      const dataSources = dataSourcesArg ?? await loadDataSourceReadiness(tx);
      const readiness = (await loadDataProductReleaseReadiness(dataSources, user, tx))
        .find((item) => item.productId === product.id);
      if (!readiness?.activeRelease || !readiness.activeReleaseCurrent) {
        throw new ApiError(409, "该数据产品尚无当前有效的 A2/A3 放行，不能把观察信号登记为正式结果");
      }
      const [lockedRelease] = await tx
        .select({
          id: schema.dataProductReleases.id,
          productId: schema.dataProductReleases.productId,
          contractVersion: schema.dataProductReleases.contractVersion,
          sourceEvidenceDigest: schema.dataProductReleases.sourceEvidenceDigest,
          status: schema.dataProductReleases.status,
          decidedAt: schema.dataProductReleases.decidedAt,
        })
        .from(schema.dataProductReleases)
        .where(eq(schema.dataProductReleases.id, readiness.activeRelease.id))
        .limit(1)
        .for("update");
      if (
        !lockedRelease
        || lockedRelease.status !== "approved"
        || lockedRelease.productId !== product.id
        || lockedRelease.contractVersion !== readiness.activeRelease.contractVersion
        || lockedRelease.sourceEvidenceDigest !== readiness.activeRelease.sourceEvidenceDigest
        || lockedRelease.decidedAt == null
      ) {
        throw new ApiError(409, "产品放行已变化，请刷新后重试");
      }
      const releaseBusinessDate = shanghaiDayOf(new Date(lockedRelease.decidedAt));
      if (value.businessDate < releaseBusinessDate) {
        throw new ApiError(409, `真实结果业务日不能早于产品放行日 ${releaseBusinessDate}`);
      }
      binding = {
        contractVersion: lockedRelease.contractVersion,
        releaseId: lockedRelease.id,
        sourceEvidenceDigest: lockedRelease.sourceEvidenceDigest,
      };
      const [root] = await tx
        .select({ id: schema.dataProductOutcomeEvents.id })
        .from(schema.dataProductOutcomeEvents)
        .where(and(
          eq(schema.dataProductOutcomeEvents.productId, product.id),
          eq(schema.dataProductOutcomeEvents.decisionRef, value.decisionRef),
        ))
        .limit(1);
      if (root) throw new ApiError(409, "该数据产品的决策编号已登记；请使用纠正功能保留历史链");
    }
    const [created]: OutcomeRow[] = await tx
      .insert(schema.dataProductOutcomeEvents)
      .values({
        ...binding,
        productId: product.id,
        decisionRef: value.decisionRef,
        businessDate: value.businessDate,
        decision: value.decision,
        result: value.result,
        handlingMinutes: value.handlingMinutes,
        savedHours: value.savedHours,
        cashImpact: value.cashImpact,
        currency: value.currency,
        reasonCode: value.reasonCode,
        evidenceRef: value.evidenceRef,
        note: value.note,
        supersedesId: value.supersedesId,
        idempotencyKey: value.idempotencyKey,
        recordedBy: user.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const concurrent = await findByIdempotency(tx, value.idempotencyKey);
      if (concurrent && concurrent.recordedBy === user.id && semanticallyMatches(concurrent, value)) {
        return toDto(concurrent, cashVisible);
      }
      throw new ApiError(409, "结果记录已由其他操作占用，请刷新后重试");
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "data_product_outcome",
      entityId: created.id,
      action: value.supersedesId == null ? "record" : "correct",
      after: {
        productId: created.productId,
        contractVersion: created.contractVersion,
        releaseId: created.releaseId,
        sourceEvidenceDigest: created.sourceEvidenceDigest,
        decisionRef: created.decisionRef,
        businessDate: created.businessDate,
        decision: created.decision,
        result: created.result,
        handlingMinutes: created.handlingMinutes,
        savedHours: created.savedHours,
        cashImpact: created.cashImpact,
        currency: created.currency,
        reasonCode: created.reasonCode,
        evidenceRef: created.evidenceRef,
        supersedesId: created.supersedesId,
      },
    });
    return toDto(created, cashVisible);
  });
}

function sumDecimal(values: Array<string | null>, scale: number): string | null {
  const present = values.filter((value): value is string => value != null);
  if (present.length === 0) return null;
  return present.reduce((total, value) => dAdd(total, value, scale), "0");
}

export async function loadDataProductOutcomeReadiness(
  releases: readonly DataProductReleaseReadiness[],
  user?: SessionUser,
  dbArg?: AnyDb,
): Promise<DataProductOutcomeReadiness[]> {
  const db = await resolveDb(dbArg);
  const rows: OutcomeRow[] = await db
    .select()
    .from(schema.dataProductOutcomeEvents)
    .orderBy(desc(schema.dataProductOutcomeEvents.createdAt), desc(schema.dataProductOutcomeEvents.id));
  const superseded = new Set(rows.map((row) => row.supersedesId).filter((id): id is number => id != null));
  const leafRows = rows.filter((row) => !superseded.has(row.id));
  const userIds = [...new Set(leafRows.map((row) => row.recordedBy))];
  const people: Array<{ id: number; name: string }> = userIds.length > 0
    ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const names = new Map(people.map((person) => [person.id, person.name]));
  const cashVisible = user ? canSeePrices(user.roles) : false;

  return DATA_PRODUCTS.map((product) => {
    const productRows = leafRows.filter((row) => row.productId === product.id);
    const evaluated = productRows.filter((row) => row.decision !== "deferred");
    const adopted = evaluated.filter((row) => row.decision === "accepted" || row.decision === "modified");
    const terminal = productRows.filter((row) => row.result !== "pending");
    const falsePositive = terminal.filter((row) => row.result === "false_positive");
    const handled = productRows.filter((row) => row.handlingMinutes != null);
    const release = releases.find((item) => item.productId === product.id);
    const canRecord = user != null && isOwner(user, product) && release?.activeReleaseCurrent === true;
    return {
      productId: product.id,
      canRecord,
      canCorrect: user != null && isOwner(user, product),
      gate: canRecord
        ? "可登记真实业务结果；该反馈不会自动升级自动化等级或写回正式单据。"
        : "需由产品责任角色在当前有效 A2/A3 放行下登记；历史记录如有错误，责任人仍可追加纠正且不会覆盖原记录。",
      cashVisible,
      outcomeCount: productRows.length,
      evaluatedDecisionCount: evaluated.length,
      adoptedCount: adopted.length,
      pendingCount: productRows.filter((row) => row.result === "pending").length,
      terminalResultCount: terminal.length,
      falsePositiveCount: falsePositive.length,
      adoptionRatePct: evaluated.length === 0 ? null : dMul(dDiv(adopted.length, evaluated.length, 6), 100, 1),
      falsePositiveRatePct: terminal.length === 0 ? null : dMul(dDiv(falsePositive.length, terminal.length, 6), 100, 1),
      avgHandlingMinutes: handled.length === 0
        ? null
        : dDiv(handled.reduce((total, row) => total + (row.handlingMinutes ?? 0), 0), handled.length, 1),
      savedHoursTotal: sumDecimal(productRows.map((row) => row.savedHours), 2),
      cashImpactTotal: cashVisible ? sumDecimal(productRows.map((row) => row.cashImpact), 2) : null,
      latest: productRows.slice(0, 5).map((row) => toDto(row, cashVisible, names)),
    };
  });
}
