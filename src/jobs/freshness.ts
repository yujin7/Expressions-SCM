/**
 * B 项：参考数据新鲜度看门狗（spec/13 §三 B——周更靠人会忘，靠系统提醒）。
 *
 * 逐 kind 检查 transit_refs 最近导入时间（max(createdAt)），超阈值则开
 * system_alerts（category=data_freshness，refKey=kind）提醒重传；同 kind 已有
 * open 项则不重复开（幂等，双调度并存无害）。数据重传后本任务自动关闭（导入时间刷新 → 自动关闭）。
 *
 * 阈值（自然日）：stock_summary/fg_order 7 天（周更节奏）；pallet/demand 40 天（月更+缓冲）。
 * sales_monthly 另查 max(yearMonth)：晚于 45 天视为断更。
 *
 * W1（路线图）：不再手写 insert/update system_alerts，统一走 alerts/engine.upsertAlerts——
 * 去重键幂等（dedupeKey = data_freshness:<kind>）、责任角色取 rules/task-triggers.ALERT_OWNER_ROLE（唯一权威）、
 * 动作链接直达数据中心文件上传、sourceRule/paramsSnapshot/why 同行落库、事件进 alert_events 台账。
 * autoCloseAfterDays=0：重传即刷新导入时间，是硬事实，不再命中即刻关闭——与迁移前一致。
 * 系统写入，不写 audit_logs（与 doc-aging / transfer_cost 同口径）。
 */
import { eq, sql } from "drizzle-orm";
import { salesMonthly, transitRefs } from "@/db/schema";
import { backfillAlertDedupeKeys, upsertAlerts, type AlertCandidate } from "@/server/modules/alerts/engine";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const DAY_MS = 86_400_000;

export const ALERT_CATEGORY = "data_freshness";
export const FRESHNESS_SOURCE_RULE = "jobs/freshness（参考数据最大账龄）";
export const FRESHNESS_ACTION_HREF = "/import/upload";

export const FRESHNESS_RULES: { kind: string; maxAgeDays: number; label: string }[] = [
  { kind: "stock_summary", maxAgeDays: 7, label: "总库存明细（全口径核对/防重复下单抑制依赖）" },
  { kind: "fg_order", maxAgeDays: 7, label: "在途订单进度表（存量在途口径依赖）" },
  { kind: "pallet", maxAgeDays: 40, label: "总货盘情况表（处置注记依赖）" },
  { kind: "demand", maxAgeDays: 40, label: "需求&达成统计表" },
];
export const SALES_MAX_AGE_DAYS = 45;

export interface FreshnessSummary {
  opened: number;
  autoClosed: number;
  /** 已开告警本轮再次命中（账龄刷新） */
  refreshed: number;
  /** 本轮回填 dedupe_key 的历史行数 */
  backfilled: number;
  stale: string[];
}

export async function runFreshnessCheck(db: AnyDb, opts?: { now?: Date }): Promise<FreshnessSummary> {
  const now = opts?.now ?? new Date();
  const backfilled = await backfillAlertDedupeKeys(db, ALERT_CATEGORY);
  const stale: string[] = [];
  const candidates: AlertCandidate[] = [];

  const push = (
    refKey: string,
    title: string,
    detail: string,
    params: Record<string, unknown>,
    why: { label: string; value: string; source: string }[],
  ) => {
    stale.push(refKey);
    candidates.push({
      refKey,
      dedupeKey: `${ALERT_CATEGORY}:${refKey}`,
      title,
      detail,
      severity: "high",
      ownerRole: ALERT_OWNER_ROLE[ALERT_CATEGORY],
      actionHref: FRESHNESS_ACTION_HREF,
      sourceRule: FRESHNESS_SOURCE_RULE,
      paramsSnapshot: params,
      why,
    });
  };

  for (const rule of FRESHNESS_RULES) {
    const [row]: { latest: string | Date | null }[] = await db
      .select({ latest: sql`max(${transitRefs.createdAt})` })
      .from(transitRefs)
      .where(eq(transitRefs.kind, rule.kind));
    const latest = row?.latest ? new Date(row.latest) : null;
    const ageDays = latest ? Math.floor((now.getTime() - latest.getTime()) / DAY_MS) : null;
    const isStale = latest != null && ageDays! > rule.maxAgeDays; // 从未导入不告警（未启用的口径不扰民）
    if (!isStale) continue;
    const latestDay = latest!.toISOString().slice(0, 10);
    push(
      rule.kind,
      `参考数据过期：${rule.label}`,
      `kind=${rule.kind} 最近导入 ${latestDay}，已 ${ageDays} 天（阈值 ${rule.maxAgeDays} 天）——请到数据中心→文件上传重传对应文件`,
      { kind: rule.kind, latestImportedAt: latestDay, ageDays, maxAgeDays: rule.maxAgeDays },
      [
        { label: "最近导入", value: `${latestDay}（已 ${ageDays} 天）`, source: "transit_refs.created_at" },
        { label: "阈值", value: `${rule.maxAgeDays} 天`, source: FRESHNESS_SOURCE_RULE },
        { label: "影响口径", value: rule.label, source: "spec/13 §三 B" },
      ],
    );
  }

  /* 销量月表断更检查（月中导上月数据的节奏 → 45 天缓冲） */
  const [{ maxYm }]: { maxYm: string | null }[] = await db
    .select({ maxYm: sql`max(${salesMonthly.yearMonth})` })
    .from(salesMonthly);
  if (maxYm) {
    const monthEnd = new Date(Date.parse(`${maxYm}-01T00:00:00Z`));
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1); // 数据月次月 1 日
    const ageDays = Math.floor((now.getTime() - monthEnd.getTime()) / DAY_MS);
    if (ageDays > SALES_MAX_AGE_DAYS) {
      push(
        "sales_monthly",
        "参考数据过期：月度销量表（销速/滞销/补货全依赖）",
        `最新数据月 ${maxYm}，距今 ${ageDays} 天（阈值 ${SALES_MAX_AGE_DAYS} 天）——请导入新月份销量`,
        { kind: "sales_monthly", latestYearMonth: maxYm, ageDays, maxAgeDays: SALES_MAX_AGE_DAYS },
        [
          { label: "最新数据月", value: `${maxYm}（距今 ${ageDays} 天）`, source: "sales_monthly.year_month" },
          { label: "阈值", value: `${SALES_MAX_AGE_DAYS} 天（月中导上月的节奏 + 缓冲）`, source: FRESHNESS_SOURCE_RULE },
          { label: "影响口径", value: "销速 / 滞销 / 补货建议", source: "core/velocity" },
        ],
      );
    }
  }

  const res = await upsertAlerts(db, {
    category: ALERT_CATEGORY,
    candidates,
    now,
    autoCloseAfterDays: 0, // 重传即关：导入时间刷新是硬事实，不需要数据缺口迟滞
  });
  return { opened: res.opened, autoClosed: res.autoClosed, refreshed: res.refreshed, backfilled, stale };
}
