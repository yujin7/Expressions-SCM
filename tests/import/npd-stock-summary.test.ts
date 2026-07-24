/** 适配器⑩⑪ 纯解析测试：NPD 节点表解析 + 总库存宽表解析 */
import { describe, expect, it } from "vitest";
import { parseNodes } from "@/server/import/adapters/npd";
import { parseStockSummarySheet } from "@/server/import/adapters/stock-summary";
import type { SheetData } from "@/server/import/parse/xlsx";
import type { TransitPayload } from "@/server/import/adapters/transit";

const sheet = (name: string, rows: (string | number | null)[][]): SheetData =>
  ({ name, hidden: false, rows }) as SheetData;

describe("parseNodes（NPD 节点表）", () => {
  it("按节点名称建索引并解析各列", () => {
    const s = sheet("数据表", [
      ["节点名称", "节点阶段", "责任部门", "执行岗位", "节点职责说明", "对上下游或平行部门需求/要求", "交付物模板", "交付事项标准", "执行时间标准（天）", "模拟开始时间", "模拟结束时间", "上一节点"],
      ["a.1 市场洞察", "立项", "产品部", "产品经理", "输出洞察报告", "需要销售数据", "模板A", "标准B", 5, "2026-01-01", "2026-01-05", null],
      [null, null, null, null, null, null, null, null, null, null, null, null],
      ["a.2 竞品分析", "立项", "产品部", null, null, null, null, null, 3, null, null, "a.1 市场洞察"],
    ]);
    const m = parseNodes(s);
    expect(m.size).toBe(2);
    const n1 = m.get("a.1 市场洞察")!;
    expect(n1.节点阶段).toBe("立项");
    expect(n1.执行天数).toBe(5);
    expect(n1.模拟开始).toBe("2026-01-01");
    expect(m.get("a.2 竞品分析")!.上一节点).toBe("a.1 市场洞察");
  });

  it("表头缺失时返回空表（不抛错）", () => {
    expect(parseNodes(sheet("数据表", [["其他", "列"]])).size).toBe(0);
  });
});

describe("parseStockSummarySheet（总库存宽表）", () => {
  it("逐 SKU 提取商品数量/在订未出/日均，并跳过空编码行", () => {
    const s = sheet("Sheet1", [
      ["产品类型", "条形码", "商家编码", "货品名称", "商品数量", "总日均销量", "总计划可销天数", "已下单未出货"],
      ["假发", "690001", "E01-001-a", "测试假发", 4168, 12.5, 333, 2000],
      ["假发", null, null, "合计行（无编码）", 99999, null, null, null],
      ["蛋白棒", "690002", "N02-028-a", "测试蛋白棒", 0, 0, null, 500],
    ]);
    const rows = parseStockSummarySheet(s);
    expect(rows.length).toBe(2);
    const p0 = rows[0].payload as TransitPayload;
    expect(p0.kind).toBe("stock_summary");
    expect(p0.skuCode).toBe("E01-001-a");
    expect(p0.externalNo).toBe("690001");
    expect(p0.qty).toBe(4168);
    expect(p0.inboundQty).toBe(2000);
    expect((p0.extra as { 总日均销量: number }).总日均销量).toBe(12.5);
    const p1 = rows[1].payload as TransitPayload;
    expect(p1.qty).toBe(0); // 0 不作 null
  });
});
