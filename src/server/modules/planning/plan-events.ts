/**
 * 运营计划事件（ops_plan_events）CRUD：大促 / 上新 / 下架 / 换链接 / 调价 / 其他。
 *
 * 纪律（D55/D43）：事件只作**上下文展示**与情景推演的人工预填，绝不自动改建议量、不开单。
 * 写路径 ops/pmc（admin 兜底），同事务 writeAudit(entity=ops_plan_event)；删除为物理删除但留审计（事件不是账）。
 * 渠道范围（D62）：受限用户只能读/写自己范围内渠道的事件；不分渠道（channel_id 空）的事件全员可见，
 * 因此受限用户（channelScope 非空且非 admin）新建/改写时 channelId 必填且须在范围内，否则 403。
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { resolveChannelScope } from "@/server/core/data-scope";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";

export const PLAN_EVENT_KINDS = ["promo", "launch", "delist", "relink", "price", "other"] as const;
export type PlanEventKind = (typeof PLAN_EVENT_KINDS)[number];
export const PLAN_EVENT_KIND_LABELS: Record<PlanEventKind, string> = {
  promo: "大促",
  launch: "上新",
  delist: "下架",
  relink: "换链接",
  price: "调价",
  other: "其他",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const baseSchema = z.object({
  skuId: z.number().int().positive().nullable().optional(),
  spuId: z.number().int().positive().nullable().optional(),
  channelId: z.number().int().positive().nullable().optional(),
  kind: z.enum(PLAN_EVENT_KINDS),
  startDate: z.string().regex(DATE_RE, "日期格式须为 YYYY-MM-DD"),
  endDate: z.string().regex(DATE_RE, "日期格式须为 YYYY-MM-DD").nullable().optional(),
  expectedUpliftPct: z.number().int().min(-100).max(1000).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
export type PlanEventInput = z.infer<typeof baseSchema>;

export interface PlanEventRow {
  id: number;
  skuId: number | null;
  skuCode: string | null;
  skuName: string | null;
  spuId: number | null;
  spuCode: string | null;
  channelId: number | null;
  channelName: string | null;
  kind: PlanEventKind;
  kindLabel: string;
  startDate: string;
  endDate: string | null;
  expectedUpliftPct: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  /** 相对今天：upcoming / active / past */
  phase: "upcoming" | "active" | "past";
}

export function phaseOf(startDate: string, endDate: string | null, today: string): PlanEventRow["phase"] {
  if (startDate > today) return "upcoming";
  if (endDate != null && endDate < today) return "past";
  return "active";
}

/** 行标签文案：「大促 9/15–9/30」 */
export function planEventTag(e: Pick<PlanEventRow, "kindLabel" | "startDate" | "endDate">): string {
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${e.kindLabel} ${md(e.startDate)}${e.endDate ? `–${md(e.endDate)}` : "起"}`;
}

async function validateTargets(db: AnyDb, v: PlanEventInput): Promise<void> {
  if (v.skuId == null && v.spuId == null) throw new ApiError(400, "SKU 或 SPU 至少填一个");
  if (v.endDate != null && v.endDate < v.startDate) throw new ApiError(400, "结束日期不得早于开始日期");
  if (v.skuId != null) {
    const [s] = await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.id, v.skuId));
    if (!s) throw new ApiError(404, "SKU 不存在");
  }
  if (v.spuId != null) {
    const [s] = await db.select({ id: schema.spus.id }).from(schema.spus).where(eq(schema.spus.id, v.spuId));
    if (!s) throw new ApiError(404, "SPU 不存在");
  }
  if (v.channelId != null) {
    const [c] = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.id, v.channelId));
    if (!c) throw new ApiError(404, "渠道不存在");
  }
}

function assertChannelWritable(user: SessionUser, channelId: number | null | undefined): void {
  // 既有事件：受限用户对范围外渠道 → resolveChannelScope 抛 403；不分渠道事件任何角色可改/删
  if (channelId == null) return;
  resolveChannelScope(user, channelId);
}

/**
 * 新建/改写后的目标渠道：受限渠道用户（channelScope 非空且非 admin）必须指定范围内渠道——
 * 不分渠道事件对全渠道可见，受限用户不得借此越过范围；不受限用户可建不分渠道事件。
 */
function requireChannelInScope(user: SessionUser, channelId: number | null | undefined): void {
  const scope = resolveChannelScope(user, null);
  if (scope.forced && channelId == null) {
    throw new ApiError(403, "受限渠道用户必须指定本人范围内的渠道，不得创建不分渠道的计划事件");
  }
  assertChannelWritable(user, channelId);
}

export async function createPlanEvent(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<{ id: number }> {
  requireAnyRole(user, "ops", "pmc");
  const v = baseSchema.parse(input);
  const db = await resolveDb(dbArg);
  await validateTargets(db, v);
  requireChannelInScope(user, v.channelId);
  return db.transaction(async (tx: AnyDb) => {
    const [row] = await tx
      .insert(schema.opsPlanEvents)
      .values({
        skuId: v.skuId ?? null,
        spuId: v.spuId ?? null,
        channelId: v.channelId ?? null,
        kind: v.kind,
        startDate: v.startDate,
        endDate: v.endDate ?? null,
        expectedUpliftPct: v.expectedUpliftPct ?? null,
        note: v.note?.trim() ? v.note.trim() : null,
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, { userId: user.id, entity: "ops_plan_event", entityId: row.id, action: "create", after: row });
    return { id: row.id };
  });
}

export async function updatePlanEvent(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<{ id: number }> {
  requireAnyRole(user, "ops", "pmc");
  const patch = baseSchema.partial().parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [before] = await tx.select().from(schema.opsPlanEvents).where(eq(schema.opsPlanEvents.id, id));
    if (!before) throw new ApiError(404, "计划事件不存在");
    assertChannelWritable(user, before.channelId);
    const merged: PlanEventInput = {
      skuId: patch.skuId !== undefined ? patch.skuId : before.skuId,
      spuId: patch.spuId !== undefined ? patch.spuId : before.spuId,
      channelId: patch.channelId !== undefined ? patch.channelId : before.channelId,
      kind: patch.kind ?? (before.kind as PlanEventKind),
      startDate: patch.startDate ?? before.startDate,
      endDate: patch.endDate !== undefined ? patch.endDate : before.endDate,
      expectedUpliftPct: patch.expectedUpliftPct !== undefined ? patch.expectedUpliftPct : before.expectedUpliftPct,
      note: patch.note !== undefined ? patch.note : before.note,
    };
    await validateTargets(tx, merged);
    requireChannelInScope(user, merged.channelId); // 受限用户不得把事件改成不分渠道/范围外
    const [after] = await tx
      .update(schema.opsPlanEvents)
      .set({
        skuId: merged.skuId ?? null,
        spuId: merged.spuId ?? null,
        channelId: merged.channelId ?? null,
        kind: merged.kind,
        startDate: merged.startDate,
        endDate: merged.endDate ?? null,
        expectedUpliftPct: merged.expectedUpliftPct ?? null,
        note: merged.note?.trim() ? merged.note.trim() : null,
      })
      .where(eq(schema.opsPlanEvents.id, id))
      .returning();
    await writeAudit(tx, { userId: user.id, entity: "ops_plan_event", entityId: id, action: "update", before, after });
    return { id };
  });
}

export async function deletePlanEvent(user: SessionUser, id: number, dbArg?: AnyDb): Promise<{ id: number }> {
  requireAnyRole(user, "ops", "pmc");
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [before] = await tx.select().from(schema.opsPlanEvents).where(eq(schema.opsPlanEvents.id, id));
    if (!before) throw new ApiError(404, "计划事件不存在");
    assertChannelWritable(user, before.channelId);
    await tx.delete(schema.opsPlanEvents).where(eq(schema.opsPlanEvents.id, id));
    await writeAudit(tx, { userId: user.id, entity: "ops_plan_event", entityId: id, action: "delete", before });
    return { id };
  });
}

export interface PlanEventQuery {
  skuId?: number;
  spuId?: number;
  channelId?: number | null;
  kind?: string;
  /** 只看未结束（active + upcoming），默认 true */
  openOnly?: boolean;
  /** 时间窗（含）：与事件区间有交集 */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function listPlanEvents(
  user: Pick<SessionUser, "roles" | "channelScope">,
  query: PlanEventQuery,
  dbArg?: AnyDb,
): Promise<{ rows: PlanEventRow[]; total: number; today: string }> {
  const db = await resolveDb(dbArg);
  const t = schema.opsPlanEvents;
  const today = todayShanghai();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const scope = resolveChannelScope(user, query.channelId ?? null);
  const conds = [];
  if (query.skuId != null) conds.push(eq(t.skuId, query.skuId));
  if (query.spuId != null) conds.push(eq(t.spuId, query.spuId));
  if (query.kind && (PLAN_EVENT_KINDS as readonly string[]).includes(query.kind)) conds.push(eq(t.kind, query.kind));
  if (query.openOnly ?? true) conds.push(or(isNull(t.endDate), gte(t.endDate, today)));
  if (query.from) conds.push(or(isNull(t.endDate), gte(t.endDate, query.from)));
  if (query.to) conds.push(lte(t.startDate, query.to));
  if (scope.channelIds !== null) {
    // 受限用户：范围内渠道 + 不分渠道事件；请求了具体渠道时只看该渠道
    conds.push(query.channelId != null ? eq(t.channelId, query.channelId) : or(isNull(t.channelId), inArray(t.channelId, scope.channelIds)));
  } else if (query.channelId != null) {
    conds.push(eq(t.channelId, query.channelId));
  }
  const where = conds.length ? and(...conds) : undefined;
  const [cnt]: { n: number }[] = await db.select({ n: sql<number>`count(*)::int` }).from(t).where(where);
  const raw: {
    id: number; skuId: number | null; skuCode: string | null; skuName: string | null; spuId: number | null; spuCode: string | null;
    channelId: number | null; channelName: string | null; kind: string; startDate: string; endDate: string | null;
    expectedUpliftPct: number | null; note: string | null; createdBy: string | null; createdAt: Date;
  }[] = await db
    .select({
      id: t.id, skuId: t.skuId, skuCode: schema.skus.code, skuName: schema.skus.name, spuId: t.spuId, spuCode: schema.spus.code,
      channelId: t.channelId, channelName: schema.channels.name, kind: t.kind, startDate: t.startDate, endDate: t.endDate,
      expectedUpliftPct: t.expectedUpliftPct, note: t.note, createdBy: schema.users.name, createdAt: t.createdAt,
    })
    .from(t)
    .leftJoin(schema.skus, eq(t.skuId, schema.skus.id))
    .leftJoin(schema.spus, eq(t.spuId, schema.spus.id))
    .leftJoin(schema.channels, eq(t.channelId, schema.channels.id))
    .leftJoin(schema.users, eq(t.createdBy, schema.users.id))
    .where(where)
    .orderBy(asc(t.startDate), desc(t.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const rows: PlanEventRow[] = raw.map((r) => {
    const kind = r.kind as PlanEventKind;
    return {
      ...r,
      kind,
      kindLabel: PLAN_EVENT_KIND_LABELS[kind],
      createdAt: r.createdAt.toISOString(),
      phase: phaseOf(r.startDate, r.endDate, today),
    };
  });
  return { rows, total: cnt?.n ?? rows.length, today };
}

/** 供补货建议行：skuId → 未结束事件（含即将开始）；不分渠道与范围内渠道 */
export async function loadOpenPlanEventsBySku(
  db: AnyDb,
  skuIds: number[],
  user?: Pick<SessionUser, "roles" | "channelScope">,
): Promise<Map<number, PlanEventRow[]>> {
  const out = new Map<number, PlanEventRow[]>();
  if (skuIds.length === 0) return out;
  const t = schema.opsPlanEvents;
  const today = todayShanghai();
  const scope = user ? resolveChannelScope(user, null) : { channelIds: null };
  const conds = [inArray(t.skuId, skuIds), or(isNull(t.endDate), gte(t.endDate, today))];
  if (scope.channelIds !== null) conds.push(or(isNull(t.channelId), inArray(t.channelId, scope.channelIds)));
  const raw: { id: number; skuId: number | null; channelId: number | null; channelName: string | null; kind: string; startDate: string; endDate: string | null; expectedUpliftPct: number | null; note: string | null }[] = await db
    .select({
      id: t.id, skuId: t.skuId, channelId: t.channelId, channelName: schema.channels.name, kind: t.kind,
      startDate: t.startDate, endDate: t.endDate, expectedUpliftPct: t.expectedUpliftPct, note: t.note,
    })
    .from(t)
    .leftJoin(schema.channels, eq(t.channelId, schema.channels.id))
    .where(and(...conds))
    .orderBy(asc(t.startDate));
  for (const r of raw) {
    if (r.skuId == null) continue;
    const kind = r.kind as PlanEventKind;
    const row: PlanEventRow = {
      id: r.id, skuId: r.skuId, skuCode: null, skuName: null, spuId: null, spuCode: null,
      channelId: r.channelId, channelName: r.channelName, kind, kindLabel: PLAN_EVENT_KIND_LABELS[kind],
      startDate: r.startDate, endDate: r.endDate, expectedUpliftPct: r.expectedUpliftPct, note: r.note,
      createdBy: null, createdAt: "", phase: phaseOf(r.startDate, r.endDate, today),
    };
    const arr = out.get(r.skuId) ?? [];
    arr.push(row);
    out.set(r.skuId, arr);
  }
  return out;
}
