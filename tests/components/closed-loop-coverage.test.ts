import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestionAccuracySection } from "@/app/(app)/report/closed-loop/closed-loop-client";
import type { AccuracyBucket, AccuracyBucketKey, SuggestionAccuracy } from "@/server/modules/report/closed-loop";
import { METRICS, metricTooltip } from "@/components/metrics";

// Render the real section and its chart-card functions. AntD/Recharts are terminal
// elements here: this verifies semantic props/text, not browser pixels or database coverage.
vi.mock("antd", () => ({
  Alert: "alert", App: {}, Card: "card", Col: "col", Row: "row", Statistic: "statistic",
  Table: "table", Tag: "tag", Tooltip: "tooltip", Typography: { Title: "heading", Text: "text" },
  theme: { useToken: () => ({ token: { colorBorderSecondary: "gray", colorTextSecondary: "gray", colorBgElevated: "white", colorBorder: "gray", borderRadius: 8, colorText: "black" } }) },
}));
vi.mock("recharts", () => ({
  Bar: "bar", BarChart: "bar-chart", CartesianGrid: "grid", Cell: "cell", ResponsiveContainer: "chart-container",
  Tooltip: "chart-tooltip", XAxis: "x-axis", YAxis: "y-axis",
}));
vi.mock("@/components/CaliberNote", () => ({ default: "caliber-note" }));
vi.mock("@/components/DecisionVisual", () => ({ default: "decision-visual" }));
vi.mock("@/components/ListToolbar", () => ({ default: "list-toolbar" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("@/components/useListState", () => ({ useListState: vi.fn() }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: vi.fn() }));

type Props = Record<string, unknown> & { children?: ReactNode; summary?: ReactNode; detail?: ReactNode; dataView?: ReactNode };
type Element = React.ReactElement<Props>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  if (typeof node.type === "function") return elements((node.type as (props: Props) => ReactNode)(node.props));
  return [node, ...[node.props.children, node.props.summary, node.props.detail, node.props.dataView].flatMap(elements)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
const keys: AccuracyBucketKey[] = ["none", "lt50", "50_90", "90_110", "110_150", "gt150"];
const labels = ["0（没有发生）", "< 50%", "50%–90%", "90%–110%", "110%–150%", "> 150%"];
const buckets = (counts: Partial<Record<AccuracyBucketKey, number>> = {}): AccuracyBucket[] => keys.map((key, i) => ({ key, label: labels[i], count: counts[key] ?? 0 }));
function accuracy(overrides: Partial<SuggestionAccuracy> = {}): SuggestionAccuracy {
  return {
    version: "closed-loop-accuracy/v3", rowLimit: 2000, truncated: false,
    sample: 1, matured: 1, immature: 0, orderedVsRequired: buckets({ none: 1 }), outboundVsRequired: buckets({ none: 1 }),
    ledgerCoverage: { qualified: 1, excluded: 0, reasons: [] },
    engineMix: [{ engineVersion: "time-phased-v3", sample: 1, matured: 1 }],
    byEngineVersion: [], caliber: ["合成口径：只按样本自己的窗口检查证据"], ...overrides,
  };
}
function render(value: SuggestionAccuracy) {
  const all = elements(SuggestionAccuracySection({ accuracy: value }));
  const note = all.find((element) => element.type === "caliber-note")!;
  const visual = (metricId: string) => all.find((element) => element.type === "decision-visual" && element.props.metricId === metricId)!;
  return { all, note, ordered: visual("suggestionOrderedRatio"), outbound: visual("suggestionRealizedRatio") };
}
function shares(visual: Element): string[] {
  const table = elements(visual.props.dataView).find((element) => element.type === "table")!;
  const columns = table.props.columns as { key?: string; render?: (_: unknown, row: AccuracyBucket) => string }[];
  const renderShare = columns.find((column) => column.key === "share")!.render!;
  return (table.props.dataSource as AccuracyBucket[]).map((row) => renderShare(undefined, row));
}

beforeEach(() => { vi.stubGlobal("React", React); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("closed-loop outbound coverage disclosure", () => {
  it("all excluded means insufficient evidence, not an observed zero-outbound distribution", () => {
    const view = render(accuracy({
      sample: 3, matured: 3, outboundVsRequired: buckets(), orderedVsRequired: buckets({ none: 3 }),
      ledgerCoverage: { qualified: 0, excluded: 3, reasons: [{ reason: "realtime_ledger_starts_after_window_start", note: "实时仓首笔晚于窗口起点，无法核验", count: 3 }] },
    }));
    expect(view.outbound.props.state).toBe("insufficient");
    expect(view.outbound.props.coverage).toEqual({ covered: 0, total: 3, label: "成熟样本出库证据" });
    expect(view.outbound.props.summary).toBe("当前没有可评样本；缺少证据不代表实际数量为零");
    expect(view.outbound.props.dataView).toBeUndefined();
    expect(view.ordered.props.state).toBe("ready");
    expect(text(view.note.props.summary)).toContain("出库可核验 0/3 行");
    expect(text(view.note.props.summary)).toContain("覆盖不足 3 行不进出库分母");
    expect(text(view.note.props.detail)).toContain("实时仓首笔晚于窗口起点，无法核验：3 行");
    expect(text(view.note.props.summary)).not.toContain("快照仓 SKU");
  });

  it("qualified zero outbound remains a real none bucket, with a 100% share in its own denominator", () => {
    const view = render(accuracy());
    expect(view.outbound.props.state).toBe("ready");
    expect(view.outbound.props.summary).toContain("分布分母 1 行：0（没有发生） 1");
    expect(shares(view.outbound)).toEqual(["100%", "0%", "0%", "0%", "0%", "0%"]);
    expect(view.outbound.props.coverage).toMatchObject({ covered: 1, total: 1 });
    expect(view.outbound.props.grain).toBe("建议行（SKU × 业务日）");
    expect(text(view.note.props.detail)).toContain("当前成熟样本均通过已登记仓与已记录日快照的窗口覆盖检查");
  });

  it("keeps excluded and immature rows out of the outbound denominator but not the ordered denominator", () => {
    const view = render(accuracy({
      sample: 5, matured: 3, immature: 2,
      orderedVsRequired: buckets({ none: 1, "90_110": 2 }), outboundVsRequired: buckets({ none: 1, "90_110": 1 }),
      ledgerCoverage: { qualified: 2, excluded: 1, reasons: [{ reason: "snapshot_stock_outside_ledger", note: "窗口内快照仓仍有非零库存", count: 1 }] },
    }));
    expect(view.outbound.props.coverage).toMatchObject({ covered: 2, total: 3 });
    expect(shares(view.outbound)).toEqual(["50%", "0%", "0%", "50%", "0%", "0%"]);
    expect(shares(view.ordered)).toEqual(["33.3%", "0%", "0%", "66.7%", "0%", "0%"]);
    expect(text(view.note.props.summary)).toContain("未成熟 2 行不进分布");
    expect(view.outbound.props.caveat).toContain("覆盖不足 1 行排除，不按零出库");
  });

  it.each([
    ["snapshot_only_no_realtime_ledger", "没有可用的实时仓流水证据"],
    ["realtime_ledger_starts_after_window_start", "实时仓首笔流水晚于窗口起点"],
    ["snapshot_stock_outside_ledger", "窗口内有账外快照库存"],
    ["snapshot_history_incomplete", "窗口快照历史缺失或无效"],
  ] as const)("discloses %s using the authoritative reason, not a blanket snapshot-only label", (reason, note) => {
    const view = render(accuracy({ outboundVsRequired: buckets(), ledgerCoverage: { qualified: 0, excluded: 1, reasons: [{ reason, note, count: 1 }] } }));
    expect(text(view.note.props.detail)).toContain(`${note}：1 行`);
    expect(text(view.note.props.summary)).not.toContain(note); // Keep first-screen explanation compact.
    expect(text(view.note.props.summary)).not.toContain("快照仓 SKU");
    expect(view.outbound.props.caveat).not.toContain("快照仓 SKU 无流水");
  });

  it("no mature samples is not a zero-accuracy result", () => {
    const view = render(accuracy({
      sample: 2, matured: 0, immature: 2, orderedVsRequired: buckets(), outboundVsRequired: buckets(),
      ledgerCoverage: { qualified: 0, excluded: 0, reasons: [] },
    }));
    expect(view.ordered.props.state).toBe("insufficient");
    expect(view.outbound.props.state).toBe("insufficient");
    expect(view.outbound.props.coverage).toMatchObject({ covered: 0, total: 0 });
    expect(view.outbound.props.dataView).toBeUndefined();
    expect(text(view.note.props.detail)).toContain("暂无成熟样本可检查");
  });

  it("no captured facts remains the explanatory empty state", () => {
    const view = render(accuracy({
      sample: 0, matured: 0, immature: 0, orderedVsRequired: buckets(), outboundVsRequired: buckets(),
      ledgerCoverage: { qualified: 0, excluded: 0, reasons: [] }, engineMix: [],
    }));
    expect(view.outbound.props.state).toBe("empty");
    expect(view.outbound.props.stateDetail).toContain("尚无人工捕获的建议快照");
    expect(view.outbound.props.dataView).toBeUndefined();
  });

  it("preserves mixed-engine and truncated-sample warnings instead of implying one comparable model", () => {
    const view = render(accuracy({
      sample: 2000, matured: 2, immature: 1998, truncated: true,
      ledgerCoverage: { qualified: 1, excluded: 1, reasons: [{ reason: "snapshot_history_incomplete", note: "历史不完整", count: 1 }] },
      engineMix: [{ engineVersion: "time-phased-v2", sample: 1000, matured: 1 }, { engineVersion: "time-phased-v3", sample: 1000, matured: 1 }],
    }));
    expect(view.outbound.props.stateDetail).toContain("取数已达上限 2000 行");
    expect(view.outbound.props.stateDetail).toContain("总分布不是同一把尺子");
    expect(view.outbound.props.source).toMatchObject({ source: expect.stringContaining("closed-loop-accuracy/v3") });
    expect(view.outbound.props.caveat).toContain("不证明未接入仓或日内轨迹完整");
    expect(view.outbound.props.question).not.toContain("说明需求估");
  });

  it("the shared metric tooltip carries the same eligibility and non-sales boundaries", () => {
    expect(METRICS.suggestionRealizedRatio.formula).toContain("仅覆盖合格的成熟样本进分布");
    expect(metricTooltip("suggestionRealizedRatio")).toContain("缺证据不按零出库");
    expect(metricTooltip("suggestionRealizedRatio")).toContain("不证明未接入仓或日内轨迹完整");
    expect(metricTooltip("suggestionRealizedRatio")).not.toContain("快照仓 SKU 弃权");
  });
});
