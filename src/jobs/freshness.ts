/**
 * B 项：参考数据新鲜度看门狗（spec/13 §三 B——周更靠人会忘，靠系统提醒）。
 *
 * 逐 kind 检查 transit_refs 最近导入时间（max(createdAt)），超阈值则开
 * review_items（category=data_freshness，refKey=kind）提醒重传；同 kind 已有
 * open 项则不重复开（幂等，双调度并存无害）。数据修复后由人工在复核清单关闭，
 * 或下次导入后本任务自动关闭（导入时间刷新 → 自动 done，note 记明）。
 *
 * 阈值（自然日）：stock_summary/fg_order 7 天（周更节奏）；pallet/demand 40 天（月更+缓冲）。
 * sales_monthly 另查 max(yearMonth)：晚于 45 天视为断更。
 */
import { eq, sql, and } from "drizzle-orm";
import { systemAlerts, salesMonthly, transitRefs } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const DAY_MS = 86_400_000;

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
  stale: string[];
}

export async function runFreshnessCheck(db: AnyDb, opts?: { now?: Date }): Promise<FreshnessSummary> {
  const now = opts?.now ?? new Date();
  let opened = 0;
  let autoClosed = 0;
  const stale: string[] = [];

  const check = async (refKey: string, isStale: boolean, title: string, detail: string) => {
    const open: { id: number }[] = await db
      .select({ id: systemAlerts.id })
      .from(systemAlerts)
      .where(and(eq(systemAlerts.category, "data_freshness"), eq(systemAlerts.refKey, refKey), eq(systemAlerts.status, "open")));
    if (isStale) {
      stale.push(refKey);
      if (open.length === 0) {
        await db.insert(systemAlerts).values({ category: "data_freshness", refKey, title, detail, severity: "high" });
        opened++;
      }
    } else if (open.length > 0) {
      // 数据已刷新 → 自动关闭（系统自动，非人工裁决）
      for (const o of open) {
        await db
          .update(systemAlerts)
          .set({ status: "resolved", autoResolved: true, resolvedAt: now })
          .where(eq(systemAlerts.id, o.id));
        autoClosed++;
      }
    }
  };

  for (const rule of FRESHNESS_RULES) {
    const [row]: { latest: string | Date | null }[] = await db
      .select({ latest: sql`max(${transitRefs.createdAt})` })
      .from(transitRefs)
      .where(eq(transitRefs.kind, rule.kind));
    const latest = row?.latest ? new Date(row.latest) : null;
    const ageDays = latest ? Math.floor((now.getTime() - latest.getTime()) / DAY_MS) : null;
    const isStale = latest != null && ageDays! > rule.maxAgeDays; // 从未导入不告警（未启用的口径不扰民）
    await check(
      rule.kind,
      isStale,
      `参考数据过期：${rule.label}`,
      `kind=${rule.kind} 最近导入 ${latest?.toISOString().slice(0, 10) ?? "无"}，已 ${ageDays ?? "-"} 天（阈值 ${rule.maxAgeDays} 天）——请到数据中心→文件上传重传对应文件`,
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
    await check(
      "sales_monthly",
      ageDays > SALES_MAX_AGE_DAYS,
      "参考数据过期：月度销量表（销速/滞销/补货全依赖）",
      `最新数据月 ${maxYm}，距今 ${ageDays} 天（阈值 ${SALES_MAX_AGE_DAYS} 天）——请导入新月份销量`,
    );
  }

  return { opened, autoClosed, stale };
}
