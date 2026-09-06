import { describe, expect, it } from "vitest";
import { workItemCreateSchema } from "@/server/modules/todo/service";

describe("待办截止日期：进入写库前验证真实业务日", () => {
  const input = { title: "测试截止日", assigneeId: 1 };

  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-01-00", "0000-01-01", "2026-1-1", "infinity"])(
    "拒绝不存在或非规范日期 %s，不交给数据库报 500",
    (dueDate) => {
      expect(workItemCreateSchema.safeParse({ ...input, dueDate }).success).toBe(false);
    },
  );

  it.each(["2024-02-29", "2026-02-28", "2026-12-31", "0001-01-01"])("保留合法业务日 %s", (dueDate) => {
    expect(workItemCreateSchema.parse({ ...input, dueDate }).dueDate).toBe(dueDate);
  });

  it("未设置、空白和显式空值保持现有可选语义", () => {
    expect(workItemCreateSchema.parse(input).dueDate).toBeUndefined();
    expect(workItemCreateSchema.parse({ ...input, dueDate: "  " }).dueDate).toBeUndefined();
    expect(workItemCreateSchema.parse({ ...input, dueDate: null }).dueDate).toBeNull();
  });
});
