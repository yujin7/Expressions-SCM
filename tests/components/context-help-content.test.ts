import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DataSourceBadge from "@/components/DataSourceBadge";
import AlertWhyList from "@/components/AlertWhyList";

// Inspect content handed to the shared popup. Keyboard, focus and layout require the real browser sweep.
vi.mock("@/components/ContextHelp", () => ({
  default: ({ label, content, children }: { label: string; content: React.ReactNode; children: React.ReactNode }) =>
    React.createElement("div", null, React.createElement("button", { "aria-label": label }, children), content),
}));
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("explanation facts stay complete", () => {
  it("does not imply current data when no source or date was provided", () => {
    const html = renderToStaticMarkup(React.createElement(DataSourceBadge, { tier: "snapshot" }));
    expect(html).toContain("来源：未提供");
    expect(html).toContain("数据时点：未提供，请核对新鲜度");
  });
  it("retains the exact source date and limitation", () => {
    const html = renderToStaticMarkup(React.createElement(DataSourceBadge, {
      tier: "reference", source: "外部参考", date: "2026-07-21", note: "不进入正式账",
    }));
    for (const value of ["外部参考", "2026-07-21", "不进入正式账"]) expect(html).toContain(value);
  });
  it("keeps collapsed reasons, unknown values and full provenance", () => {
    const html = renderToStaticMarkup(React.createElement(AlertWhyList, { max: 1, why: [
      { label: "可销天数", value: 0 },
      { label: "需求覆盖", value: null, source: "尚未取得完整月份" },
      { label: "来源说明", value: "<script>unsafe</script>", source: "外部观察/批次-123" },
    ] }));
    for (const value of ["查看其余 2 项告警依据", "需求覆盖", "—", "尚未取得完整月份", "外部观察/批次-123"])
      expect(html).toContain(value);
    expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("does not offer an empty expansion", () => {
    const html = renderToStaticMarkup(React.createElement(AlertWhyList, { max: 12, why: [{ label: "库存", value: 0 }] }));
    expect(html).not.toContain("<button");
    expect(html).toContain(">0<");
  });
});
