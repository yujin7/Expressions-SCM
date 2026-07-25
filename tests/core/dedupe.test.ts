/**
 * E5-09 主档去重侦测。
 *
 * 带 ⚠ 的用例都是**在 5,376 个真实 SKU 上被打脸后补的回归守卫**——
 * 初版算法把整条产品线判成了一组重复。改动本模块前先读这几条。
 */
import { describe, expect, it } from "vitest";
import { detectDuplicates, diceSimilarity, normalizeName, specSignature, type SkuLike } from "@/server/core/dedupe";

const sku = (skuId: number, code: string, name: string, brand?: string): SkuLike => ({ skuId, code, name, brand });

describe("normalizeName", () => {
  it("统一全角/大小写/括号/空白/分隔符", () => {
    const forms = [
      "玻尿酸原液精华30ml",
      "玻尿酸原液精华（30ml）",
      "玻尿酸原液精华 30ML",
      "玻尿酸原液精华-30ml",
    ];
    const normed = forms.map(normalizeName);
    expect(new Set(normed).size).toBe(1);
    expect(normed[0]).toBe("玻尿酸原液精华30ml");
  });

  it("⚠ **保留规格的值**——删掉规格会把不同容量判成同一物（真实数据踩过）", () => {
    expect(normalizeName("清洁泥膜(110g)")).not.toBe(normalizeName("清洁泥膜(20g)"));
    expect(normalizeName("清洁泥膜(110g)")).toBe("清洁泥膜110g");
  });

  it("乘号写法统一，但不误伤 latin 词里的 x", () => {
    expect(normalizeName("面膜28ml×10片")).toBe(normalizeName("面膜28ml*10片"));
    expect(normalizeName("max强效")).toBe("max强效");
  });

  it("空/异常输入不抛错", () => {
    expect(() => normalizeName("")).not.toThrow();
    // @ts-expect-error 故意传 null 验证运行时健壮性
    expect(normalizeName(null)).toBe("");
  });
});

describe("specSignature", () => {
  it("抽出所有数字+单位并排序，数值归一（030g ≡ 30g）", () => {
    expect(specSignature("面膜28ml*10片")).toEqual(["10片", "28ml"]);
    expect(specSignature("面霜030g")).toEqual(specSignature("面霜30g"));
  });

  it("无规格时为空数组（不臆造）", () => {
    expect(specSignature("莹润焕白淡斑霜")).toEqual([]);
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

describe("detectDuplicates — 命中", () => {
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

  it("高相似度成簇并标注百分比", () => {
    const r = detectDuplicates([
      sku(1, "A001", "深层保湿修护面霜", "NING"),
      sku(2, "A002", "深层保湿修护面霜a", "NING"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].topScore).toBeGreaterThanOrEqual(0.9);
    expect(r[0].reasons[0]).toMatch(/高度相似/);
  });

  it("成员按 skuId 升序——第一个即建档最早的", () => {
    const r = detectDuplicates([sku(90, "C", "紧致眼霜"), sku(7, "A", "紧致眼霜"), sku(44, "B", "紧致眼霜")]);
    expect(r[0].members.map((m) => m.skuId)).toEqual([7, 44, 90]);
  });
});

describe("detectDuplicates — ⚠ 真实数据回归守卫（改动前必读）", () => {
  it("⚠ **规格不同一票否决**：10ml / 15ml / 30ml 是三个 SKU，不是重复", () => {
    const base = "(NING DERMOLOGIE)光感润白淡斑精华液";
    const r = detectDuplicates([
      sku(1, "N-10", `${base}(10ml)`, "NING"),
      sku(2, "N-15", `${base}(15ml)`, "NING"),
      sku(3, "N-30", `${base}(30ml)`, "NING"),
    ]);
    // 名称长、前缀共享，Dice 高达 0.9+，靠调阈值分不开——必须靠规格硬判别
    expect(r).toHaveLength(0);
  });

  it("⚠ **剂型不同一票否决**：精华液 vs 精华乳，同规格也不是重复", () => {
    const r = detectDuplicates([
      sku(1, "N-A", "(NING DERMOLOGIE)光感润白淡斑精华液(15ml)", "NING"),
      sku(2, "N-B", "(NING DERMOLOGIE)光感润白淡斑精华乳(15ml)", "NING"),
    ]);
    expect(r).toHaveLength(0);
  });

  it("⚠ 剂型取**最后一个**：「水感净澈卸妆油」的剂型是油不是水", () => {
    // 这两个名字相似度 0.92，已超阈值——只有正确识别剂型才拦得住。
    // 若 formOf 取「第一个」剂型字，两者都会被判成「水」，冲突消失 → 误报。
    const r = detectDuplicates([
      sku(1, "A", "(NING DERMOLOGIE)水感净澈卸妆油150ml", "NING"),
      sku(2, "B", "(NING DERMOLOGIE)水感净澈卸妆水150ml", "NING"),
    ]);
    expect(r).toHaveLength(0);
  });

  it("⚠ **完全连接：不得链式扩张**（A≈B、B≈C 但 A≉C 时，C 不进簇）", () => {
    const r = detectDuplicates(
      [
        sku(1, "A001", "补水面膜金装版"),
        sku(2, "A002", "补水面膜金装"),
        sku(3, "A003", "补水面膜"),
      ],
      { threshold: 0.7 }, // A-B=0.909, B-C=0.75, **A-C=0.667 不达标**
    );
    expect(r).toHaveLength(1);
    // 单连接（并查集）会把 3 也拉进来——那正是真实数据上「整条产品线成一簇」的成因
    expect(r[0].members.map((m) => m.skuId)).toEqual([1, 2]);
  });

  it("⚠ 整条产品线不得被判成一组重复（六个不同剂型的姐妹品）", () => {
    const line = ["精华水(115ml)", "精华液(30ml)", "眼霜(30g)", "面霜(50g)", "面膜(28ml)", "精华乳(100ml)"];
    const r = detectDuplicates(line.map((n, i) => sku(i + 1, `DEV${i}`, `(DEVIANCE)肌源紧致赋活${n}`, "DEV")));
    expect(r).toHaveLength(0);
  });
});

describe("detectDuplicates — 不误报与健壮性", () => {
  it("面霜 / 面膜是不同品，绝不合并", () => {
    const r = detectDuplicates([
      sku(1, "A001", "深层保湿面霜", "NING"),
      sku(2, "A002", "深层保湿面膜", "NING"),
    ]);
    expect(r).toHaveLength(0);
  });

  it("孤立项不产出（只报真候选，不制造噪音）", () => {
    const r = detectDuplicates([sku(1, "A", "商品甲"), sku(2, "B", "货物乙"), sku(3, "C", "物件丙")]);
    expect(r).toHaveLength(0);
  });

  it("跨品牌标记 crossBrand，并排在同品牌之后", () => {
    const r = detectDuplicates([
      sku(1, "A1", "补水喷雾", "NING"),
      sku(2, "A2", "补水喷雾", "EXPRESSIONS"),
      sku(3, "B1", "紧致眼霜", "NING"),
      sku(4, "B2", "紧致眼霜", "NING"),
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].crossBrand).toBe(false);
    expect(r[0].members.map((m) => m.skuId)).toEqual([3, 4]);
    expect(r[1].crossBrand).toBe(true);
  });

  it("两个空名不算重复（幽灵行不能互相配对）", () => {
    const r = detectDuplicates([sku(1, "0", ""), sku(2, "0", "   ")]);
    expect(r).toHaveLength(0);
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
