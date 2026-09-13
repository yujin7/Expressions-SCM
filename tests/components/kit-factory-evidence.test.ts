import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import KitFactoryEvidence from "@/components/KitFactoryEvidence";
const h = vi.hoisted(() => ({ data: null as unknown, phase: "loading", error: null as string | null, retry: vi.fn(), read: vi.fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Space: "space", Table: "table", Tag: "tag", Typography: { Title: "title", Paragraph: "paragraph", Text: "text" } }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "error" }));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: h.read }));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const render = () => nodes(KitFactoryEvidence({ woId: 18 }));
const evidence = () => ({ woId: 18, woDocNo: "WO-18", woVersion: 2, observedAt: "2026-09-13T12:00:00Z", supplierName: "合成加工厂", allocationStatus: "unverified", warehouses: [], materials: [{ skuId: 2, code: "PK-2", name: "合成包材", unit: "个", required: "100", factoryOnHand: null, warehouses: [], peers: [] }] });
beforeEach(() => { h.data = null; h.phase = "loading"; h.error = null; h.retry.mockClear(); h.read.mockReset().mockImplementation(() => h); vi.stubGlobal("React", React); });
it("loading and failure are not presented as zero stock or verified allocation", () => {
  expect(render().some(n => n.type === "table")).toBe(false);
  expect(h.read).toHaveBeenCalledWith("/api/outsource/auto-chain/evidence?woId=18");
  h.phase = "error"; h.error = "网络中断";
  expect(render().find(n => n.type === "error")?.props.error).toBe("网络中断");
  expect(render().some(n => n.type === "table")).toBe(false);
});
it("wrong identity or allocation semantics never renders as valid evidence", () => {
  h.phase = "success";
  for (const data of [{ ...evidence(), woId: 19 }, { ...evidence(), allocationStatus: "verified" }]) {
    h.data = data; expect(render().some(n => n.type === "table")).toBe(false);
    expect(render().find(n => n.type === "error")?.props.error).toContain("身份不符");
  }
});
it("unknown stays unknown, narrow tables scroll internally, retry is a read", () => {
  h.phase = "success"; h.data = evidence();
  const tree = render(), table = tree.find(n => n.type === "table")!;
  expect(table.props.tableLayout).toBe("fixed"); expect(table.props.scroll).toEqual({ x: 650 });
  const cols = table.props.columns as { dataIndex?: string; render?: (v: unknown) => ReactNode }[];
  expect(cols.find(c => c.dataIndex === "factoryOnHand")!.render!(null)).toBe("未知");
  expect(JSON.stringify(tree)).toContain("本单可领用量尚未确认");
  (tree.find(n => n.type === "button")!.props.onClick as () => void)(); expect(h.retry).toHaveBeenCalledTimes(1);
});
