import { eq } from "drizzle-orm";
import { approvalConfigs, users } from "@/db/schema";
import { canSeePrices, type SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";
import { approvalRoleError } from "@/server/docflow/approval";

/** Read guidance only; every mutation rechecks authority and locks the document. */
export function poTaskActions(user: SessionUser, doc: { status: string; createdBy: number | null }, role: string | null) {
  const admin = user.roles.includes("admin"), maker = doc.createdBy === user.id;
  const buyer = admin || user.roles.includes("purchasing");
  const owner = maker || admin;
  const approvalBlock = approvalRoleError(user, role);
  const review = doc.status === "pending" && !maker && !approvalBlock;
  const confirmRole = buyer || user.roles.includes("pmc");
  const reason = doc.status === "draft"
    ? owner || buyer ? "核对物料、采购数量与价格后提交；价格异动会生成待审改价申请，采购单仍保留草稿。" : "仅制单人、采购或管理员可提交，请联系相应人员核对。"
    : doc.status === "pending" ? maker ? "制单人不能自审或自行驳回；需要更正时可撤回，由另一位合格审批人核对。"
      : approvalBlock ? `${approvalBlock.message}；请联系合格审批人处理。`
        : !canSeePrices(user.roles) ? "当前可驳回，但不可查看采购价格，不能批准；请由具备金额可见权限的合格审批人核对。"
          : "核对物料、数量、价格与履约条件后批准或驳回；批准不产生收货或库存流水。"
      : doc.status === "approved" ? "内部代录只记录确认备注并进入执行中，不代表供应商已回传交期；逐行承诺请使用供应商确认门户。"
        : doc.status === "in_progress" ? "按实际履约收货、核对交期或收口；重新生成确认链接会使原链接失效，请确认后再转发。"
          : "当前为历史只读状态；核对关联单据及审计，不重复提交、审批或确认。";
  return { submit: doc.status === "draft" && (owner || buyer), approve: review && canSeePrices(user.roles), reject: review,
    withdraw: doc.status === "pending" && owner, confirm: doc.status === "approved" && confirmRole,
    confirmToken: ["approved", "in_progress"].includes(doc.status) && confirmRole, reason };
}
export type PoTaskActions = ReturnType<typeof poTaskActions>;

export async function loadPoTaskActions(db: AnyDb, doc: { status: string; createdBy: number | null }, user?: SessionUser): Promise<PoTaskActions | null> {
  if (!user) return null;
  const [[current], [config]] = await Promise.all([
    db.select().from(users).where(eq(users.id, user.id)),
    db.select({ role: approvalConfigs.approverRole }).from(approvalConfigs).where(eq(approvalConfigs.docType, "po")),
  ]);
  if (!current?.active || (user.sessionVersion != null && current.sessionVersion !== user.sessionVersion)) return null;
  return poTaskActions(current, doc, config?.role ?? null);
}
