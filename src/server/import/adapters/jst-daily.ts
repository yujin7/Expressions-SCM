/**
 * 适配器⑦：聚水潭销售出库日汇总 → jst_daily_sales（reconcile-jst 的 jst 侧数据源，《01》§7.2）。
 *
 * 无真实样例文件——模板由本适配器**定义**（见 JST_DAILY_TEMPLATE），操作员按模板从聚水潭导出。
 * 支持 .xlsx（readWorkbook 双通道）与 .csv（UTF-8/逗号分隔/双引号转义的简单解析器）。
 * 列匹配为容错「包含匹配」：表头单元格文本包含 日期/商家编码/仓库/数量 即命中（顺序不限，可有多余列）。
 *
 * 对账口径提示（《01》§7.2）：对账=自有仓发货；操作员导出时应只含自有仓行，
 * 仓库列（可选）经 warehouse 别名映射留痕，reconcile-jst 按 日期×SKU 汇总。
 */
import { readFileSync } from "node:fs";
import { normalizeDateCell, readWorkbook, type CellValue } from "../parse/xlsx";
import {
  cellToString,
  isBlankRow,
  stagePipeline,
  toNumberTolerant,
  type Adapter,
  type AdapterReject,
  type AdapterRow,
  type StageSummary,
} from "./types";
import type { AnyDb } from "../staging";

const TARGET_TABLE = "jst_daily_sales";
/** import_jobs.template 标识 */
export const JST_DAILY_TEMPLATE_ID = "jst_daily_sales";

/** 操作员模板说明（导出规范；.xlsx 或 .csv 均可） */
export const JST_DAILY_TEMPLATE = `聚水潭销售出库日汇总导入模板（.xlsx 或 UTF-8 .csv）
第 1 行为表头；列名按「包含匹配」识别，顺序不限，允许多余列：
  日期（必填）    出库自然日：YYYY-MM-DD / YYYY/M/D / Excel 日期均可
  商家编码（必填）聚水潭商家编码（经 sku_code 别名映射到系统 SKU）
  仓库（可选）    聚水潭仓库名（经 warehouse 别名映射，仅留痕）
  数量（必填）    当日出库数量，数值且 ≥0
导出口径：自有仓发货行（《01》§7.2）；同 日期×商家编码 多行时对账自动求和。`;

/* ── CSV 简单解析器（逗号/UTF-8/双引号转义；BOM 容忍） ── */
export function parseCsv(text: string): CellValue[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: CellValue[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row.map((s) => (s.trim() === "" ? null : s.trim())));
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** 表头「包含匹配」取列（区别于 findCol 的精确匹配） */
function findColContains(header: CellValue[], key: string): number {
  return header.findIndex((c) => typeof c === "string" && c.includes(key));
}

interface SheetLike {
  name: string;
  rows: CellValue[][];
}

async function readSheets(filePath: string): Promise<SheetLike[]> {
  if (filePath.toLowerCase().endsWith(".csv")) {
    return [{ name: "csv", rows: parseCsv(readFileSync(filePath, "utf8")) }];
  }
  const wb = await readWorkbook(filePath);
  return wb.sheets.filter((s) => !s.hidden);
}

export const jstDailyAdapter: Adapter = async (filePath) => {
  const sheets = await readSheets(filePath);
  const rows: AdapterRow[] = [];
  const rejects: AdapterReject[] = [];
  let sheetsParsed = 0;
  const skuSet = new Set<string>();
  const dateSet = new Set<string>();

  for (const sheet of sheets) {
    // 表头行：前 10 行内同时含 日期/商家编码/数量
    const scan = Math.min(sheet.rows.length, 10);
    let headerIdx = -1;
    for (let i = 0; i < scan; i++) {
      const r = sheet.rows[i] ?? [];
      if (findColContains(r, "日期") >= 0 && findColContains(r, "商家编码") >= 0 && findColContains(r, "数量") >= 0) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) continue; // 非数据页（xlsx 可能有说明页）静默跳过

    sheetsParsed++;
    const hdr = sheet.rows[headerIdx];
    const cDate = findColContains(hdr, "日期");
    const cSku = findColContains(hdr, "商家编码");
    const cWh = findColContains(hdr, "仓库");
    const cQty = findColContains(hdr, "数量");

    for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
      const r = sheet.rows[i] ?? [];
      if (isBlankRow(r)) continue;
      const rowNo = i + 1;
      const skuCode = cellToString(r[cSku]);
      if (skuCode === null) {
        rejects.push({ rowNo, sheet: sheet.name, reason: "缺少商家编码", raw: r });
        continue;
      }
      const bizDate = normalizeDateCell(r[cDate]);
      if (bizDate === null) {
        rejects.push({ rowNo, sheet: sheet.name, reason: `日期无法解析: ${String(r[cDate])}`, raw: r });
        continue;
      }
      const qty = toNumberTolerant(r[cQty]);
      if (qty === null || qty < 0) {
        rejects.push({ rowNo, sheet: sheet.name, reason: `数量非法: ${String(r[cQty])}`, raw: r });
        continue;
      }
      const warehouseRaw = cWh >= 0 ? cellToString(r[cWh]) : null;
      skuSet.add(skuCode);
      dateSet.add(bizDate);
      rows.push({
        rowNo,
        targetTable: TARGET_TABLE,
        payload: { bizDate, skuCode, warehouseRaw, qty },
      });
    }
  }

  if (sheetsParsed === 0) {
    rejects.push({ rowNo: 0, sheet: "-", reason: "未找到表头行（需含 日期/商家编码/数量 列）", raw: null });
  }

  return {
    rows,
    rejects,
    stats: {
      sheetsParsed,
      dataRows: rows.length,
      rejected: rejects.length,
      distinctSkus: skuSet.size,
      distinctDates: dateSet.size,
    },
  };
};

/** 全链路：别名解析 sku_code（+可选 warehouse）→ staging */
export async function stageJstDaily(db: AnyDb, filePath: string, userId: number): Promise<StageSummary> {
  return stagePipeline(db, {
    filePath,
    template: JST_DAILY_TEMPLATE_ID,
    userId,
    adapter: jstDailyAdapter,
    targetTable: TARGET_TABLE,
    aliasRefs: (row) => [
      { field: "sku", aliasType: "sku_code", value: row.payload.skuCode as string | null },
      { field: "warehouse", aliasType: "warehouse", value: row.payload.warehouseRaw as string | null },
    ],
  });
}
