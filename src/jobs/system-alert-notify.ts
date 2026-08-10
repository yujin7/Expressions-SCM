/**
 * 把 system_alerts 推进通知发件箱（→ 飞书 / 站内）。
 *
 * 事故预防（2026-08-04）：`runExceptionNotify` 推的是**业务异常**（控制塔口径），
 * 而 `system_alerts` —— 数据过期、单据超时，以及本轮新增的**凭据到期、任务连续失败**
 * —— 只出现在 `/alerts` 页面，**从来不通知任何人**。
 *
 * 也就是说：三方同步挂了会开告警、聚水潭 token 快过期会开告警，
 * 但这些告警自己躺在一个没人主动打开的页面里。监控链路到此断掉，等于没监控。
 * 本任务把这段接上。
 *
 * 推送纪律：
 *  - 每条告警**只推一次**（dedupeKey 绑定告警 id）；已解决的不推。
 *  - 收件人是 admin：这些是运维/集成健康问题，不是 PMC 的业务待办，
 *    混进业务通知里只会稀释两边的信噪比。
 *  - 飞书未配置时降级为站内通知，不静默丢弃。
 */
import { and, eq } from "drizzle-orm";
import { systemAlerts } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";
import { enqueueNotification, isFeishuDeliveryConfigured } from "./notify";

/** 告警类别 → 中文名，用于通知标题（与 /alerts 页 CAT 同源同口径） */
const CATEGORY_LABEL: Record<string, string> = {
  data_freshness: "数据过期",
  doc_aging: "单据超时",
  integration_token: "凭据到期",
  job_failure: "任务失败",
};

export interface SystemAlertNotifySummary {
  enqueued: number;
  scanned: number;
}

export async function runSystemAlertNotify(
  db: AnyDb,
): Promise<SystemAlertNotifySummary> {
  const channel = isFeishuDeliveryConfigured() ? "feishu" as const : "in_app" as const;

  const open: {
    id: number;
    category: string;
    refKey: string | null;
    title: string;
    detail: string | null;
    severity: string | null;
  }[] = await db
    .select({
      id: systemAlerts.id,
      category: systemAlerts.category,
      refKey: systemAlerts.refKey,
      title: systemAlerts.title,
      detail: systemAlerts.detail,
      severity: systemAlerts.severity,
    })
    .from(systemAlerts)
    .where(eq(systemAlerts.status, "open"));

  let enqueued = 0;
  for (const alert of open) {
    const label = CATEGORY_LABEL[alert.category] ?? alert.category;
    if (await enqueueNotification(db, {
      channel,
      title: `【${label}】${alert.title}`,
      body: alert.detail ?? "",
      href: "/alerts",
      severity: alert.severity,
      // 绑定告警 id：同一条告警只推一次；关闭后再开是新 id，会重新推
      dedupeKey: `system_alert:${alert.id}`,
      targetRole: "admin",
    })) enqueued++;
  }

  return { enqueued, scanned: open.length };
}

/** 供测试与健康面板复用的只读判定：某类别是否有未处理告警 */
export async function hasOpenAlerts(db: AnyDb, category: string): Promise<boolean> {
  const rows: { id: number }[] = await db
    .select({ id: systemAlerts.id })
    .from(systemAlerts)
    .where(and(eq(systemAlerts.category, category), eq(systemAlerts.status, "open")))
    .limit(1);
  return rows.length > 0;
}
