import { describe, expect, it } from "vitest";
import {
  assessSkuStandardName,
  participatesInNormalSalesMovement,
  unicodeLength,
} from "@/server/rules/sku-standardization";

describe("SKU 标准名称", () => {
  it("按 品牌+渠道+简称+版本+规格 生成并跳过空片段", () => {
    expect(assessSkuStandardName({
      brand: "EXPRESSIONS",
      channel: "天猫",
      shortName: "胶原蛋白肽饮",
      version: "升级版",
      spec: "50ml×10",
    })).toEqual({
      suggestion: "EXPRESSIONS 天猫 胶原蛋白肽饮 升级版 50ml×10",
      missing: [],
      ready: true,
    });
    expect(assessSkuStandardName({
      brand: "NING",
      channel: null,
      shortName: "面膜",
      version: null,
      spec: "25ml×5",
    }).suggestion).toBe("NING 面膜 25ml×5");
  });

  it("缺品牌或简称时拒绝伪造建议", () => {
    expect(assessSkuStandardName({
      brand: null,
      channel: "天猫",
      shortName: "",
      version: null,
      spec: null,
    })).toEqual({ suggestion: null, missing: ["brand", "shortName"], ready: false });
  });

  it("相邻重复片段去重，字符长度按 Unicode 码点计算", () => {
    expect(assessSkuStandardName({
      brand: "NING",
      channel: "NING",
      shortName: "面膜",
      version: "",
      spec: "",
    }).suggestion).toBe("NING 面膜");
    expect(unicodeLength("胶原蛋白肽饮")).toBe(6);
  });

  it("样品等非销售用途保留库存但不进入正常销售动销口径", () => {
    expect(participatesInNormalSalesMovement("retail")).toBe(true);
    expect(participatesInNormalSalesMovement("unclassified")).toBe(true);
    expect(participatesInNormalSalesMovement("sample")).toBe(false);
    expect(participatesInNormalSalesMovement("gift")).toBe(false);
    expect(participatesInNormalSalesMovement("tester")).toBe(false);
    expect(participatesInNormalSalesMovement("internal")).toBe(false);
  });
});
