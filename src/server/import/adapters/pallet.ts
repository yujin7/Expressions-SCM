/**
 * 适配器⑨：总货盘情况表-PMC（月度）→ staging(transit_ref, kind='pallet')。
 *
 * 取用（参考层）：八张品牌页逐 SKU——当前库存/月销量合计/近三月日均销/可销天数/
 * 是否滞销/备注（处置注记：过期待报废/临期禁售/商务库存……R14 备注字典的唯一数据源）。
 * 弃用记明：成本单价（大量空缺且 D2 成本引擎未定，落库会污染参考口径——不造数）、
 * 单品总金额（依赖成本价）、汇总页（公式透视）、往期数据（历史工作稿）、隐藏页（工作副本）。
 * 文件公式列多未缓存 → forceRaw 通道；月份自文件名推导。
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
import { monthEnd, monthFromFilename } from "./demand";
import type { TransitPayload } from "./transit";

export const PALLET_TEMPLATE = "pallet";
const TARGET_TABLE = "transit_ref";

const BRAND_SHEETS: Record<string, string> = {
  NING: "NING",
  EXPRESSIONS: "EXPRESSIONS",
  DEVIANCE: "DEVIANCE",
  BORN2FLY: "BORN2FLY",
  国内品牌LYUV: "LYUV",
  国内品牌爱碧生: "爱碧生",
  国内品牌黛雯丝: "黛雯丝",
  微初: "微初",
};

const str = (v: CellValue): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: CellValue): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const emptyPayload = (): Omit<TransitPayload, "kind"> => ({
  brandRaw: null, skuCode: null, materialCode: null, materialName: null, oemRaw: null,
  externalNo: null, approvalNo: null, feishuNo: null, orderType: null,
  qty: null, doneQty: null, inboundQty: null, closedQty: null, usedQty: null, remainQty: null,
  orderDate: null, needDate: null, replyDate: null, revisedDate: null, expectDate: null, startDate: null,
  progress: null, urgentDept: null, follower: null, exception: null, extra: null,
});

export interface PalletParseResult {
  rows: StagingRowInput[];
  stats: Record<string, number>;
}

export function parsePalletWorkbook(sheets: SheetData[], yearMonth: string): PalletParseResult {
  const rows: StagingRowInput[] = [];
  const stats: Record<string, number> = { pallet: 0, brands: 0, withRemark: 0 };
  let rowNo = 0;

  for (const sh of sheets) {
    const brand = BRAND_SHEETS[sh.name.trim()];
    if (!brand || sh.hidden) continue;
    // 双行表头：r0 主列（货品编号/货品名称/当前库存/成本单价…），r1 副列（各渠道/合计/日均/可销/滞销/备注）
    const hi = sh.rows.findIndex((r) => r.some((c) => typeof c === "string" && String(c).includes("货品编号")));
    if (hi < 0) continue;
    const h0 = sh.rows[hi] ?? [];
    const h1 = sh.rows[hi + 1] ?? [];
    const col = new Map<string, number>();
    const put = (c: CellValue, i: number) => {
      if (typeof c === "string") {
        const k = c.replace(/\s/g, "");
        if (k && !col.has(k)) col.set(k, i);
      }
    };
    h0.forEach(put);
    h1.forEach(put);
    const c = (...keys: string[]): number => {
      for (const k of keys) {
        const i = col.get(k);
        if (i != null) return i;
      }
      return -1;
    };
    const cCode = c("货品编号");
    const cName = c("货品名称");
    const cStock = c("当前库存");
    const cSales = c("6月销量合计", "6月总销量", "6月销量", "总销量");
    const cDaily = c("近三月日均销");
    const cDays = c("可销天数");
    const cSlow = c("是否滞销");
    const cRemark = c("备注");
    stats.brands++;

    for (let i = hi + 2; i < sh.rows.length; i++) {
      const r = sh.rows[i] ?? [];
      const code = str(r[cCode]);
      if (!code || code.includes("合计")) continue;
      const stock = num(r[cStock]);
      const sales = num(r[cSales]);
      const remark = cRemark >= 0 ? str(r[cRemark]) : null;
      if (stock == null && sales == null && !remark) continue;
      const p: TransitPayload = {
        ...emptyPayload(),
        kind: "pallet" as TransitPayload["kind"],
        brandRaw: brand,
        skuCode: code,
        materialName: str(r[cName]),
        qty: stock,
        doneQty: sales,
        progress: yearMonth,
        exception: remark, // 处置注记（过期待报废/临期禁售/商务库存…）
        extra: {
          近三月日均销: cDaily >= 0 ? num(r[cDaily]) : null,
          可销天数_文件口径: cDays >= 0 ? num(r[cDays]) : null,
          是否滞销_文件口径: cSlow >= 0 ? str(r[cSlow]) : null,
        },
      };
      rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
      stats.pallet++;
      if (remark) stats.withRemark++;
    }
  }
  return { rows, stats };
}

export async function stagePallet(db: AnyDb, filePath: string, userId: number) {
  const wb = await readWorkbook(filePath, { forceRaw: true });
  const ym = monthFromFilename(filePath, new Date().getFullYear());
  const { rows, stats } = parsePalletWorkbook(wb.sheets, ym);
  if (rows.length === 0) throw new Error("货盘文件未解析到任何品牌 SKU 行");
  const job = await createImportJob(db, {
    template: PALLET_TEMPLATE,
    filePath,
    createdBy: userId,
    sourceAsOf: monthEnd(ym),
    scope: { mode: "full", targetKinds: ["pallet"], yearMonth: ym },
  });
  try {
    const aliased = await resolveReferenceAliases(db, {
      filePath,
      template: PALLET_TEMPLATE,
      rows,
      aliasRefs: (row) => {
        const p = row.payload as TransitPayload;
        return [
          { field: "brand", aliasType: "brand", value: p.brandRaw },
          { field: "sku", aliasType: "sku_code", value: p.skuCode },
        ];
      },
    });
    await writeStagingRows(db, job.id, aliased.rows);
    await finalizeImportJob(db, job.id, { okRows: rows.length, failRows: 0, controlRows: rows.length });
    return {
      jobId: job.id,
      stats: {
        ...stats,
        stagedRows: rows.length,
        yearMonth: ym,
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
