import { describe, expect, it } from "vitest";
import {
  canEdit,
  nextStatus,
  TransitionError,
  type DocAction,
  type DocStatus,
} from "@/server/docflow/state";

const ALL_STATUSES: DocStatus[] = [
  "draft",
  "pending",
  "approved",
  "in_progress",
  "completed",
  "closed",
  "void",
];
const ALL_ACTIONS: DocAction[] = [
  "submit",
  "withdraw",
  "approve",
  "reject",
  "confirm",
  "start",
  "complete",
  "short_close",
  "reopen",
  "void",
];

describe("统一状态机 nextStatus", () => {
  it("完整合法路径 draft→pending→approved→in_progress→completed（start 版）", () => {
    let s: DocStatus = "draft";
    s = nextStatus(s, "submit");
    expect(s).toBe("pending");
    s = nextStatus(s, "approve");
    expect(s).toBe("approved");
    s = nextStatus(s, "start");
    expect(s).toBe("in_progress");
    s = nextStatus(s, "complete");
    expect(s).toBe("completed");
  });

  it("PO/JG 用 confirm（供应商确认代录）走同一条边 approved→in_progress", () => {
    expect(nextStatus("approved", "confirm")).toBe("in_progress");
    expect(nextStatus("approved", "start")).toBe("in_progress");
  });

  it("驳回/撤回回草稿；草稿可作废", () => {
    expect(nextStatus("pending", "reject")).toBe("draft");
    expect(nextStatus("pending", "withdraw")).toBe("draft");
    expect(nextStatus("draft", "void")).toBe("void");
  });

  it("短关：approved→closed 与 in_progress→closed；重开 closed→in_progress", () => {
    expect(nextStatus("approved", "short_close")).toBe("closed");
    expect(nextStatus("in_progress", "short_close")).toBe("closed");
    expect(nextStatus("closed", "reopen")).toBe("in_progress");
  });

  it("非法跳转抛 TransitionError：draft→approve、pending→start 等", () => {
    expect(() => nextStatus("draft", "approve")).toThrow(TransitionError);
    expect(() => nextStatus("draft", "complete")).toThrow(TransitionError);
    expect(() => nextStatus("pending", "start")).toThrow(TransitionError);
    expect(() => nextStatus("approved", "approve")).toThrow(TransitionError);
    expect(() => nextStatus("in_progress", "void")).toThrow(TransitionError);
  });

  it("终态 completed / void 任何动作都抛错", () => {
    for (const from of ["completed", "void"] as const) {
      for (const a of ALL_ACTIONS) {
        expect(() => nextStatus(from, a), `${from} + ${a}`).toThrow(TransitionError);
      }
    }
  });

  it("TransitionError 携带 from/action", () => {
    try {
      nextStatus("closed", "submit");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
      expect((e as TransitionError).from).toBe("closed");
      expect((e as TransitionError).action).toBe("submit");
    }
  });
});

describe("canEdit", () => {
  it("仅 draft 可编辑", () => {
    for (const s of ALL_STATUSES) {
      expect(canEdit(s), s).toBe(s === "draft");
    }
  });
});
