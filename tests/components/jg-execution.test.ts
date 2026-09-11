import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jgExecutionView } from "@/lib/jg-execution";
import JgExecutionStatus from "@/components/JgExecutionStatus";
import JgPrint from "@/app/(app)/outsource/jg/[id]/print/page";

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: h.read }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), use: () => ({ id: "17" }) }));
beforeEach(() => { vi.stubGlobal("React", React); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe("JG execution interpretation", () => {
  it.each(["completed", "closed", "void"].flatMap(status => [true, false].map(inProduction => ({ status, inProduction }))))(
    "$status / confirmation=$inProduction never revives terminal production", facts => {
      const input = Object.freeze({ ...facts, urgentFlag: true, isPaused: true });
      const view = jgExecutionView(input);
      expect(view.terminal).toBe(true);
      expect(view.warning).toBe(false);
      expect(view.phase).not.toMatch(/未开始|生产中|待加工/);
      expect(view.flags).toEqual([{ text: "历史加急", color: "default" }, { text: "历史暂停", color: "default" }]);
      expect(view.explanation).toContain("实际收货、质检与入库数量");
    });
  it.each([
    ["draft", false, "待提交", false], ["pending", false, "待审批", false],
    ["approved", false, "待加工确认", false], ["in_progress", true, "已确认加工", false],
    ["in_progress", false, "确认信息待核对", true], ["approved", true, "确认信息待核对", true],
    ["pending", true, "确认信息待核对", true], ["draft", true, "确认信息待核对", true],
  ] as const)("%s and %s keep stage and uncertainty distinct", (status, inProduction, phase, warning) => {
    const view = jgExecutionView({ status, inProduction });
    expect(view).toMatchObject({ terminal: false, phase, warning });
    expect(view.flags).toEqual([]);
  });
  it("missing confirmation remains unknown, not unstarted", () => {
    expect(jgExecutionView({ status: "in_progress" })).toMatchObject({ warning: true, phase: "确认信息待核对" });
  });
  it("unknown states do not become active signals", () => {
    const view = jgExecutionView({ status: "new-unrecognized-state", inProduction: true, urgentFlag: true });
    expect(view).toMatchObject({ warning: true, phase: "状态待核对" });
    expect(view.flags[0].color).toBe("default");
  });
  it("planning flags are explicit, not an inferred late/physical status", () => {
    const view = jgExecutionView({ status: "in_progress", inProduction: true, urgentFlag: true, isPaused: true });
    expect(view.phase).toBe("已确认加工");
    expect(view.flags.map(flag => flag.text)).toEqual(["计划加急", "计划暂停"]);
    expect(view.flagExplanation).toContain("不是自动逾期判断");
  });
});

it.each(["completed", "closed", "void"])("actual status component renders %s without a contradictory production badge", status => {
  const html = renderToStaticMarkup(React.createElement(JgExecutionStatus, {
    facts: { status, inProduction: false, urgentFlag: true }, docNo: "JG-QA-17",
  }));
  expect(html).toContain("历史加急");
  expect(html).not.toMatch(/未开始|生产中|计划加急/);
  expect(html).toContain('aria-label="查看JG-QA-17执行口径"');
  expect(html).toContain('aria-haspopup="dialog"');
});

it.each(["completed", "closed"])("actual %s print keeps historical flags and exact quantity", status => {
  h.read.mockReturnValue({ data: { id: 17, status, docNo: "JG-QA-17", qty: "1000.1250", inProduction: false,
    urgentFlag: true, isPaused: true, supplierName: "QA", productSkuCode: "QA", productSkuName: "长名称测试", baseUom: "盒",
    createdAt: "2026-09-11T01:00:00Z" }, error: null });
  const html = renderToStaticMarkup(React.createElement(JgPrint, { params: Promise.resolve({ id: "17" }) }));
  expect(html).toContain("历史加急"); expect(html).toContain("历史暂停");
  expect(html).toContain("1000.125"); expect(html).not.toContain("1000.1250");
  expect(html).not.toContain("（紧急）"); expect(html).toContain("不作为当前催单");
  expect(html).toContain("盒"); expect(html).not.toContain("单位待核对");
});
