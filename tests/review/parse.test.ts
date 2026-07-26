import { describe, expect, it } from "vitest";
import { parseReviewLine, parseReviewMarkdown } from "@/server/modules/review/parse";

describe("复核清单 md 解析器", () => {
  it("SPU 簇代决 → spu_cluster + spu 编码", () => {
    const r = parseReviewLine(
      "- SPU 簇代决接受：DEV001（成员 1；原因：跨族同名「净透控油洁面乳」：DEV001/DEV01）",
    )!;
    expect(r.category).toBe("spu_cluster");
    expect(r.refType).toBe("spu");
    expect(r.refKey).toBe("DEV001");
    expect(r.title).toBe("SPU 簇代决接受：DEV001");
    expect(r.detail).toContain("成员 1");
  });

  it("BOM 歧义代决 → bom_version，尾注并入 detail", () => {
    const r = parseReviewLine("- BOM 歧义代决：N009-004（1 块，取表内最后一块为现行版）——自动裁决待复核")!;
    expect(r.category).toBe("bom_version");
    expect(r.refType).toBe("bom");
    expect(r.refKey).toBe("N009-004");
    expect(r.title).toBe("BOM 歧义代决：N009-004");
    expect(r.detail).toContain("自动裁决待复核");
  });

  it("物料代决分类 → segment + sku 编码（半角括号行整行为 title）", () => {
    const r = parseReviewLine(
      "- 物料代决分类为包材：N032-0501 中文标贴-(NING DERMOLOGIE)宁源氨基酸净透洁面乳(100g)(日本一般贸易)",
    )!;
    expect(r.category).toBe("segment");
    expect(r.refType).toBe("sku");
    expect(r.refKey).toBe("N032-0501");
    expect(r.detail).toBeNull();
  });

  it("物料代决无可解析编码 → refType/refKey 置空", () => {
    const r = parseReviewLine("- 物料代决分类为包材：76 瓶子-(EXPRESSIONS)柔润亮泽香氛护发精油(100ml)")!;
    expect(r.category).toBe("segment");
    expect(r.refType).toBeNull();
    expect(r.refKey).toBeNull();
  });

  it("壳档品牌行 → shell_brand，编码可解析", () => {
    const r = parseReviewLine("- 壳档品牌消去法推断（V→微初），存疑待业务确认：V001-000")!;
    expect(r.category).toBe("shell_brand");
    expect(r.refType).toBe("sku");
    expect(r.refKey).toBe("V001-000");
  });

  it("SKU/BOM 放行受阻 → blocked_sku，refType 各归其位（嵌套括号 detail 完整）", () => {
    const a = parseReviewLine("- SKU 放行受阻：DEV005-000-0301（物料段位无法判定（segment=unknown））")!;
    expect(a.category).toBe("blocked_sku");
    expect(a.refType).toBe("sku");
    expect(a.refKey).toBe("DEV005-000-0301");
    expect(a.detail).toBe("物料段位无法判定（segment=unknown）");
    const b = parseReviewLine("- BOM 放行受阻：N02-032-a（SKU 未放行：N02-032-a-0602/N02-032-a-0601）")!;
    expect(b.category).toBe("blocked_sku");
    expect(b.refType).toBe("bom");
    expect(b.refKey).toBe("N02-032-a");
  });

  it("BOM 生效抽检 → activation_sample，编码不含版本号", () => {
    const r = parseReviewLine("- BOM 生效抽检（10%样本）：DEV001-X000 V2")!;
    expect(r.category).toBe("activation_sample");
    expect(r.refType).toBe("bom");
    expect(r.refKey).toBe("DEV001-X000");
  });

  it("无编码物料 → uncoded 无引用；其余 → other", () => {
    const u = parseReviewLine("- 无编码物料待人工建档：收缩膜（出现 284 次）")!;
    expect(u.category).toBe("uncoded");
    expect(u.refType).toBeNull();
    expect(u.title).toBe("无编码物料待人工建档：收缩膜");
    expect(u.detail).toBe("出现 284 次");
    const o = parseReviewLine("- 46 行费用候选供应商列为空——加工费参考价必须挂工厂")!;
    expect(o.category).toBe("other");
  });

  it("非条目行返回 null；全文解析按 title 去重", () => {
    expect(parseReviewLine("# 数据填充代决复核清单（2026-07-24）")).toBeNull();
    expect(parseReviewLine("## 补遗轮")).toBeNull();
    expect(parseReviewLine("")).toBeNull();
    expect(parseReviewLine("正文说明，不是条目")).toBeNull();
    const md = [
      "# 标题",
      "- 物料代决分类为包材：TYCL01-016 溯源码标签",
      "",
      "## 补遗轮",
      "- 物料代决分类为包材：TYCL01-016 溯源码标签", // 与主轮重复
      "- SPU 簇代决接受：E02（成员 7；原因：同族异名）",
    ].join("\n");
    const items = parseReviewMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0].refKey).toBe("TYCL01-016");
    expect(items[1].category).toBe("spu_cluster");
  });
});
