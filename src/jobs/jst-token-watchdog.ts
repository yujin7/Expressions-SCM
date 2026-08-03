/**
 * 聚水潭 access_token 到期看门狗。
 *
 * 官方文档（open.jushuitan.com/document/2135.html，2026-08-04 查）：
 *  - 新商家 token 有效期 **一年**；
 *  - **到期前一周内可刷新**，刷新后 token 值不变、只延长有效期；
 *  - 刷新后接口有缓存，需稍等再调业务接口；
 *  - 过期后无法再刷新，只能让商家重走授权。
 *
 * 有效期按租户/接入方式可能不同，故 TTL 走环境变量 `JST_TOKEN_TTL_DAYS` 配置，
 * 默认取官方对新商家的一年——**不把猜测写死在代码里**。
 *
 * 刷新接口的确切入参未在可访问的公开文档页给出，因此本模块**不实现刷新调用**
 * （凭想象拼参数＝把猜测伪装成实现）。看门狗只做一件确定的事：
 * 在仍处于可刷新窗口时把事情喊出来，让 token 不会走到"过期了只能重新授权"那一步。
 *
 * 密钥姿态不变：token **不入库**，只读 env。
 */
import { and, eq } from "drizzle-orm";
import { systemAlerts } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** 官方对新商家为一年；不同租户可能不同，故可用 JST_TOKEN_TTL_DAYS 覆盖 */
export const JST_TOKEN_TTL_DAYS_DEFAULT = 365;
/** 与官方"到期前一周内可刷新"的窗口对齐 */
export const JST_TOKEN_WARN_DAYS = 7;

export function jstTokenTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JST_TOKEN_TTL_DAYS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value > 0 && value <= 3650) return value;
  }
  return JST_TOKEN_TTL_DAYS_DEFAULT;
}
const ALERT_CATEGORY = "integration_token";
const ALERT_REF = "jst_access_token";

export interface JstTokenWatchdogSummary {
  status: "skipped" | "checked";
  reason?: string;
  daysRemaining?: number;
  opened: number;
  autoClosed: number;
}

/**
 * token 取得时间。授权/刷新脚本会写入 `JST_TOKEN_OBTAINED_AT`（ISO 时刻）。
 * 缺失时返回 null——**不猜**，宁可报"无法评估"也不假装还早。
 */
export function jstTokenObtainedAt(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = env.JST_TOKEN_OBTAINED_AT?.trim();
  if (!raw) return null;
  const instant = Date.parse(raw);
  return Number.isFinite(instant) ? new Date(instant) : null;
}

export function jstTokenDaysRemaining(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): number | null {
  const obtainedAt = jstTokenObtainedAt(env);
  if (!obtainedAt) return null;
  const elapsedDays = (now.getTime() - obtainedAt.getTime()) / DAY_MS;
  return Math.floor(jstTokenTtlDays(env) - elapsedDays);
}

export async function runJstTokenWatchdog(
  db: AnyDb,
  opts?: { now?: Date; env?: NodeJS.ProcessEnv },
): Promise<JstTokenWatchdogSummary> {
  const now = opts?.now ?? new Date();
  const env = opts?.env ?? process.env;

  if (!env.JST_ACCESS_TOKEN?.trim()) {
    // 还没授权，不是"快过期"，不扰民
    return { status: "skipped", reason: "尚未配置 JST_ACCESS_TOKEN", opened: 0, autoClosed: 0 };
  }

  const open: { id: number }[] = await db
    .select({ id: systemAlerts.id })
    .from(systemAlerts)
    .where(and(
      eq(systemAlerts.category, ALERT_CATEGORY),
      eq(systemAlerts.refKey, ALERT_REF),
      eq(systemAlerts.status, "open"),
    ));

  const daysRemaining = jstTokenDaysRemaining(env, now);

  // 不知道什么时候取的 token，等于不知道还剩几天——这本身要告警，不能当没事
  if (daysRemaining === null) {
    if (open.length === 0) {
      await db.insert(systemAlerts).values({
        category: ALERT_CATEGORY,
        refKey: ALERT_REF,
        title: "聚水潭 token 到期时间未知",
        detail: "缺少 JST_TOKEN_OBTAINED_AT，无法评估有效期。"
          + "请在刷新或重新授权后记录取得时刻，否则 token 会在无人察觉时失效，"
          + "届时无法用刷新接口，必须让商家重走一遍授权。",
        severity: "high",
      });
      return { status: "checked", opened: 1, autoClosed: 0 };
    }
    return { status: "checked", opened: 0, autoClosed: 0 };
  }

  const needsAttention = daysRemaining <= JST_TOKEN_WARN_DAYS;
  if (needsAttention) {
    if (open.length === 0) {
      const expired = daysRemaining < 0;
      await db.insert(systemAlerts).values({
        category: ALERT_CATEGORY,
        refKey: ALERT_REF,
        title: expired ? "聚水潭 token 已过期" : `聚水潭 token 还有 ${daysRemaining} 天过期`,
        detail: expired
          ? "已超过有效期。刷新接口对已过期 token 无效，只能让商家重新授权："
            + "`npm run jst:auth-url` 生成链接 → 商家同意 → `npx tsx scripts/jst-exchange-code.ts <code>`。"
          : "处于官方「到期前一周可刷新」窗口内：请在聚水潭开放平台完成 token 刷新"
            + "（刷新后 token 值不变、仅延长有效期），随后更新 JST_TOKEN_OBTAINED_AT。"
            + "务必在窗口内处理——一旦过期就**不能再刷新**，只能让商家重走授权："
            + "`npm run jst:auth-url`。",
        severity: "high",
      });
      return { status: "checked", daysRemaining, opened: 1, autoClosed: 0 };
    }
    return { status: "checked", daysRemaining, opened: 0, autoClosed: 0 };
  }

  // 已刷新 → 自动关闭（系统自动，非人工裁决）
  let autoClosed = 0;
  for (const alert of open) {
    await db.update(systemAlerts).set({
      status: "resolved",
      autoResolved: true,
      resolvedAt: now,
    }).where(eq(systemAlerts.id, alert.id));
    autoClosed++;
  }
  return { status: "checked", daysRemaining, opened: 0, autoClosed };
}
