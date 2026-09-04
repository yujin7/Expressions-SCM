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
 *  - **收件角色取告警行自己的 owner_role**（W1 后各看门狗统一按 rules/task-triggers.ALERT_OWNER_ROLE 落库），
 *    行上没有（引擎接入前的历史行）才回落到本文件的类别表——本文件不再是责任角色的第二套真相。
 *  - 数据产品门禁例外：责任角色随产品变（product.ownerRoles），按产品动态分派，
 *    且只有它的 dedupeKey 带角色后缀，因此确实会给每个责任角色各发一条。
 *    其余类别的 dedupeKey 只绑告警 id（历史决定：升级时不把所有未关闭告警按角色重推一遍），
 *    所以**每条告警只会落一条通知**——收件人就是责任角色本人，不做抄送假象。
 *  - **动作链接取告警行自己的 action_href**，缺失才回落类别表——「去处理」在页面与通知里是同一个落点。
 *  - 飞书未配置时降级为站内通知，不静默丢弃。
 */
import { and, eq } from "drizzle-orm";
import { systemAlerts } from "@/db/schema";
import { DATA_PRODUCTS } from "@/components/data-products";
import type { AnyDb } from "@/server/import/staging";
import { enqueueNotification, isFeishuDeliveryConfigured } from "./notify";

/** 告警类别 → 中文名，用于通知标题（与 /alerts 页 CAT 同源同口径） */
const CATEGORY_LABEL: Record<string, string> = {
  data_freshness: "数据过期",
  doc_aging: "单据超时",
  integration_token: "凭据到期",
  job_failure: "任务失败",
  data_product_gate: "决策门禁降级",
  inventory_cover: "断货预警",
  sales_spike: "爆单预警",
  transfer_cost: "调拨成本异常",
  data_quality: "数据质量核对",
  /* W2 审计 5 新增的四类（procurement-quality-alerts）。补登记于 2026-09-04：
     /alerts 页的 CAT 映射当时补了，本表漏了——于是同一条告警在页面上叫「交期承诺违约」，
     推到站内/飞书的标题却是「【promise_breach】…」。中文界面里的英文 slug
     会被当成系统噪音直接略过，等于把这条通知的处置概率打了折。
     `tests/architecture/alert-category-labels.test.ts` 现在同时钉住这两张表。 */
  supplier_license: "供应商证照到期",
  promise_breach: "交期承诺违约",
  otif_collapse: "供应商 OTIF 崩塌",
  quality_case_overdue: "质量案件逾期",
};

/** 回落责任角色：只用于 owner_role 为空的历史行（引擎接入前手写的告警），口径与迁移前首位角色一致 */
const CATEGORY_PRIMARY: Record<string, string> = {
  inventory_cover: "pmc",
  sales_spike: "ops",
  transfer_cost: "warehouse",
};

export interface AlertNotifyRow {
  category: string;
  refKey: string | null;
  ownerRole?: string | null;
  actionHref?: string | null;
}

/** refKey `<productId>:<releaseId>` → 产品定义（数据产品门禁的责任角色随产品变） */
function dataProductOf(refKey: string | null) {
  if (!refKey) return null;
  const productId = refKey.slice(0, refKey.lastIndexOf(":"));
  return DATA_PRODUCTS.find((item) => item.id === productId) ?? null;
}

export function alertAudience(alert: AlertNotifyRow): string[] {
  if (alert.category === "data_product_gate") {
    const product = dataProductOf(alert.refKey);
    if (product) return [...new Set<string>(product.ownerRoles)];
  }
  return [alert.ownerRole?.trim() || CATEGORY_PRIMARY[alert.category] || "admin"];
}

export function alertHref(alert: AlertNotifyRow): string {
  const own = alert.actionHref?.trim();
  if (own) return own;
  if (alert.category === "inventory_cover") return "/inventory/alerts?tab=cover";
  if (alert.category === "sales_spike") return "/inventory/alerts?tab=spike";
  if (alert.category === "transfer_cost") return "/inventory/transfer-routes?tab=anomalies";
  const product = alert.category === "data_product_gate" ? dataProductOf(alert.refKey) : null;
  if (product) return `/report/decision-studio?tab=readiness&product=${encodeURIComponent(product.id)}#data-product-${encodeURIComponent(product.id)}`;
  return "/alerts";
}

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
    ownerRole: string | null;
    actionHref: string | null;
  }[] = await db
    .select({
      id: systemAlerts.id,
      category: systemAlerts.category,
      refKey: systemAlerts.refKey,
      title: systemAlerts.title,
      detail: systemAlerts.detail,
      severity: systemAlerts.severity,
      ownerRole: systemAlerts.ownerRole,
      actionHref: systemAlerts.actionHref,
    })
    .from(systemAlerts)
    .where(eq(systemAlerts.status, "open"));

  let enqueued = 0;
  for (const alert of open) {
    const label = CATEGORY_LABEL[alert.category] ?? alert.category;
    for (const targetRole of alertAudience(alert)) {
      if (await enqueueNotification(db, {
        channel,
        title: `【${label}】${alert.title}`,
        body: alert.detail ?? "",
        href: alertHref(alert),
        severity: alert.severity,
        // 旧告警保留既有 key，避免升级时把所有未关闭告警重推；门禁告警才按责任角色拆分。
        dedupeKey: alert.category === "data_product_gate"
          ? `system_alert:${alert.id}:${targetRole}`
          : `system_alert:${alert.id}`,
        targetRole,
      })) enqueued++;
    }
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
