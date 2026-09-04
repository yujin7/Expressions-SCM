/**
 * 适配器：简版周期补录表（2026-09-04 审计 #2）→ staging `sku_leadtime_simple`。
 *
 * 为什么另起一个适配器而不是扩展 `leadtime.ts`：后者按**页名**分流
 * （「生产周期统计」「生产周期明细」）并绑死那两份供应商工作簿的列名。
 * 业务自己造不出那样的文件，于是「线下补一批周期」这件事在系统里没有入口。
 * 本适配器只认 `@/lib/supply-params-csv` 那一份表头——正是页面导出的那一份，
 * 导出的表原样填完就能导回来（`tests/import/sku-leadtime-simple.test.ts` 钉住往返）。
 *
 * 口径：
 *  - 按**列名**取列，不依赖列位置（业务会调列序、会加自己的备注列）；
 *  - 三个周期列全空的行**不产出**（只是没填，不是错误），计入 stats.blankRows；
 *  - 缺 SKU 编码才拒收；数值走 toNumberTolerant（"待确认"/"/"→null，绝不产 NaN）；
 *  - 负数与 >365 记拒收——线下表里这类值一律是手误，放进 staging 只会污染放行预演。
 */
import { SKU_LEADTIME_SIMPLE_SHEET, SKU_LEADTIME_SIMPLE_TEMPLATE, SUPPLY_PARAMS_CSV_KEY_HEADER, SUPPLY_PARAMS_CSV_LEAD_HEADERS } from "@/lib/supply-params-csv";
import { readCsvWorkbook } from "../parse/csv";
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
import type { AnyDb } from "../staging";

export const SKU_LEADTIME_SIMPLE_TARGET = SKU_LEADTIME_SIMPLE_TEMPLATE;

const LEAD_FIELDS = Object.entries(SUPPLY_PARAMS_CSV_LEAD_HEADERS) as [
  keyof typeof SUPPLY_PARAMS_CSV_LEAD_HEADERS,
  string,
][];

export function isCsvPath(filePath: string): boolean {
  return /\.csv$/i.test(filePath);
}

/** 读文件（csv 与 xlsx 两条路都要通——业务从 Excel 另存哪一种都不该被挡） */
export async function readSupplyParamsSheets(filePath: string): Promise<SheetData[]> {
  return isCsvPath(filePath)
    ? readCsvWorkbook(filePath, SKU_LEADTIME_SIMPLE_SHEET).sheets
    : (await readWorkbook(filePath)).sheets;
}

/** 找到含 `SKU编码` 且至少含一个周期列的表头行（任意页名——不再绑死供应商页名） */
export function findSupplyParamsHeader(sheets: SheetData[]): { sheet: SheetData; headerIdx: number } | null {
  for (const sheet of sheets) {
    const headerIdx = sheet.rows.findIndex(
      (r) => r != null
        && findCol(r, SUPPLY_PARAMS_CSV_KEY_HEADER) >= 0
        && LEAD_FIELDS.some(([, label]) => findCol(r, label) >= 0),
    );
    if (headerIdx >= 0) return { sheet, headerIdx };
  }
  return null;
}

export const skuLeadtimeSimpleAdapter: Adapter = async (filePath) => {
  const sheets = await readSupplyParamsSheets(filePath);
  const found = findSupplyParamsHeader(sheets);
  const rows: AdapterRow[] = [];
  const rejects: AdapterReject[] = [];
  const stats: Record<string, number> = { blankRows: 0, dataRows: 0, rejected: 0 };
  if (!found) {
    throw new Error(
      `未找到表头行（须含「${SUPPLY_PARAMS_CSV_KEY_HEADER}」与「${LEAD_FIELDS.map(([, l]) => l).join("/")}」中至少一列）: ${filePath}`,
    );
  }
  const { sheet, headerIdx } = found;
  const hdr = sheet.rows[headerIdx];
  const cSku = findCol(hdr, SUPPLY_PARAMS_CSV_KEY_HEADER);
  const cols = LEAD_FIELDS.map(([field, label]) => ({ field, label, idx: findCol(hdr, label) }));

  for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    if (isBlankRow(r)) continue;
    const code = cellToString(r[cSku]);
    if (code === SUPPLY_PARAMS_CSV_KEY_HEADER) continue; // 粘贴出来的重复表头
    if (code === null) {
      rejects.push({ rowNo: i + 1, sheet: sheet.name, reason: `缺少${SUPPLY_PARAMS_CSV_KEY_HEADER}`, raw: r.slice(0, 8) });
      continue;
    }
    const payload: Record<string, unknown> = { skuCode: code };
    let filled = 0;
    let bad: string | null = null;
    for (const c of cols) {
      if (c.idx < 0) continue;
      const raw = r[c.idx] ?? null;
      const n = toNumberTolerant(raw);
      if (n == null) continue;
      if (!Number.isInteger(n) || n < 0 || n > 365) {
        bad = `「${c.label}」须为 0–365 的整数天，实际「${String(raw)}」`;
        break;
      }
      payload[c.field] = n;
      filled++;
    }
    if (bad) {
      rejects.push({ rowNo: i + 1, sheet: sheet.name, reason: bad, raw: r.slice(0, 8) });
      continue;
    }
    if (filled === 0) {
      stats.blankRows += 1; // 只是这一行还没填，不是错误
      continue;
    }
    rows.push({ rowNo: i + 1, targetTable: SKU_LEADTIME_SIMPLE_TARGET, payload });
  }
  stats.dataRows = rows.length;
  stats.rejected = rejects.length;
  return { rows, rejects, stats };
};

/** 全链路：只解析 sku_code 别名（本模板不含供应商/仓库等其它维） */
export async function stageSkuLeadtimeSimple(
  db: AnyDb,
  filePath: string,
  userId: number,
): Promise<StageSummary> {
  return stagePipeline(db, {
    filePath,
    template: SKU_LEADTIME_SIMPLE_TEMPLATE,
    userId,
    adapter: skuLeadtimeSimpleAdapter,
    targetTable: SKU_LEADTIME_SIMPLE_TARGET,
    job: {
      sourceAsOf: null,
      schemaVersion: "sku-leadtime-simple-v1",
      scope: { mode: "partial", targets: ["sku_params"], sourceSection: SKU_LEADTIME_SIMPLE_SHEET },
    },
    aliasRefs: (row) => [{ field: "sku", aliasType: "sku_code", value: row.payload.skuCode as string | null }],
  });
}
