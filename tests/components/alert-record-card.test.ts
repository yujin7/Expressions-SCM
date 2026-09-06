import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AlertRecordCard } from "@/app/(app)/alerts/alerts-client";

beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
const row = {
  id: 7, category: "sales_spike", title: "EXP-0007 完整告警标题及需核对的店铺和日期",
  detail: "历史观察不足，不代表当前仍在爆单", status: "open", severity: "high", ownerRole: "pmc",
  createdAt: "2026-09-01T00:00:00Z", lastHitAt: null, refKey: "EXP-0007", sourceRule: "sales-spike/v3",
  paramsSnapshot: { baseline: 20, why: [{ label: "覆盖", value: "7/10", source: "观察批次" }] },
};
const render = (overrides: Partial<Parameters<typeof AlertRecordCard>[0]["row"]> = {}, actions: React.ReactNode = null) =>
  renderToStaticMarkup(createElement(AlertRecordCard, { row: { ...row, ...overrides }, actions }));

describe("narrow alert record evidence", () => {
  it("shows the full identity and unknown latest hit without opening evidence", () => {
    const html = render();
    expect(html.slice(0, html.indexOf("<details"))).toContain(row.title);
    expect(html).toContain("最近命中：—");
    expect(html).toContain("待处理");
    expect(html).toContain("未知悉");
  });
  it("retains full details, provenance and why using a native keyboard-operable disclosure", () => {
    const html = render();
    expect(html).toMatch(/<details[^>]*><summary>详情与证据<\/summary>/);
    for (const text of [row.detail, row.sourceRule, "EXP-0007", "为什么触发", "7/10", "观察批次"]) expect(html).toContain(text);
    expect(html).toContain("white-space:normal;overflow-wrap:anywhere");
  });
  it("retains the actual resolved state and full human close evidence", () => {
    const html = render({ status: "resolved", closeReasonCode: "legacy_reason", closeNote: "需完整保留的人工复核依据", closedByName: "计划员", closedAt: "2026-09-06T00:00:00Z" });
    expect(html).toContain("已关闭");
    expect(html).toContain("legacy_reason");
    expect(html).toContain("需完整保留的人工复核依据");
    expect(html).toContain("计划员");
  });
  it("does not infer severity, owner or human closure for missing facts", () => {
    const html = render({ severity: null, ownerRole: null, status: "resolved", autoResolved: true });
    expect(html).toContain("严重度未登记");
    expect(html).toContain("责任：未登记");
    expect(html).toContain("引擎自动关闭");
  });
  it("renders only caller-provided actions, without inventing permission or mutations", () => {
    expect(render()).not.toContain("<button");
    const html = render({}, createElement("a", { href: "/inventory/alerts?id=7" }, "去处理"));
    expect(html).toContain('href="/inventory/alerts?id=7"');
    expect(html).not.toContain("<button");
  });
});
