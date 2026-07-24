/**
 * #8 通知发件箱（outbox）+ 分发。
 *
 * enqueueNotification：应用内产生通知 → 入队（dedupeKey 幂等，防同事件重复推）。
 * dispatchNotifications：分发任务读取 pending 逐条推送：
 *  - channel=feishu：POST 到 env FEISHU_WEBHOOK_URL（飞书自定义机器人 webhook——只需一个 URL，
 *    无需应用密钥；未配置则标记 skipped，不报错）；
 *  - channel=in_app：站内通知，直接标记 sent（前端从 notifications 表读）。
 * runExceptionNotify：把控制塔 critical/high 异常按天去重入队（每日一次推送到飞书/站内）。
 *
 * 网络失败标记 failed（保留 error），下轮重试。全部 best-effort，绝不反噬业务。
 */
import { eq } from "drizzle-orm";
import { notifications } from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";
import { computeExceptions } from "@/server/modules/workbench/focus";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface NotifyInput {
  channel: "feishu" | "in_app";
  title: string;
  body: string;
  href?: string | null;
  severity?: string | null;
  dedupeKey?: string | null;
}

/** 入队（同 dedupeKey 已存在则跳过——幂等） */
export async function enqueueNotification(db: AnyDb, n: NotifyInput): Promise<boolean> {
  if (n.dedupeKey) {
    const existing: { id: number }[] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.dedupeKey, n.dedupeKey));
    if (existing.length > 0) return false;
  }
  await db.insert(notifications).values({
    channel: n.channel,
    title: n.title,
    body: n.body,
    href: n.href ?? null,
    severity: n.severity ?? null,
    dedupeKey: n.dedupeKey ?? null,
  }).onConflictDoNothing();
  return true;
}

async function pushFeishu(url: string, title: string, body: string, href?: string | null): Promise<void> {
  const text = `【供应链】${title}\n${body}${href ? `\n${href}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
  });
  if (!res.ok) throw new Error(`feishu webhook ${res.status}`);
}

export interface DispatchSummary {
  sent: number;
  skipped: number;
  failed: number;
}

/** 分发 pending 通知；opts.webhookUrl / opts.fetchImpl 供测试注入 */
export async function dispatchNotifications(
  db: AnyDb,
  opts?: { webhookUrl?: string | null },
): Promise<DispatchSummary> {
  const webhookUrl = opts?.webhookUrl ?? process.env.FEISHU_WEBHOOK_URL ?? null;
  const pending: { id: number; channel: string; title: string; body: string; href: string | null }[] = await db
    .select({ id: notifications.id, channel: notifications.channel, title: notifications.title, body: notifications.body, href: notifications.href })
    .from(notifications)
    .where(eq(notifications.status, "pending"))
    .limit(200);
  let sent = 0, skipped = 0, failed = 0;
  const now = new Date();
  for (const p of pending) {
    if (p.channel === "in_app") {
      await db.update(notifications).set({ status: "sent", sentAt: now }).where(eq(notifications.id, p.id));
      sent++;
      continue;
    }
    if (p.channel === "feishu") {
      if (!webhookUrl) {
        await db.update(notifications).set({ status: "skipped", error: "未配置 FEISHU_WEBHOOK_URL" }).where(eq(notifications.id, p.id));
        skipped++;
        continue;
      }
      try {
        await pushFeishu(webhookUrl, p.title, p.body, p.href);
        await db.update(notifications).set({ status: "sent", sentAt: now, error: null }).where(eq(notifications.id, p.id));
        sent++;
      } catch (e) {
        await db.update(notifications).set({ status: "failed", error: (e as Error).message.slice(0, 300) }).where(eq(notifications.id, p.id));
        failed++;
      }
      continue;
    }
    await db.update(notifications).set({ status: "skipped", error: `未知渠道 ${p.channel}` }).where(eq(notifications.id, p.id));
    skipped++;
  }
  return { sent, skipped, failed };
}

/** 每日把关键异常入队（按天去重）——复用控制塔唯一异常源（Wave BB struct#9/#10：不再手写第三份、不用缺周期代理） */
export async function runExceptionNotify(db: AnyDb): Promise<{ enqueued: number }> {
  const today = todayShanghai();
  const channel: NotifyInput["channel"] = process.env.FEISHU_WEBHOOK_URL ? "feishu" : "in_app";
  let enqueued = 0;
  const exceptions = await computeExceptions(db); // 与工作台控制塔/驾驶舱同源同口径
  for (const ex of exceptions) {
    if (await enqueueNotification(db, {
      channel, title: ex.title, body: ex.impact, href: ex.href, severity: ex.severity,
      dedupeKey: `${ex.key}:${today}`,
    })) enqueued++;
  }
  return { enqueued };
}
