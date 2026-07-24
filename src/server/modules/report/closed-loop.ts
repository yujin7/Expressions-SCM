/**
 * 建议闭环追踪（只读报表层）：补货建议 / NPD 首单 → 生成的 BH 草稿 → 其审批/执行状态。
 *
 * 链路来源（既有审计，不新增口径）：
 * - audit_logs action='draft_bh'（补货建议页 createReplenishDraft，after={docNo,lineCount,source}）；
 * - audit_logs action='first_order_draft'（NPD 首单 createFirstOrder，after={docNo,skuCode,qty}）。
 * 以 after.docNo 关联 bh_docs 取当前状态；createBy 经 users 解析姓名。
 * 采纳率 = 进入审批通过及以后状态（approved/in_progress/completed）÷ 建议草稿总数。
 * 只读不写库、无金额字段免脱敏。
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { num, r1 } from "@/server/core/svc";
import { DOC_STATUS_LABELS } from "@/components/labels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** 单据状态 → 中文标签（兼容 PRD 命名与实际枚举） */
const STATUS_LABEL: Record<string, string> = {
  ...DOC_STATUS_LABELS, // 唯一源（components/labels，纯 TS 可跨层复用）
  done: "已完成", rejected: "已驳回", // PRD 命名兼容
};

/** 采纳类：进入审批通过及以后状态 */
const ADOPTED = new Set(["approved", "in_progress", "completed", "done"]);
/** 待审批类 */
const PENDING = new Set(["draft", "pending"]);

export interface ClosedLoopRow {
  id: number;
  createdAt: string;
  docNo: string;
  source: string;
  lineCount: number;
  createdBy: string;
  /** BH 当前状态码；单据不存在 = '已删除' */
  currentStatus: string;
  /** E3-01：下游实际到货量与到货率（WO→JG→SH 正常行实收，与 wip.ts 同口径） */
  receivedQty: number;
  plannedQty: number;
  receiptRate: number | null;
  statusLabel: string;
  downstreamWo: string;
}

export interface ClosedLoopSummary {
  total: number;
  adopted: number; // 采纳中/已完成
  pending: number; // 待审批
  rejected: number; // 已否决/关闭
  deleted: number; // 已删除
  adoptRate: number; // 采纳率（百分比，1 位小数）——口径=进入审批通过及以后
  /** E3-01：实际到货口径——建议最终有货落地的占比（比采纳率更硬） */
  deliveredRate: number;
  deliveredCount: number;
}

export interface ClosedLoopResult {
  rows: ClosedLoopRow[];
  total: number;
  summary: ClosedLoopSummary;
}

export async function getClosedLoop(
  query: { page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<ClosedLoopResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 20));

  const al = schema.auditLogs;
  const logs: { id: number; userId: number; action: string; after: unknown; createdAt: Date }[] = await db
    .select({ id: al.id, userId: al.userId, action: al.action, after: al.after, createdAt: al.createdAt })
    .from(al)
    .where(inArray(al.action, ["draft_bh", "first_order_draft"]))
    .orderBy(desc(al.createdAt), desc(al.id));

  // 解析制单人姓名
  const userIds = [...new Set(logs.map((l) => l.userId).filter((v) => v != null))];
  const userRows: { id: number; name: string }[] = userIds.length
    ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const nameById = new Map<number, string>(userRows.map((u) => [u.id, u.name]));

  // 关联 BH 当前状态
  const docNos = [
    ...new Set(
      logs
        .map((l) => (l.after as { docNo?: unknown } | null)?.docNo)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
  const bhRows: { docNo: string; status: string }[] = docNos.length
    ? await db.select({ docNo: schema.bhDocs.docNo, status: schema.bhDocs.status }).from(schema.bhDocs).where(inArray(schema.bhDocs.docNo, docNos))
    : [];
  const statusByDocNo = new Map<string, string>(bhRows.map((b) => [b.docNo, b.status]));

  // func#3 下游追溯：BH → 子 WO（woDocs.bhId）最远阶段——采纳不等于到货
  const bhIdByDocNo = new Map<string, number>();
  if (docNos.length) {
    const idRows: { id: number; docNo: string }[] = await db.select({ id: schema.bhDocs.id, docNo: schema.bhDocs.docNo }).from(schema.bhDocs).where(inArray(schema.bhDocs.docNo, docNos));
    for (const r of idRows) bhIdByDocNo.set(r.docNo, r.id);
  }
  const bhIds = [...bhIdByDocNo.values()];
  const STAGE_RANK: Record<string, number> = { draft: 0, pending: 1, approved: 2, in_progress: 3, completed: 4, closed: 4, void: -1 };
  const woStageByBhId = new Map<number, string>();
  if (bhIds.length) {
    const woRows: { bhId: number | null; status: string }[] = await db
      .select({ bhId: schema.woDocs.bhId, status: schema.woDocs.status })
      .from(schema.woDocs)
      .where(inArray(schema.woDocs.bhId, bhIds));
    for (const w of woRows) {
      if (w.bhId == null) continue;
      const cur = woStageByBhId.get(w.bhId);
      if (!cur || (STAGE_RANK[w.status] ?? 0) > (STAGE_RANK[cur] ?? 0)) woStageByBhId.set(w.bhId, w.status);
    }
  }

  /* ── E3-01：闭环延伸到入库——采纳≠到货。经 WO→JG→SH(正常行,已生效) 累计实收 ── */
  const woIdsByBh = new Map<number, number[]>();
  const woQtyByBh = new Map<number, number>();
  if (bhIds.length) {
    const woFull: { id: number; bhId: number | null; qty: string }[] = await db
      .select({ id: schema.woDocs.id, bhId: schema.woDocs.bhId, qty: schema.woDocs.qty })
      .from(schema.woDocs)
      .where(inArray(schema.woDocs.bhId, bhIds));
    for (const w of woFull) {
      if (w.bhId == null) continue;
      (woIdsByBh.get(w.bhId) ?? woIdsByBh.set(w.bhId, []).get(w.bhId)!).push(w.id);
      woQtyByBh.set(w.bhId, (woQtyByBh.get(w.bhId) ?? 0) + num(w.qty));
    }
  }
  const allWoIds = [...woIdsByBh.values()].flat();
  const receivedByWo = new Map<number, number>();
  if (allWoIds.length) {
    const jgRows: { id: number; woId: number }[] = await db
      .select({ id: schema.jgDocs.id, woId: schema.jgDocs.woId })
      .from(schema.jgDocs)
      .where(inArray(schema.jgDocs.woId, allWoIds));
    const woByJg = new Map(jgRows.map((j) => [j.id, j.woId]));
    const jgIds = jgRows.map((j) => j.id);
    if (jgIds.length) {
      const recv: { jgId: number; qty: string | null }[] = await db
        .select({ jgId: schema.shDocs.sourceId, qty: sql<string | null>`sum(${schema.shLines.actualQty})` })
        .from(schema.shLines)
        .innerJoin(schema.shDocs, eq(schema.shLines.shId, schema.shDocs.id))
        .where(and(
          eq(schema.shDocs.sourceType, "jg"),
          inArray(schema.shDocs.sourceId, jgIds),
          inArray(schema.shDocs.status, ["approved", "in_progress", "completed"]),
          eq(schema.shLines.lineType, "normal"),
        ))
        .groupBy(schema.shDocs.sourceId);
      for (const r of recv) {
        const woId = woByJg.get(r.jgId);
        if (woId == null) continue;
        receivedByWo.set(woId, (receivedByWo.get(woId) ?? 0) + num(r.qty));
      }
    }
  }
  const receivedByBh = new Map<number, number>();
  for (const [bhId, woIds] of woIdsByBh) {
    receivedByBh.set(bhId, woIds.reduce((a, id) => a + (receivedByWo.get(id) ?? 0), 0));
  }

  const all: ClosedLoopRow[] = logs.map((l) => {
    const after = (l.after ?? {}) as { docNo?: unknown; source?: unknown; lineCount?: unknown };
    const docNo = typeof after.docNo === "string" ? after.docNo : "";
    const source =
      typeof after.source === "string" && after.source
        ? after.source === "replenish_suggestion"
          ? "补货建议"
          : after.source
        : l.action === "first_order_draft"
          ? "NPD首单"
          : "补货建议";
    const lineCount = after.lineCount != null ? num(after.lineCount) : 1;
    const status = docNo ? statusByDocNo.get(docNo) : undefined;
    const currentStatus = status ?? "已删除";
    const statusLabel = status ? STATUS_LABEL[status] ?? status : "已删除";
    const bhId = docNo ? bhIdByDocNo.get(docNo) : undefined;
    const woStage = bhId != null ? woStageByBhId.get(bhId) : undefined;
    const downstreamWo = woStage ? (STATUS_LABEL[woStage] ?? woStage) : (status === "approved" || status === "in_progress" || status === "completed") ? "未开工单" : "—";
    return {
      id: l.id,
      createdAt: (l.createdAt instanceof Date ? l.createdAt : new Date(l.createdAt)).toISOString(),
      docNo,
      source,
      lineCount,
      createdBy: nameById.get(l.userId) ?? `用户#${l.userId}`,
      currentStatus,
      statusLabel,
      downstreamWo,
      receivedQty: bhId != null ? r1(receivedByBh.get(bhId) ?? 0) : 0,
      plannedQty: bhId != null ? r1(woQtyByBh.get(bhId) ?? 0) : 0,
      receiptRate: bhId != null && (woQtyByBh.get(bhId) ?? 0) > 0
        ? r1(((receivedByBh.get(bhId) ?? 0) / (woQtyByBh.get(bhId) ?? 1)) * 100)
        : null,
    };
  });

  // 汇总
  let adopted = 0;
  let pending = 0;
  let rejected = 0;
  let deleted = 0;
  for (const r of all) {
    if (r.currentStatus === "已删除") deleted++;
    else if (ADOPTED.has(r.currentStatus)) adopted++;
    else if (PENDING.has(r.currentStatus)) pending++;
    else rejected++; // rejected/closed/void
  }
  const total = all.length;
  const adoptRate = total > 0 ? r1((adopted / total) * 100) : 0;
  // E3-01：实际到货 = 下游已有正常行实收（>0）
  const deliveredCount = all.filter((r) => r.receivedQty > 0).length;
  const deliveredRate = total > 0 ? r1((deliveredCount / total) * 100) : 0;

  return {
    rows: all.slice((page - 1) * pageSize, page * pageSize),
    total,
    summary: { total, adopted, pending, rejected, deleted, adoptRate, deliveredRate, deliveredCount },
  };
}
