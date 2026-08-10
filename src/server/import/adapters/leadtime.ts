/**
 * 适配器④：SKU 交期/MOQ 参数 → sku_leadtime。两个来源，同一适配器按页名分流：
 * (a) 26年产品销量汇总 ·「生产周期统计」页：品牌|OEM|商家编码|货品名称|常规生产周期|…
 *     （表头行下标 0，行下标 1 为重复表头+月份带，须跳过；「待确认」37 行 → null）
 * (b) 2026年成品在途订单实时进度表---新版 ·「生产周期明细」页（表头行下标 1；该文件
 *     畸形，仅 ooxml 通道可开——readWorkbook 自动降级）：成品起订量→moq，
 *     常规总生产周期（同名两列，取首个有值者）→normalLeadDays，紧急总生产周期→urgentLeadDays。
 * 数值一律容错（待确认 / "/" → null，绝不产出 NaN）；仅缺商家编码才拒收。
 */
import { readWorkbook, type SheetData } from "../parse/xlsx";
import {
  cellToString,
  findCol,
  isBlankRow,
  stagePipeline,
  toNumberTolerant,
  type Adapter,
  type AdapterReject,
  type AdapterRow,
  type StageSummary,
} from "./types";
import type { CellValue } from "../parse/xlsx";
import type { AnyDb } from "../staging";

const TARGET_TABLE = "sku_leadtime";
export const LEADTIME_TEMPLATE = "sku_leadtime";

const SHEET_A = "生产周期统计"; // 销量汇总文件
const SHEET_B = "生产周期明细"; // 在途进度表文件

/** 同名多列时取首个非空值（如「常规总生产周期」出现两次） */
function firstValueOfCols(row: CellValue[], cols: number[]): CellValue {
  for (const c of cols) {
    const v = row[c];
    if (v != null) return v;
  }
  return null;
}

function allCols(header: CellValue[], name: string): number[] {
  const out: number[] = [];
  header.forEach((c, i) => {
    if (typeof c === "string" && c.trim() === name) out.push(i);
  });
  return out;
}

interface ParseAcc {
  rows: AdapterRow[];
  rejects: AdapterReject[];
  stats: Record<string, number>;
}

function parseSourceA(sheet: SheetData, acc: ParseAcc): void {
  const headerIdx = sheet.rows.findIndex(
    (r) => r != null && findCol(r, "商家编码") >= 0 && findCol(r, "常规生产周期") >= 0,
  );
  if (headerIdx < 0) {
    acc.rejects.push({ rowNo: 0, sheet: sheet.name, reason: "未找到表头行（商家编码/常规生产周期）", raw: null });
    return;
  }
  const hdr = sheet.rows[headerIdx];
  const cSku = findCol(hdr, "商家编码");
  const cOem = findCol(hdr, "OEM");
  const cNormal = findCol(hdr, "常规生产周期");
  let n = 0;
  let pendingConfirm = 0;
  for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    if (isBlankRow(r)) continue;
    const skuCell = cellToString(r[cSku]);
    if (skuCell === "商家编码") continue; // 重复表头行（月份带下的第二表头）
    if (skuCell === null) {
      acc.rejects.push({ rowNo: i + 1, sheet: sheet.name, reason: "缺少商家编码", raw: r.slice(0, 8) });
      continue;
    }
    const normalRaw = r[cNormal] ?? null;
    if (typeof normalRaw === "string" && normalRaw.trim() === "待确认") pendingConfirm++;
    acc.rows.push({
      rowNo: i + 1,
      targetTable: TARGET_TABLE,
      payload: {
        source: "sales_summary",
        skuCode: skuCell,
        oemRaw: cellToString(r[cOem]),
        normalLeadDays: toNumberTolerant(normalRaw),
      },
    });
    n++;
  }
  acc.stats.sourceARows = n;
  acc.stats.sourceANormalPendingConfirm = pendingConfirm;
}

function parseSourceB(sheet: SheetData, acc: ParseAcc): void {
  const headerIdx = sheet.rows.findIndex(
    (r) => r != null && findCol(r, "商家编码") >= 0 && findCol(r, "成品起订量") >= 0,
  );
  if (headerIdx < 0) {
    acc.rejects.push({ rowNo: 0, sheet: sheet.name, reason: "未找到表头行（商家编码/成品起订量）", raw: null });
    return;
  }
  const hdr = sheet.rows[headerIdx];
  const cSku = findCol(hdr, "商家编码");
  const cOem = findCol(hdr, "OEM");
  const cMoq = findCol(hdr, "成品起订量");
  const normalCols = allCols(hdr, "常规总生产周期");
  const urgentCols = allCols(hdr, "紧急总生产周期");
  let n = 0;
  for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    if (isBlankRow(r)) continue;
    const skuCell = cellToString(r[cSku]);
    if (skuCell === "商家编码") continue;
    if (skuCell === null) {
      acc.rejects.push({ rowNo: i + 1, sheet: sheet.name, reason: "缺少商家编码", raw: r.slice(0, 8) });
      continue;
    }
    acc.rows.push({
      rowNo: i + 1,
      targetTable: TARGET_TABLE,
      payload: {
        source: "transit_progress",
        skuCode: skuCell,
        oemRaw: cellToString(r[cOem]),
        normalLeadDays: toNumberTolerant(firstValueOfCols(r, normalCols)),
        urgentLeadDays: toNumberTolerant(firstValueOfCols(r, urgentCols)),
        moq: cMoq >= 0 ? toNumberTolerant(r[cMoq] ?? null) : null,
      },
    });
    n++;
  }
  acc.stats.sourceBRows = n;
}

export const leadtimeAdapter: Adapter = async (filePath) => {
  const wb = await readWorkbook(filePath);
  const sheetA = wb.sheets.find((s) => s.name.trim() === SHEET_A);
  const sheetB = wb.sheets.find((s) => s.name.trim() === SHEET_B);
  if (!sheetA && !sheetB) {
    throw new Error(`未找到「${SHEET_A}」或「${SHEET_B}」工作表: ${filePath}`);
  }
  const acc: ParseAcc = { rows: [], rejects: [], stats: {} };
  if (sheetA) parseSourceA(sheetA, acc);
  if (sheetB) parseSourceB(sheetB, acc);
  acc.stats.dataRows = acc.rows.length;
  acc.stats.rejected = acc.rejects.length;
  return acc;
};

/** 全链路：别名解析 sku_code + supplier_oem */
/**
 * `sourceAsOf` 同 inventory-long/expiry/sales-monthly：不再写死。
 * 原为 `fromSales ? "2026-06-30" : null`——那是最初那份销量文件的日期，
 * 业务自助重传会被盖上同一个过去的时点，进而在 month-close 里进错月份。
 */
export async function stageLeadtime(
  db: AnyDb,
  filePath: string,
  userId: number,
  sourceAsOf: string | null = null,
): Promise<StageSummary> {
  const fromSales = filePath.includes("销量汇总");
  return stagePipeline(db, {
    filePath,
    template: LEADTIME_TEMPLATE,
    userId,
    adapter: leadtimeAdapter,
    targetTable: TARGET_TABLE,
    job: {
      sourceAsOf,
      schemaVersion: "sku-leadtime-v2",
      scope: {
        mode: "full",
        targets: ["sku_params", "uom_convs.moq"],
        sourceSection: fromSales ? "生产周期" : "生产周期明细",
      },
    },
    aliasRefs: (row) => [
      { field: "sku", aliasType: "sku_code", value: row.payload.skuCode as string | null },
      { field: "oem", aliasType: "supplier_oem", value: row.payload.oemRaw as string | null },
    ],
  });
}
