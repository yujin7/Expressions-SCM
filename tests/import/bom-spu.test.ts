/**
 * SPU 建议引擎测试（《04》§4.1 派生规则）：族前缀 ∩ 归一化品名双证。
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import type { BomBlock } from "@/server/import/adapters/bom";
import { parseBomWorkbook } from "@/server/import/adapters/bom";
import { familyPrefix, suggestSpus } from "@/server/import/adapters/bom-spu";

function block(productCode: string | null, productName: string): BomBlock {
  return {
    sheet: "T", brandCode: "NING", productCode, productName, productSpec: "",
    versionMarker: "none", barcode: null, ambiguous: false, lines: [], feeLines: [],
  };
}

describe("suggestSpus（合成）", () => {
  it("族前缀 ∩ 归一化品名双证一致 → auto；-a/-X 变体默认同簇", () => {
    const clusters = suggestSpus([
      block("N006-000", "(NING DERMOLOGIE)测试眼霜(30g)"),
      block("N006-001-a", "(NING)测试眼霜(30g)升级版"),
      block("N006-X-000", "(NING)测试眼霜(10g)"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].spuKey).toBe("N006");
    expect(clusters[0].confidence).toBe("auto");
    expect(clusters[0].members).toEqual(["N006-000", "N006-001-a", "N006-X-000"]);
    expect(clusters[0].suggestedName).toBe("测试眼霜");
  });

  it("同族异名 → review（双证不一致，人工归组）", () => {
    const clusters = suggestSpus([
      block("N007-000", "(NING)测试洁面乳(100g)"),
      block("N007-001", "(NING)测试卸妆膏(100g)"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].confidence).toBe("review");
    expect(clusters[0].reasons.join()).toContain("同族异名");
  });

  it("跨族同名 → 两簇均 review（不自动合并）", () => {
    const clusters = suggestSpus([
      block("N008-000", "(NING)测试面膜(100g)"),
      block("N009-000", "(NING)测试面膜(120g)"),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.confidence === "review")).toBe(true);
    expect(clusters[0].reasons.join()).toContain("跨族同名");
  });

  it("成员总数 = 去重产品编码数；null 编码块不入簇", () => {
    const clusters = suggestSpus([
      block("N010-000", "(NING)甲(1g)"),
      block("N010-000", "(NING)甲(1g)"), // 同码多块
      block("N011-000", "(NING)乙(1g)"),
      block(null, "(NING)丙(1g)"),
    ]);
    const members = clusters.flatMap((c) => c.members);
    expect(members).toHaveLength(2);
    expect(new Set(members).size).toBe(2);
  });

  it("familyPrefix：首段大写", () => {
    expect(familyPrefix("N006-001-a")).toBe("N006");
    expect(familyPrefix("dev025-000")).toBe("DEV025");
    expect(familyPrefix("E01")).toBe("E01");
  });
});

const REAL = {
  NING: "/Users/yj/Desktop/SCM/【NING】产品bom表.xlsx",
  EXP: "/Users/yj/Desktop/SCM/【EXPRESSIONS】产品bom表.xlsx",
};

describe.runIf(existsSync(REAL.NING) && existsSync(REAL.EXP))("suggestSpus（真实文件）", () => {
  it("NING：成员守恒 + 簇非空 + N02 族 -a 变体同簇", async () => {
    const r = await parseBomWorkbook(REAL.NING, "NING");
    const clusters = suggestSpus(r.blocks);
    const members = clusters.flatMap((c) => c.members);
    expect(members.length).toBe(r.stats.distinctProductCodes);
    expect(new Set(members).size).toBe(members.length);
    expect(clusters.every((c) => c.members.length > 0)).toBe(true);
    // 已知族：N02 含 -a 变体（N02-032-a 等），须与同族其余编码聚在一簇
    const n02 = clusters.find((c) => c.spuKey === "N02");
    expect(n02).toBeDefined();
    expect(n02!.members.some((m) => /-a$/i.test(m))).toBe(true);
    expect(n02!.members.length).toBeGreaterThan(1);
    // auto 与 review 并存（真实数据必然有需人工归组的簇）
    expect(clusters.some((c) => c.confidence === "auto")).toBe(true);
    expect(clusters.some((c) => c.confidence === "review")).toBe(true);
  });

  it("EXPRESSIONS：E02 族 -a 变体同簇（E02-011-a）", async () => {
    const r = await parseBomWorkbook(REAL.EXP, "EXP");
    const clusters = suggestSpus(r.blocks);
    expect(clusters.flatMap((c) => c.members).length).toBe(r.stats.distinctProductCodes);
    const e02 = clusters.find((c) => c.spuKey === "E02");
    expect(e02).toBeDefined();
    expect(e02!.members).toContain("E02-011-a");
    expect(e02!.members.length).toBeGreaterThan(1);
  });
});
