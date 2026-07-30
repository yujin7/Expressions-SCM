import { describe, expect, it } from "vitest";
import {
  isValidGtin,
  normalizeSkuIdentifier,
  skuIdentifierSchema,
} from "@/server/rules/sku-identifier";

describe("SKU 交换标识规则", () => {
  it("按 GS1 Mod-10 验证 GTIN-8/12/13/14", () => {
    for (const value of ["96385074", "012345678905", "6901234567892", "00012345600012"]) {
      expect(isValidGtin(value), value).toBe(true);
    }
    for (const value of ["96385075", "6901234567893", "123", "ABC12345"]) {
      expect(isValidGtin(value), value).toBe(false);
    }
  });

  it("GTIN 强制 GS1 作用域与包装层级", () => {
    expect(() => skuIdentifierSchema.parse({
      kind: "gtin",
      value: "6901234567892",
    })).toThrow("包装层级");
    expect(() => skuIdentifierSchema.parse({
      kind: "gtin",
      value: "6901234567892",
      packagingLevel: "each",
      scope: "JST",
    })).toThrow("GS1");
    expect(normalizeSkuIdentifier(skuIdentifierSchema.parse({
      kind: "gtin",
      value: "6901234567892",
      packagingLevel: "case",
      isPrimary: true,
    }))).toMatchObject({
      scope: "GS1",
      packagingLevel: "case",
      isPrimary: true,
    });
  });

  it("交易伙伴和外部系统编码必须带来源作用域", () => {
    for (const kind of ["external", "vendor", "customer"] as const) {
      expect(() => skuIdentifierSchema.parse({ kind, value: "X-001" })).toThrow("作用域");
    }
    expect(normalizeSkuIdentifier(skuIdentifierSchema.parse({
      kind: "external",
      value: "  jst-001  ",
      scope: " jst ",
    }))).toMatchObject({ value: "jst-001", scope: "JST" });
  });
});
