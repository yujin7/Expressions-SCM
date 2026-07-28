/**
 * #11 单据时效看门狗（SLA/aging——对标商业系统的状态时钟）。
 *
 * 扫描处于「等待态」且停留超阈值的单据 → 开 review_items（category=doc_aging，
 * refKey=docType:docNo 幂等）；单据离开等待态后由本任务自动关闭对应提醒。
 * 停留时长以 updatedAt 为准（状态机每次流转刷新 updatedAt——docColumns 契约）。
 *
 * 等待态与阈值（自然日）：
 * - pending（待审批）：3 天——审批不应久拖；
 * - approved（PO/JG 待供应商确认 / 待执行）：5 天——供应商确认窗口。
 * draft 不计（未提交是正常暂存）；in_progress/done/closed 为终态或执行中不告警。
 */
import { and, eq, lt } from "drizzle-orm";
import { bhDocs, jgDocs, poDocs, systemAlerts, woDocs } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;
const DAY_MS = 86_400_000;

interface DocSource {
  docType: string;
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
  table: any;
}
const SOURCES: DocSource[] = [
  { docType: "BH", label: "备货申请", table: bhDocs },
  { docType: "WO", label: "委外工单", table: woDocs },
  { docType: "PO", label: "采购订单", table: poDocs },
  { docType: "JG", label: "加工通知单", table: jgDocs },
];
const THRESHOLD_DAYS: Record<string, number> = { pending: 3, approved: 5 };

export interface DocAgingSummary {
  opened: number;
  autoClosed: number;
  aging: { docType: string; docNo: string; status: string; days: number }[];
}

export async function runDocAging(db: AnyDb, opts?: { now?: Date }): Promise<DocAgingSummary> {
  const now = opts?.now ?? new Date();
  let opened = 0;
  let autoClosed = 0;
  const aging: DocAgingSummary["aging"] = [];
  const staleKeys = new Set<string>();

  for (const src of SOURCES) {
    for (const [status, days] of Object.entries(THRESHOLD_DAYS)) {
      const cutoff = new Date(now.getTime() - days * DAY_MS);
      const rows: { docNo: string; updatedAt: Date }[] = await db
        .select({ docNo: src.table.docNo, updatedAt: src.table.updatedAt })
        .from(src.table)
        .where(and(eq(src.table.status, status), lt(src.table.updatedAt, cutoff)));
      for (const r of rows) {
        const refKey = `${src.docType}:${r.docNo}`;
        staleKeys.add(refKey);
        const dwell = Math.floor((now.getTime() - new Date(r.updatedAt).getTime()) / DAY_MS);
        aging.push({ docType: src.docType, docNo: r.docNo, status, days: dwell });
        const existing: { id: number }[] = await db
          .select({ id: systemAlerts.id })
          .from(systemAlerts)
          .where(and(eq(systemAlerts.category, "doc_aging"), eq(systemAlerts.refKey, refKey), eq(systemAlerts.status, "open")));
        if (existing.length === 0) {
          await db.insert(systemAlerts).values({
            category: "doc_aging",
            refKey,
            title: `${src.label} ${r.docNo} 停留「${status === "pending" ? "待审批" : "待确认/待执行"}」已 ${dwell} 天`,
            detail: `阈值 ${days} 天；请跟进审批或供应商确认`,
            severity: "high",
          });
          opened++;
        }
      }
    }
  }

  // 自动关闭：已离开等待态（不在本轮 staleKeys 中）的 open doc_aging 项
  const openItems: { id: number; refKey: string | null }[] = await db
    .select({ id: systemAlerts.id, refKey: systemAlerts.refKey })
    .from(systemAlerts)
    .where(and(eq(systemAlerts.category, "doc_aging"), eq(systemAlerts.status, "open")));
  for (const it of openItems) {
    if (it.refKey && !staleKeys.has(it.refKey)) {
      await db
        .update(systemAlerts)
        .set({ status: "resolved", autoResolved: true, resolvedAt: now })
        .where(eq(systemAlerts.id, it.id));
      autoClosed++;
    }
  }

  return { opened, autoClosed, aging };
}
