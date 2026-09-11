import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import SupplierDeclaredCapacity from "@/components/SupplierDeclaredCapacity";
import { compareDeclaredCapacity } from "@/server/rules/declared-capacity";

beforeAll(() => vi.stubGlobal("React", React));
const declaration = { declaredMonthlyCapacity: "1000", capacityUom: "支", surgeCapacityPct: 20,
  capacityValidFrom: "2026-09-01", capacityValidUntil: "2026-12-31", capacityEvidence: "<script>不是可执行指令</script>" };
const context = { baseUom: "支", dueDate: "2026-10-20", asOfDay: "2026-09-09", projectedQty: "1100", undatedOrders: 0 };
const render = (value = compareDeclaredCapacity(declaration, context)) => renderToStaticMarkup(React.createElement(SupplierDeclaredCapacity, { value, supplierName: "A&B 工厂" }));

describe("申报产能：可读证据与行动", () => {
  it("核心限制常显，依据用原生展开，不执行来源文本", () => {
    const html = render();
    for (const t of ["超正常申报", "正常申报", "加班情景", "本系统计划", "核对日", "2026-09-09", "不自动放单", "差额不是可承诺产能", "-100"]) expect(html).toContain(t);
    expect(html).toContain('<summary>有效期与申报依据</summary>');
    expect(html).not.toContain('<details open');
    expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
    expect(html).toContain('/master/supplier?q=A%26B%20%E5%B7%A5%E5%8E%82');
  });
  it("无证据不渲染成正常/零余量", () => {
    const html = render(compareDeclaredCapacity({ ...declaration, declaredMonthlyCapacity: null }, context));
    expect(html).toContain("暂不可比较");expect(html).toContain("未知");
    expect(html).not.toContain("未超正常申报");expect(html).not.toContain("正常情景差额");
  });
  it("零加班与未知加班文字不同；未超上限不是绿色承诺", () => {
    const unknown = render(compareDeclaredCapacity({ ...declaration, surgeCapacityPct: null }, { ...context, projectedQty: "500" }));
    expect(unknown).toContain("加班情景 未知");expect(unknown).toContain("ant-alert-info");expect(unknown).not.toContain("ant-alert-success");
    const zero = render(compareDeclaredCapacity({ ...declaration, surgeCapacityPct: 0 }, context));
    expect(zero).toContain("超加班上限");expect(zero).toContain("ant-alert-warning");
  });
});
