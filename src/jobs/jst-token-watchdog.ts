/**
 * 聚水潭 access_token 到期看门狗。
 *
 * 事故预防（2026-08-04 查官方文档确认）：聚水潭 token **默认 30 天过期**，
 * 且——这是最要命的一条——**一旦过期就不能再用刷新接口，必须让商家重走一遍授权**。
 * 也就是说：授权当天一切正常，一个月后静默失效，然后要再去后台点一次 OAuth。
 *
 * 本仓的密钥姿态是「只存 env、不入库」，所以这里**不把 token 写进数据库**。
 * 看门狗只做一件事：在还来得及刷新的时候把事情喊出来（system_alerts + 通知），
 * 让 token 永远不会走到"过期了只能重新授权"那一步。
 *
 * 刷新动作本身由 `npx tsx src/jobs/cli.ts refresh-jst-token` 执行并写回 .env
 * （与 scripts/jst-exchange-code.ts 同一套路径），保持密钥只在 env 一处。
 */
import { and, eq } from "drizzle-orm";
import { systemAlerts } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** 官方默认 30 天 */
export const JST_TOKEN_TTL_DAYS = 30;
/** 剩余不足这个天数就开告警——留足人工处理窗口，别卡在最后一天 */
export const JST_TOKEN_WARN_DAYS = 7;
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
  return Math.floor(JST_TOKEN_TTL_DAYS - elapsedDays);
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
        detail: "缺少 JST_TOKEN_OBTAINED_AT，无法评估 30 天有效期。"
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
          ? "已超过 30 天有效期。刷新接口对已过期 token 无效，需让商家重新授权："
            + "`npm run jst:auth-url` 生成链接 → 商家同意 → `npx tsx scripts/jst-exchange-code.ts <code>`。"
          : "请在过期前刷新：`npx tsx src/jobs/cli.ts refresh-jst-token`。"
            + "一旦过期就不能再刷新，只能让商家重走授权流程。",
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
