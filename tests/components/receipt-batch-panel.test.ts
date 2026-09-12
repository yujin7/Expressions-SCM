import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReceiptBatchPanel, { type ReceiptBatchView } from "@/app/(app)/matflow/sh/receipt-batch-panel";

// Callback/lifecycle checks; real AntD confirmation and layout require browser verification.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanups: [] as (() => void)[], post: vi.fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Popconfirm: "confirm", Space: "space", Typography: { Text: "text" } }));
vi.mock("@/components/fetchJson", () => ({ postJson: h.post }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = initial; return [h.slots[i], (v: unknown) => { h.slots[i] = v; }]; },
  useEffect: (fn: () => (() => void)) => { const i = h.cursor++; if (!(i in h.slots)) { h.slots[i] = true; h.cleanups.push(fn()); } },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode; description?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children), ...nodes(v.props.description)] : [];
const pending: ReceiptBatchView = { requestId: 9, woId: 12, woDocNo: "WO-12", requestedAt: "2026-09-13T00:00:00Z", checkedAt: null, state: "pending", jgId: null, docNo: null, reason: null };
const checked = vi.fn();
function render(review: ReceiptBatchView | null = pending, canCheck = true) { h.cursor = 0; return ReceiptBatchPanel({ receiptId: 181, review, canCheck, onChecked: checked }); }
const submit = () => (nodes(render()).find(n => n.type === "confirm")!.props.onConfirm as () => Promise<void>)();
beforeEach(() => { h.cursor = 0; h.slots = []; h.cleanups = []; h.post.mockReset(); checked.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { h.cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); });
it("warehouse sees completed stock plus pending PMC handoff, not a generation control", () => {
  const tree = render(pending, false);
  expect(JSON.stringify(tree)).toContain("请PMC或管理员");
  expect(nodes(tree).some(n => n.type === "confirm")).toBe(false);
  expect(JSON.stringify(tree)).toContain("库存已经入账");
});
it("missing historical intent is unknown rather than successful or failed", () => {
  expect(JSON.stringify(render(null))).toContain("不能据此判断已建批");
  expect(nodes(render(null)).some(n => n.type === "confirm")).toBe(false);
});
it("synchronous double confirmation submits one exact receipt recovery, never another inbound", async () => {
  const task = Promise.withResolvers<unknown>(); h.post.mockReturnValue(task.promise);
  const first = submit(); await submit();
  expect(h.post).toHaveBeenCalledTimes(1); expect(h.post).toHaveBeenCalledWith("/api/matflow/sh/181/batch-check", {});
  task.resolve({ state: "created" }); await first; expect(checked).toHaveBeenCalledTimes(1);
});
it("failed request retains actionable feedback and only an explicit retry resubmits", async () => {
  h.post.mockRejectedValueOnce(Error("连接中断，请先核对结果")); await submit();
  expect(JSON.stringify(render())).toContain("连接中断"); expect(checked).not.toHaveBeenCalled();
  render(); expect(h.post).toHaveBeenCalledTimes(1);
  h.post.mockResolvedValue({ state: "created" }); await submit(); expect(checked).toHaveBeenCalledTimes(1);
});
it("unmounted receipt cannot refresh a different document after a late response", async () => {
  const task = Promise.withResolvers<unknown>(); h.post.mockReturnValue(task.promise);
  const first = submit(); h.cleanups.forEach(fn => fn()); task.resolve({ state: "created" }); await first;
  expect(checked).not.toHaveBeenCalled();
});
it("created draft links the exact JG, blocked check shows reason without declaring the problem solved", () => {
  const created = render({ ...pending, state: "created", jgId: 92, docNo: "JG-92", checkedAt: pending.requestedAt });
  expect(nodes(created).find(n => n.props.href === "/outsource/jg?docId=92")).toBeTruthy();
  expect(nodes(created).some(n => n.type === "confirm")).toBe(false);
  expect(JSON.stringify(render({ ...pending, state: "not_generated", reason: "当前可生产量不足" }))).toContain("不代表当前问题已解决");
});
