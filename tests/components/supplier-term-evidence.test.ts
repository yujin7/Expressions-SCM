import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import PaymentTermTab from "@/app/(app)/report/supplier-scorecard/payment-term-tab";
import type { SupplierPaymentTermModel } from "@/server/modules/report/supplier-payment-term";

const state = vi.hoisted(() => ({ desktop: false, scope: "all", buyer: true, data: null as unknown, error: null as string | null }));
const exported = vi.hoisted(() => vi.fn());
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useMemo: (fn: () => unknown) => fn(), useState: (v: unknown) => [v, vi.fn()],
}));
vi.mock("antd", () => ({
  Alert: "alert", Button: "button", Card: "card", Col: "col", DatePicker: "date", Input: { TextArea: "textarea" }, InputNumber: "number",
  Modal: "modal", Row: "row", Segmented: "segmented", Select: "select", Space: "space", Statistic: "statistic", Table: "table", Tag: "tag", Tooltip: "tooltip",
  Typography: { Text: "text", Paragraph: "paragraph" }, Grid: { useBreakpoint: () => ({ lg: state.desktop }) },
  Form: Object.assign("form", { useForm: () => [{ setFieldsValue: vi.fn() }], Item: "item" }), App: { useApp: () => ({ message: {} }) },
}));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: () => ({ data: state.data, error: state.error, phase: state.error ? "error" : "success", retry: vi.fn() }) }));
vi.mock("@/components/useMe", () => ({ useMe: () => ({}), hasAnyRole: () => state.buyer }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { scope: state.scope }, setFilter: vi.fn(), tableSize: "small", paginationProps: () => ({}) }) }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/CaliberNote", () => ({ default: "caliber" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/exportCsv", () => ({ exportCsv: exported }));

type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const text = (v: ReactNode): string => typeof v === "string" || typeof v === "number" ? String(v) : Array.isArray(v) ? v.map(text).join("") : isValidElement<Node["props"]>(v) ? text(v.props.children) : "";
function fixture(): SupplierPaymentTermModel {
  return {
    key: "supplier-payment-term/v3", authority: "ledger", sourceBinding: "test", builtAt: "2026-09-08T00:00:00Z", asOf: "2026-09-08", year: 2026, moneyVisible: true,
    params: { minYears: 2, targetMinDays: 45, targetMaxDays: 60 }, limitations: ["未来条款待生效，不提前计达标"],
    summary: { suppliers: 1, withSpend: 1, candidates: 1, candidatesAttained: 0, attainmentRate: 0, creditTermSuppliers: 0, totalSpend: "3000", creditTermSpend: "0", creditTermSpendSharePct: null, unclassifiedSpendSuppliers: 1, byPool: [] },
    rows: [{ supplierId: 1, code: "TERM-TEST", name: "长名称合成供应商", kinds: ["processor"], status: "qualified", pool: "processor", cooperationSince: "2023-01-01", cooperationSource: "system_inferred", cooperationYears: 3, hasCurrentYearSpend: true,
      spend: [2026, 2025, 2024].map(year => ({ year, poNet: "3000", jsSettle: null, total: "3000", rank: 1, rankOf: 1 })), rankTrend: "up", candidate: true, candidateReason: "合作满两年，排名上升", paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2100-01-01", paymentTermText: null, attainment: "pending", termState: "pending" }],
  };
}
beforeEach(() => { vi.stubGlobal("React", React); state.data = fixture(); state.error = null; state.desktop = false; state.scope = "all"; state.buyer = true; exported.mockClear(); });

it("窄屏保留供应商、三年排名/采购额、未来生效日和行动，不用固定列遮挡", () => {
  const table = nodes(PaymentTermTab()).find(n => n.type === "table")!;
  expect(table.props.scroll).toEqual({ x: undefined });
  const columns = table.props.columns as { fixed?: string; render: (v: unknown, r: unknown) => ReactNode }[];
  expect(columns).toHaveLength(1); expect(columns[0].fixed).toBeUndefined();
  const content = text(columns[0].render(null, fixture().rows[0]));
  for (const value of ["TERM-TEST", "待生效", "2100-01-01", "2026", "2025", "2024", "登记账期"]) expect(content).toContain(value);
});
it("桌面保留宽表横向视口与左右身份/操作列", () => {
  state.desktop = true;
  const table = nodes(PaymentTermTab()).find(n => n.type === "table")!;
  expect(table.props.scroll).toEqual({ x: "max-content" });
  const columns = table.props.columns as { key?: string; dataIndex?: string; fixed?: string }[];
  expect(columns.length).toBeGreaterThan(1);
  expect(columns.find(c => c.dataIndex === "name")?.fixed).toBe("left");
  expect(columns.find(c => c.key === "actions")?.fixed).toBe("right");
});
it("CSV保留上海截至日和条款状态，未来协议不导出成达标", () => {
  const toolbar = nodes(PaymentTermTab()).find(n => n.type === "toolbar")!;
  (toolbar.props.onExport as () => void)();
  const [, headers, rows] = exported.mock.calls[0];
  expect(headers.slice(-2)).toEqual(["截至(上海)", "条款状态"]);
  expect(rows[0].slice(-3)).toEqual(["待生效", "2026-09-08", "待生效"]);
});
it("无金额权限的有往来筛选仍保留供应商，且没有登记入口", () => {
  const m = fixture(); m.moneyVisible = false; m.rows[0].spend.forEach(s => { s.total = s.poNet = s.jsSettle = null; });
  state.data = m; state.scope = "active"; state.buyer = false;
  const table = nodes(PaymentTermTab()).find(n => n.type === "table")!;
  expect(table.props.dataSource).toHaveLength(1);
  const columns = table.props.columns as { render: (v: unknown, r: unknown) => ReactNode }[];
  const content = text(columns[0].render(null, m.rows[0]));
  expect(content).toContain("金额无权限"); expect(content).not.toContain("登记账期"); expect(content).not.toContain("3000");
});
it("读取失败不留下旧导出或伪装空候选", () => {
  state.data = null; state.error = "读取超时，请重试";
  const tree = nodes(PaymentTermTab());
  expect(tree.find(n => n.type === "toolbar")!.props.onExport).toBeUndefined();
  expect(tree.find(n => n.type === "table")!.props.dataSource).toEqual([]);
  expect(tree.some(n => n.type === "alert" && n.props.message === "供应商账期加载失败")).toBe(true);
});
it("无采购额的未知条款不谎称已分类采购额占比留空", () => {
  const m = fixture(); m.summary.unclassifiedSpendSuppliers = 0; m.summary.creditTermSpendSharePct = "100.00";
  m.rows[0].spend.forEach(s => { s.total = s.poNet = s.jsSettle = null; });
  state.data = m;
  const warning = nodes(PaymentTermTab()).find(n => n.type === "alert" && n.props.type === "warning")!;
  expect(warning.props.message).toBe("存在待生效/待核对条款，请核对原协议。");
  expect(String(warning.props.message)).not.toContain("占比留空");
});
