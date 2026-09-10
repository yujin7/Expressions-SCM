import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { GoalHistoryCard, TodoCompletionStrictCard, TodoThroughputCard } from "@/app/(app)/cockpit/trends/screen-s4";
import type { GoalHistoryBlock, GoalHistorySeries } from "@/server/modules/report/cockpit-trends";
import type { Block } from "@/server/modules/report/cockpit";

const state = vi.hoisted(() => ({ desktop: true, strictView: "month" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useMemo: (fn: () => unknown) => fn(), useState: (v: unknown) => [v === "month" ? state.strictView : v, vi.fn()] }));
vi.mock("recharts", () => Object.fromEntries(["Bar", "BarChart", "CartesianGrid", "Cell", "Legend", "Line", "LineChart", "ResponsiveContainer", "Tooltip", "XAxis", "YAxis"].map(k => [k, k.toLowerCase()])));
vi.mock("antd", () => ({ Col: "col", Row: "row", Segmented: "segmented", Space: "space", Statistic: "statistic", Table: "table", Tag: "tag", Typography: { Text: "text" }, Grid: { useBreakpoint: () => ({ md: state.desktop }) } }));
vi.mock("@/app/(app)/cockpit/trends/shared", () => ({ TrendCard: "trend", metricLabel: (_: string, fallback: string) => fallback, Muted: "muted", sourceChartRows: vi.fn(), useChartTheme: () => ({ tooltip: {} }) }));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(v: ReactNode): Node[] {
  if (Array.isArray(v)) return v.flatMap(nodes);
  if (!isValidElement<Node["props"]>(v)) return [];
  if (typeof v.type === "function") return nodes((v.type as (p: unknown) => ReactNode)(v.props));
  return [v, ...nodes(v.props.children)];
}
function text(v: ReactNode): string {
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(text).join("");
  if (!isValidElement<Node["props"]>(v)) return "";
  return typeof v.type === "function" ? text((v.type as (p: unknown) => ReactNode)(v.props)) : text(v.props.children);
}
const series = (): GoalHistorySeries => ({ deptKey: "purchasing", metricKey: "paymentTermAttainment", metricLabel: "账期达成率", unit: "pct", direction: "up", periodKind: "month", points: ["2026-08", "2026-09"].map(period => ({ period, targetValue: "80", actualValue: null, actualSource: "auto", attainment: null, attained: null, valueWithheld: false, unavailableReason: "账期自动值未封存逐期来源依据，不能作为历史实际值" })) });
function content(s = series()) {
  const data: GoalHistoryBlock = { periodsPerSeries: 6, series: [s], metricIds: ["goalAttainment"] };
  const block: Block<GoalHistoryBlock> = { state: "ready", data, note: "合成依据", source: { tier: "manual", source: "synthetic", asOf: null } };
  const card = GoalHistoryCard({ block }) as React.ReactElement<{ children: (data: GoalHistoryBlock) => ReactNode }>;
  return card.props.children(data);
}
beforeEach(() => { vi.stubGlobal("React", React); state.desktop = true; state.strictView = "month"; });
it("桌面部门中文化，无可评估值不显示0/0", () => {
  const table = nodes(content()).find(n => n.type === "table")!;
  const columns = table.props.columns as { dataIndex?: string; key?: string; render?: (v: unknown, s: GoalHistorySeries) => ReactNode }[];
  const dept = columns.find(c => c.dataIndex === "deptKey")!;
  expect(text(dept.render ? dept.render("purchasing", series()) : "purchasing")).toBe("采购");
  expect(text(columns.find(c => c.key === "n")!.render!(null, series()))).toBe("无可评估期间");
});
it("手机每条记录同时保留部门、指标、所有期间和缺据说明，不依赖横滚找身份", () => {
  state.desktop = false;
  const tree = nodes(content());
  expect(tree.some(n => n.type === "table")).toBe(false);
  const all = text(content());
  for (const value of ["采购", "账期达成率", "26-08", "26-09", "缺逐期依据", "无可评估期间"]) expect(all).toContain(value);
  expect(all).not.toContain("0 / 0");
});
it("权限不足保持独立状态，不误称未填或缺数据", () => {
  state.desktop = false;
  const s = series(); s.points.forEach(p => { p.valueWithheld = true; p.unavailableReason = null; });
  expect(text(content(s))).toContain("无权限");
  expect(text(content(s))).not.toContain("未填");
});
it("角色筛选用中文标签但保留原始角色键", () => {
  const data = { months: ["2026-09"], roles: ["purchasing", "finance"], rows: [], caliber: "合成" };
  const element = TodoThroughputCard({ block: { state: "ready", data, note: "", source: { tier: "manual", source: "synthetic", asOf: null } } as never }) as Node;
  const segmented = nodes(element.props.extra as ReactNode).find(n => n.type === "segmented")!;
  expect(segmented.props.options).toEqual([{ label: "全部", value: "全部" }, { label: "采购", value: "purchasing" }, { label: "财务", value: "finance" }]);
});
it("真实0仍作为可评估值，保留手工标记；不与未知相混", () => {
  state.desktop = false;
  const s = series();
  s.points[0] = { ...s.points[0], actualValue: "0", attainment: "0.0", attained: false, actualSource: "manual", unavailableReason: null };
  const all = text(content(s));
  expect(all).toContain("0.0%·手"); expect(all).toContain("0 / 1");
  expect(all).toContain("缺逐期依据"); expect(all).not.toContain("无可评估期间");
});
it("手机长指标与6期间全部保留，未知角色不丢身份", () => {
  state.desktop = false;
  const s = series(); s.deptKey = "future_role"; s.metricLabel = "跨渠道长名称指标完整解释".repeat(4);
  s.points = Array.from({ length: 6 }, (_, i) => ({ ...s.points[0], period: `2026-${String(i + 4).padStart(2, "0")}` }));
  const all = text(content(s)); expect(all).toContain(s.metricLabel); expect(all).toContain("future_role");
  for (const month of ["04", "05", "06", "07", "08", "09"]) expect(all).toContain(`26-${month}`);
});
it("严格待办图表、提示和数据表复用相同中文角色标签", () => {
  state.strictView = "role";
  const cell = { key: "purchasing", total: 1, done: 0, cancelled: 0, cancelledBySourceClose: 0, cancelledBySourceManualClose: 0, cancelledByHuman: 0, completionRate: 0, completionRateStrict: 0, gapPp: 0 };
  const data = { overall: cell, byRole: [cell], byMonth: [] };
  const element = TodoCompletionStrictCard({ block: { state: "ready", data, note: "", source: { tier: "manual", source: "synthetic", asOf: null } } as never }) as Node;
  const table = nodes(element.props.dataView as ReactNode).find(n => n.type === "table")!;
  const first = (table.props.columns as { render: (v: string) => string }[])[0];
  expect(first.render("purchasing")).toBe("采购");
  const render: unknown = element.props.children;
  expect(typeof render).toBe("function");
  const chart = nodes((render as (d: unknown) => ReactNode)(data));
  expect((chart.find(n => n.type === "xaxis")!.props.tickFormatter as (v: string) => string)("purchasing")).toBe("采购");
  expect((chart.find(n => n.type === "tooltip")!.props.labelFormatter as (v: string) => string)("purchasing")).toBe("采购");
  expect(table.props.dataSource).toBe(data.byRole);
});
