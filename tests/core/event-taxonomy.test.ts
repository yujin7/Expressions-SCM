/** E8-05 审计事件分类法测试 */
import { describe, expect, it } from "vitest";
import { canonicalOf, catalogSize, classifyEvent, domainLabel, isStateChange } from "@/server/core/event-taxonomy";

describe("classifyEvent", () => {
  it("登记过的 action 正确分类并给出规范名", () => {
    const e = classifyEvent("bh", "approve");
    expect(e.domain).toBe("doc");
    expect(e.label).toBe("审批通过");
    expect(e.canonical).toBe("doc.bh.approve");
    expect(e.isStateChange).toBe(true);
  });

  it("同一 action 在不同 entity 下给出不同规范名", () => {
    expect(canonicalOf("bh", "approve")).toBe("doc.bh.approve");
    expect(canonicalOf("po", "approve")).toBe("doc.po.approve");
    expect(canonicalOf("bh", "approve")).not.toBe(canonicalOf("po", "approve"));
  });

  it("**未登记的 action 走 fallback 且绝不抛错**——分类法不得成为新故障源", () => {
    // action 有动态来源（审批透传/复核计算/auditFromRoute 自由字符串），静态清单必然不全
    expect(() => classifyEvent("weird_entity", "some_brand_new_action")).not.toThrow();
    const e = classifyEvent("weird_entity", "some_brand_new_action");
    expect(e.domain).toBe("system");
    expect(e.label).toBe("some_brand_new_action"); // 保留原文，不丢信息
    expect(e.canonical).toBe("system.weird_entity.some_brand_new_action");
    expect(e.isStateChange).toBe(false);
  });

  it("动态来源的 reject 已登记（它不在任何字面量 grep 结果里）", () => {
    const e = classifyEvent("wo", "reject");
    expect(e.domain).toBe("doc");
    expect(e.isStateChange).toBe(true);
    expect(e.label).toBe("驳回");
  });

  it("复核清单计算出的三个 action 已登记", () => {
    for (const a of ["review_done", "review_overrule", "review_reopen"]) {
      expect(classifyEvent("review_item", a).domain).toBe("data");
    }
  });

  it("空/异常输入不抛错", () => {
    expect(() => classifyEvent("", "")).not.toThrow();
    expect(classifyEvent("", "").domain).toBe("system");
    expect(classifyEvent("x", "").label).toBe("(未命名事件)");
    // @ts-expect-error 故意传 null 验证运行时健壮性
    expect(() => classifyEvent(null, null)).not.toThrow();
  });

  it("状态流转事件可被筛出（流程挖掘只取这类）", () => {
    expect(isStateChange("bh", "submit")).toBe(true);
    expect(isStateChange("bh", "approve")).toBe(true);
    expect(isStateChange("sku", "update")).toBe(false); // 修改不算流转
    expect(isStateChange("import_job", "upload")).toBe(false);
  });

  it("目录覆盖主要域且规模合理", () => {
    expect(catalogSize()).toBeGreaterThanOrEqual(40);
    const domains = new Set(["doc", "master", "plan", "data", "system"].map((d) => domainLabel(d as never)));
    expect(domains.size).toBe(5);
  });

  it("域中文名可读", () => {
    expect(domainLabel("doc")).toBe("单据");
    expect(domainLabel("plan")).toBe("计划");
  });
});
