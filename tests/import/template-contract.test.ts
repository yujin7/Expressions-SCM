import { describe, expect, it } from "vitest";
import {
  assertWorkbookMatchesTemplate,
  type ImportTemplate,
} from "@/server/import/template-contract";
import type { WorkbookData } from "@/server/import/parse/xlsx";

function workbook(name: string, row: string[]): WorkbookData {
  return {
    channel: "exceljs",
    sheets: [{ name, hidden: false, rows: [row] }],
  };
}

describe("上传模板内容签名", () => {
  const cases: [ImportTemplate, WorkbookData][] = [
    ["bom", workbook("产品", ["序号", "产品编码（系统）", "原材料编码（自编）"])],
    ["inventory", workbook("7-21数据源", ["仓库", "商家编码", "商品数量"])],
    ["expiry", workbook("天猫保税仓", ["商品编码", "盘点后数量"])],
    ["sales", workbook("NING销量", ["货品编号", "货品名称"])],
    ["leadtime", workbook("生产周期明细", ["商家编码", "成品起订量"])],
    ["transit", workbook("成品跟进表", ["商品编码", "订单数量", "订单实时进度"])],
    ["demand", workbook("库存明细", ["品牌", "产品编码"])],
    ["pallet", workbook("NING", ["货品编号", "货品名称"])],
    ["stock_summary", workbook("库存汇总表", ["商家编码", "商品数量"])],
    ["sku_cost", workbook("成本", ["商家编码", "单位成本"])],
  ];

  it.each(cases)("接受 %s 的稳定表头指纹", (template, wb) => {
    expect(() => assertWorkbookMatchesTemplate(wb, template)).not.toThrow();
  });

  it("拒绝把销量表伪装成库存、在途或效期导入", () => {
    const sales = workbook("NING销量", ["货品编号", "货品名称", "1月"]);
    for (const template of ["inventory", "transit", "expiry"] as const) {
      expect(() => assertWorkbookMatchesTemplate(sales, template)).toThrow(/模板不匹配/);
    }
  });
});
