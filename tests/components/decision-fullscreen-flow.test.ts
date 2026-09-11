import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import DecisionVisual from "@/components/DecisionVisual";
const ui = vi.hoisted(() => ({ index: 0, fullscreen: true }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useId: () => "summary", useState: () => [ui.index++ === 1 ? ui.fullscreen : false, vi.fn()] }));
vi.mock("antd", () => ({ Alert: "alert", App: { useApp: () => ({ message: {} }) }, Button: "button", Card: "card", Empty: Object.assign("empty", { PRESENTED_IMAGE_SIMPLE: "simple" }), Progress: "progress", Skeleton: "skeleton", Space: "space", Tag: "tag", Tooltip: "tooltip", Typography: { Text: "text", Paragraph: "p" } }));
vi.mock("@/components/DataSourceBadge", () => ({ default: "source" }));
vi.mock("@/components/ContextHelp", () => ({ default: "help" }));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(v: ReactNode): Node[] { return Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : []; }
const render = (fitContent: boolean) => DecisionVisual({ title: "目标历史", question: "持续达成吗", source: { tier: "reference", source: "QA" }, summary: "五条六期", fitContent, children: React.createElement("div", null, "长记录"), caveat: "缺据不回填" });
beforeEach(() => { ui.index = 0; ui.fullscreen = true; vi.stubGlobal("React", React); });
it("自然高度内容在全屏也按实际高度排版，限制说明不能覆盖后续记录", () => {
  const body = nodes(render(true)).find(n => n.props["aria-describedby"] === "summary")!;
  expect(body.props.style).toMatchObject({ height: undefined, minHeight: undefined });
});
it("真正的图表全屏仍保留确定画布高度", () => {
  const body = nodes(render(false)).find(n => n.props["aria-describedby"] === "summary")!;
  expect(body.props.style).toMatchObject({ height: "calc(100vh - 230px)" });
});
