/**
 * 适配器①：电商部库存明细（7-21数据源 长表）→ stock_opening_candidate（《04》§5 期初权威来源）。
 * 结构：表头在第 2 行（仓库|品牌|商家编码|商品名称|商品数量，B–F 列），数据自第 3 行。
 * 复核基准：3,473 行 / 15 仓；绍兴令时达保税仓（综合）=867、菜鸟仓-保税仓=586。
 */
import { readWorkbook } from "../parse/xlsx";
import {
  cellToString,
  findCol,
  stagePipeline,
  type Adapter,
  type AdapterReject,
  type AdapterRow,
  type StageSummary,
} from "./types";
import type { AnyDb } from "../staging";

const SHEET_NAME = "7-21数据源";
const TARGET_TABLE = "stock_opening_candidate";
export const INVENTORY_LONG_TEMPLATE = "inventory_long_721";

export const inventoryLongAdapter: Adapter = async (filePath) => {
  const wb = await readWorkbook(filePath);
  const sheet = wb.sheets.find((s) => s.name.trim() === SHEET_NAME);
  if (!sheet) throw new Error(`未找到工作表「${SHEET_NAME}」: ${filePath}`);

  // 防御式定位表头（基准：行下标 1），列按名映射
  const headerIdx = sheet.rows.findIndex(
    (r) => r != null && findCol(r, "仓库") >= 0 && findCol(r, "商家编码") >= 0,
  );
  if (headerIdx < 0) throw new Error(`「${SHEET_NAME}」未找到表头行（仓库/商家编码）`);
  const hdr = sheet.rows[headerIdx];
  const cWh = findCol(hdr, "仓库");
  const cBrand = findCol(hdr, "品牌");
  const cSku = findCol(hdr, "商家编码");
  const cName = findCol(hdr, "商品名称");
  const cQty = findCol(hdr, "商品数量");
  if (cQty < 0) throw new Error(`「${SHEET_NAME}」表头缺少「商品数量」列`);

  const rows: AdapterRow[] = [];
  const rejects: AdapterReject[] = [];
  const warehouses = new Set<string>();
  let blankSkipped = 0;

  for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    const rowNo = i + 1; // Excel 1-based 行号，便于人工回查
    const picked = [r[cWh], r[cBrand], r[cSku], r[cName], r[cQty]];
    if (picked.every((c) => c == null)) {
      blankSkipped++;
      continue;
    }
    const warehouseRaw = cellToString(r[cWh]);
    const skuCode = cellToString(r[cSku]);
    const qtyRaw = r[cQty];
    if (warehouseRaw === null || skuCode === null) {
      rejects.push({ rowNo, sheet: SHEET_NAME, reason: "缺少仓库或商家编码", raw: picked });
      continue;
    }
    if (typeof qtyRaw !== "number" || !Number.isFinite(qtyRaw) || qtyRaw < 0) {
      rejects.push({ rowNo, sheet: SHEET_NAME, reason: "商品数量非法（须为 ≥0 数值）", raw: picked });
      continue;
    }
    warehouses.add(warehouseRaw);
    rows.push({
      rowNo,
      targetTable: TARGET_TABLE,
      payload: {
        warehouseRaw,
        brandRaw: cellToString(r[cBrand]),
        skuCode,
        skuName: cellToString(r[cName]),
        qty: qtyRaw,
      },
    });
  }

  return {
    rows,
    rejects,
    stats: {
      dataRows: rows.length,
      rejected: rejects.length,
      blankSkipped,
      distinctWarehouses: warehouses.size,
    },
  };
};

/** 全链路：createImportJob → 解析 → 别名解析（warehouse/sku_code）→ staging → finalize */
/**
 * `sourceAsOf` 是**这份文件反映的业务时点**，不是代码写死的常量。
 *
 * 事故背景（2026-08-04）：这里原本硬编码 "2026-07-21"——那是最初一次性导入的那份文件的日期。
 * 但本函数同时被 `/api/import/upload`（业务自助上传）调用，于是**以后每次重传都会被
 * 盖上同一个过去的日期**：9 月传的库存会被记成 7 月的。后果不只是显示不准——
 * `month-close.ts` 正是按 sourceAsOf 做月份区间过滤，数据会进错月份的结账证据。
 *
 * 现在改为参数：一次性回填脚本显式传历史日期；上传路径不传，
 * 留 null 由 `month-close` 按既有约定回落 createdAt（真实上传时刻），
 * 宁可"没有声明源时点"，也不要"声明一个错的"。
 */
export async function stageInventoryLong(
  db: AnyDb,
  filePath: string,
  userId: number,
  sourceAsOf: string | null = null,
): Promise<StageSummary> {
  return stagePipeline(db, {
    filePath,
    template: INVENTORY_LONG_TEMPLATE,
    userId,
    adapter: inventoryLongAdapter,
    targetTable: TARGET_TABLE,
    job: {
      sourceAsOf,
      schemaVersion: "inventory-long-v2",
      scope: { mode: "full", target: "stock_snapshots", sourceSheet: SHEET_NAME },
    },
    aliasRefs: (row) => [
      { field: "warehouse", aliasType: "warehouse", value: row.payload.warehouseRaw as string | null },
      { field: "sku", aliasType: "sku_code", value: row.payload.skuCode as string | null },
    ],
  });
}
