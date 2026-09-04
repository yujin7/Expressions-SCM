/**
 * D61 待办完成率 / 按时率（只读统计，不打分，绩效 = 证据导出）。
 *
 * 口径：
 *  - 分组：按人×月 或 责任角色×月；月 = 创建月（Asia/Shanghai）。
 *  - 宽口径分母不含 cancelled；source_kind=manual（含空）不计入——手工项可自建自关，不作考核证据。
 *  - done = status done；onTime = done 且（无截止日 或 完成日 ≤ 截止日）；
 *    overdue = 未完成且已过截止日，或完成晚于截止日（「完成不按时」）；
 *  - suspicious = done 且 completedAt − createdAt < 10 分钟（与 service 同口径）。
 *  - cancelled 拆**三**类（闭环审计 #9 + 红队审计 A7）：
 *      cancelledBySourceClose      = 来源告警被引擎迟滞自动关闭（system_alerts.autoResolved=true）后由
 *                                    closeStaleProjectedItems 取消——条件自己消失、无人动手；
 *      cancelledBySourceManualClose= 来源告警被**人工**关闭（autoResolved=false）后连带取消；
 *      cancelledByHuman            = 其余（直接把待办本身取消）。
 *  - 完成率（宽）= done ÷ (total − cancelled)；完成率（严）= done ÷ (total − cancelledByHuman)——
 *    **两种"来源关闭"造成的取消都留在严口径分母里**；按时率 = onTime ÷ done；分母 0 → null。
 *
 *  为什么要单拆"来源人工关闭"（红队 A7）：原实现把它并进 cancelledByHuman，于是
 *  「做不完的待办 → 把来源告警按 wont_fix 关掉 → closeStaleProjectedItems 取消待办」
 *  这条路径能把一条待办**同时**从宽口径和严口径的分母里摘掉——完成率不降反升，
 *  而这恰恰是最该被看见的一种"没做完"。现在它有自己的桶、留在严口径分母里，页面也把它列出来。
 * 可见性：与列表同一谓词（service.resolveTodoVisibility / isWorkItemVisible）：admin 全见；
 *   其他人只见 我相关（指派给我/我指派/我创建）∪ 本角色责任项（D62 受限用户按 deptScope 裁剪角色），服务端裁剪。
 */
import { and, eq, gte, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { systemAlerts, users, workItems } from "@/db/schema";
import { ROLES } from "@/server/core/constants";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, r1n } from "@/server/core/svc";
import { isOverdue, isSuspiciousClose, isWorkItemVisible, resolveTodoVisibility, SUSPICIOUS_CLOSE_MINUTES } from "./service";
import { shanghaiDayOf, shanghaiMonthOf } from "@/server/core/business-day";

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
  /** 取消细分：来源告警被引擎自动关闭（autoResolved=true）而取消 */
  cancelledBySourceClose: number;
  /** 取消细分：来源告警被**人工**关闭（autoResolved=false）而取消——留在严口径分母，不当逃生口 */
  cancelledBySourceManualClose: number;
  /** 取消细分：直接取消待办本身（唯一从严口径分母里出去的一类） */
  cancelledByHuman: number;
  suspicious: number;
  completionRate: number | null; // %（宽口径：done ÷ (total − cancelled)）
  /** %（严口径：done ÷ (total − cancelledByHuman)，来源关闭（自动/人工）造成的取消都留在分母） */
  completionRateStrict: number | null;
  onTimeRate: number | null; // %
}

export interface TodoStatsResult {
  groupBy: StatsGroupBy;
  fromMonth: string;
  toMonth: string;
  rows: TodoStatsRow[];
  caliber: string;
}

const dayShanghai = shanghaiDayOf;
export const monthShanghai = shanghaiMonthOf;
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
  `完成率（宽）= 已完成 ÷ (总数 − 已取消)；完成率（严）= 已完成 ÷ (总数 − 人工取消待办)，`
  + `来源告警被关闭（引擎自动关闭 **或人工关闭**）而连带取消的待办都留在严口径分母——`
  + `等看门狗关掉不算完成，把来源告警按「不处理/误报」关掉也不算完成（否则关闭原因就成了完成率的逃生口）；`
  + `按时率 = 按时完成 ÷ 已完成；手工来源不计入；创建后不足 ${SUSPICIOUS_CLOSE_MINUTES} 分钟即关闭计「可疑」仅标注不扣分；月份按创建时间（Asia/Shanghai）`;

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
    dueDate: string | null; completedAt: Date | null; createdAt: Date; sourceKind: string | null; sourceRef: string | null;
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
      sourceKind: workItems.sourceKind,
      sourceRef: workItems.sourceRef,
    })
    .from(workItems)
    .leftJoin(users, eq(users.id, workItems.assigneeId))
    .where(and(...clauses));

  // 取消细分：告警来源的已取消待办 → 回查 system_alerts（引擎迟滞关闭 = 条件消失；人工关闭 = 有人做了判断）
  const cancelledAlertIds = [...new Set(rows
    .filter((r) => r.status === "cancelled" && r.sourceKind === "alert" && r.sourceRef && /^\d+$/.test(r.sourceRef))
    .map((r) => Number(r.sourceRef)))];
  const autoResolvedAlerts = new Set<number>();
  const manuallyClosedAlerts = new Set<number>();
  if (cancelledAlertIds.length) {
    const ar: { id: number; autoResolved: boolean }[] = await db
      .select({ id: systemAlerts.id, autoResolved: systemAlerts.autoResolved }).from(systemAlerts)
      .where(and(inArray(systemAlerts.id, cancelledAlertIds), eq(systemAlerts.status, "resolved")));
    for (const a of ar) (a.autoResolved ? autoResolvedAlerts : manuallyClosedAlerts).add(a.id);
  }

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
      b = {
        groupKey, groupLabel, month, total: 0, done: 0, onTime: 0, overdue: 0, cancelled: 0,
        cancelledBySourceClose: 0, cancelledBySourceManualClose: 0, cancelledByHuman: 0,
        suspicious: 0, completionRate: null, completionRateStrict: null, onTimeRate: null,
      };
      buckets.set(key, b);
    }
    b.total++;
    const completedAt = r.completedAt ? new Date(r.completedAt) : null;
    const overdue = isOverdue({ status: r.status, dueDate: r.dueDate, completedAt }, today);
    if (overdue) b.overdue++;
    if (r.status === "cancelled") {
      b.cancelled++;
      const sourceAlertId = r.sourceKind === "alert" && r.sourceRef ? Number(r.sourceRef) : null;
      if (sourceAlertId != null && autoResolvedAlerts.has(sourceAlertId)) b.cancelledBySourceClose++;
      else if (sourceAlertId != null && manuallyClosedAlerts.has(sourceAlertId)) b.cancelledBySourceManualClose++;
      else b.cancelledByHuman++;
    }
    if (r.status === "done") {
      b.done++;
      if (!overdue) b.onTime++;
      if (completedAt && isSuspiciousClose(new Date(r.createdAt), completedAt)) b.suspicious++;
    }
  }
  const out = [...buckets.values()].map((b) => {
    const denom = b.total - b.cancelled;
    const strictDenom = b.total - b.cancelledByHuman;
    return {
      ...b,
      completionRate: denom > 0 ? r1n((b.done / denom) * 100) : null,
      completionRateStrict: strictDenom > 0 ? r1n((b.done / strictDenom) * 100) : null,
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
