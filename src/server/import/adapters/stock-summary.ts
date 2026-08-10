/**
 * 适配器⑪：总库存明细（宽表汇总）→ staging(transit_ref, kind='stock_summary')。
 * 口径：与「电商部库存明细」同日（期初权威源已过账）——本表**只作核对参考**，绝不二次入账；
 * 独有价值：已下单未出货（在订）、总日均销量、条形码核对。渠道块与快照重叠，不重复登记。
 */
import { readWorkbook, type CellValue, type SheetData } from "../parse/xlsx";
import { resolveReferenceAliases } from "../reference-aliases";
import {
  createImportJob,
  failImportJob,
  finalizeImportJob,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "../staging";
import type { TransitPayload } from "./transit";

export const STOCK_SUMMARY_TEMPLATE = "stock_summary";
const TARGET_TABLE = "transit_ref";
/**
 * 最初那份「总库存明细2026-7-21.xlsx」的业务时点。
 * **只用于一次性回填脚本**（load-npd-stock），不再作为上传路径的默认值——
 * 业务自助重传若被盖上这个日期，month-close 会把新数据算进 2026-07 的月结。
 */
export const STOCK_SUMMARY_AS_OF = "2026-07-21";

const str = (v: CellValue): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: CellValue): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseStockSummarySheet(sheet: SheetData, asOf: string | null = null): StagingRowInput[] {
  const hi = sheet.rows.findIndex((r) => r.some((c) => typeof c === "string" && String(c).includes("商家编码")));
  if (hi < 0) throw new Error("总库存文件未找到表头行（商家编码）");
  const col = new Map<string, number>();
  (sheet.rows[hi] ?? []).forEach((c, i) => { if (typeof c === "string") col.set(String(c).replace(/\s/g, ""), i); });
  const c = (k: string) => col.get(k) ?? -1;
  const rows: StagingRowInput[] = [];
  let rowNo = 0;
  for (let i = hi + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    const sku = str(r[c("商家编码")]);
    if (!sku) continue;
    const p: TransitPayload = {
      kind: "stock_summary" as TransitPayload["kind"],
      brandRaw: null,
      skuCode: sku,
      materialCode: null,
      materialName: str(r[c("货品名称")]),
      oemRaw: null,
      externalNo: str(r[c("条形码")]),
      approvalNo: null,
      feishuNo: null,
      orderType: str(r[c("产品类型")]),
      qty: num(r[c("商品数量")]),
      doneQty: null,
      inboundQty: num(r[c("已下单未出货")]), // 在订未出（独有）
      closedQty: null,
      usedQty: null,
      remainQty: null,
      orderDate: null, needDate: null, replyDate: null, revisedDate: null, expectDate: null, startDate: null,
      progress: asOf,
      urgentDept: null,
      follower: null,
      exception: null,
      extra: { 总日均销量: num(r[c("总日均销量")]), 总计划可销天数: num(r[c("总计划可销天数")]) },
    };
    rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
  }
  return rows;
}

/**
 * `asOf` 是这份文件反映的业务时点：一次性回填脚本显式传，
 * 上传路径不传（null），由 month-close 回落 createdAt。理由同其余适配器。
 * 注意 `progress` 也用同一时点——它标的是这批总库存快照对应的期次。
 */
export async function stageStockSummary(
  db: AnyDb,
  filePath: string,
  userId: number,
  asOf: string | null = null,
) {
  const wb = await readWorkbook(filePath, { forceRaw: true });
  const rows = parseStockSummarySheet(wb.sheets[0], asOf);
  if (rows.length === 0) throw new Error("总库存文件未解析到任何 SKU 行");
  const job = await createImportJob(db, {
    template: STOCK_SUMMARY_TEMPLATE,
    filePath,
    createdBy: userId,
    sourceAsOf: asOf,
    scope: { mode: "full", targetKinds: ["stock_summary"] },
  });
  try {
    const aliased = await resolveReferenceAliases(db, {
      filePath,
      template: STOCK_SUMMARY_TEMPLATE,
      rows,
      aliasRefs: (row) => {
        const p = row.payload as TransitPayload;
        return [
          { field: "sku", aliasType: "sku_code", value: p.skuCode },
        ];
      },
    });
    await writeStagingRows(db, job.id, aliased.rows);
    await finalizeImportJob(db, job.id, { okRows: rows.length, failRows: 0, controlRows: rows.length });
    return {
      jobId: job.id,
      stats: {
        stagedRows: rows.length,
        aliasValidated: aliased.validated,
        aliasPending: aliased.pending,
        unresolved: aliased.unresolved,
      },
    };
  } catch (error) {
    await failImportJob(db, job.id, TARGET_TABLE, error);
    throw error;
  }
}
