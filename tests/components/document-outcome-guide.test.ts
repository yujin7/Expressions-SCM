import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocumentOutcomeGuide from "@/components/DocumentOutcomeGuide";

vi.mock("antd", () => ({ Button: "button" }));
vi.mock("@/components/DocStatusTag", () => ({ default: "status" }));
type Props = Parameters<typeof DocumentOutcomeGuide>[0];
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const text = (v: ReactNode): string => Array.isArray(v) ? v.map(text).join("") : isValidElement<Node["props"]>(v) ? text(v.props.children) : typeof v === "string" || typeof v === "number" ? String(v) : "";
const open = vi.fn(), create = vi.fn();
const base: Props = { kind: "ct", status: "void", closedReason: "选错实物批次", actionReason: "原单只读",
  replacement: { predecessor: null, successor: null, canCreate: true, reason: null }, onOpen: open, onCreateReplacement: create };
beforeEach(() => { vi.stubGlobal("React", React); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it("renders one named guidance region without auto-navigation or creation", () => {
  const tree = DocumentOutcomeGuide(base);
  expect(tree?.props["aria-label"]).toBe("单据状态与下一步");
  expect(nodes(tree).filter(n => n.type === "section")).toHaveLength(1);
  expect(text(tree)).toContain("选错实物批次"); expect(text(tree)).toContain("原单只读");
  expect(open).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  const button = nodes(tree).find(n => n.type === "button")!;
  expect(button.props.children).toBe("新建替代退货单"); expect(button.props.disabled).toBe(false);
  (button.props.onClick as () => void)(); expect(create).toHaveBeenCalledOnce();
});
it.each(["stock", "ct"] as const)("%s keeps stock/return safety visible outside optional help", kind => {
  const tree = DocumentOutcomeGuide({ ...base, kind });
  const main = React.Children.toArray(tree?.props.children).filter((n): n is Node => isValidElement<Node["props"]>(n) && n.type === "p");
  expect(main.some(n => text(n).includes(kind === "ct" ? "作废不代表已退货或已冲销" : "不冲销已过账库存"))).toBe(true);
  const help = nodes(tree).find(n => n.type === "details")!;
  expect(help.props.open).toBeUndefined();
  expect(nodes(help)[1].type).toBe("summary"); expect(text(help)).toContain("独立提交");
  expect(text(help)).toContain(kind === "ct" ? "不证明该批次来自" : "红字引用");
});
it.each(["draft", "pending", "approved", "in_progress", "completed", "closed"])("%s never creates a replacement even with contradictory canCreate", status => {
  const tree = DocumentOutcomeGuide({ ...base, status });
  expect(nodes(tree).some(n => n.type === "button")).toBe(false);
  if (status === "closed") { expect(text(tree)).toContain("短关原因"); expect(text(tree)).not.toContain("作废原因"); }
});
it.each([undefined, { ...base.replacement!, canCreate: false, reason: "当前账号无权替代" },
  { ...base.replacement!, reason: "仍须核对流水" }])("unknown/refused eligibility has no create entry: %j", replacement => {
  const tree = DocumentOutcomeGuide({ ...base, replacement });
  expect(nodes(tree).some(n => n.type === "button")).toBe(false);
  expect(text(tree)).toContain(replacement?.reason || "资格尚未确认");
});
it("existing successor wins over contradictory creation hint and navigation opens exact identities only", () => {
  const tree = DocumentOutcomeGuide({ ...base, replacement: { ...base.replacement!,
    predecessor: { id: 5, docNo: "CT-原始很长的中文单据名称", status: "void" }, successor: { id: 9, docNo: "CT-后继", status: "draft" } } });
  const buttons = nodes(tree).filter(n => n.type === "button"); expect(buttons).toHaveLength(2);
  expect(text(buttons[0])).toContain("被替代原单"); expect(text(buttons[1])).toContain("后续替代单");
  (buttons[0].props.onClick as () => void)(); (buttons[1].props.onClick as () => void)();
  expect(open.mock.calls).toEqual([[5], [9]]); expect(create).not.toHaveBeenCalled();
});
it.each(["正在读取本机记录", "正在核对原请求", "先核对或取消原请求"])("blocked creation explains why: %s", createBlockedReason => {
  const tree = DocumentOutcomeGuide({ ...base, createBlockedReason });
  expect(nodes(tree).find(n => n.type === "button")?.props.disabled).toBe(true);
  expect(text(tree)).toContain(createBlockedReason); expect(create).not.toHaveBeenCalled();
});
it.each([null, undefined, "   "])("missing reason %j stays unknown rather than implying reversal", closedReason => {
  expect(text(DocumentOutcomeGuide({ ...base, closedReason }))).toContain("历史未登记，请核对审计记录");
});
it("normal documents without a hint or lineage do not get decorative empty panels", () => {
  expect(DocumentOutcomeGuide({ kind: "stock", status: "draft", onOpen: open })).toBeNull();
});
it("linked draft can explain its predecessor but cannot create another replacement", () => {
  const tree = DocumentOutcomeGuide({ ...base, status: "draft", replacement: { ...base.replacement!,
    predecessor: { id: 5, docNo: "CT-5", status: "void" }, canCreate: false } });
  expect(nodes(tree).filter(n => n.type === "button")).toHaveLength(1);
  expect(text(tree)).not.toContain("作废原因"); expect(text(tree)).toContain("被替代原单");
});
