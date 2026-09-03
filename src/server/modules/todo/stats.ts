/**
 * D61 待办完成率 / 按时率（只读统计，不打分，绩效 = 证据导出）。
 *
 * 口径：
 *  - 分组：按人×月 或 责任角色×月；月 = 创建月（Asia/Shanghai）。
 *  - 分母不含 cancelled；source_kind=manual（含空）不计入——手工项可自建自关，不作考核证据。
 *  - done = status done；onTime = done 且（无截止日 或 完成日 ≤ 截止日）；
 *    overdue = 未完成且已过截止日，或完成晚于截止日（「完成不按时」）；
 *  - suspicious = done 且 completedAt − createdAt < 10 分钟（与 service 同口径）。
 *  - 完成率 = done ÷ (total − cancelled)；按时率 = onTime ÷ done；分母 0 → null。
 * 可见性：与列表同一谓词（service.resolveTodoVisibility / isWorkItemVisible）：admin 全见；
 *   其他人只见 我相关（指派给我/我指派/我创建）∪ 本角色责任项（D62 受限用户按 deptScope 裁剪角色），服务端裁剪。
 */
import { and, eq, gte, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { users, workItems } from "@/db/schema";
import { ROLES } from "@/server/core/constants";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, r1n } from "@/server/core/svc";
import { isOverdue, isSuspiciousClose, isWorkItemVisible, resolveTodoVisibility, SUSPICIOUS_CLOSE_MINUTES } from "./service";

export type StatsGroupBy = "person" | "role";

export interface TodoStatsArgs {
  groupBy: StatsGroupBy;
  /** 起止月 'YYYY-MM'（含）；缺省近 3 个月 */
  fromMonth?: string;
  toMonth?: string;
  /** 只看某角色（role 分组）或某人（person 分组） */
  ownerRole?: string;
  assigneeId?: number;
  /** 计算「今天」的时点（测试可注入） */
  now?: Date;
}

export interface TodoStatsRow {
  groupKey: string; // userId 或 role
  groupLabel: string; // 姓名 或 角色码
  month: string; // YYYY-MM
  total: number;
  done: number;
  onTime: number;
  overdue: number;
  cancelled: number;
  suspicious: number;
  completionRate: number | null; // %
  onTimeRate: number | null; // %
}

export interface TodoStatsResult {
  groupBy: StatsGroupBy;
  fromMonth: string;
  toMonth: string;
  rows: TodoStatsRow[];
  caliber: string;
}

const SH = "Asia/Shanghai";
function dayShanghai(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SH }).format(d);
}
export function monthShanghai(d: Date): string {
  return dayShanghai(d).slice(0, 7);
}
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}
/** 月首日在上海时区对应的 UTC 时刻 */
function monthStartUtc(ym: string): Date {
  return new Date(`${ym}-01T00:00:00+08:00`);
}

export const TODO_STATS_CALIBER =
  `完成率 = 已完成 ÷ (总数 − 已取消)；按时率 = 按时完成 ÷ 已完成；手工来源不计入；创建后不足 ${SUSPICIOUS_CLOSE_MINUTES} 分钟即关闭计「可疑」仅标注不扣分；月份按创建时间（Asia/Shanghai）`;

export async function getTodoStats(args: TodoStatsArgs, user: SessionUser, dbArg?: AnyDb): Promise<TodoStatsResult> {
  const db = dbArg ?? (await getDbAsync());
  const now = args.now ?? new Date();
  const today = dayShanghai(now);
  const toMonth = args.toMonth && /^\d{4}-\d{2}$/.test(args.toMonth) ? args.toMonth : monthShanghai(now);
  const fromMonth = args.fromMonth && /^\d{4}-\d{2}$/.test(args.fromMonth) ? args.fromMonth : shiftMonth(toMonth, -2);
  const vis = resolveTodoVisibility(user);

  const clauses: SQL[] = [
    isNotNull(workItems.sourceKind),
    inArray(workItems.sourceKind, ["alert", "review"]),
    gte(workItems.createdAt, monthStartUtc(fromMonth)),
    lt(workItems.createdAt, monthStartUtc(shiftMonth(toMonth, 1))),
  ];
  if (args.ownerRole && (ROLES as readonly string[]).includes(args.ownerRole)) clauses.push(eq(workItems.ownerRole, args.ownerRole));
  if (args.assigneeId) clauses.push(eq(workItems.assigneeId, args.assigneeId));

  const rows: {
    id: number; assigneeId: number; assigneeName: string | null; assignerId: number; createdBy: number; ownerRole: string | null; status: string;
    dueDate: string | null; completedAt: Date | null; createdAt: Date;
  }[] = await db
    .select({
      id: workItems.id,
      assigneeId: workItems.assigneeId,
      assigneeName: users.name,
      assignerId: workItems.assignerId,
      createdBy: workItems.createdBy,
      ownerRole: workItems.ownerRole,
      status: workItems.status,
      dueDate: workItems.dueDate,
      completedAt: workItems.completedAt,
      createdAt: workItems.createdAt,
    })
    .from(workItems)
    .leftJoin(users, eq(users.id, workItems.assigneeId))
    .where(and(...clauses));

  const buckets = new Map<string, TodoStatsRow>();
  for (const r of rows) {
    // 可见性裁剪：与列表同一谓词
    if (!isWorkItemVisible(r, user, vis)) continue;
    const groupKey = args.groupBy === "person" ? String(r.assigneeId) : (r.ownerRole ?? "(未分配角色)");
    const groupLabel = args.groupBy === "person" ? (r.assigneeName ?? `#${r.assigneeId}`) : groupKey;
    const month = monthShanghai(new Date(r.createdAt));
    const key = `${groupKey}|${month}`;
    let b = buckets.get(key);
    if (!b) {
      b = { groupKey, groupLabel, month, total: 0, done: 0, onTime: 0, overdue: 0, cancelled: 0, suspicious: 0, completionRate: null, onTimeRate: null };
      buckets.set(key, b);
    }
    b.total++;
    const completedAt = r.completedAt ? new Date(r.completedAt) : null;
    const overdue = isOverdue({ status: r.status, dueDate: r.dueDate, completedAt }, today);
    if (overdue) b.overdue++;
    if (r.status === "cancelled") b.cancelled++;
    if (r.status === "done") {
      b.done++;
      if (!overdue) b.onTime++;
      if (completedAt && isSuspiciousClose(new Date(r.createdAt), completedAt)) b.suspicious++;
    }
  }
  const out = [...buckets.values()].map((b) => {
    const denom = b.total - b.cancelled;
    return {
      ...b,
      completionRate: denom > 0 ? r1n((b.done / denom) * 100) : null,
      onTimeRate: b.done > 0 ? r1n((b.onTime / b.done) * 100) : null,
    };
  }).sort((a, b) => (a.month === b.month ? a.groupLabel.localeCompare(b.groupLabel, "zh-CN") : b.month.localeCompare(a.month)));
  return { groupBy: args.groupBy, fromMonth, toMonth, rows: out, caliber: TODO_STATS_CALIBER };
}

/* ────────────────────────── 第 4 屏「待办跟进进度」数据块 ────────────────────────── */

export interface TodoProgressRoleRow {
  role: string;
  open: number;
  overdue: number;
  doneThisMonth: number;
  completionRate: number | null;
}

export interface TodoProgressBlock {
  generatedAt: string;
  month: string;
  /** 当前用户：指派给我的未完成 / 逾期 */
  mine: { open: number; overdue: number };
  /** 全局（admin）或本角色范围 */
  totals: { open: number; overdue: number; doneThisMonth: number; completionRate: number | null };
  byRole: TodoProgressRoleRow[];
  metricIds: readonly ["todoOpen", "todoOverdue", "todoCompletionRate"];
  caliber: string;
  href: string;
}

/**
 * 驾驶舱第 4 屏数据块：即时口径（不走缓存——待办是事务表，量小且要求实时）。
 * 完成率 = 本月创建（alert/review 来源）中已完成占比；open/overdue 按当前状态计（含 manual）。
 * 非 admin 的 byRole 只含本人角色（D62 受限用户按 deptScope 裁剪）；范围判定与列表 / stats 同一谓词（isWorkItemVisible）。
 */
export async function getTodoProgressBlock(user: SessionUser, dbArg?: AnyDb, opts?: { now?: Date }): Promise<TodoProgressBlock> {
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const today = dayShanghai(now);
  const month = monthShanghai(now);
  const vis = resolveTodoVisibility(user);
  const visibleRoles = vis.roleKeys;

  const active: { assigneeId: number; assignerId: number; createdBy: number; ownerRole: string | null; dueDate: string | null }[] = await db
    .select({ assigneeId: workItems.assigneeId, assignerId: workItems.assignerId, createdBy: workItems.createdBy, ownerRole: workItems.ownerRole, dueDate: workItems.dueDate })
    .from(workItems)
    .where(inArray(workItems.status, ["open", "in_progress"]));

  const mine = { open: 0, overdue: 0 };
  const byRole = new Map<string, TodoProgressRoleRow>();
  for (const r of visibleRoles) byRole.set(r, { role: r, open: 0, overdue: 0, doneThisMonth: 0, completionRate: null });
  const totals = { open: 0, overdue: 0, doneThisMonth: 0, completionRate: null as number | null };
  for (const a of active) {
    const overdue = a.dueDate != null && a.dueDate < today;
    if (a.assigneeId === user.id) { mine.open++; if (overdue) mine.overdue++; }
    if (!isWorkItemVisible(a, user, vis)) continue;
    totals.open++;
    if (overdue) totals.overdue++;
    const b = a.ownerRole ? byRole.get(a.ownerRole) : undefined;
    if (b) { b.open++; if (overdue) b.overdue++; }
  }

  const stats = await getTodoStats({ groupBy: "role", fromMonth: month, toMonth: month, now }, user, db);
  let done = 0, denom = 0;
  for (const s of stats.rows) {
    const b = byRole.get(s.groupKey);
    if (b) { b.doneThisMonth = s.done; b.completionRate = s.completionRate; }
    done += s.done;
    denom += s.total - s.cancelled;
  }
  totals.doneThisMonth = done;
  totals.completionRate = denom > 0 ? r1n((done / denom) * 100) : null;

  return {
    generatedAt: now.toISOString(),
    month,
    mine,
    totals,
    byRole: [...byRole.values()],
    metricIds: ["todoOpen", "todoOverdue", "todoCompletionRate"],
    caliber: TODO_STATS_CALIBER,
    href: "/todo",
  };
}
