import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("C153 下一步建议可达性与失败诚实性", () => {
  it("工作台 API 返回建议，UI 渲染证据与责任角色，结算链接消费 jgId 上下文", () => {
    const focus = read("src/server/modules/workbench/focus.ts");
    const client = read("src/app/(app)/workbench/workbench-client.tsx");
    const settlement = read("src/app/(app)/settlement/js/js-client.tsx");
    expect(focus).toContain("getNextActions");
    expect(focus).toContain("nextActions");
    expect(client).toContain("审计事件触发 · 当前状态复核 · 不自动执行");
    expect(client).toContain("item.evidence");
    expect(client).toContain("item.ownerLabel");
    expect(settlement).toContain('searchParams.get("jgId")');
    expect(settlement).toContain("void pickJg(jgId)");
  });

  it("接口失败时不再把空数组渲染成“无异常/无待办”的绿色成功态", () => {
    const client = read("src/app/(app)/workbench/workbench-client.tsx");
    expect(client).toContain("setFocusError(error)");
    expect(client).toContain("未用空数据伪装成“无异常”");
    expect(client).toContain("!focusError && queues.length === 0");
  });
});
