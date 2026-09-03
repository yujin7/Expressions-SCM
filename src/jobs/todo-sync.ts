/**
 * D61 待办同步任务（不在此注册；建议编排方登记到 scheduler：每 30 分钟，cron `0,30 * * * *`）。
 *
 *  1. 投影触发：system_alerts(open) / review_items(open，类别 blocked… 与 doc_aging) → 待办候选 → service.projectCandidates
 *     （指纹去重、7 天内 reopen；默认指派该责任角色最早在职用户，无则 admin）。
 *  2. 到期提醒：今天到期或已逾期且未完成的待办 → 定向站内 + 飞书私聊（有 union_id 时）
 *     dedupeKey task:{id}:due:{today}（每天至多一次；与告警群发不重叠——提醒只发给责任人）。
 *
 * 执行者：首个在职 admin（审计 userId）；无 admin 则跳过投影只做提醒。全部 best-effort。
 */
import { and, eq, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";
import { listDueReminderTargets, projectCandidates, type ProjectCandidatesSummary } from "@/server/modules/todo/service";
import { collectTodoCandidates, type CollectTriggerOptions } from "@/server/modules/todo/triggers";
import { enqueueNotification, isFeishuAppConfigured } from "./notify";

export interface TodoSyncSummary {
  projection: ProjectCandidatesSummary | null;
  reminders: { scanned: number; enqueued: number };
  actorId: number | null;
}

function dayShanghai(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}

async function systemActor(db: AnyDb): Promise<SessionUser | null> {
  const [u]: { id: number; name: string; roles: string[]; isApprover: boolean }[] = await db
    .select({ id: users.id, name: users.name, roles: users.roles, isApprover: users.isApprover })
    .from(users)
    .where(and(eq(users.active, true), sql`'admin' = ANY(${users.roles})`))
    .orderBy(users.id)
    .limit(1);
  return u ? { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover } : null;
}

export async function runTodoSync(
  db: AnyDb,
  opts?: { now?: Date; triggers?: CollectTriggerOptions; feishuConfigured?: boolean },
): Promise<TodoSyncSummary> {
  const now = opts?.now ?? new Date();
  const today = dayShanghai(now);
  const actor = await systemActor(db);

  let projection: ProjectCandidatesSummary | null = null;
  if (actor) {
    const candidates = await collectTodoCandidates(db, opts?.triggers);
    projection = await projectCandidates(db, candidates, actor, { now });
  }

  const feishu = opts?.feishuConfigured ?? isFeishuAppConfigured();
  const due = await listDueReminderTargets(db, today);
  let enqueued = 0;
  for (const item of due) {
    const state = item.dueDate === today ? "今天到期" : `已逾期（截止 ${item.dueDate}）`;
    const title = `【待办提醒】${item.title}`;
    const body = `${state}｜优先级 ${item.priority}｜责任角色 ${item.ownerRole ?? "-"}`;
    const href = `/todo?mine_q=${encodeURIComponent(`#${item.id}`)}`;
    if (await enqueueNotification(db, {
      channel: "in_app", title, body, href, severity: item.overdue ? "high" : "info",
      dedupeKey: `task:${item.id}:due:${today}`, userId: item.assigneeId,
    })) enqueued++;
    if (feishu) {
      const [u]: { feishuUnionId: string | null }[] = await db
        .select({ feishuUnionId: users.feishuUnionId }).from(users).where(eq(users.id, item.assigneeId));
      if (u?.feishuUnionId && await enqueueNotification(db, {
        channel: "feishu", title, body, href, severity: item.overdue ? "high" : "info",
        dedupeKey: `task:${item.id}:due:${today}:feishu`, userId: item.assigneeId,
      })) enqueued++;
    }
  }
  return { projection, reminders: { scanned: due.length, enqueued }, actorId: actor?.id ?? null };
}
