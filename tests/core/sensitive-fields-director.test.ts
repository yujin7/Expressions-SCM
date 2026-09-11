/**
 * D53/D60：销售金额（salesAmount）与单位费用（unitFee）入 R9 敏感字段黑名单——
 * ops/warehouse/quality 经 maskSensitive 后看不到；价格可见角色保留。
 * 注意：不加泛化的 amount 之外的键（会误伤非金额字段）。
 */
import { describe, expect, it } from "vitest";
import { SENSITIVE_FIELDS } from "@/server/core/constants";
import { maskSensitive } from "@/server/core/dto";

describe("SENSITIVE_FIELDS：总监计划新增键", () => {
  it("黑名单收录 salesAmount 与 unitFee", () => {
    expect(SENSITIVE_FIELDS).toContain("salesAmount");
    expect(SENSITIVE_FIELDS).toContain("unitFee");
  });

  it("ops/warehouse/quality 看不到；finance/pmc 看得到；嵌套数组同样剥离", () => {
    const payload = {
      yearMonth: "2026-08",
      salesAmount: "1234567.89",
      rows: [{ route: "工厂发仓", unitFee: "2.35", qty: "1000" }],
    };
    for (const role of ["ops", "warehouse", "quality"]) {
      const masked = maskSensitive(payload, [role]) as Record<string, unknown>;
      expect(masked).not.toHaveProperty("salesAmount");
      expect((masked.rows as Record<string, unknown>[])[0]).not.toHaveProperty("unitFee");
      expect((masked.rows as Record<string, unknown>[])[0]).toHaveProperty("qty", "1000");
    }
    for (const role of ["finance", "pmc"]) {
      const kept = maskSensitive(payload, [role]);
      expect(kept.salesAmount).toBe("1234567.89");
      expect(kept.rows[0].unitFee).toBe("2.35");
    }
    expect(payload.salesAmount).toBe("1234567.89"); // 不可变
  });
});
