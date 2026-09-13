/**
 * 通知 → 来源对象的反查（W2）——纯导航模块，服务端与测试同源。
 *
 * 背景：`jobs/system-alert-notify` 把每条未处理 `system_alerts` 推进发件箱，
 * dedupeKey 写成 `system_alert:<alertId>`（数据产品门禁多一段角色后缀 `:<role>`），
 * 而通知的 `href` 指向的是**处置页**（告警行自己的 actionHref，比如 /inventory/alerts?tab=cover）。
 * 于是通知中心里没有任何一条路能回到「这条通知说的那条告警」——
 * 看不到它的规则来源、参数快照、已知悉状态，也看不出它是不是已经被关掉了。
 *
 * 这里是那条反查的**唯一实现**：dedupeKey 的构造在 `jobs/system-alert-notify`，解析在这里，
 * 两边由 `tests/jobs/system-alert-notify.test.ts` 钉住同一份规则，不允许页面自己再写一个正则。
 * 放在 `src/lib` 而不是 `src/server`：通知中心是 `"use client"` 组件，禁止值导入 @/server/*。
 */
import { sopCycleHref } from "@/lib/sop-links";

/** Upgrade only the exact historical home link with a known structured SOP notification key.
 * This is a read projection after recipient filtering, never a rewrite of notification history.
 * Unknown keys/custom links stay unchanged; the destination still checks current access/state.
 */
export function notificationActionHref(href: string | null, dedupeKey: string | null): string | null {
  if (href !== "/replenish/sop" || !dedupeKey) return href;
  const key = /^sop:([1-9]\d*):v([1-9]\d*):(await|reject|frozen):(ops|pmc|finance)$/.exec(dedupeKey);
  if (!key || Number(key[2]) > 2_147_483_647) return href;
  return sopCycleHref(Number(key[1])) ?? href;
}

/** 系统告警通知的 dedupeKey 前缀（与 jobs/system-alert-notify 的构造一致） */
export const SYSTEM_ALERT_DEDUPE_PREFIX = "system_alert:";

const SYSTEM_ALERT_KEY = /^system_alert:(\d+)(?::.+)?$/;

/** `system_alert:42` / `system_alert:42:pmc` → 42；其它通知 → null */
export function alertIdOfNotification(dedupeKey: string | null | undefined): number | null {
  if (!dedupeKey) return null;
  const m = SYSTEM_ALERT_KEY.exec(dedupeKey);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 单条告警的深链（/alerts 按 id 精确定位，忽略状态筛选——已关闭的也要能看到） */
export function alertDeepLink(alertId: number): string {
  return `/alerts?id=${alertId}`;
}
