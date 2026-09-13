import { dAdd, dCmp } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { approvalRoleError } from "@/server/docflow/approval";

export function canCreateMaterialDoc(user: SessionUser) {
  return user.roles.includes("admin") || user.roles.includes("warehouse");
}

export function canEditMaterialDraft(user: SessionUser, doc: { status: string; createdBy: number | null }) {
  return doc.status === "draft" && canCreateMaterialDoc(user)
    && (doc.createdBy === user.id || user.roles.includes("admin"));
}

/** Same per-SKU predicate for action hints and transactional approval; no cross-material netting. */
export function materialExcess(lines: readonly { skuId: number; qty: string }[], cumulative: ReadonlyMap<number, string>, limits: ReadonlyMap<number, string>) {
  const totals = new Map(cumulative);
  for (const line of lines) totals.set(line.skuId, dAdd(totals.get(line.skuId) ?? "0", line.qty));
  for (const [skuId, qty] of totals) {
    const limit = limits.get(skuId) ?? "0";
    if (dCmp(qty, limit) > 0) return { skuId, qty, limit };
  }
  return null;
}

/** Read-only hints. All identity/source/version/stock checks still run inside the write. */
export function materialTaskActions(user: SessionUser, doc: { status: string; createdBy: number | null }, role: string | null,
  sourceBlock: string | null, quantityBlock: string | null) {
  const maker = doc.createdBy === user.id;
  const qualification = approvalRoleError(user, role);
  const submitRole = maker || canCreateMaterialDoc(user);
  const submit = doc.status === "draft" && submitRole && !sourceBlock;
  const reject = doc.status === "pending" && !maker && !qualification;
  const approve = reject && !sourceBlock && !quantityBlock;
  const reason = doc.status === "draft"
    ? !submitRole ? "请联系制单人、仓管或管理员核对后提交。" : sourceBlock ?? "请核对来源、仓库、物料和数量后提交；提交不会立即改变库存。"
    : doc.status === "pending" ? maker ? "制单人不可自审或自行驳回，请另一位合格审批人处理。"
      : qualification?.message ?? sourceBlock ?? quantityBlock ?? "当前具备处理资格；批准时仍会检查最新来源、数量、版本与库存，批准成功即过账。"
    : "单据已结束或生效，保留历史只读；如需纠错请联系仓管核对，不重复提交或审批。";
  return { submit, approve, reject, reason: reject && !approve ? `${reason}；仍可驳回交制单人核对。` : reason };
}
