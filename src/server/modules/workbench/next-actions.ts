import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";

import {
  auditLogs,
  bhDocs,
  jgDocs,
  jsDocs,
  poDocs,
  qcRecords,
  shDocs,
  woDocs,
} from "@/db/schema";
import { ROLE_LABELS, type Role } from "@/server/core/constants";
import type { AnyDb } from "@/server/core/svc";
import { resolveDb } from "@/server/core/svc";
import {
  NEXT_ACTION_DEFINITIONS,
  nextActionDefinitionsForRoles,
  type NextActionDefinition,
  type NextActionPriority,
  type NextActionRuleId,
} from "@/server/rules/next-action";

const PER_RULE_LIMIT = 20;
const TOTAL_LIMIT = 12;

export interface NextActionItem {
  key: string;
  ruleId: NextActionRuleId;
  priority: NextActionPriority;
  docTypeLabel: string;
  docNo: string;
  triggerLabel: string;
  triggerAt: Date;
  actionLabel: string;
  reason: string;
  ownerRole: Exclude<Role, "admin">;
  ownerLabel: string;
  href: string;
  evidence: string;
}

interface TransitionRow {
  id: number;
  docNo: string;
  triggerAt: Date | string;
}

function auditedTransitions(db: AnyDb, definition: NextActionDefinition, alias: string) {
  return db
    .select({
      entityId: auditLogs.entityId,
      triggerAt: sql<Date>`max(${auditLogs.createdAt})`.as("trigger_at"),
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entity, definition.triggerEntity),
        eq(auditLogs.action, definition.triggerAction),
      ),
    )
    .groupBy(auditLogs.entityId)
    .as(alias);
}

function baseItem(
  definition: NextActionDefinition,
  row: TransitionRow,
  content: Pick<NextActionItem, "docTypeLabel" | "actionLabel" | "reason" | "href" | "evidence">,
): NextActionItem {
  const triggerAt = row.triggerAt instanceof Date ? row.triggerAt : new Date(row.triggerAt);
  return {
    key: `${definition.id}:${row.id}`,
    ruleId: definition.id,
    priority: definition.priority,
    docTypeLabel: content.docTypeLabel,
    docNo: row.docNo,
    triggerLabel: definition.triggerAction === "approve" ? "审批通过" : "收货关闭",
    triggerAt,
    actionLabel: content.actionLabel,
    reason: content.reason,
    ownerRole: definition.ownerRole,
    ownerLabel: ROLE_LABELS[definition.ownerRole],
    href: content.href,
    evidence: content.evidence,
  };
}

async function approvedBhWithoutWo(db: AnyDb, definition: NextActionDefinition): Promise<NextActionItem[]> {
  const events = auditedTransitions(db, definition, "next_bh_approve");
  const rows: TransitionRow[] = await db
    .select({ id: bhDocs.id, docNo: bhDocs.docNo, triggerAt: events.triggerAt })
    .from(bhDocs)
    .innerJoin(events, eq(events.entityId, bhDocs.id))
    .where(
      and(
        eq(bhDocs.status, "approved"),
        notExists(db.select({ one: sql`1` }).from(woDocs).where(eq(woDocs.bhId, bhDocs.id))),
      ),
    )
    .orderBy(desc(events.triggerAt))
    .limit(PER_RULE_LIMIT);
  return rows.map((row) =>
    baseItem(definition, row, {
      docTypeLabel: "备货申请",
      actionLabel: "生成委外工单草稿",
      reason: "申请已经审批，但尚未形成关联工单。",
      href: "/outsource/auto-chain",
      evidence: "当前状态=已审批；关联 WO=0",
    }),
  );
}

async function approvedWoWithoutExecutionDocs(
  db: AnyDb,
  definition: NextActionDefinition,
): Promise<NextActionItem[]> {
  const events = auditedTransitions(db, definition, "next_wo_approve");
  const rows: TransitionRow[] = await db
    .select({ id: woDocs.id, docNo: woDocs.docNo, triggerAt: events.triggerAt })
    .from(woDocs)
    .innerJoin(events, eq(events.entityId, woDocs.id))
    .where(
      and(
        eq(woDocs.status, "approved"),
        notExists(db.select({ one: sql`1` }).from(jgDocs).where(eq(jgDocs.woId, woDocs.id))),
      ),
    )
    .orderBy(desc(events.triggerAt))
    .limit(PER_RULE_LIMIT);
  return rows.map((row) =>
    baseItem(definition, row, {
      docTypeLabel: "委外工单",
      actionLabel: "生成采购单与加工通知",
      reason: "工单已经审批并固化需求快照，但尚未生成执行单据。",
      href: `/outsource/wo?q=${encodeURIComponent(row.docNo)}`,
      evidence: "当前状态=已审批；关联 JG=0",
    }),
  );
}

async function approvedPoAwaitingConfirmation(
  db: AnyDb,
  definition: NextActionDefinition,
): Promise<NextActionItem[]> {
  const events = auditedTransitions(db, definition, "next_po_approve");
  const rows: (TransitionRow & { hasToken: boolean })[] = await db
    .select({
      id: poDocs.id,
      docNo: poDocs.docNo,
      triggerAt: events.triggerAt,
      hasToken: sql<boolean>`${poDocs.confirmToken} is not null`,
    })
    .from(poDocs)
    .innerJoin(events, eq(events.entityId, poDocs.id))
    .where(and(eq(poDocs.status, "approved"), isNull(poDocs.confirmedAt)))
    .orderBy(desc(events.triggerAt))
    .limit(PER_RULE_LIMIT);
  return rows.map((row) =>
    baseItem(definition, row, {
      docTypeLabel: "采购订单",
      actionLabel: row.hasToken ? "跟进供应商确认交期" : "生成供应商确认链接",
      reason: row.hasToken
        ? "确认链接已经生成，但供应商尚未回传逐行交期。"
        : "订单已经审批，但尚未生成供应商确认入口。",
      href: `/outsource/po?q=${encodeURIComponent(row.docNo)}`,
      evidence: `当前状态=已审批；确认时间=空；确认链接=${row.hasToken ? "已生成" : "未生成"}`,
    }),
  );
}

async function approvedJgAwaitingProduction(
  db: AnyDb,
  definition: NextActionDefinition,
): Promise<NextActionItem[]> {
  const events = auditedTransitions(db, definition, "next_jg_approve");
  const rows: TransitionRow[] = await db
    .select({ id: jgDocs.id, docNo: jgDocs.docNo, triggerAt: events.triggerAt })
    .from(jgDocs)
    .innerJoin(events, eq(events.entityId, jgDocs.id))
    .where(and(eq(jgDocs.status, "approved"), isNull(jgDocs.confirmedAt)))
    .orderBy(desc(events.triggerAt))
    .limit(PER_RULE_LIMIT);
  return rows.map((row) =>
    baseItem(definition, row, {
      docTypeLabel: "加工通知",
      actionLabel: "确认投产与交期",
      reason: "加工通知已经审批，但尚未确认进入生产。",
      href: `/outsource/jg?q=${encodeURIComponent(row.docNo)}`,
      evidence: "当前状态=已审批；投产确认时间=空",
    }),
  );
}

async function approvedShAwaitingCompletion(
  db: AnyDb,
  definition: NextActionDefinition,
): Promise<NextActionItem[]> {
  const events = auditedTransitions(db, definition, "next_sh_approve");
  const rows: (TransitionRow & { hasQc: boolean })[] = await db
    .select({
      id: shDocs.id,
      docNo: shDocs.docNo,
      triggerAt: events.triggerAt,
      hasQc: sql<boolean>`exists (
        select 1 from ${qcRecords} q where q.sh_id = ${shDocs.id}
      )`,
    })
    .from(shDocs)
    .innerJoin(events, eq(events.entityId, shDocs.id))
    .where(eq(shDocs.status, "approved"))
    .orderBy(desc(events.triggerAt))
    .limit(PER_RULE_LIMIT);
  return rows.map((row) =>
    baseItem(definition, row, {
      docTypeLabel: "收货单",
      actionLabel: row.hasQc ? "确认入库" : "录入质检结果",
      reason: row.hasQc
        ? "检验记录已经完成，等待仓管确认入库。"
        : "收货单已经审批，必须完成全行质检后才能入库。",
      href: `/matflow/sh?q=${encodeURIComponent(row.docNo)}`,
      evidence: `当前状态=已审批；质检记录=${row.hasQc ? "已存在" : "不存在"}`,
    }),
  );
}

async function completedJgWithoutSettlement(
  db: AnyDb,
  definition: NextActionDefinition,
): Promise<NextActionItem[]> {
  const events = auditedTransitions(db, definition, "next_jg_complete");
  const rows: TransitionRow[] = await db
    .select({ id: jgDocs.id, docNo: jgDocs.docNo, triggerAt: events.triggerAt })
    .from(jgDocs)
    .innerJoin(events, eq(events.entityId, jgDocs.id))
    .where(
      and(
        eq(jgDocs.status, "completed"),
        notExists(db.select({ one: sql`1` }).from(jsDocs).where(eq(jsDocs.jgId, jgDocs.id))),
      ),
    )
    .orderBy(desc(events.triggerAt))
    .limit(PER_RULE_LIMIT);
  return rows.map((row) =>
    baseItem(definition, row, {
      docTypeLabel: "加工通知",
      actionLabel: "创建委外结算草稿",
      reason: "收货已经关闭，但尚未形成一对一委外结算单。",
      href: `/settlement/js?jgId=${row.id}`,
      evidence: "当前状态=已完成；关联 JS=0",
    }),
  );
}

const LOADERS: Record<
  NextActionRuleId,
  (db: AnyDb, definition: NextActionDefinition) => Promise<NextActionItem[]>
> = {
  "bh.create_wo": approvedBhWithoutWo,
  "wo.generate_execution_docs": approvedWoWithoutExecutionDocs,
  "po.confirm_due_date": approvedPoAwaitingConfirmation,
  "jg.confirm_production": approvedJgAwaitingProduction,
  "sh.finish_qc_inbound": approvedShAwaitingCompletion,
  "jg.create_settlement": completedJgWithoutSettlement,
};

const PRIORITY_RANK: Record<NextActionPriority, number> = { high: 0, medium: 1 };

export async function getNextActions(roles: readonly string[], dbArg?: AnyDb): Promise<NextActionItem[]> {
  const db = await resolveDb(dbArg);
  const definitions = nextActionDefinitionsForRoles(roles);
  const groups = await Promise.all(
    definitions.map((definition) => LOADERS[definition.id](db, definition)),
  );
  return groups
    .flat()
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.triggerAt.getTime() - b.triggerAt.getTime() ||
        a.key.localeCompare(b.key),
    )
    .slice(0, TOTAL_LIMIT);
}

/** Exported for contract tests and admin explainability; not a mutation surface. */
export { NEXT_ACTION_DEFINITIONS };
