/**
 * #11 单据时效看门狗（SLA/aging——对标商业系统的状态时钟）。
 *
 * 扫描处于「等待态」且停留超阈值的单据 → 开 system_alerts（category=doc_aging，
 * refKey=docType:docNo 幂等）；单据离开等待态后由本任务自动关闭对应告警。
 * 停留时长以 updatedAt 为准（状态机每次流转刷新 updatedAt——docColumns 契约）。
 *
 * 等待态与阈值（自然日）：
 * - pending（待审批）：3 天——审批不应久拖；
 * - approved（PO/JG 待供应商确认 / 待执行）：5 天——供应商确认窗口。
 * draft 不计（未提交是正常暂存）；in_progress/done/closed 为终态或执行中不告警。
 *
 * W1（路线图）：本任务不再手写 insert/update system_alerts，统一走 alerts/engine.upsertAlerts——
 * 去重键幂等（dedupeKey = doc_aging:<refKey>，数据库部分唯一索引兜底）、责任角色取
 * rules/task-triggers.ALERT_OWNER_ROLE（唯一权威）、动作链接精确打开单据、
 * sourceRule/paramsSnapshot/why 同行落库、open/refresh/close 进 alert_events 台账。
 * autoCloseAfterDays=0：单据流出等待态是硬事实（不是数据缺口），不再命中即刻关闭——与迁移前一致。
 * system_alerts 属系统写入（无 id=0 伪用户），不写 audit_logs（与 freshness / transfer_cost 同口径）。
 */
import { and, eq, lt } from "drizzle-orm";
import { documentHref } from "@/lib/document-links";
import { bhDocs, jgDocs, poDocs, woDocs } from "@/db/schema";
import { backfillAlertDedupeKeys, upsertAlerts, type AlertCandidate } from "@/server/modules/alerts/engine";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;
const DAY_MS = 86_400_000;

export const ALERT_CATEGORY = "doc_aging";
export const DOC_AGING_SOURCE_RULE = "jobs/doc-aging（等待态停留阈值）";

interface DocSource {
  docType: string;
  label: string;
  /** 单据页兜底；正常记录通过documentHref绑定精确ID。 */
  href: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
  table: any;
}
const SOURCES: DocSource[] = [
  { docType: "BH", label: "备货申请", href: "/outsource/bh", table: bhDocs },
  { docType: "WO", label: "委外工单", href: "/outsource/wo", table: woDocs },
  { docType: "PO", label: "采购订单", href: "/outsource/po", table: poDocs },
  { docType: "JG", label: "加工通知单", href: "/outsource/jg", table: jgDocs },
];
const THRESHOLD_DAYS: Record<string, number> = { pending: 3, approved: 5 };
const STATUS_LABEL: Record<string, string> = { pending: "待审批", approved: "待确认/待执行" };

export interface DocAgingSummary {
  opened: number;
  autoClosed: number;
  /** 已开告警本轮再次命中（停留天数/标题刷新） */
  refreshed: number;
  /** 本轮回填 dedupe_key 的历史行数 */
  backfilled: number;
  aging: { docType: string; docNo: string; status: string; days: number }[];
}

export async function runDocAging(db: AnyDb, opts?: { now?: Date }): Promise<DocAgingSummary> {
  const now = opts?.now ?? new Date();
  const backfilled = await backfillAlertDedupeKeys(db, ALERT_CATEGORY);
  const aging: DocAgingSummary["aging"] = [];
  const candidates: AlertCandidate[] = [];

  for (const src of SOURCES) {
    for (const [status, days] of Object.entries(THRESHOLD_DAYS)) {
      const cutoff = new Date(now.getTime() - days * DAY_MS);
      const rows: { id: number; docNo: string; updatedAt: Date }[] = await db
        .select({ id: src.table.id, docNo: src.table.docNo, updatedAt: src.table.updatedAt })
        .from(src.table)
        .where(and(eq(src.table.status, status), lt(src.table.updatedAt, cutoff)));
      for (const r of rows) {
        const refKey = `${src.docType}:${r.docNo}`;
        const dwell = Math.floor((now.getTime() - new Date(r.updatedAt).getTime()) / DAY_MS);
        aging.push({ docType: src.docType, docNo: r.docNo, status, days: dwell });
        candidates.push({
          refKey,
          dedupeKey: `${ALERT_CATEGORY}:${refKey}`,
          title: `${src.label} ${r.docNo} 停留「${STATUS_LABEL[status] ?? status}」已 ${dwell} 天`,
          detail: `阈值 ${days} 天；请跟进审批或供应商确认`,
          severity: "high",
          ownerRole: ALERT_OWNER_ROLE[ALERT_CATEGORY],
          actionHref: documentHref(src.docType.toLowerCase(), r.id) ?? src.href,
          sourceRule: DOC_AGING_SOURCE_RULE,
          paramsSnapshot: { docType: src.docType, docNo: r.docNo, status, dwellDays: dwell, thresholdDays: days },
          why: [
            { label: "停留时长", value: `${dwell} 天（自最近一次状态流转起算）`, source: `${src.docType.toLowerCase()}_docs.updated_at` },
            { label: "阈值", value: `${days} 天（${STATUS_LABEL[status] ?? status}）`, source: DOC_AGING_SOURCE_RULE },
            { label: "当前状态", value: STATUS_LABEL[status] ?? status, source: "docflow 状态机" },
          ],
        });
      }
    }
  }

  const res = await upsertAlerts(db, {
    category: ALERT_CATEGORY,
    candidates,
    now,
    autoCloseAfterDays: 0, // 单据离开等待态即关：状态流转是硬事实，不需要数据缺口迟滞
  });
  return { opened: res.opened, autoClosed: res.autoClosed, refreshed: res.refreshed, backfilled, aging };
}
