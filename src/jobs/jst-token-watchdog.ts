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
 *
 * W1（路线图）：告警写入统一走 alerts/engine.upsertAlerts——去重键幂等
 * （dedupeKey = integration_token:jst_access_token）、责任角色取 rules/task-triggers.ALERT_OWNER_ROLE（唯一权威）、
 * 动作链接直达集成健康页、sourceRule/paramsSnapshot/why 同行落库、事件进 alert_events 台账。
 * autoCloseAfterDays=0：刷新后剩余天数回到窗口外是硬事实，不再命中即刻关闭——与迁移前一致。
 * why/detail 只写"还剩几天"，**绝不写 token 本身或取得时刻以外的任何凭据片段**。
 */
import type { AnyDb } from "@/server/import/staging";
import { backfillAlertDedupeKeys, upsertAlerts, type AlertCandidate } from "@/server/modules/alerts/engine";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";

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
export const ALERT_CATEGORY = "integration_token";
export const ALERT_REF = "jst_access_token";
export const JST_TOKEN_SOURCE_RULE = "jobs/jst-token-watchdog（官方可刷新窗口 7 天）";
export const JST_TOKEN_ACTION_HREF = "/admin/health";

export interface JstTokenWatchdogSummary {
  status: "skipped" | "checked";
  reason?: string;
  daysRemaining?: number;
  opened: number;
  autoClosed: number;
  /** 已开告警本轮再次命中（剩余天数刷新） */
  refreshed?: number;
  /** 本轮回填 dedupe_key 的历史行数 */
  backfilled?: number;
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
    // 还没授权，不是"快过期"，不扰民（也不动既有告警：没配置≠已解决）
    return { status: "skipped", reason: "尚未配置 JST_ACCESS_TOKEN", opened: 0, autoClosed: 0 };
  }

  const daysRemaining = jstTokenDaysRemaining(env, now);
  const candidate = (
    title: string,
    detail: string,
    params: Record<string, unknown>,
    why: { label: string; value: string; source: string }[],
  ): AlertCandidate => ({
    refKey: ALERT_REF,
    dedupeKey: `${ALERT_CATEGORY}:${ALERT_REF}`,
    title,
    detail,
    severity: "high",
    ownerRole: ALERT_OWNER_ROLE[ALERT_CATEGORY],
    actionHref: JST_TOKEN_ACTION_HREF,
    sourceRule: JST_TOKEN_SOURCE_RULE,
    paramsSnapshot: params,
    why,
  });

  const candidates: AlertCandidate[] = [];
  // 不知道什么时候取的 token，等于不知道还剩几天——这本身要告警，不能当没事
  if (daysRemaining === null) {
    candidates.push(candidate(
      "聚水潭 token 到期时间未知",
      "缺少 JST_TOKEN_OBTAINED_AT，无法评估有效期。"
        + "请在刷新或重新授权后记录取得时刻，否则 token 会在无人察觉时失效，"
        + "届时无法用刷新接口，必须让商家重走一遍授权。",
      { ref: ALERT_REF, daysRemaining: null, ttlDays: jstTokenTtlDays(env), warnDays: JST_TOKEN_WARN_DAYS },
      [
        { label: "剩余有效期", value: "未知（缺 JST_TOKEN_OBTAINED_AT）", source: "env" },
        { label: "有效期设定", value: `${jstTokenTtlDays(env)} 天`, source: "JST_TOKEN_TTL_DAYS / 官方新商家一年" },
        { label: "可刷新窗口", value: `到期前 ${JST_TOKEN_WARN_DAYS} 天内`, source: "聚水潭开放平台文档 2135" },
      ],
    ));
  } else if (daysRemaining <= JST_TOKEN_WARN_DAYS) {
    const expired = daysRemaining < 0;
    candidates.push(candidate(
      expired ? "聚水潭 token 已过期" : `聚水潭 token 还有 ${daysRemaining} 天过期`,
      expired
        ? "已超过有效期。刷新接口对已过期 token 无效，只能让商家重新授权："
          + "`npm run jst:auth-url` 生成链接 → 商家同意 → `npx tsx scripts/jst-exchange-code.ts <code>`。"
        : "处于官方「到期前一周可刷新」窗口内：请在聚水潭开放平台完成 token 刷新"
          + "（刷新后 token 值不变、仅延长有效期），随后更新 JST_TOKEN_OBTAINED_AT。"
          + "务必在窗口内处理——一旦过期就**不能再刷新**，只能让商家重走授权："
          + "`npm run jst:auth-url`。",
      { ref: ALERT_REF, daysRemaining, expired, ttlDays: jstTokenTtlDays(env), warnDays: JST_TOKEN_WARN_DAYS },
      [
        { label: "剩余有效期", value: expired ? `已过期 ${-daysRemaining} 天` : `${daysRemaining} 天`, source: "JST_TOKEN_OBTAINED_AT + TTL" },
        { label: "可刷新窗口", value: expired ? "已错过（只能重新授权）" : `到期前 ${JST_TOKEN_WARN_DAYS} 天内`, source: "聚水潭开放平台文档 2135" },
        { label: "有效期设定", value: `${jstTokenTtlDays(env)} 天`, source: "JST_TOKEN_TTL_DAYS / 官方新商家一年" },
      ],
    ));
  }

  const backfilled = await backfillAlertDedupeKeys(db, ALERT_CATEGORY);
  const res = await upsertAlerts(db, {
    category: ALERT_CATEGORY,
    candidates,
    now,
    autoCloseAfterDays: 0, // 刷新后即关：剩余天数回到窗口外是硬事实，不需要数据缺口迟滞
  });
  return {
    status: "checked",
    ...(daysRemaining === null ? {} : { daysRemaining }),
    opened: res.opened,
    autoClosed: res.autoClosed,
    refreshed: res.refreshed,
    backfilled,
  };
}
