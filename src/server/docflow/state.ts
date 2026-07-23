/**
 * 统一单据状态机（《01》§4）：
 * 草稿 ─提交→ 待审批 ─通过→ 已审批 ─[PO/JG:确认(代录)｜其他:开始]→ 执行中 ─完成→ 已完成
 *   │            │驳回→草稿              │                              │
 *   └─作废       └─撤回→草稿             └─短关(留原因)→ 已关闭 ─重开(管理员)→ 执行中
 * 纠错=红字冲销，无反审批——因此不存在 approved→pending 之类的逆向流转。
 */
export type DocStatus =
  | "draft"
  | "pending"
  | "approved"
  | "in_progress"
  | "completed"
  | "closed"
  | "void";

export type DocAction =
  | "submit"
  | "withdraw"
  | "approve"
  | "reject"
  | "confirm" // PO/JG：供应商确认（内部代录）
  | "start" // 其他单据：开始执行（与 confirm 同一条边）
  | "complete"
  | "short_close"
  | "reopen"
  | "void";

export class TransitionError extends Error {
  constructor(
    public readonly from: DocStatus,
    public readonly action: DocAction,
  ) {
    super(`非法状态流转: ${from} -[${action}]→`);
    this.name = "TransitionError";
  }
}

const TRANSITIONS: Record<DocStatus, Partial<Record<DocAction, DocStatus>>> = {
  draft: { submit: "pending", void: "void" },
  pending: { withdraw: "draft", reject: "draft", approve: "approved" },
  approved: { confirm: "in_progress", start: "in_progress", short_close: "closed" },
  in_progress: { complete: "completed", short_close: "closed" },
  completed: {},
  closed: { reopen: "in_progress" }, // 仅管理员（权限在调用侧校验）
  void: {},
};

/** 计算流转后状态；非法流转抛 TransitionError */
export function nextStatus(from: DocStatus, action: DocAction): DocStatus {
  const to = TRANSITIONS[from]?.[action];
  if (!to) throw new TransitionError(from, action);
  return to;
}

/** 仅草稿可编辑；其余状态改动一律走红字/短关等正向动作 */
export function canEdit(status: DocStatus): boolean {
  return status === "draft";
}
