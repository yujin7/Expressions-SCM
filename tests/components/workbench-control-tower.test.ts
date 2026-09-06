import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ControlTower } from "@/app/(app)/workbench/workbench-client";

beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());

const item = {
  key: "sales_spike", severity: "critical" as const, title: "爆单告警待复核",
  impact: "2 条未关闭告警；请核对最新日销证据，未关闭不代表当前仍在爆单",
  count: 2, href: "/alerts?category=sales_spike&status=open", daysShown: 8, newSinceLastVisit: true,
};
const props = { items: [item], loading: false, onSnooze: vi.fn(), canSnooze: true, sinceLastVisit: null };
const render = (overrides: Partial<Parameters<typeof ControlTower>[0]> = {}) =>
  renderToStaticMarkup(createElement(ControlTower, { ...props, ...overrides }));

describe("ControlTower evidence and accessible actions", () => {
  it("an empty visible queue is informational, not proof that every monitor is healthy", () => {
    const html = render({ items: [] });
    expect(html).toContain("ant-alert-info");
    expect(html).toContain("证据不足");
    expect(html).toContain("打盹");
    expect(html).not.toContain("各项监控均在阈值内");
  });

  it("keeps loading distinct from an empty queue", () => {
    const html = render({ items: [], loading: true });
    expect(html).toContain("ant-skeleton");
    expect(html).not.toContain("当前没有可显示的例外");
  });

  it("retains full evidence, exact destination and new/chronic markers", () => {
    const html = render();
    expect(html).toContain(item.impact);
    expect(html).toContain("/alerts?category=sales_spike&amp;status=open");
    expect(html).toContain("上次访问后新增");
    expect(html).toContain("已连续 8 天");
  });

  it("uses a native named button for snooze and a named navigation link", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-label="打盹：爆单告警待复核"/);
    expect(html).toContain('aria-label="处理：爆单告警待复核"');
  });

  it("does not show snooze to an unauthorized viewer", () => {
    const html = render({ canSnooze: false });
    expect(html).not.toContain('aria-label="打盹：');
    expect(html).toContain('aria-label="处理：');
  });
});
