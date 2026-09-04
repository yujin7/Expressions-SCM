/**
 * license-alert（《02》§5）：营业执照 30 天到期/已过期提醒，纯查询、无副作用。
 *
 * 三道体量边界（C6，均为本模块导出的常量，改动要被代码评审看见）：
 * 状态白名单 `LICENSE_ALERT_ACTIVE_STATUSES`、已过期下界 `LICENSE_ALERT_EXPIRED_FLOOR_DAYS`、
 * 单批上限 `LICENSE_ALERT_MAX_ROWS`。没有它们时本任务对 156 家生产主数据首跑一次
 * 就能开出几十到上百条 high 告警（每条还投影一条采购待办），其中大量是
 * 早已过期若干年的、以及暂停/黑名单供应商——这些都不是「今天该做的事」。
 *
 * 决策（W4）：不写 audit_logs——audit_logs.user_id NOT NULL 且系统无 id=0 的「系统用户」，
 * 造一个伪用户违反主数据纪律；本任务为只读提醒（非业务写路径，CLAUDE.md 的
 * writeAudit 约定针对 service 写路径），结果由工作台/API 实时出数即可追溯。
 * 若 P1 需要留痕，应先补 system 用户主数据再回填。
 */
import { and, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { suppliers } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";

export const LICENSE_ALERT_WINDOW_DAYS = 30;

/**
 * 只对**还在做生意的**供应商提醒（C6）。
 *
 * 事故形态：本任务此前没有任何 `status` 过滤，导入的 156 家主数据里
 * 暂停（paused）与黑名单（blacklisted）供应商的证照照样 `severity: high` 起告警，
 * 而这些供应商本来就不许下新 PO——「去续期」对它们不是一个动作。
 * 每条 open 告警又会投影成一条采购待办，于是首跑一次就能开出几十上百条。
 * pending（在评估中）保留：证照有效性正是准入评估的内容。
 */
export const LICENSE_ALERT_ACTIVE_STATUSES = ["qualified", "pending"] as const;

/**
 * 过期多久之后不再算「可执行的提醒」（C6）。
 *
 * 下界此前是没有的：`license_expiry <= today+30` 会把导入主数据里
 * 早已过期若干年的证照全部拉进来，全部判 high。超过本天数的属于**主数据清理**问题，
 * 该由主数据治理批量处理，不该每 6 小时叫醒一次采购。
 */
export const LICENSE_ALERT_EXPIRED_FLOOR_DAYS = 180;

/**
 * 单批告警条数上限（C6 的**体量硬闸**）。
 *
 * 上面两道过滤是口径，这一道是兜底：主数据一次批量导入若把大量证照日期写成同一个过去日期，
 * 口径过滤挡不住，仍会一次性开出成百条告警与待办。按 daysLeft 升序取最紧的这些，
 * 其余计入 `truncated`/`totalCandidates` 如实上报——**截断必须可见**，不能静默丢。
 */
export const LICENSE_ALERT_MAX_ROWS = 50;

export interface LicenseAlertRow {
  supplierId: number;
  code: string;
  name: string;
  licenseExpiry: string; // YYYY-MM-DD
  /** 距到期天数；负数=已过期 N 天 */
  daysLeft: number;
}

export interface LicenseAlertSummary {
  today: string;
  windowDays: number;
  alertCount: number;
  alerts: LicenseAlertRow[];
  /** 过滤后的候选总数（截断前）——alertCount 只是本批实际下发的条数 */
  totalCandidates: number;
  /** true = 命中体量上限被截断，行数 < 候选数 */
  truncated: boolean;
  /** 生效的边界（供 paramsSnapshot 留痕） */
  expiredFloorDays: number;
  maxRows: number;
  statuses: readonly string[];
}

/** Asia/Shanghai 今日（YYYY-MM-DD） */
function todayShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);
}

/**
 * licenseExpiry ∈ [today−180, today+30]、且状态在 `LICENSE_ALERT_ACTIVE_STATUSES` 内的供应商，
 * 按 daysLeft 升序，最多 `LICENSE_ALERT_MAX_ROWS` 条（截断如实上报）。
 */
export async function runLicenseAlert(db: AnyDb, today?: string): Promise<LicenseAlertSummary> {
  const t = today ?? todayShanghai();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`today 格式须为 YYYY-MM-DD: ${t}`);
  const threshold = addDaysISO(t, LICENSE_ALERT_WINDOW_DAYS);
  const floor = addDaysISO(t, -LICENSE_ALERT_EXPIRED_FLOOR_DAYS);

  const rows: { id: number; code: string; name: string; licenseExpiry: string | null }[] = await db
    .select({
      id: suppliers.id,
      code: suppliers.code,
      name: suppliers.name,
      licenseExpiry: suppliers.licenseExpiry,
    })
    .from(suppliers)
    .where(and(
      isNotNull(suppliers.licenseExpiry),
      lte(suppliers.licenseExpiry, threshold),
      gte(suppliers.licenseExpiry, floor),
      inArray(suppliers.status, [...LICENSE_ALERT_ACTIVE_STATUSES]),
    ));

  const candidates: LicenseAlertRow[] = rows
    .filter((r): r is typeof r & { licenseExpiry: string } => r.licenseExpiry !== null)
    .map((r) => ({
      supplierId: r.id,
      code: r.code,
      name: r.name,
      licenseExpiry: r.licenseExpiry,
      daysLeft: diffDays(t, r.licenseExpiry),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const alerts = candidates.slice(0, LICENSE_ALERT_MAX_ROWS);

  return {
    today: t,
    windowDays: LICENSE_ALERT_WINDOW_DAYS,
    alertCount: alerts.length,
    alerts,
    totalCandidates: candidates.length,
    truncated: candidates.length > alerts.length,
    expiredFloorDays: LICENSE_ALERT_EXPIRED_FLOOR_DAYS,
    maxRows: LICENSE_ALERT_MAX_ROWS,
    statuses: LICENSE_ALERT_ACTIVE_STATUSES,
  };
}
