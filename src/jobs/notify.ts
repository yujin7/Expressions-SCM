/**
 * #8 通知发件箱（outbox）+ 分发。
 *
 * enqueueNotification：应用内产生通知 → 入队（dedupeKey 幂等，防同事件重复推）。
 * dispatchNotifications：分发任务读取 pending 逐条推送：
 *  - channel=feishu：优先用飞书应用机器人（tenant token + chat_id + UUID 去重），
 *    失败时可回退自定义机器人 webhook；两者均未配置则标记 skipped；
 *  - channel=in_app：站内通知，直接标记 sent（前端从 notifications 表读）。
 * runExceptionNotify：把控制塔 critical/high 异常按天去重入队（每日一次推送到飞书/站内）。
 *
 * 网络失败标记 failed（保留 error），下轮重试。全部 best-effort，绝不反噬业务。
 */
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { notifications } from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";
import { computeExceptions } from "@/server/modules/workbench/focus";
import { getDecisionStudio } from "@/server/modules/report/decision-studio";
import {
  FeishuAppClient,
  feishuAppConfigFromEnv,
} from "@/server/integrations/feishu";
import { fetchJson } from "@/server/integrations/http";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface NotifyInput {
  channel: "feishu" | "in_app";
  title: string;
  body: string;
  href?: string | null;
  severity?: string | null;
  dedupeKey?: string | null;
  userId?: number | null; // func#12 定向个人（null=广播）
  targetRole?: string | null; // 定向角色（null=全员）
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
    userId: n.userId ?? null,
    targetRole: n.targetRole ?? null,
  }).onConflictDoNothing();
  return true;
}

async function pushFeishu(url: string, title: string, body: string, href?: string | null): Promise<void> {
  const text = `【供应链】${title}\n${body}${href ? `\n${href}` : ""}`;
  const payload = await fetchJson("飞书 webhook", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
  }, { retries: 0 });
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("飞书 webhook 响应结构非法");
  }
  const envelope = payload as Record<string, unknown>;
  const rawCode = envelope.code ?? envelope.StatusCode;
  const code = Number(rawCode);
  if (!Number.isFinite(code) || code !== 0) {
    throw new Error(`飞书 webhook 业务失败 (${Number.isFinite(code) ? code : "unknown"})`);
  }
}

export interface DispatchSummary {
  sent: number;
  skipped: number;
  failed: number;
}

interface FeishuSender {
  sendText(input: {
    title: string;
    body: string;
    href?: string | null;
    uuid: string;
  }): Promise<unknown>;
}

export function isFeishuDeliveryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FEISHU_WEBHOOK_URL?.trim()) || feishuAppConfigFromEnv(env) !== null;
}

/** 分发 pending 通知；应用机器人优先，失败时若有 webhook 则回退。 */
export async function dispatchNotifications(
  db: AnyDb,
  opts?: {
    webhookUrl?: string | null;
    appClient?: FeishuSender | null;
  },
): Promise<DispatchSummary> {
  const selectionStartedAt = new Date();
  const staleLeaseBefore = new Date(selectionStartedAt.getTime() - 10 * 60 * 1000);
  const webhookUrl = opts && Object.hasOwn(opts, "webhookUrl")
    ? opts.webhookUrl ?? null
    : process.env.FEISHU_WEBHOOK_URL?.trim() || null;
  const envAppConfig = feishuAppConfigFromEnv();
  const appClient: FeishuSender | null = opts && Object.hasOwn(opts, "appClient")
    ? opts.appClient ?? null
    : envAppConfig ? new FeishuAppClient(envAppConfig) : null;
  const pending: {
    id: number;
    channel: string;
    title: string;
    body: string;
    href: string | null;
  }[] = await db
    .select({
      id: notifications.id,
      channel: notifications.channel,
      title: notifications.title,
      body: notifications.body,
      href: notifications.href,
    })
    .from(notifications)
    .where(or(
      inArray(notifications.status, ["pending", "failed"]),
      and(
        eq(notifications.status, "sending"),
        lt(notifications.dispatchStartedAt, staleLeaseBefore),
      ),
    ))
    .limit(200);
  let sent = 0, skipped = 0, failed = 0;
  for (const p of pending) {
    const claimStartedAt = new Date();
    const claimStaleBefore = new Date(claimStartedAt.getTime() - 10 * 60 * 1000);
    const [claimed]: { id: number }[] = await db.update(notifications).set({
      status: "sending",
      dispatchStartedAt: claimStartedAt,
      attemptCount: sql`${notifications.attemptCount} + 1`,
      error: null,
    }).where(and(
      eq(notifications.id, p.id),
      or(
        inArray(notifications.status, ["pending", "failed"]),
        and(
          eq(notifications.status, "sending"),
          lt(notifications.dispatchStartedAt, claimStaleBefore),
        ),
      ),
    )).returning({ id: notifications.id });
    if (!claimed) continue;

    if (p.channel === "in_app") {
      await db.update(notifications).set({
        status: "sent",
        sentAt: new Date(),
        dispatchStartedAt: null,
      }).where(eq(notifications.id, p.id));
      sent++;
      continue;
    }
    if (p.channel === "feishu") {
      if (!appClient && !webhookUrl) {
        await db.update(notifications).set({
          status: "skipped",
          error: "未配置飞书应用（FEISHU_APP_ID/SECRET/CHAT_ID）或 FEISHU_WEBHOOK_URL",
          dispatchStartedAt: null,
        }).where(eq(notifications.id, p.id));
        skipped++;
        continue;
      }
      try {
        if (appClient) {
          try {
            await appClient.sendText({
              title: p.title,
              body: p.body,
              href: p.href,
              uuid: `scm-notification-${p.id}`,
            });
          } catch (appError) {
            if (!webhookUrl) throw appError;
            await pushFeishu(webhookUrl, p.title, p.body, p.href);
          }
        } else if (webhookUrl) {
          await pushFeishu(webhookUrl, p.title, p.body, p.href);
        }
        await db.update(notifications).set({
          status: "sent",
          sentAt: new Date(),
          error: null,
          dispatchStartedAt: null,
        }).where(eq(notifications.id, p.id));
        sent++;
      } catch (e) {
        await db.update(notifications).set({
          status: "failed",
          error: (e as Error).message.slice(0, 300),
          dispatchStartedAt: null,
        }).where(eq(notifications.id, p.id));
        failed++;
      }
      continue;
    }
    await db.update(notifications).set({
      status: "skipped",
      error: `未知渠道 ${p.channel}`,
      dispatchStartedAt: null,
    }).where(eq(notifications.id, p.id));
    skipped++;
  }
  return { sent, skipped, failed };
}

/**
 * 把关键异常入队——复用控制塔唯一异常源（Wave BB struct#9/#10：不手写第三份）。
 *
 * 去重策略（2026-07-25 审计整改）。原实现 dedupeKey=`${key}:${today}`＝**每天必推一条**，
 * 无 severity 过滤、内容一字不变也照推：像「成品缺生产周期 506 个」这种只会随主数据
 * 补齐而变化的静态事实，每天生成一条新未读。而通知表无保留期、列表硬截断 100 条且无分页，
 * 按 3 条/天无衰减累积，约 33 天后日推摘要占满唯一视图，真实事件通知被永久挤出。
 *
 * 现在两道闸：
 *  ① **内容去重**：dedupeKey 含 impact 文案的指纹——数字没变就不再推，
 *     变了才算“新消息”。静态事实自然只推一次。
 *  ② **节流窗口**：critical/high 最多每天一条；medium 降为每 ISO 周一条
 *     （medium 多为待补主数据这类慢变量，天天提醒只会训练用户无视）。
 */
export async function runExceptionNotify(db: AnyDb): Promise<{ enqueued: number }> {
  const today = todayShanghai();
  const channel: NotifyInput["channel"] = isFeishuDeliveryConfigured() ? "feishu" : "in_app";
  let enqueued = 0;
  const exceptions = await computeExceptions(db); // 与工作台控制塔/驾驶舱同源同口径
  for (const ex of exceptions) {
    // 内容指纹：同一异常、同一措辞（含计数）→ 同一 key → 不重复入队
    const fingerprint = fnv1a(`${ex.title}|${ex.impact}`);
    /* 节流窗口。**内容指纹只有在窗口不变时才起降噪作用**——
       首版对 critical/high 仍取 today，于是文案一字不变也照旧每天一条新未读，
       指纹形同虚设（我在源码注释里写的「静态事实自然只推一次」当时是不实描述）。
       现在窗口只在**内容变化时**才推进：指纹相同即复用同一个 dedupeKey，
       跨天不再重复入队；medium 另按 ISO 周降频，慢变量连周内变化也不刷屏。 */
    const window = ex.severity === "medium" ? isoWeekOf(today) : "by-content";
    if (await enqueueNotification(db, {
      channel, title: ex.title, body: ex.impact, href: ex.href, severity: ex.severity,
      dedupeKey: `${ex.key}:${window}:${fingerprint}`, targetRole: "pmc",
    })) enqueued++;
  }
  return { enqueued };
}

/**
 * E7-15：周度决策摘要订阅。
 *
 * 没有飞书应用/webhook 时仍投递站内通知；任选一路配置后沿用同一 outbox 自动出圈。
 * 每个数据最新月只入队一次，避免调度器每周重复推送完全相同的月事实。
 */
export async function runDecisionDigestNotify(db: AnyDb): Promise<{ enqueued: number; month: string | null }> {
  const studio = await getDecisionStudio({ dimension: "brand" }, db);
  if (!studio.latestMonth) return { enqueued: 0, month: null };
  const channel: NotifyInput["channel"] = isFeishuDeliveryConfigured() ? "feishu" : "in_app";
  const body = studio.review.bullets.join("\n");
  const created = await enqueueNotification(db, {
    channel,
    title: `${studio.latestMonth} 经营决策摘要`,
    body,
    href: "/report/decision-studio?tab=review",
    severity: "info",
    dedupeKey: `decision-digest:${studio.latestMonth}`,
    targetRole: "pmc",
  });
  return { enqueued: created ? 1 : 0, month: studio.latestMonth };
}

/** 32 位 FNV-1a：稳定、无依赖、够用于文案指纹（非安全用途） */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** ISO 周键 YYYY-Www（Asia/Shanghai 日界，输入为 YYYY-MM-DD） */
function isoWeekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dow + 3); // 移到本周周四
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
