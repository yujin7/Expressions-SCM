/**
 * 适配器②：7月电商组效期占比情况-仅数量 → batch_stock（《04》§2.9 批次库存参考层）。
 * 每明细页（跳过「汇总」）：真实表头在行下标 2，列位跨页漂移——一律按表头名定位；
 * 数量列 = 盘点后数量；全部日期经 normalizeDateCell（四种编码并存，逐格判断）。
 * 复核基准：6 明细页；保质期天数有值 ~3,131 行，其中 ≥99% = 1095。
 *
 * 行分类：整行空 → 静默跳过；仅「盘点所属期间/截止日期」有值（公式下拉残留）→
 * 视同空行跳过（skippedFillDown 计数）；有业务内容但缺编码或数量 → 拒收。
 */
import { normalizeDateCell, readWorkbook } from "../parse/xlsx";
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

const TARGET_TABLE = "batch_stock";
export const EXPIRY_TEMPLATE = "expiry_batch_202607";

/** 表头搜索深度：真实表头位于行下标 2，防御性地在前 6 行内找 */
const HEADER_SCAN_ROWS = 6;

export const expiryAdapter: Adapter = async (filePath) => {
  const wb = await readWorkbook(filePath);
  const detailSheets = wb.sheets.filter((s) => !s.name.includes("汇总"));

  const rows: AdapterRow[] = [];
  const rejects: AdapterReject[] = [];
  let blankSkipped = 0;
  let fillDownSkipped = 0;
  let shelfLifePopulated = 0;
  let shelfLife1095 = 0;

  for (const sheet of detailSheets) {
    const headerIdx = sheet.rows
      .slice(0, HEADER_SCAN_ROWS)
      .findIndex((r) => r != null && findCol(r, "商品编码") >= 0 && findCol(r, "盘点后数量") >= 0);
    if (headerIdx < 0) {
      rejects.push({ rowNo: 0, sheet: sheet.name, reason: "未找到表头行（商品编码/盘点后数量）", raw: null });
      continue;
    }
    const hdr = sheet.rows[headerIdx];
    const cStocktake = findCol(hdr, "盘点所属期间");
    const cOperator = findCol(hdr, "操作仓储方");
    const cBrand = findCol(hdr, "品牌");
    const cSku = findCol(hdr, "商品编码");
    const cName = findCol(hdr, "商品名称");
    const cProd = findCol(hdr, "生产日期");
    const cExpiry = findCol(hdr, "有效期至");
    const cShelf = findCol(hdr, "产品保质期天数");
    const cQty = findCol(hdr, "盘点后数量");

    for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
      const r = sheet.rows[i] ?? [];
      const rowNo = i + 1;
      if (isBlankRow(r)) {
        blankSkipped++;
        continue;
      }
      const operatorRaw = cellToString(r[cOperator]);
      const brand = cellToString(r[cBrand]);
      const skuCode = cellToString(r[cSku]);
      const skuName = cellToString(r[cName]);
      const prodDate = normalizeDateCell(r[cProd] ?? null);
      const expiryDate = normalizeDateCell(r[cExpiry] ?? null);
      const qty = toNumberTolerant(r[cQty] ?? null);
      // 公式下拉残留：业务字段全空（只剩盘点期间/截止日期等派生列）→ 视同空行
      if (operatorRaw === null && brand === null && skuCode === null && skuName === null
        && prodDate === null && expiryDate === null && qty === null) {
        fillDownSkipped++;
        continue;
      }
      if (skuCode === null || qty === null) {
        rejects.push({
          rowNo,
          sheet: sheet.name,
          reason: "缺少商品编码或盘点后数量",
          raw: { operatorRaw, brand, skuCode, skuName, qty: r[cQty] ?? null },
        });
        continue;
      }
      const shelfLifeDays = toNumberTolerant(r[cShelf] ?? null);
      if (shelfLifeDays !== null) {
        shelfLifePopulated++;
        if (shelfLifeDays === 1095) shelfLife1095++;
      }
      rows.push({
        rowNo,
        targetTable: TARGET_TABLE,
        payload: {
          sheetWarehouse: sheet.name,
          operatorRaw,
          brand,
          skuCode,
          skuName,
          prodDate,
          expiryDate,
          shelfLifeDays,
          qty,
          stocktakeDate: normalizeDateCell(r[cStocktake] ?? null),
        },
      });
    }
  }

  return {
    rows,
    rejects,
    stats: {
      detailSheets: detailSheets.length,
      dataRows: rows.length,
      rejected: rejects.length,
      blankSkipped,
      fillDownSkipped,
      shelfLifePopulated,
      shelfLife1095,
    },
  };
};

/** 全链路：别名解析 sku_code + warehouse（以页名为仓库别名，如「天猫保税仓」） */
export async function stageExpiry(db: AnyDb, filePath: string, userId: number): Promise<StageSummary> {
  return stagePipeline(db, {
    filePath,
    template: EXPIRY_TEMPLATE,
    userId,
    adapter: expiryAdapter,
    targetTable: TARGET_TABLE,
    job: {
      sourceAsOf: "2026-07-21",
      schemaVersion: "expiry-batch-v2",
      scope: { mode: "full", target: "batch_stocks", stocktakePeriod: "2026-07" },
    },
    aliasRefs: (row) => [
      { field: "warehouse", aliasType: "warehouse", value: row.payload.sheetWarehouse as string | null },
      { field: "sku", aliasType: "sku_code", value: row.payload.skuCode as string | null },
    ],
  });
}
