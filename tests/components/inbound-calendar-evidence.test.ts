import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import InboundCalendarClient from "@/app/(app)/report/inbound-calendar/inbound-calendar-client";
import { buildPromiseReliability } from "@/server/modules/report/supply-commitment";

const state = vi.hoisted(() => ({ phase: "loading", data: null as unknown, error: null as string | null, retry: vi.fn(), read: vi.fn() }));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: (url: string) => { state.read(url); return state; } }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (v: unknown) => [v, vi.fn()], useMemo: (fn: () => unknown) => fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Card: "card", DatePicker: { RangePicker: "range" }, Empty: "empty", Space: "space", Spin: "spin", Statistic: "stat", Table: "table", Tag: "tag", Typography: { Title: "h", Paragraph: "p", Text: "text" } }));
vi.mock("recharts", () => ({ Bar: "bar", BarChart: "chart", CartesianGrid: "grid", Legend: "legend", ResponsiveContainer: "container", Tooltip: "tooltip", XAxis: "x", YAxis: "y" }));
vi.mock("@/components/DecisionVisual", () => ({ default: "visual" }));
vi.mock("@/components/ExportButton", () => ({ default: "export" }));
vi.mock("@/components/SkuHoverCard", () => ({ default: "sku" }));
vi.mock("@/components/ProductExternalDecisionEvidenceCard", () => ({ default: "evidence" }));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const view = () => nodes(InboundCalendarClient()).find(n => n.type === "visual")!;
beforeEach(() => { vi.stubGlobal("React", React); state.phase = "loading"; state.data = null; state.error = null; state.retry.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

it("读取失败有持久重试且不能导出旧结果，等待不画成成功零值", () => {
  expect(view().props.state).toBe("loading"); expect(view().props.extra).toBeUndefined();
  state.phase = "error"; state.error = "读取超时";
  expect(view().props.state).toBe("error"); expect(view().props.extra).toBeUndefined();
  const error = nodes(InboundCalendarClient()).find(n => n.type === "alert" && n.props.type === "error")!;
  const retry = nodes(error.props.action as ReactNode)[0]; (retry.props.onClick as () => void)(); expect(state.retry).toHaveBeenCalledOnce();
  expect(state.read).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/report\/inbound-calendar\?from=\d{4}-\d{2}-\d{2}&to=/));
});
it("完整导出绑定观察窗而不是预览数组，每行链接按PO/行身份构造", () => {
  const promise = buildPromiseReliability([], [], [], { asOf: "2026-08-10", windowDays: 90 });
  state.phase = "success"; state.data = { summary: { bySource: {}, undatedLines: 0, totalLines: 0, totalQty: 0 }, days: [], promiseReliability: promise, supportingObservations: [] };
  const visual = view(); const exp = nodes(visual.props.extra as ReactNode)[0];
  expect(exp.props.href).toBe("/api/export/supply-commitment?asOf=2026-08-10&windowDays=90");
  expect(visual.props.onExport).toBeUndefined();
  const table = nodes(visual.props.dataView as ReactNode).find(n => n.type === "table")!;
  const column = (table.props.columns as { dataIndex: string; render: (value: string, row: unknown) => ReactNode }[]).find(c => c.dataIndex === "docNo")!;
  expect(nodes(column.render("PO-SAME", { poId: 3, lineId: 8 }))[0].props.href).toBe("/outsource/po?docId=3&poLineId=8");
  expect(JSON.stringify(visual.props.dataView)).toContain("列排序仅作用于本预览");
});
