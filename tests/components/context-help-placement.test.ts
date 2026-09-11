import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropdownProps } from "antd";
import ContextHelp from "@/components/ContextHelp";

const captured = vi.hoisted(() => ({ props: null as DropdownProps | null }));
vi.mock("antd", () => ({
  Dropdown: (props: DropdownProps) => { captured.props = props; return props.children; },
}));
beforeEach(() => { vi.stubGlobal("React", React); captured.props = null; });
afterEach(() => vi.unstubAllGlobals());

describe("shared explanation placement contract", () => {
  // Configuration guard only: the frozen browser must still prove popup geometry and focus.
  it("shifts inside the viewport when neither left nor right alignment fits", () => {
    renderToStaticMarkup(React.createElement(ContextHelp, {
      label: "销售与作业口径", title: "口径", content: "无记录不代表零需求",
    }));
    expect(captured.props?.align?.overflow).toEqual({ adjustX: true, adjustY: true, shiftX: true, shiftY: true });
    expect(captured.props?.trigger).toEqual(["click"]);
    expect(captured.props?.destroyOnHidden).toBe(true);
  });

  it("retains a named native button and non-modal dialog semantics", () => {
    const html = renderToStaticMarkup(React.createElement(ContextHelp, {
      label: "查看完整来源", title: "来源与时点", content: "尚未提供",
    }));
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="查看完整来源"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    const panel = renderToStaticMarkup(captured.props!.popupRender!(React.createElement("span")));
    expect(panel).toContain('role="dialog"');
    expect(panel).not.toContain('aria-modal="true"');
    expect(panel).toContain("尚未提供");
    expect(panel).toContain('aria-label="关闭来源与时点"');
  });

  it("does not retain dropdown's four-pixel placement offset after viewport shifting", () => {
    renderToStaticMarkup(React.createElement(ContextHelp, {
      label: "外部窗口", title: "长口径", content: "逐店铺逐日覆盖说明".repeat(30),
    }));
    // rc-trigger applies popupOffsetY again after shifting. Default ±4 puts the
    // dialog at y=-4 or bottom=viewport+4; actual 390px reproduction is retained.
    expect(captured.props?.align?.offset).toEqual([0, 0]);
    expect(captured.props?.overlayStyle?.padding).toBe(8);
  });
});
