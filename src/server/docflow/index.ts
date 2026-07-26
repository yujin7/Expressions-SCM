/** 单据流引擎：取号（R8/B5）/ 统一状态机（§4）/ 单级审批（§6, R10） */
export { nextDocNo, bizDateShanghai, type AnyDb } from "./doc-no";
export {
  nextStatus,
  canEdit,
  TransitionError,
  type DocStatus,
  type DocAction,
} from "./state";
export { approveDoc, ApprovalError, type ApprovalErrorCode, type Approver } from "./approval";
