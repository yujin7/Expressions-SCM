import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SnapshotAgeStatus, SnapshotAgeTable, SnapshotHealthCard } from "@/app/(app)/admin/health/health-client";
import type { OpsHealth } from "@/server/modules/admin/health";

type Row = OpsHealth["snapshotAges"][number];
const fresh: Row = { warehouseId: 1, code: "QA-SNAPSHOT", name: "合成仓", latestBizDate: "2026-09-06", ageDays: 0, ageState: "fresh" };
const row = (patch: Partial<Row> = {}): Row => ({ ...fresh, ...patch });
const card = (rows: Row[], thresholdDays: number | undefined = 3) => renderToStaticMarkup(createElement(SnapshotHealthCard, { rows, thresholdDays }));
const status = (value: Row, thresholdDays: number | undefined = 3) => renderToStaticMarkup(createElement(SnapshotAgeStatus, { row: value, thresholdDays }));

describe("operational snapshot display does not turn missing evidence green", () => {
  it("没有活跃快照仓不是正常或零天，摘要和实际表格均提示无法判断", () => {
    const summary = card([]);
    expect(summary).toContain("未配置活跃快照仓");
    expect(summary).toContain("无法判断");
    expect(summary).not.toContain("ant-tag-green");
    const table = renderToStaticMarkup(createElement(SnapshotAgeTable, { rows: [], thresholdDays: 3 }));
    expect(table).toContain("未配置活跃快照仓，无法判断数据新鲜度");
  });

  it("有效的零天和恰等3天显示新鲜，清楚限定每仓最新日期而非完整覆盖", () => {
    expect(status(fresh)).toContain("新鲜 · 0 天");
    expect(status(row({ ageDays: 3 }))).toContain("ant-tag-green");
    const summary = card([fresh, row({ warehouseId: 2, ageDays: 3 })]);
    expect(summary).toContain("新鲜 2 仓");
    expect(summary).toContain("超过 3 天为陈旧");
    expect(summary).toContain("不代表完整覆盖");
  });

  it.each([
    { patch: { ageDays: 4, ageState: "stale" as const }, label: "陈旧 · 4 天" },
    { patch: { ageDays: null, latestBizDate: null, ageState: "missing" as const }, label: "暂无快照" },
    { patch: { ageDays: -1, latestBizDate: "2026-09-07", ageState: "future" as const }, label: "未来日期" },
    { patch: { ageDays: null, latestBizDate: "infinity", ageState: "invalid" as const }, label: "日期异常" },
  ])("$label 与新鲜分开，且不使用Infinity假年龄", ({ patch, label }) => {
    const html = status(row(patch));
    expect(html).toContain(label);
    expect(html).not.toContain("ant-tag-green");
    expect(html).not.toContain("∞");
    expect(html).not.toContain("NaN");
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.5, null, undefined])("即使误标fresh，非法年龄%s仍显示未知", (ageDays) => {
    const html = status(row({ ageDays: ageDays as number | null }));
    expect(html).toContain("状态未知");
    expect(html).not.toContain("ant-tag-green");
  });

  it("fresh标记与已超过阈值的数字冲突时保守未知", () => {
    expect(status(row({ ageDays: 4 }))).toContain("状态未知");
  });

  it("旧DTO缺状态或缺服务端阈值，不能只凭ageDays为零猜测新鲜", () => {
    const legacy = { warehouseId: 1, code: "QA", name: "旧数据", latestBizDate: "2026-09-06", ageDays: 0 } as Row;
    expect(status(legacy)).toContain("状态未知");
    const missingThreshold = renderToStaticMarkup(createElement(SnapshotAgeStatus, { row: fresh }));
    expect(missingThreshold).toContain("状态未知");
    expect(missingThreshold).not.toContain("ant-tag-green");
  });

  it("混合仓状态分别计数，不把缺失说成陈旧，也不汇总成全部正常", () => {
    const summary = card([
      fresh,
      row({ warehouseId: 2, ageDays: null, latestBizDate: null, ageState: "missing" }),
      row({ warehouseId: 3, ageDays: 5, ageState: "stale" }),
      row({ warehouseId: 4, ageDays: -1, ageState: "future" }),
    ]);
    expect(summary).toContain("新鲜 1 仓");
    expect(summary).toContain("暂无快照 1 仓");
    expect(summary).toContain("陈旧 1 仓");
    expect(summary).toContain("未来日期 1 仓");
    expect(summary).not.toContain("正常");
  });

  it("实际表格使用相同状态呈现，不再把负数画绿", () => {
    const table = renderToStaticMarkup(createElement(SnapshotAgeTable, {
      rows: [row({ ageDays: -1, ageState: "future", latestBizDate: "2026-09-07" })], thresholdDays: 3,
    }));
    expect(table).toContain("未来日期");
    expect(table).not.toContain("ant-tag-green");
  });
});
