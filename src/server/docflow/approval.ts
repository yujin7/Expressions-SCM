import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core";
import { approvalConfigs, approvals } from "@/db/schema";
import type { AnyDb } from "./doc-no";
import { nextStatus, type DocStatus } from "./state";

export type ApprovalErrorCode =
  | "NO_CONFIG" // approval_configs 缺该单据类型
  | "ROLE_FORBIDDEN" // 审批人无所需角色
  | "NOT_APPROVER" // is_approver=false（管理员豁免）
  | "SELF_APPROVAL" // 审批人=制单人（职责分离，系统强制）
  | "NOT_FOUND" // 单据不存在
  | "BAD_STATUS" // 非 pending 不可审批
  | "VERSION_CONFLICT"; // 乐观锁冲突（R10）

export class ApprovalError extends Error {
  constructor(
    public readonly code: ApprovalErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApprovalError";
  }
}

export type Approver = { id: number; roles: string[]; isApprover: boolean };

/**
 * 通用单级审批（MVP node=1，《01》§6）。同一事务内：
 * 权限（角色/is_approver/职责分离）→ 幂等（R10：优先于状态与版本冲突）
 * → 状态校验 → 写 approvals（uq_approval_idem 兜底）→ 乐观锁更新单据状态。
 */
export async function approveDoc(
  db: AnyDb,
  i: {
    docType: string; // 'bh' | 'wo' | 'po' | ...
    table: AnyPgTable; // 单据 drizzle 表（须含 id/status/version/createdBy/updatedAt）
    docId: number;
    approver: Approver;
    action: "approve" | "reject";
    comment?: string;
    expectedVersion: number; // 乐观锁（R10）
  },
): Promise<{ status: string; idempotent: boolean }> {
  return db.transaction(async (tx) => {
    // 1) 审批配置：单一权威；管理员全局兜底
    const [cfg] = await tx
      .select()
      .from(approvalConfigs)
      .where(eq(approvalConfigs.docType, i.docType));
    if (!cfg) throw new ApprovalError("NO_CONFIG", `缺少审批配置: ${i.docType}`);
    const isAdmin = i.approver.roles.includes("admin");
    if (!isAdmin && !i.approver.roles.includes(cfg.approverRole)) {
      throw new ApprovalError("ROLE_FORBIDDEN", `需要角色 ${cfg.approverRole}`);
    }
    // 2) 同角色内仅 is_approver=true 者可审批（管理员豁免）
    if (!isAdmin && !i.approver.isApprover) throw new ApprovalError("NOT_APPROVER");

    const cols = getTableColumns(i.table) as Record<string, PgColumn>;
    const [doc] = await tx
      .select({ status: cols.status, version: cols.version, createdBy: cols.createdBy })
      .from(i.table)
      .where(eq(cols.id, i.docId));
    if (!doc) throw new ApprovalError("NOT_FOUND", `${i.docType}#${i.docId} 不存在`);

    // 3) 职责分离：审批人≠制单人（管理员亦不豁免）
    if (i.approver.id === (doc.createdBy as number)) throw new ApprovalError("SELF_APPROVAL");

    // 5) 幂等先于状态/版本校验（R10：重试返回缓存结果，优先于版本冲突）
    const [existing] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.docType, i.docType),
          eq(approvals.docId, i.docId),
          eq(approvals.node, 1),
          eq(approvals.action, i.action),
        ),
      );
    if (existing) return { status: String(doc.status), idempotent: true };

    // 4) 仅待审批可审
    if (doc.status !== "pending") {
      throw new ApprovalError("BAD_STATUS", `当前状态不可审批: ${String(doc.status)}`);
    }

    // 6) 写审批记录；UNIQUE(uq_approval_idem) 兜底并发重试
    const inserted = await tx
      .insert(approvals)
      .values({
        docType: i.docType,
        docId: i.docId,
        node: 1,
        approverId: i.approver.id,
        action: i.action,
        comment: i.comment,
      })
      .onConflictDoNothing({
        target: [approvals.docType, approvals.docId, approvals.node, approvals.action],
      })
      .returning({ id: approvals.id });
    if (inserted.length === 0) return { status: String(doc.status), idempotent: true };

    // 7) 状态机流转 + 乐观锁更新
    const newStatus = nextStatus(doc.status as DocStatus, i.action);
    const updated = await tx
      .update(i.table)
      .set({
        status: newStatus,
        version: sql`${cols.version} + 1`,
        updatedAt: new Date(),
      } as Record<string, unknown>)
      .where(and(eq(cols.id, i.docId), eq(cols.version, i.expectedVersion)))
      .returning({ id: cols.id });
    if (updated.length === 0) {
      throw new ApprovalError("VERSION_CONFLICT", `期望版本 ${i.expectedVersion} 已过期`);
    }
    return { status: newStatus, idempotent: false };
  });
}
