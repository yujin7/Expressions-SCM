import { eq, getTableColumns } from "drizzle-orm";
import { approvalConfigs, jgDocs, pcDocs, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { dCmp } from "@/server/core/decimal";
import { assertJgFeeMutable } from "@/server/core/jg-fee-boundary";
import { approvalRoleError, loadApprovalHistory } from "@/server/docflow/approval";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, resolveDb } from "./common";

/** Read-only qualification; approvePc still rechecks identity, version and business facts. */
export function pcTaskActions(user: SessionUser, doc: { status: string; createdBy: number | null }, role: string | null, effectBlock: string | null = null) {
  const qualification = approvalRoleError(user, role);
  const reason = doc.status !== "pending"
    ? doc.status === "draft" ? "已驳回；加工费请重新发起申请，采购价请返回原PO核对后重新提交。" : "本次改价已结束；历史申请不再审批。"
    : user.id === doc.createdBy ? "制单人不可自审或自行驳回；请另一位有资格的审批人处理。"
    : qualification?.message ?? null;
  const reject = !reason;
  return { approve: reject && !effectBlock, reject,
    reason: reason ?? effectBlock ?? "请核对改价对象和生效范围；提交时将再次检查当前权限、版本及结算冻结状态。" };
}

export async function getPc(id: number, user: SessionUser, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc] = await db.select({ ...getTableColumns(pcDocs), createdByName: users.name })
    .from(pcDocs).leftJoin(users, eq(pcDocs.createdBy, users.id)).where(eq(pcDocs.id, id));
  if (!doc) throw new ApiError(404, "价格变更申请不存在");
  const [cfg] = await db.select({ role: approvalConfigs.approverRole }).from(approvalConfigs).where(eq(approvalConfigs.docType, "pc"));
  let effectBlock: string | null = null;
  if (doc.status === "pending" && doc.target === "jg_fee") {
    const [jg] = doc.jgId == null ? [] : await db.select({ rate: jgDocs.feeRateCurrent }).from(jgDocs).where(eq(jgDocs.id, doc.jgId));
    if (!jg || doc.jgId == null) effectBlock = "关联加工单不存在，请核对来源并驳回旧申请。";
    else {
      try { await assertJgFeeMutable(db, doc.jgId); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        effectBlock = `${error.message}；本申请仍可驳回。`;
      }
      if (!effectBlock && dCmp(jg.rate, doc.oldPrice) !== 0) effectBlock = "加工费现价已与申请原价不一致，请驳回旧申请后重新发起。";
    }
  }
  return { ...doc, approvals: await loadApprovalHistory(db, "pc", id), actions: pcTaskActions(user, doc, cfg?.role ?? null, effectBlock) };
}
