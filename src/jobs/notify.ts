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
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { notifications, reviewItems, batchStocks, skus } from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
const num = (v: unknown): number => (v == null ? 0 : Number(v));

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

/** 每日把关键异常入队（按天去重）——飞书未配置时仍会以 in_app 落库供站内提醒 */
export async function runExceptionNotify(db: AnyDb, opts?: { now?: Date }): Promise<{ enqueued: number }> {
  const today = todayShanghai();
  const channel: NotifyInput["channel"] = process.env.FEISHU_WEBHOOK_URL ? "feishu" : "in_app";
  let enqueued = 0;
  const push = async (key: string, title: string, body: string, href: string, severity: string) => {
    if (await enqueueNotification(db, { channel, title, body, href, severity, dedupeKey: `${key}:${today}` })) enqueued++;
  };

  // 已过期库存
  const [expired] = await db
    .select({ skus: sql<number>`count(distinct ${batchStocks.skuId})::int`, qty: sql<string>`coalesce(sum(${batchStocks.qty}),0)` })
    .from(batchStocks)
    .where(and(isNotNull(batchStocks.expiryDate), sql`${batchStocks.qty} > 0`, lte(batchStocks.expiryDate, today)));
  if ((expired?.skus ?? 0) > 0) {
    await push("expired_stock", "已过期库存待处置", `${expired.skus} 个 SKU · ${num(expired.qty).toLocaleString("zh-CN")} 件`, "/report/risk?action=报废评审", "critical");
  }
  // 单据超时
  const [{ c: docAging }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(reviewItems)
    .where(and(eq(reviewItems.category, "doc_aging"), eq(reviewItems.status, "open")));
  if (docAging > 0) await push("doc_aging", "单据超时未流转", `${docAging} 张单据停留超阈值`, "/review/checklist", "high");
  // 参考数据过期
  const [{ c: stale }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(reviewItems)
    .where(and(eq(reviewItems.category, "data_freshness"), eq(reviewItems.status, "open")));
  if (stale > 0) await push("stale_data", "关键参考数据过期", `${stale} 类数据待重传`, "/review/checklist", "high");
  // 断货风险（缺生产周期的成品数作为轻量代理，避免全表推演）
  const [{ c: missingLead }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(skus)
    .where(and(eq(skus.skuType, "finished"), eq(skus.active, true), sql`not exists (select 1 from sku_params sp where sp.sku_id = ${skus.id} and sp.normal_lead_days > 0)`));
  if (missingLead > 0) await push("missing_lead", "成品缺生产周期", `${missingLead} 个成品无法推算下单日`, "/report/data-health?missing=生产周期", "medium");

  return { enqueued };
}
