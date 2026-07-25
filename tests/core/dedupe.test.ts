/** E5-09 主档去重侦测测试（逻辑已在 node 中逐例执行验证） */
import { describe, expect, it } from "vitest";
import { detectDuplicates, diceSimilarity, normalizeName, type SkuLike } from "@/server/core/dedupe";

const sku = (skuId: number, code: string, name: string, brand?: string): SkuLike => ({ skuId, code, name, brand });

describe("normalizeName", () => {
  it("全角、空格、括号规格后缀归一到同一形态", () => {
    const forms = [
      "玻尿酸原液精华30ml",
      "玻尿酸原液精华（30ml）",
      "玻尿酸原液精华 30ML",
      "玻尿酸原液精华-30ml",
    ];
    const normed = forms.map(normalizeName);
    expect(new Set(normed).size).toBe(1);
    expect(normed[0]).toBe("玻尿酸原液精华");
  });

  it("剥离 *15片 这类件数后缀", () => {
    expect(normalizeName("面膜*15片")).toBe("面膜");
    expect(normalizeName("面膜x15")).toBe("面膜");
  });

  it("不误伤不带单位的数字（SK2 不能被吃掉）", () => {
    expect(normalizeName("sk2神仙水")).toBe("sk2神仙水");
  });

  it("空/异常输入不抛错", () => {
    expect(() => normalizeName("")).not.toThrow();
    // @ts-expect-error 故意传 null 验证运行时健壮性
    expect(normalizeName(null)).toBe("");
  });
});

describe("diceSimilarity", () => {
  it("完全相同 = 1，完全不同 = 0", () => {
    expect(diceSimilarity("面霜", "面霜")).toBe(1);
    expect(diceSimilarity("abcd", "wxyz")).toBe(0);
  });

  it("一字之差按 bigram 计分", () => {
    expect(diceSimilarity("abc", "abd")).toBeCloseTo(0.5, 6);
  });

  it("空串处理不抛错", () => {
    expect(diceSimilarity("", "")).toBe(1);
    expect(diceSimilarity("", "x")).toBe(0);
  });
});

describe("detectDuplicates", () => {
  it("归一化后完全相同 → 成簇，topScore=1", () => {
    const r = detectDuplicates([
      sku(1, "A001", "玻尿酸原液精华30ml", "NING"),
      sku(2, "A002", "玻尿酸原液精华（30ml）", "NING"),
      sku(3, "B999", "完全无关的商品", "NING"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].members.map((m) => m.skuId)).toEqual([1, 2]);
    expect(r[0].topScore).toBe(1);
    expect(r[0].reasons).toContain("归一化后名称完全相同");
  });

  it("**近似但低于阈值不误报**——面霜/面膜是不同品，绝不能合并", () => {
    const r = detectDuplicates([
      sku(1, "A001", "深层保湿面霜", "NING"),
      sku(2, "A002", "深层保湿面膜", "NING"),
    ]);
    expect(r).toHaveLength(0); // dice=0.8 < 0.85
  });

  it("高相似度成簇并标注百分比", () => {
    const r = detectDuplicates([
      sku(1, "A001", "深层保湿修护面霜", "NING"),
      sku(2, "A002", "深层保湿修护面霜a", "NING"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].topScore).toBeGreaterThanOrEqual(0.85);
    expect(r[0].reasons[0]).toMatch(/高度相似/);
  });

  it("传递性：A≈B、B≈C 归为一簇（并查集），不散成两两对", () => {
    const r = detectDuplicates(
      [
        sku(1, "A001", "补水面膜金装版"),
        sku(2, "A002", "补水面膜金装"),
        sku(3, "A003", "补水面膜"),
      ],
      { threshold: 0.7 }, // A-B=0.909, B-C=0.75, A-C=0.667（A-C 本身不达标）
    );
    expect(r).toHaveLength(1);
    expect(r[0].members.map((m) => m.skuId)).toEqual([1, 2, 3]);
  });

  it("孤立项不产出（只报真候选，不制造噪音）", () => {
    const r = detectDuplicates([sku(1, "A", "商品甲"), sku(2, "B", "货物乙"), sku(3, "C", "物件丙")]);
    expect(r).toHaveLength(0);
  });

  it("跨品牌标记 crossBrand，并排在同品牌之后", () => {
    const r = detectDuplicates([
      // 跨品牌簇（同名不同品，可能是正常的）
      sku(1, "A1", "补水喷雾", "NING"),
      sku(2, "A2", "补水喷雾", "EXPRESSIONS"),
      // 同品牌簇（更可能是真重复）
      sku(3, "B1", "紧致眼霜", "NING"),
      sku(4, "B2", "紧致眼霜", "NING"),
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].crossBrand).toBe(false); // 同品牌优先
    expect(r[0].members.map((m) => m.skuId)).toEqual([3, 4]);
    expect(r[1].crossBrand).toBe(true);
  });

  it("两个空名不算重复（幽灵行不能互相配对）", () => {
    const r = detectDuplicates([sku(1, "0", ""), sku(2, "0", "   ")]);
    expect(r).toHaveLength(0);
  });

  it("成员按 skuId 升序——第一个即建议保留的最早建档项", () => {
    const r = detectDuplicates([sku(90, "C", "紧致眼霜"), sku(7, "A", "紧致眼霜"), sku(44, "B", "紧致眼霜")]);
    expect(r[0].members.map((m) => m.skuId)).toEqual([7, 44, 90]);
  });

  it("maxClusterSize 拦住病态簇（防一条脏数据炸出上百成员）", () => {
    const many = Array.from({ length: 25 }, (_, i) => sku(i + 1, `C${i}`, "同一个名字"));
    expect(detectDuplicates(many)).toHaveLength(0);
    expect(detectDuplicates(many, { maxClusterSize: 30 })[0].members).toHaveLength(25);
  });

  it("不修改入参", () => {
    const input = [sku(2, "B", "紧致眼霜"), sku(1, "A", "紧致眼霜")];
    const snapshot = JSON.stringify(input);
    detectDuplicates(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("空数组不抛错", () => {
    expect(detectDuplicates([])).toEqual([]);
  });
});
