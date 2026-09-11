/**
 * 上传模板签名校验。
 *
 * 扩展名只能证明“这是一个 xlsx”，不能证明“这是用户选择的那类业务文件”。
 * 真实 dev 数据曾出现把销量表依次按 inventory/transit/expiry/... 上传的记录：
 * 部分适配器返回 0 行却把任务标成 done，造成“文件已入库”的假象。
 *
 * 本层只检查稳定的工作表/表头指纹，不检查业务值；业务值仍由各适配器逐行校验。
 */
import { SUPPLY_PARAMS_CSV_KEY_HEADER, SUPPLY_PARAMS_CSV_LEAD_HEADERS } from "@/lib/supply-params-csv";
import type { CellValue, SheetData, WorkbookData } from "./parse/xlsx";

export const IMPORT_TEMPLATES = [
  "bom",
  "inventory",
  "expiry",
  "sales",
  "leadtime",
  "sku_leadtime_simple",
  "transit",
  "demand",
  "pallet",
  "stock_summary",
  "sku_cost",
] as const;

export type ImportTemplate = (typeof IMPORT_TEMPLATES)[number];

function text(v: CellValue): string {
  return typeof v === "string" ? v.replace(/\s/g, "") : "";
}

function hasHeader(sheet: SheetData, required: string[], anyOf: string[] = []): boolean {
  return sheet.rows.some((row) => {
    const cells = row.map(text).filter(Boolean);
    return required.every((key) => cells.some((cell) => cell.includes(key)))
      && (anyOf.length === 0 || anyOf.some((key) => cells.some((cell) => cell.includes(key))));
  });
}

function named(wb: WorkbookData, name: string): SheetData | undefined {
  return wb.sheets.find((sheet) => sheet.name.trim() === name);
}

function matches(wb: WorkbookData, template: ImportTemplate): boolean {
  switch (template) {
    case "bom":
      return wb.sheets.some((sheet) => hasHeader(sheet, ["产品编码", "原材料"]));
    case "inventory": {
      const sheet = named(wb, "7-21数据源");
      return !!sheet && hasHeader(sheet, ["仓库", "商家编码", "商品数量"]);
    }
    case "expiry":
      return wb.sheets.some(
        (sheet) => !sheet.name.includes("汇总") && hasHeader(sheet, ["商品编码", "盘点后数量"]),
      );
    case "sales":
      return wb.sheets.some((sheet) => sheet.name.includes("销量") && hasHeader(sheet, ["货品编号"]));
    case "leadtime": {
      const sales = named(wb, "生产周期统计");
      const transit = named(wb, "生产周期明细");
      return (!!sales && hasHeader(sales, ["商家编码", "常规生产周期"]))
        || (!!transit && hasHeader(transit, ["商家编码", "成品起订量"]));
    }
    /* 简版周期补录表（#2）：不绑页名、不绑供应商列名——业务自己导出的表就是这一份。
       只要有「SKU编码」+ 任意一个周期列即认，正是 `@/lib/supply-params-csv` 的表头。 */
    case "sku_leadtime_simple":
      return wb.sheets.some(
        (sheet) => hasHeader(sheet, [SUPPLY_PARAMS_CSV_KEY_HEADER], [...Object.values(SUPPLY_PARAMS_CSV_LEAD_HEADERS)]),
      );
    case "transit": {
      const sheet = named(wb, "成品跟进表");
      return !!sheet && hasHeader(sheet, ["商品编码", "订单数量", "订单实时进度"]);
    }
    case "demand": {
      const sheet = named(wb, "库存明细");
      return !!sheet && hasHeader(sheet, ["产品编码"]);
    }
    case "pallet":
      return wb.sheets.some((sheet) => hasHeader(sheet, ["货品编号", "货品名称"]));
    case "stock_summary":
      return wb.sheets.some((sheet) => hasHeader(sheet, ["商家编码", "商品数量"]));
    case "sku_cost":
      return wb.sheets.some(
        (sheet) => hasHeader(sheet, ["成本"], ["商家编码", "SKU编码", "编码"]),
      );
  }
}

const LABELS: Record<ImportTemplate, string> = {
  bom: "BOM",
  inventory: "库存长表",
  expiry: "效期批次",
  sales: "月销量",
  leadtime: "生产周期/起订量",
  sku_leadtime_simple: "周期补录（导出→填写→导回）",
  transit: "成品与包材在途",
  demand: "需求计划达成",
  pallet: "总货盘",
  stock_summary: "总库存核对",
  sku_cost: "SKU 单位成本",
};

/** 不匹配时抛错；调用方必须在创建 import_job 前执行。 */
export function assertWorkbookMatchesTemplate(wb: WorkbookData, template: ImportTemplate): void {
  if (matches(wb, template)) return;
  const sheets = wb.sheets.map((sheet) => sheet.name).slice(0, 12).join("、") || "（无工作表）";
  throw new Error(
    `文件内容与“${LABELS[template]}”模板不匹配；检测到工作表：${sheets}。`
    + "请重新选择正确模板，系统未创建导入任务。",
  );
}
