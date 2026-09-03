/**
 * D65 数据质量周/月核对（data_quality_reviews）写路径。
 *
 * - generateReviewPack：按周期 × 三类来源生成 pending 行（UNIQUE 幂等：已存在不重复）；evidence 固化生成时的
 *   数据质量读模型切片（准确率/及时性/完整性/覆盖），只读证据不回算。有操作人时同事务 writeAudit；
 *   由定时任务生成（无操作人）时 evidence.generatedBy='job'，不写审计（系统无伪用户，与 snapshot-age 同型）。
 * - closeReview：完成 / 豁免（豁免必须写原因）；只允许 pending → completed|waived；同事务 writeAudit(entity=data_quality_review)。
 * - resolveCadence：连续 4 周完成且达标 → 月核对（rules 在 dq/periods.decideCadence）。
 * 写守卫：角色 pmc / finance / warehouse（admin 兜底），非法角色 ApiError 403。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { REVIEWED_SOURCE_CLASSES, SOURCE_CLASS_DEFS, type ReviewedSourceClass } from "@/server/core/data-source-class";
import { ROLE_LABELS } from "@/server/core/constants";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { computeDataQuality, type DataQualityReport, type DqSourceRow } from "@/server/modules/report/data-quality";
import {
  decideCadence, MONTH_KEY_RE, periodRange, previousPeriodKey, reviewPeriodKeyFor, type ReviewPeriodKind, todayShanghai, WEEK_KEY_RE,
} from "./periods";

export const DQ_REVIEW_ROLES = ["pmc", "finance", "warehouse"] as const;
export type DqReviewStatus = "pending" | "completed" | "waived";

export interface DqReviewEvidence {
  generatedAt: string;
  generatedBy: "user" | "job";
  today: string;
  range: { from: string; through: string };
  sourceClass: ReviewedSourceClass;
  targetAccuracyPct: number | null;
  accuracy: DqSourceRow["accuracy"];
  timeliness: DqSourceRow["timeliness"];
  completeness: DqSourceRow["completeness"];
  coverage: DqSourceRow["coverage"];
  manualOverrides: DataQualityReport["manualOverrides"];
  snapshotJumpAlerts: number;
}

export interface DqReviewRow {
  id: number;
  periodKind: ReviewPeriodKind;
  periodKey: string;
  sourceClass: ReviewedSourceClass;
  sourceLabel: string;
  status: DqReviewStatus;
  evidence: DqReviewEvidence | null;
  note: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

function guardReviewer(user: SessionUser): void {
  if (user.roles.includes("admin")) return;
  if (DQ_REVIEW_ROLES.some((r) => user.roles.includes(r))) return;
  const labels = DQ_REVIEW_ROLES.map((r) => ROLE_LABELS[r] ?? r);
  throw new ApiError(403, `无权限执行此操作：需要${labels.join("/")}角色`);
}

const periodKindSchema = z.enum(["week", "month"]);

export function assertPeriodKey(kind: ReviewPeriodKind, key: string): void {
  const ok = kind === "week" ? WEEK_KEY_RE.test(key) : MONTH_KEY_RE.test(key);
  if (!ok) throw new ApiError(400, kind === "week" ? `周键格式须为 YYYY-Www：${key}` : `月键格式须为 YYYY-MM：${key}`);
}

function toRow(r: typeof schema.dataQualityReviews.$inferSelect, reviewerName: string | null): DqReviewRow {
  const cls = r.sourceClass as ReviewedSourceClass;
  return {
    id: r.id,
    periodKind: r.periodKind as ReviewPeriodKind,
    periodKey: r.periodKey,
    sourceClass: cls,
    sourceLabel: SOURCE_CLASS_DEFS[cls]?.label ?? r.sourceClass,
    status: r.status as DqReviewStatus,
    evidence: (r.evidence as DqReviewEvidence | null) ?? null,
    note: r.note,
    reviewedBy: r.reviewedBy,
    reviewedByName: reviewerName,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export interface GenerateReviewPackInput {
  periodKind: ReviewPeriodKind;
  periodKey: string;
  sourceClasses?: ReviewedSourceClass[];
  /** 操作人（API 触发）；定时任务传 null */
  actorId?: number | null;
  today?: string;
  /** 测试注入：跳过读模型重算 */
  report?: DataQualityReport;
}

export interface GenerateReviewPackResult {
  periodKind: ReviewPeriodKind;
  periodKey: string;
  created: number;
  existing: number;
  rows: DqReviewRow[];
}

export async function generateReviewPack(dbArg: AnyDb, input: GenerateReviewPackInput): Promise<GenerateReviewPackResult> {
  const db = await resolveDb(dbArg);
  const periodKind = periodKindSchema.parse(input.periodKind);
  assertPeriodKey(periodKind, input.periodKey);
  const classes = input.sourceClasses?.length ? input.sourceClasses : [...REVIEWED_SOURCE_CLASSES];
  for (const cls of classes) {
    if (!REVIEWED_SOURCE_CLASSES.includes(cls)) throw new ApiError(400, `不核对的来源类：${cls}`);
  }
  const today = input.today ?? todayShanghai();
  const report = input.report ?? await computeDataQuality(db, { today });
  const range = periodRange(periodKind, input.periodKey);
  const generatedAt = new Date().toISOString();

  let created = 0;
  await db.transaction(async (tx: AnyDb) => {
    for (const cls of classes) {
      const src = report.sources.find((s) => s.sourceClass === cls);
      if (!src) continue;
      const evidence: DqReviewEvidence = {
        generatedAt,
        generatedBy: input.actorId ? "user" : "job",
        today,
        range,
        sourceClass: cls,
        targetAccuracyPct: SOURCE_CLASS_DEFS[cls].targetAccuracyPct,
        accuracy: src.accuracy,
        timeliness: src.timeliness,
        completeness: src.completeness,
        coverage: src.coverage,
        manualOverrides: report.manualOverrides,
        snapshotJumpAlerts: report.snapshotQuality.alerts,
      };
      const inserted: { id: number }[] = await tx
        .insert(schema.dataQualityReviews)
        .values({ periodKind, periodKey: input.periodKey, sourceClass: cls, status: "pending", evidence })
        .onConflictDoNothing({
          target: [schema.dataQualityReviews.periodKind, schema.dataQualityReviews.periodKey, schema.dataQualityReviews.sourceClass],
        })
        .returning({ id: schema.dataQualityReviews.id });
      if (inserted.length === 0) continue;
      created += 1;
      if (input.actorId) {
        await writeAudit(tx, {
          userId: input.actorId,
          entity: "data_quality_review",
          entityId: inserted[0].id,
          action: "create",
          after: { periodKind, periodKey: input.periodKey, sourceClass: cls, accuracy: src.accuracy },
        });
      }
    }
  });
  const rows = await listReviews(db, { periodKind, periodKey: input.periodKey, page: 1, pageSize: 50 });
  return { periodKind, periodKey: input.periodKey, created, existing: classes.length - created, rows: rows.data };
}

/** API 入口：操作人触发生成（角色守卫 + 审计） */
export async function generateReviewPackAs(
  actor: SessionUser,
  input: { periodKind?: ReviewPeriodKind; periodKey?: string },
  dbArg?: AnyDb,
): Promise<GenerateReviewPackResult> {
  guardReviewer(actor);
  const db = await resolveDb(dbArg);
  const today = todayShanghai();
  const periodKind = input.periodKind ? periodKindSchema.parse(input.periodKind) : (await resolveCadence(db, today)).cadence;
  const periodKey = input.periodKey ?? reviewPeriodKeyFor(periodKind, today);
  return generateReviewPack(db, { periodKind, periodKey, actorId: actor.id, today });
}

const closeSchema = z.object({
  status: z.enum(["completed", "waived"]),
  note: z.string().trim().max(500).optional(),
});

export async function closeReview(
  actor: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<DqReviewRow> {
  guardReviewer(actor);
  const parsed = closeSchema.parse(input);
  if (parsed.status === "waived" && !parsed.note) throw new ApiError(400, "豁免必须填写原因");
  const db = await resolveDb(dbArg);
  const updated = await db.transaction(async (tx: AnyDb) => {
    const [row]: (typeof schema.dataQualityReviews.$inferSelect)[] = await tx
      .select().from(schema.dataQualityReviews).where(eq(schema.dataQualityReviews.id, id));
    if (!row) throw new ApiError(404, "核对记录不存在");
    if (row.status !== "pending") throw new ApiError(409, `核对记录已${row.status === "completed" ? "完成" : "豁免"}，不可重复处理`);
    const now = new Date();
    const [next]: (typeof schema.dataQualityReviews.$inferSelect)[] = await tx
      .update(schema.dataQualityReviews)
      .set({ status: parsed.status, note: parsed.note ?? null, reviewedBy: actor.id, reviewedAt: now })
      .where(and(eq(schema.dataQualityReviews.id, id), eq(schema.dataQualityReviews.status, "pending")))
      .returning();
    if (!next) throw new ApiError(409, "核对记录已被他人处理");
    await writeAudit(tx, {
      userId: actor.id,
      entity: "data_quality_review",
      entityId: id,
      action: parsed.status === "completed" ? "complete" : "waive",
      before: { status: row.status },
      after: { status: next.status, note: next.note, periodKind: next.periodKind, periodKey: next.periodKey, sourceClass: next.sourceClass },
    });
    return next;
  });
  return toRow(updated, actor.name);
}

export interface ListReviewsQuery {
  periodKind?: ReviewPeriodKind;
  periodKey?: string;
  status?: DqReviewStatus;
  sourceClass?: ReviewedSourceClass;
  page?: number;
  pageSize?: number;
}

export async function listReviews(dbArg: AnyDb, q: ListReviewsQuery): Promise<{ data: DqReviewRow[]; total: number; page: number; pageSize: number }> {
  const db = await resolveDb(dbArg);
  const page = Math.max(1, Math.trunc(q.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(q.pageSize ?? 20)));
  const conds = [];
  if (q.periodKind) conds.push(eq(schema.dataQualityReviews.periodKind, q.periodKind));
  if (q.periodKey) conds.push(eq(schema.dataQualityReviews.periodKey, q.periodKey));
  if (q.status) conds.push(eq(schema.dataQualityReviews.status, q.status));
  if (q.sourceClass) conds.push(eq(schema.dataQualityReviews.sourceClass, q.sourceClass));
  const where = conds.length ? and(...conds) : undefined;
  const [{ n }]: { n: number }[] = await db
    .select({ n: sql<number>`count(*)::int` }).from(schema.dataQualityReviews).where(where);
  const rows: { r: typeof schema.dataQualityReviews.$inferSelect; reviewerName: string | null }[] = await db
    .select({ r: schema.dataQualityReviews, reviewerName: schema.users.name })
    .from(schema.dataQualityReviews)
    .leftJoin(schema.users, eq(schema.users.id, schema.dataQualityReviews.reviewedBy))
    .where(where)
    .orderBy(desc(schema.dataQualityReviews.periodKey), schema.dataQualityReviews.sourceClass)
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { data: rows.map((x) => toRow(x.r, x.reviewerName)), total: Number(n), page, pageSize };
}

export async function pendingReviewCount(dbArg: AnyDb): Promise<number> {
  const db = await resolveDb(dbArg);
  const [{ n }]: { n: number }[] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.dataQualityReviews)
    .where(eq(schema.dataQualityReviews.status, "pending"));
  return Number(n);
}

/** 某周期是否「完成且达标」：三类全部 completed 且各自准确率 ≥ 目标（无目标类只看 completed） */
export function periodMet(rows: { sourceClass: string; status: string; evidence: unknown }[]): boolean {
  const byClass = new Map(rows.map((r) => [r.sourceClass, r]));
  for (const cls of REVIEWED_SOURCE_CLASSES) {
    const r = byClass.get(cls);
    if (!r || r.status !== "completed") return false;
    const target = SOURCE_CLASS_DEFS[cls].targetAccuracyPct;
    const rate = (r.evidence as Partial<DqReviewEvidence> | null)?.accuracy?.rate ?? null;
    if (target != null && (rate == null || rate < target)) return false;
  }
  return true;
}

/** D65 节奏：最近 4 个连续 ISO 周（不含本周）全部完成且达标 → 月核对 */
export async function resolveCadence(
  dbArg: AnyDb,
  today: string = todayShanghai(),
  requiredStreak = 4,
): Promise<{ cadence: ReviewPeriodKind; streak: number; reason: string; periodKey: string }> {
  const db = await resolveDb(dbArg);
  const keys: string[] = [];
  let key = reviewPeriodKeyFor("week", today);
  for (let i = 0; i < requiredStreak; i += 1) {
    keys.push(key);
    key = previousPeriodKey("week", key);
  }
  const rows: { periodKey: string; sourceClass: string; status: string; evidence: unknown }[] = await db
    .select({
      periodKey: schema.dataQualityReviews.periodKey,
      sourceClass: schema.dataQualityReviews.sourceClass,
      status: schema.dataQualityReviews.status,
      evidence: schema.dataQualityReviews.evidence,
    })
    .from(schema.dataQualityReviews)
    .where(eq(schema.dataQualityReviews.periodKind, "week"));
  const history = keys.map((k) => ({ periodKey: k, met: periodMet(rows.filter((r) => r.periodKey === k)) }));
  const decision = decideCadence(history, requiredStreak);
  return { ...decision, periodKey: reviewPeriodKeyFor(decision.cadence, today) };
}
