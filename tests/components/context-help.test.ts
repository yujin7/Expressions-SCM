import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CaliberNote from "@/components/CaliberNote";
import DataSourceBadge from "@/components/DataSourceBadge";
import DecisionMetric from "@/components/DecisionMetric";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("context help controls", () => {
  it("uses a native, labelled disclosure button for the page explanation", () => {
    const html = renderToStaticMarkup(React.createElement(CaliberNote, { summary: "缺失不能当零", detail: "完整来源与口径" }));
    expect(html).toContain("缺失不能当零");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="查看口径说明"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });
  it("does not add an empty help control without detail", () => {
    const html = renderToStaticMarkup(React.createElement(CaliberNote, { summary: "必须保持可见" }));
    expect(html).toContain("必须保持可见");
    expect(html).not.toContain("<button");
  });
  it.each(["ledger", "snapshot", "reference", "derived"] as const)("%s source is a button, not an inert image", tier => {
    const html = renderToStaticMarkup(React.createElement(DataSourceBadge, { tier, source: "测试来源", date: "2026-09-07" }));
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="查看数据来源：测试来源"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('role="img"');
  });
  it("metric explanation and source use the same explicit help interaction", () => {
    const html = renderToStaticMarkup(React.createElement(DecisionMetric, {
      metricId: "salesQty", value: "—", source: { tier: "snapshot", name: "销售月事实" },
    }));
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="全渠道销量口径说明"');
    expect(html).toContain("—");
  });
});
