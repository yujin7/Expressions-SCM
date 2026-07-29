import { describe, expect, it } from "vitest";
import {
  assertGovernedSkuCode,
  generateGovernedSkuCode,
  normalizeSkuOrigin,
  parseGovernedSkuCode,
} from "@/server/rules/sku-code";

describe("SKU S1 编码规则", () => {
  it("生成结果可稳定解析，并保留来源、类型与流水", () => {
    const code = generateGovernedSkuCode({ origin: "exp", skuType: "finished", sequence: 123 });
    expect(code).toMatch(/^S1-EXP-F-000123-[0-9A-Z]{2}$/);
    expect(parseGovernedSkuCode(code)).toMatchObject({
      scheme: "S1",
      origin: "EXP",
      skuType: "finished",
      sequence: 123,
    });
  });

  it("共享物料默认使用 GEN，错误校验码会被拒绝", () => {
    const code = generateGovernedSkuCode({ skuType: "packaging", sequence: 8 });
    expect(code).toContain("S1-GEN-P-000008-");
    const wrong = `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;
    expect(parseGovernedSkuCode(wrong)).toBeNull();
    expect(() => assertGovernedSkuCode(wrong)).toThrow("格式或校验码错误");
  });

  it("校验预期来源与 SKU 类型，不把可变业务字段编码", () => {
    const code = generateGovernedSkuCode({ origin: "NING", skuType: "raw", sequence: 99 });
    expect(() => assertGovernedSkuCode(code, { origin: "EXP", skuType: "raw" })).toThrow("品牌短码不一致");
    expect(() => assertGovernedSkuCode(code, { origin: "NING", skuType: "finished" })).toThrow("SKU 类型不一致");
  });

  it("品牌来源只允许 2–4 位大写字母或数字", () => {
    expect(normalizeSkuOrigin(null)).toBe("GEN");
    expect(normalizeSkuOrigin("b2f")).toBe("B2F");
    expect(() => normalizeSkuOrigin("EXP-T")).toThrow("2–4 位");
  });
});
