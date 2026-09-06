import { describe, expect, it } from "vitest";
import { workItemSourceAction } from "@/lib/work-item-source";

describe("待办来源深链：只允许明确来源和安全数据库 ID", () => {
  it.each(["1", "42", "2147483647"])("生成正整数 %s 的精确站内入口", (sourceRef) => {
    expect(workItemSourceAction({ sourceKind: "alert", sourceRef })).toMatchObject({
      href: `/alerts?id=${sourceRef}`, label: "查看来源告警",
    });
    expect(workItemSourceAction({ sourceKind: "review", sourceRef })).toMatchObject({
      href: `/review/checklist?id=${sourceRef}`, label: "查看来源复核",
    });
  });

  it("容忍首尾空白，但明确完成待办不等于完成来源事项", () => {
    const alert = workItemSourceAction({ sourceKind: "alert", sourceRef: " 42 " });
    expect(alert?.href).toBe("/alerts?id=42");
    expect(alert?.completionHint).toContain("不会关闭来源告警");
    const review = workItemSourceAction({ sourceKind: "review", sourceRef: "42" });
    expect(review?.completionHint).toContain("不会代替来源复核");
  });

  it.each([
    null, "", " ", "0", "-1", "+1", "01", "1.0", "1.5", "1e2", "0x10",
    "2147483648", "9007199254740993", "NaN", "Infinity", "1/2", "1&id=2",
    "https://example.com", "//example.com", "javascript:alert(1)", "<script>",
  ])("拒绝不安全或非规范 sourceRef %j", (sourceRef) => {
    for (const sourceKind of ["alert", "review"]) {
      expect(workItemSourceAction({ sourceKind, sourceRef })).toBeNull();
    }
  });

  it.each([null, "", "manual", "Alert", "../alerts", "https://example.com"])("不把未知来源 %j 解析成 URL", (sourceKind) => {
    expect(workItemSourceAction({ sourceKind, sourceRef: "42" })).toBeNull();
  });
});
