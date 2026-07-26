/**
 * license-alert（《02》§5）：营业执照 30 天到期/已过期提醒，纯查询、无副作用。
 *
 * 决策（W4）：不写 audit_logs——audit_logs.user_id NOT NULL 且系统无 id=0 的「系统用户」，
 * 造一个伪用户违反主数据纪律；本任务为只读提醒（非业务写路径，CLAUDE.md 的
 * writeAudit 约定针对 service 写路径），结果由工作台/API 实时出数即可追溯。
 * 若 P1 需要留痕，应先补 system 用户主数据再回填。
 */
import { and, isNotNull, lte } from "drizzle-orm";
import { suppliers } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";

export const LICENSE_ALERT_WINDOW_DAYS = 30;

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

/** licenseExpiry ≤ today+30（含已过期）的供应商，按 daysLeft 升序 */
export async function runLicenseAlert(db: AnyDb, today?: string): Promise<LicenseAlertSummary> {
  const t = today ?? todayShanghai();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`today 格式须为 YYYY-MM-DD: ${t}`);
  const threshold = addDaysISO(t, LICENSE_ALERT_WINDOW_DAYS);

  const rows: { id: number; code: string; name: string; licenseExpiry: string | null }[] = await db
    .select({
      id: suppliers.id,
      code: suppliers.code,
      name: suppliers.name,
      licenseExpiry: suppliers.licenseExpiry,
    })
    .from(suppliers)
    .where(and(isNotNull(suppliers.licenseExpiry), lte(suppliers.licenseExpiry, threshold)));

  const alerts: LicenseAlertRow[] = rows
    .filter((r): r is typeof r & { licenseExpiry: string } => r.licenseExpiry !== null)
    .map((r) => ({
      supplierId: r.id,
      code: r.code,
      name: r.name,
      licenseExpiry: r.licenseExpiry,
      daysLeft: diffDays(t, r.licenseExpiry),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  return { today: t, windowDays: LICENSE_ALERT_WINDOW_DAYS, alertCount: alerts.length, alerts };
}
