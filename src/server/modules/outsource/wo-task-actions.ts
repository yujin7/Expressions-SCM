import { eq } from "drizzle-orm";
import { approvalConfigs, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";
import { approvalRoleError } from "@/server/docflow/approval";

/** Read-only guidance; mutation services still lock/recheck actor, state and version. */
export function woTaskActions(user: SessionUser, doc: { status: string; createdBy: number | null }, role: string | null) {
  const admin = user.roles.includes("admin"), maker = doc.createdBy === user.id;
  const owner = maker || admin;
  const approvalBlock = approvalRoleError(user, role);
  const review = doc.status === "pending" && !maker && !approvalBlock;
  const generate = doc.status === "approved" && (admin || user.roles.includes("pmc"));
  const manage = ["approved", "in_progress"].includes(doc.status) && (admin || user.roles.some(r => r === "pmc" || r === "ops"));
  const reason = doc.status === "draft"
    ? owner ? "核对成品、数量、加工费及BOM后提交；提交不生成采购单、加工单或库存流水。" : "仅制单人或管理员可提交此草稿，请联系制单人核对。"
    : doc.status === "pending" ? maker ? "制单人不可自审或自行驳回，请另一位合格审批人处理；需要收回时可撤回。"
      : approvalBlock ? `${approvalBlock.message}${owner ? "；仍可撤回交制单人核对。" : "；请联系合格审批人处理。"}`
        : "核对后可批准或独立驳回；批准只冻结需求快照，不改变库存。"
    : doc.status === "approved" ? "工单已审批；生成仅创建待提交草稿，仍须核对工厂资格和已有单据。"
      : doc.status === "in_progress" ? "按实际履约情况完成或短关；保留已发生的加工、收货和审计事实。"
        : "当前为历史只读状态；如需纠错请核对关联单据，不重复提交或审批。";
  return { submit: doc.status === "draft" && owner, approve: review, reject: review,
    withdraw: doc.status === "pending" && owner, generate, manage, reason };
}
export type WoTaskActions = ReturnType<typeof woTaskActions>;

export async function loadWoTaskActions(db: AnyDb, doc: { status: string; createdBy: number | null }, user?: SessionUser): Promise<WoTaskActions | null> {
  if (!user) return null;
  const [[current], [config]] = await Promise.all([
    db.select().from(users).where(eq(users.id, user.id)),
    db.select({ role: approvalConfigs.approverRole }).from(approvalConfigs).where(eq(approvalConfigs.docType, "wo")),
  ]);
  if (!current?.active || (user.sessionVersion != null && current.sessionVersion !== user.sessionVersion)) return null;
  return woTaskActions(current, doc, config?.role ?? null);
}
