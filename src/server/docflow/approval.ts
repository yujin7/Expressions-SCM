import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core";
import { approvalConfigs, approvals, users } from "@/db/schema";
import { ROLE_LABELS } from "@/server/core/constants";
import type { AnyDb } from "./doc-no";
import { nextStatus, type DocStatus } from "./state";

export type ApprovalErrorCode =
  | "NO_CONFIG" // approval_configs 缺该单据类型
  | "ROLE_FORBIDDEN" // 审批人无所需角色
  | "NOT_APPROVER" // is_approver=false（管理员豁免）
  | "SELF_APPROVAL" // 审批人=制单人（职责分离，系统强制）
  | "NOT_FOUND" // 单据不存在
  | "BAD_STATUS" // 非 pending 不可审批
  | "NOT_OWNER" // 撤回仅限制单人本人（管理员豁免）
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
      throw new ApprovalError("ROLE_FORBIDDEN", `需要${ROLE_LABELS[cfg.approverRole as keyof typeof ROLE_LABELS] ?? cfg.approverRole}审批角色`);
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
    //    幂等键含 cycle=expectedVersion（红队 M1）：同轮次重试幂等；驳回→重提→再驳回=新轮次，允许再次流转
    const [existing] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.docType, i.docType),
          eq(approvals.docId, i.docId),
          eq(approvals.node, 1),
          eq(approvals.action, i.action),
          eq(approvals.cycle, i.expectedVersion),
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
        cycle: i.expectedVersion,
        approverId: i.approver.id,
        action: i.action,
        comment: i.comment,
      })
      .onConflictDoNothing({
        target: [approvals.docType, approvals.docId, approvals.node, approvals.action, approvals.cycle],
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

/**
 * 撤回：待审批 → 草稿（状态机 `pending -[withdraw]→ draft`）。
 *
 * 为什么必须有：此前状态机里定义了这条边，但没有任何服务/接口/按钮。
 * 制单人填错了自己没有出路，只能等审批人驳回——试用期这是最高频的诉求。
 *
 * 与审批的区别（故意不复用 approveDoc）：
 * - 撤回**不是审批动作**，不写 approvals，也不占审批轮次；
 *   否则「提交→撤回→再提交」会把幂等键 cycle 撑乱，影响后续真正的审批。
 * - 权限相反：审批要求审批人≠制单人；撤回要求**必须是制单人本人**（管理员豁免）。
 * - 幂等：已经是草稿就直接返回成功，双击不报错。
 * - 乐观锁同审批（R10）：版本不符即冲突，不做静默覆盖。
 */
export async function withdrawDoc(
  db: AnyDb,
  i: {
    docType: string;
    table: AnyPgTable; // 须含 id/status/version/createdBy/updatedAt
    docId: number;
    user: { id: number; roles: string[] };
    expectedVersion: number;
  },
): Promise<{ status: string; idempotent: boolean }> {
  return db.transaction(async (tx) => {
    const cols = getTableColumns(i.table) as Record<string, PgColumn>;
    const [doc] = await tx
      .select({ status: cols.status, version: cols.version, createdBy: cols.createdBy })
      .from(i.table)
      .where(eq(cols.id, i.docId));
    if (!doc) throw new ApprovalError("NOT_FOUND", `${i.docType}#${i.docId} 不存在`);

    // 幂等先于状态校验：已回到草稿说明撤回已生效，重试不该报错
    if (doc.status === "draft") return { status: "draft", idempotent: true };
    if (doc.status !== "pending") {
      throw new ApprovalError("BAD_STATUS", `当前状态不可撤回: ${String(doc.status)}`);
    }
    // 撤回是制单人收回自己的提交；管理员可代为处理（留审计）
    const isAdmin = i.user.roles.includes("admin");
    if (!isAdmin && i.user.id !== (doc.createdBy as number)) {
      throw new ApprovalError("NOT_OWNER", "只有制单人本人可以撤回；如需否决请走驳回");
    }

    const newStatus = nextStatus(doc.status as DocStatus, "withdraw");
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

export interface ApprovalHistoryRow {
  /** 审批人姓名；账号被删/停用后为 null（leftJoin），**渲染必须带兜底** */
  approverName: string | null;
  action: string;
  comment: string | null;
  createdAt: Date;
}

/**
 * 读取单据的审批轨迹（按时间升序）。
 *
 * 此前这段 select + leftJoin + orderBy 在 11 个单据模块里逐字复制。
 * 复制体之间已经开始分叉：6 处用 `eq(docType, "x")`、5 处用 `inArray(docType, [...])`，
 * 因此本函数签名同时接受两种形态——**stock-doc 确实需要一次查三个域**
 * （stock_doc / opening / count 共用一条单据线）。
 *
 * `approverName` 走 leftJoin，审批人账号被删后为 null；调用方渲染时必须带兜底，
 * 曾有两个页面漏写导致该行显示空白。
 */
export async function loadApprovalHistory(
  db: AnyDb,
  docType: string | string[],
  docId: number,
): Promise<ApprovalHistoryRow[]> {
  const types = Array.isArray(docType) ? docType : [docType];
  return db
    .select({
      approverName: users.name,
      action: approvals.action,
      comment: approvals.comment,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .leftJoin(users, eq(approvals.approverId, users.id))
    .where(and(inArray(approvals.docType, types), eq(approvals.docId, docId)))
    .orderBy(approvals.createdAt, approvals.id);
}
