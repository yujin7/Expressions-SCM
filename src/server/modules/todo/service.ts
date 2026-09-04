/**
 * D61 待办工作项（work_items）写路径 + 三视角列表。
 *
 * 纪律：
 *  - 每个写操作都在同一事务内 writeAudit(entity="work_item")；
 *  - 指纹去重：source_kind + source_ref（alert/review 来源）——
 *      · 已有 open/in_progress 同指纹 → 直接返回既有项（不新建）；
 *      · 7 天内 done/cancelled 的同指纹再触发 → reopen（审计 action=reopen）而不是再建一条；
 *  - 结构性防刷：创建后 <10 分钟即关闭 → 审计 after.suspicious=true，stats 侧按 completedAt−createdAt 派生同一口径；
 *  - 通知：定向站内 + 飞书私聊（dedupeKey task:{id}:{event}[:feishu]）；
 *      告警来源的待办不再飞书私聊（告警已由 system-alert-notify 群发，避免双发），只发站内定向。
 */
import { and, desc, eq, getTableColumns, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { users, workItems } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { ROLES, type Role } from "@/server/core/constants";
import { resolveDeptScope } from "@/server/core/data-scope";
import type { SessionUser } from "@/server/core/dto";
import { enqueueNotification, isFeishuAppConfigured } from "@/jobs/notify";
import { ApiError } from "@/server/modules/master/common";
import type { AnyDb } from "@/server/core/svc";
import { fingerprintOf, type TodoCandidate } from "@/server/rules/task-triggers";

export const WORK_ITEM_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export const WORK_ITEM_PRIORITIES = ["low", "normal", "high"] as const;
export const WORK_ITEM_SOURCE_KINDS = ["alert", "manual", "review"] as const;
export type WorkItemSourceKind = (typeof WORK_ITEM_SOURCE_KINDS)[number];

/** 创建后不足 N 分钟即关闭 → suspicious（D61 结构性防刷；stats 同口径派生） */
export const SUSPICIOUS_CLOSE_MINUTES = 10;
/** 同指纹在 N 天内再次触发 → reopen 而非新建 */
export const REOPEN_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const workItemCreateSchema = z.object({
  title: z.string().trim().min(1, "标题必填").max(200),
  detail: z.preprocess(emptyToUndef, z.string().trim().max(2000).nullable().optional()),
  assigneeId: z.number().int().positive({ message: "必须指定责任人" }),
  ownerRole: z.preprocess(emptyToUndef, z.enum(ROLES).nullable().optional()),
  priority: z.enum(WORK_ITEM_PRIORITIES).optional().default("normal"),
  dueDate: z.preprocess(emptyToUndef, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "截止日期格式 YYYY-MM-DD").nullable().optional()),
  sourceKind: z.enum(WORK_ITEM_SOURCE_KINDS).optional().default("manual"),
  sourceRef: z.preprocess(emptyToUndef, z.string().trim().max(200).nullable().optional()),
});
export type WorkItemCreateInput = z.input<typeof workItemCreateSchema>;

export const workItemPatchSchema = z.object({
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  assigneeId: z.number().int().positive().optional(),
  note: z.preprocess(emptyToUndef, z.string().trim().max(500).nullable().optional()),
}).refine((v) => v.status !== undefined || v.assigneeId !== undefined, { message: "status 或 assigneeId 至少一项" });

export interface WorkItemRow {
  id: number;
  title: string;
  detail: string | null;
  assigneeId: number;
  assigneeName: string | null;
  assignerId: number;
  assignerName: string | null;
  ownerRole: string | null;
  priority: string;
  dueDate: string | null;
  status: WorkItemStatus;
  sourceKind: string | null;
  sourceRef: string | null;
  completedAt: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  /** 派生：未完成且已过截止日，或完成晚于截止日 */
  overdue: boolean;
  /** 派生：创建后 <10 分钟即完成 */
  suspicious: boolean;
}

export interface CreateWorkItemResult {
  item: WorkItemRow;
  /** true=新建；false=命中既有 open 项或 reopen */
  created: boolean;
  reopened: boolean;
}

/** 允许的状态流转（D61 四态） */
const TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  open: ["in_progress", "done", "cancelled"],
  in_progress: ["open", "done", "cancelled"],
  done: ["open"],
  cancelled: ["open"],
};

function dayShanghai(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}

export function isSuspiciousClose(createdAt: Date, completedAt: Date): boolean {
  return completedAt.getTime() - createdAt.getTime() < SUSPICIOUS_CLOSE_MINUTES * 60_000;
}

export function isOverdue(
  row: { status: string; dueDate: string | null; completedAt: Date | string | null },
  today: string,
): boolean {
  if (!row.dueDate) return false;
  if (row.status === "done") {
    return row.completedAt != null && dayShanghai(new Date(row.completedAt)) > row.dueDate;
  }
  if (row.status === "cancelled") return false;
  return row.dueDate < today;
}

type RawRow = typeof workItems.$inferSelect & { assigneeName?: string | null; assignerName?: string | null };

function toRow(r: RawRow, today: string): WorkItemRow {
  const createdAt = new Date(r.createdAt);
  const completedAt = r.completedAt ? new Date(r.completedAt) : null;
  return {
    id: r.id,
    title: r.title,
    detail: r.detail ?? null,
    assigneeId: r.assigneeId,
    assigneeName: r.assigneeName ?? null,
    assignerId: r.assignerId,
    assignerName: r.assignerName ?? null,
    ownerRole: r.ownerRole ?? null,
    priority: r.priority,
    dueDate: r.dueDate ?? null,
    status: r.status as WorkItemStatus,
    sourceKind: r.sourceKind ?? null,
    sourceRef: r.sourceRef ?? null,
    completedAt: completedAt ? completedAt.toISOString() : null,
    createdBy: r.createdBy,
    createdAt: createdAt.toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    overdue: isOverdue({ status: r.status, dueDate: r.dueDate ?? null, completedAt }, today),
    suspicious: r.status === "done" && completedAt != null && isSuspiciousClose(createdAt, completedAt),
  };
}

async function loadRow(db: AnyDb, id: number): Promise<RawRow | null> {
  const assigner = sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${workItems.assignerId})`;
  const [r]: RawRow[] = await db
    .select({ ...getTableColumns(workItems), assigneeName: users.name, assignerName: assigner })
    .from(workItems)
    .leftJoin(users, eq(users.id, workItems.assigneeId))
    .where(eq(workItems.id, id));
  return r ?? null;
}

export async function getWorkItem(id: number, dbArg?: AnyDb): Promise<WorkItemRow> {
  const db = dbArg ?? (await getDbAsync());
  const r = await loadRow(db, id);
  if (!r) throw new ApiError(404, "待办不存在");
  return toRow(r, dayShanghai(new Date()));
}

async function requireActiveUser(db: AnyDb, id: number): Promise<{ id: number; name: string; feishuUnionId: string | null }> {
  const [u]: { id: number; name: string; active: boolean; feishuUnionId: string | null }[] = await db
    .select({ id: users.id, name: users.name, active: users.active, feishuUnionId: users.feishuUnionId })
    .from(users)
    .where(eq(users.id, id));
  if (!u || !u.active) throw new ApiError(400, "责任人不存在或已停用");
  return u;
}

/**
 * 通知（尽力而为，失败不影响写入）：
 *  - 站内定向 assignee：dedupeKey task:{id}:{event}
 *  - 飞书私聊（配置了飞书且 assignee 绑定 union_id，且来源不是 alert）：task:{id}:{event}:feishu
 * 本人给自己建/改的待办不通知。
 */
async function notifyAssignee(
  db: AnyDb,
  item: WorkItemRow,
  event: "assigned" | "reassigned" | "reopened",
  actor: { id: number; name: string },
  assignee: { feishuUnionId: string | null },
): Promise<void> {
  if (item.assigneeId === actor.id) return;
  const titleMap = { assigned: "新待办", reassigned: "待办改派给你", reopened: "待办重新打开" } as const;
  const body = `${item.title}${item.dueDate ? `（截止 ${item.dueDate}）` : ""}｜指派人：${actor.name}`;
  const href = `/todo?mine_q=${encodeURIComponent(`#${item.id}`)}`;
  try {
    await enqueueNotification(db, {
      channel: "in_app",
      title: `【${titleMap[event]}】${item.title}`,
      body,
      href,
      severity: item.priority === "high" ? "high" : "info",
      dedupeKey: `task:${item.id}:${event}`,
      userId: item.assigneeId,
    });
    if (item.sourceKind !== "alert" && assignee.feishuUnionId && isFeishuAppConfigured()) {
      await enqueueNotification(db, {
        channel: "feishu",
        title: `【${titleMap[event]}】${item.title}`,
        body,
        href,
        severity: item.priority === "high" ? "high" : "info",
        dedupeKey: `task:${item.id}:${event}:feishu`,
        userId: item.assigneeId,
      });
    }
  } catch {
    // 通知失败不反噬业务
  }
}

/**
 * 创建待办。alert/review 来源带 sourceRef 时按指纹去重 / reopen；manual 不去重。
 */
export async function createWorkItem(
  raw: WorkItemCreateInput,
  actor: SessionUser,
  dbArg?: AnyDb,
  opts?: { now?: Date },
): Promise<CreateWorkItemResult> {
  const input = workItemCreateSchema.parse(raw);
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const today = dayShanghai(now);
  const assignee = await requireActiveUser(db, input.assigneeId);

  const fingerprinted = input.sourceKind !== "manual" && !!input.sourceRef;
  const result = await db.transaction(async (tx: AnyDb) => {
    if (fingerprinted) {
      const [existing]: (typeof workItems.$inferSelect)[] = await tx
        .select()
        .from(workItems)
        .where(and(eq(workItems.sourceKind, input.sourceKind), eq(workItems.sourceRef, input.sourceRef as string)))
        .orderBy(desc(workItems.id))
        .limit(1);
      if (existing) {
        if (existing.status === "open" || existing.status === "in_progress") {
          return { id: existing.id, created: false, reopened: false };
        }
        const closedAt = new Date(existing.updatedAt).getTime();
        if (now.getTime() - closedAt <= REOPEN_WINDOW_DAYS * DAY_MS) {
          await tx.update(workItems).set({
            status: "open",
            completedAt: null,
            title: input.title,
            detail: input.detail ?? existing.detail,
            priority: input.priority,
            dueDate: input.dueDate ?? existing.dueDate,
            // 审阅修复：reopen 采用本次（已校验在职的）指派人与责任角色，不把待办留在已离职的旧责任人名下
            assigneeId: input.assigneeId,
            assignerId: actor.id,
            ownerRole: input.ownerRole ?? existing.ownerRole,
            updatedAt: now,
          }).where(eq(workItems.id, existing.id));
          await writeAudit(tx, {
            userId: actor.id,
            entity: "work_item",
            entityId: existing.id,
            action: "reopen",
            before: { status: existing.status, completedAt: existing.completedAt, assigneeId: existing.assigneeId },
            after: { status: "open", assigneeId: input.assigneeId, fingerprint: fingerprintOf(input.sourceKind as "alert" | "review", input.sourceRef as string), withinDays: REOPEN_WINDOW_DAYS },
          });
          return { id: existing.id, created: false, reopened: true };
        }
      }
    }
    const [ins]: { id: number }[] = await tx.insert(workItems).values({
      title: input.title,
      detail: input.detail ?? null,
      assigneeId: input.assigneeId,
      assignerId: actor.id,
      ownerRole: input.ownerRole ?? null,
      priority: input.priority,
      dueDate: input.dueDate ?? null,
      status: "open",
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef ?? null,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: workItems.id });
    await writeAudit(tx, {
      userId: actor.id,
      entity: "work_item",
      entityId: ins.id,
      action: "create",
      after: {
        title: input.title,
        assigneeId: input.assigneeId,
        ownerRole: input.ownerRole ?? null,
        priority: input.priority,
        dueDate: input.dueDate ?? null,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef ?? null,
      },
    });
    return { id: ins.id, created: true, reopened: false };
  });

  const item = toRow((await loadRow(db, result.id)) as RawRow, today);
  if (result.created) await notifyAssignee(db, item, "assigned", actor, assignee);
  else if (result.reopened) await notifyAssignee(db, item, "reopened", actor, assignee);
  return { item, ...result };
}

function canManage(item: { assigneeId: number; assignerId: number; createdBy: number; ownerRole: string | null }, user: SessionUser): boolean {
  if (user.roles.includes("admin")) return true;
  if ([item.assigneeId, item.assignerId, item.createdBy].includes(user.id)) return true;
  return item.ownerRole != null && user.roles.includes(item.ownerRole);
}

/** 改派：assigner/creator/admin/同责任角色可改派；写审计 action=assign */
export async function assignWorkItem(
  id: number,
  assigneeId: number,
  actor: SessionUser,
  dbArg?: AnyDb,
  opts?: { now?: Date; note?: string | null },
): Promise<WorkItemRow> {
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const existing = await loadRow(db, id);
  if (!existing) throw new ApiError(404, "待办不存在");
  if (!canManage(existing, actor)) throw new ApiError(403, "无权改派该待办");
  if (existing.status === "done" || existing.status === "cancelled") throw new ApiError(409, "已完成/已取消的待办不能改派");
  const assignee = await requireActiveUser(db, assigneeId);
  if (existing.assigneeId === assigneeId) return toRow(existing, dayShanghai(now));
  await db.transaction(async (tx: AnyDb) => {
    await tx.update(workItems).set({ assigneeId, assignerId: actor.id, updatedAt: now }).where(eq(workItems.id, id));
    await writeAudit(tx, {
      userId: actor.id,
      entity: "work_item",
      entityId: id,
      action: "assign",
      before: { assigneeId: existing.assigneeId },
      after: { assigneeId, note: opts?.note ?? null },
    });
  });
  const item = toRow((await loadRow(db, id)) as RawRow, dayShanghai(now));
  await notifyAssignee(db, item, "reassigned", actor, assignee);
  return item;
}

/**
 * 状态流转：open ⇄ in_progress → done/cancelled；done/cancelled → open（reopen）。
 * done 写 completedAt；<10 分钟即关闭 → 审计 after.suspicious=true（不阻断）。
 */
export async function setWorkItemStatus(
  id: number,
  status: WorkItemStatus,
  actor: SessionUser,
  dbArg?: AnyDb,
  opts?: { now?: Date; note?: string | null },
): Promise<WorkItemRow & { suspicious: boolean }> {
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const existing = await loadRow(db, id);
  if (!existing) throw new ApiError(404, "待办不存在");
  if (!canManage(existing, actor)) throw new ApiError(403, "无权变更该待办状态");
  const from = existing.status as WorkItemStatus;
  if (from === status) return toRow(existing, dayShanghai(now));
  if (!TRANSITIONS[from].includes(status)) throw new ApiError(409, `状态不能从 ${from} 流转到 ${status}`);

  const completedAt = status === "done" ? now : null;
  const suspicious = status === "done" && isSuspiciousClose(new Date(existing.createdAt), now);
  await db.transaction(async (tx: AnyDb) => {
    await tx.update(workItems).set({ status, completedAt, updatedAt: now }).where(eq(workItems.id, id));
    const action = status === "done" ? "complete" : status === "cancelled" ? "cancel" : status === "open" && (from === "done" || from === "cancelled") ? "reopen" : "update";
    await writeAudit(tx, {
      userId: actor.id,
      entity: "work_item",
      entityId: id,
      action,
      before: { status: from, completedAt: existing.completedAt },
      after: { status, completedAt, suspicious, note: opts?.note ?? null },
    });
  });
  return toRow((await loadRow(db, id)) as RawRow, dayShanghai(now));
}

export function completeWorkItem(id: number, actor: SessionUser, dbArg?: AnyDb, opts?: { now?: Date; note?: string | null }) {
  return setWorkItemStatus(id, "done", actor, dbArg, opts);
}

export function cancelWorkItem(id: number, actor: SessionUser, dbArg?: AnyDb, opts?: { now?: Date; note?: string | null }) {
  return setWorkItemStatus(id, "cancelled", actor, dbArg, opts);
}

/* ────────────────────────── 可见性谓词（唯一权威：list / stats / 第 4 屏三处共用） ────────────────────────── */

/** 待办可见范围：admin 全量；其他人 = 我相关（指派给我 / 我指派 / 我创建）∪ 我角色的责任项（ownerRole ∈ roleKeys） */
export interface TodoVisibility {
  /** true = 全量可见（admin） */
  all: boolean;
  /** 可按 ownerRole 看到的角色键：user.roles ∩ ROLES，D62 受限用户（deptScope 非空）再按 resolveDeptScope 裁剪；admin = 全部角色 */
  roleKeys: string[];
}

export type WorkItemVisibilityFields = { assigneeId: number; assignerId: number; createdBy: number; ownerRole: string | null };

export function resolveTodoVisibility(user: SessionUser): TodoVisibility {
  if (user.roles.includes("admin")) return { all: true, roleKeys: [...ROLES] };
  const scope = resolveDeptScope(user, null);
  const roleKeys = user.roles.filter((r) => (ROLES as readonly string[]).includes(r) && (scope.deptKeys === null || scope.deptKeys.includes(r)));
  return { all: false, roleKeys };
}

/** 内存判定（stats / 第 4 屏）——与 workItemVisibilitySql 必须同口径 */
export function isWorkItemVisible(item: WorkItemVisibilityFields, user: SessionUser, vis: TodoVisibility = resolveTodoVisibility(user)): boolean {
  if (vis.all) return true;
  if (item.assigneeId === user.id || item.assignerId === user.id || item.createdBy === user.id) return true;
  return item.ownerRole != null && vis.roleKeys.includes(item.ownerRole);
}

/** SQL 判定（列表）；undefined = 不限（admin） */
export function workItemVisibilitySql(user: SessionUser, vis: TodoVisibility = resolveTodoVisibility(user)): SQL | undefined {
  if (vis.all) return undefined;
  return or(
    eq(workItems.assigneeId, user.id),
    eq(workItems.assignerId, user.id),
    eq(workItems.createdBy, user.id),
    vis.roleKeys.length ? inArray(workItems.ownerRole, vis.roleKeys) : sql`false`,
  );
}

export type WorkItemView = "mine" | "all";

export interface ListWorkItemsArgs {
  view: WorkItemView;
  q?: string;
  status?: string; // 单值或逗号分隔；"active" = open+in_progress
  ownerRole?: string;
  assigneeId?: number;
  sourceKind?: string;
  overdueOnly?: boolean;
  page: number;
  pageSize: number;
}

/**
 * 列表：
 *  - mine：指派给我；
 *  - all：按 workItemVisibilitySql（与 stats / 第 4 屏同一谓词 resolveTodoVisibility）。
 */
export async function listWorkItems(args: ListWorkItemsArgs, user: SessionUser, dbArg?: AnyDb) {
  const db = dbArg ?? (await getDbAsync());
  const today = dayShanghai(new Date());
  const clauses: SQL[] = [];
  if (args.view === "mine") {
    clauses.push(eq(workItems.assigneeId, user.id));
  } else {
    const visible = workItemVisibilitySql(user);
    if (visible) clauses.push(visible);
  }
  if (args.q) {
    const m = /^#(\d+)$/.exec(args.q.trim());
    if (m) clauses.push(eq(workItems.id, Number(m[1])));
    else {
      const like = or(ilike(workItems.title, `%${args.q}%`), ilike(workItems.detail, `%${args.q}%`), ilike(workItems.sourceRef, `%${args.q}%`));
      if (like) clauses.push(like);
    }
  }
  if (args.status) {
    const list = args.status === "active"
      ? ["open", "in_progress"]
      : args.status.split(",").map((s) => s.trim()).filter((s) => (WORK_ITEM_STATUSES as readonly string[]).includes(s));
    if (list.length) clauses.push(inArray(workItems.status, list));
  }
  if (args.ownerRole && (ROLES as readonly string[]).includes(args.ownerRole)) clauses.push(eq(workItems.ownerRole, args.ownerRole as Role));
  if (args.assigneeId) clauses.push(eq(workItems.assigneeId, args.assigneeId));
  if (args.sourceKind) clauses.push(eq(workItems.sourceKind, args.sourceKind));
  if (args.overdueOnly) {
    clauses.push(inArray(workItems.status, ["open", "in_progress"]));
    clauses.push(lt(workItems.dueDate, today));
  }
  const where = clauses.length ? and(...clauses) : undefined;
  const assigner = sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${workItems.assignerId})`;
  const [rows, [{ total }]]: [RawRow[], { total: number }[]] = await Promise.all([
    db
      .select({ ...getTableColumns(workItems), assigneeName: users.name, assignerName: assigner })
      .from(workItems)
      .leftJoin(users, eq(users.id, workItems.assigneeId))
      .where(where)
      .orderBy(
        sql`CASE ${workItems.status} WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END`,
        sql`CASE ${workItems.priority} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`,
        sql`${workItems.dueDate} NULLS LAST`,
        desc(workItems.id),
      )
      .limit(args.pageSize)
      .offset((args.page - 1) * args.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(workItems).where(where),
  ]);
  return { rows: rows.map((r) => toRow(r, today)), total: Number(total), today };
}

/** 责任角色 → 默认指派人：该角色最早创建的在职用户；无则回落 admin；再无则 null */
export async function defaultAssigneeForRole(db: AnyDb, role: Role): Promise<number | null> {
  const pick = async (r: string): Promise<number | null> => {
    const [u]: { id: number }[] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.active, true), sql`${r} = ANY(${users.roles})`))
      .orderBy(users.id)
      .limit(1);
    return u?.id ?? null;
  };
  return (await pick(role)) ?? (await pick("admin"));
}

export interface ProjectCandidatesSummary {
  scanned: number;
  created: number;
  reopened: number;
  /** 单条投影失败（校验/指派异常）计数：不让一条坏候选拖垮整轮同步 */
  failed: number;
  matched: number;
  unassigned: number;
  /**
   * 触发窗口被预算截断（红队 A1）：告警或复核任一来源取满了本轮预算，
   * 说明还有 open 行本轮根本没被看到——`scanned/matched` 再好看也不代表投影是全的。
   */
  truncated: boolean;
}

/**
 * 把触发候选落为待办（供 jobs/todo-sync 调用）。actor = 系统执行者（首个在职 admin）。
 * 截止日：候选自带 dueDate（断货告警的最晚下单日，闭环审计 #9）优先——已过去的按今天计（窗口已错过，不给未来假期限）；
 * 否则缺省 = 今天 + dueDays（high 3 天 / normal 7 天 / low 14 天）。
 */
export async function projectCandidates(
  db: AnyDb,
  candidates: readonly TodoCandidate[],
  actor: SessionUser,
  opts?: { now?: Date; truncated?: boolean },
): Promise<ProjectCandidatesSummary> {
  const now = opts?.now ?? new Date();
  const summary: ProjectCandidatesSummary = { scanned: candidates.length, created: 0, reopened: 0, matched: 0, unassigned: 0, failed: 0, truncated: opts?.truncated ?? false };
  const dueDays: Record<string, number> = { high: 3, normal: 7, low: 14 };
  const assigneeByRole = new Map<string, Promise<number | null>>(); // 同一责任角色一轮只查一次
  for (const c of candidates) {
    const roleKey = c.ownerRole ?? "";
    let pending = assigneeByRole.get(roleKey);
    if (!pending) { pending = defaultAssigneeForRole(db, c.ownerRole); assigneeByRole.set(roleKey, pending); }
    const assigneeId = await pending;
    if (!assigneeId) { summary.unassigned++; continue; }
    const today = dayShanghai(now);
    const fallbackDue = dayShanghai(new Date(now.getTime() + (dueDays[c.priority] ?? 7) * DAY_MS));
    const dueDate = c.dueDate ? (c.dueDate < today ? today : c.dueDate) : fallbackDue;
    try {
      const r = await createWorkItem({
        title: c.title.slice(0, 200),
        detail: (c.detail ? `${c.detail}\n${c.href}` : c.href).slice(0, 2000),
        assigneeId,
        ownerRole: c.ownerRole,
        priority: c.priority,
        dueDate,
        sourceKind: c.sourceKind,
        sourceRef: c.sourceRef,
      }, actor, db, { now });
      if (r.created) summary.created++;
      else if (r.reopened) summary.reopened++;
      else summary.matched++;
    } catch (e) {
      // 审阅修复：单条失败只计数，不中断其余候选与到期提醒
      summary.failed++;
      console.warn("[todo] 投影候选失败", c.sourceKind, c.sourceRef, e instanceof Error ? e.message : e);
    }
  }
  return summary;
}

/**
 * 来源已关闭的投影待办自动取消（审阅修复）：告警被引擎迟滞关闭 / 人工裁决项关闭后，
 * 其投影待办不再计入逾期与完成率；走 setWorkItemStatus（审计 action=cancel，note 说明来源）。
 */
export async function closeStaleProjectedItems(db: AnyDb, actor: SessionUser, opts?: { now?: Date }): Promise<{ scanned: number; cancelled: number }> {
  const now = opts?.now ?? new Date();
  const stale: { id: number; sourceKind: string | null }[] = await db
    .select({ id: workItems.id, sourceKind: workItems.sourceKind })
    .from(workItems)
    .where(and(
      inArray(workItems.status, ["open", "in_progress"]),
      or(
        and(eq(workItems.sourceKind, "alert"), sql`NOT EXISTS (SELECT 1 FROM system_alerts a WHERE a.id::text = ${workItems.sourceRef} AND a.status = 'open')`),
        and(eq(workItems.sourceKind, "review"), sql`NOT EXISTS (SELECT 1 FROM review_items r WHERE r.id::text = ${workItems.sourceRef} AND r.status = 'open')`),
      ),
    ))
    .orderBy(workItems.id)
    .limit(500);
  let cancelled = 0;
  for (const s of stale) {
    try {
      await setWorkItemStatus(s.id, "cancelled", actor, db, { now, note: s.sourceKind === "alert" ? "来源告警已关闭，自动取消" : "来源裁决项已关闭，自动取消" });
      cancelled++;
    } catch (e) {
      console.warn("[todo] 自动取消失败", s.id, e instanceof Error ? e.message : e);
    }
  }
  return { scanned: stale.length, cancelled };
}

/** 到期提醒候选：今天到期或已逾期且未完成 */
export async function listDueReminderTargets(db: AnyDb, today: string): Promise<WorkItemRow[]> {
  const assigner = sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${workItems.assignerId})`;
  const rows: RawRow[] = await db
    .select({ ...getTableColumns(workItems), assigneeName: users.name, assignerName: assigner })
    .from(workItems)
    .leftJoin(users, eq(users.id, workItems.assigneeId))
    .where(and(
      inArray(workItems.status, ["open", "in_progress"]),
      sql`${workItems.dueDate} IS NOT NULL AND ${workItems.dueDate} <= ${today}`,
    ));
  return rows.map((r) => toRow(r, today));
}
