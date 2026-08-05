import { describe, expect, it } from "vitest";
import {
  assessSkuStandardName,
  matchesPublishedNameFormat,
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
      publishedFormat: false,
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
    })).toEqual({ suggestion: null, missing: ["brand", "shortName"], ready: false, publishedFormat: false });
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

  it("现名已符合公司公布格式时不给建议名——防止不可逆降级", () => {
    // 公布标准：(品牌)产品全称(规格)，可带版本类型后缀
    const published = [
      "(EXPRESSIONS)水光肌透亮焕颜精华乳(100ml)",
      "(NING DERMOLOGIE)多酸毛孔细致精华水(20ml)",
      "(DEVIANCE)防脱育发液(100ml)",
      "(EXPRESSIONS)(CN)柔润丝滑香氛发膜(200g)",
      "(NING DERMOLOGIE)水杨酸精华棉片(2.5ml*50pcs)",
      "(品牌)产品全称(规格)TK-CHN",
      "(品牌)产品全称(规格)AMZ-KOR",
    ];
    for (const name of published) {
      const a = assessSkuStandardName({
        name,
        brand: "EXPRESSIONS",
        channel: "天猫",
        shortName: "精华乳",
        version: "升级版",
        spec: "100ml",
      });
      expect(matchesPublishedNameFormat(name), name).toBe(true);
      expect(a.publishedFormat, name).toBe(true);
      expect(a.suggestion, name).toBeNull(); // 无建议 → 界面不渲染「采用标准名」
      expect(a.ready, name).toBe(false);
    }
  });

  it("系统口径的空格串名称不算公司格式，仍可给建议", () => {
    const spaced = "EXPRESSIONS 天猫 胶原蛋白肽饮 升级版 50ml";
    expect(matchesPublishedNameFormat(spaced)).toBe(false);
    expect(matchesPublishedNameFormat("")).toBe(false);
    expect(matchesPublishedNameFormat(null)).toBe(false);
    expect(matchesPublishedNameFormat("彩盒-(EXPRESSIONS)水光肌(100ml)")).toBe(false); // 材料名，非成品名
    const a = assessSkuStandardName({
      name: spaced,
      brand: "NING",
      channel: "",
      shortName: "面膜",
      version: "",
      spec: "",
    });
    expect(a.publishedFormat).toBe(false);
    expect(a.suggestion).toBe("NING 面膜");
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
