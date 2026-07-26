/**
 * 适配器⑧：业务部需求&计划&达成统计表（月度）→ staging(transit_ref)。
 *
 * 通道：强制原生 OOXML（共享公式重的工作簿，exceljs 丢缓存值——RT 实测）。
 * 取用（参考层口径）：
 * - 库存明细：SKU×渠道 需求/期初/期末/销售达成（全 744 行字面值）→ kind='demand'
 *   ⚠ 总需求/达成率/动销率/采购量列为未缓存公式——不落库不造数；达成率由前端按 达成/需求 现算
 * - 借入/借出（透视导出）：SKU×对方部门 数量 → kind='borrow'（orderType=借入/借出）
 *   ——R16 上线前的历史借调，供 /report/jiediao 历史页签对账衔接
 * 弃用记明：数据汇总（纯公式透视，全部可由明细推导）、入库（期初快照已覆盖该期间末态）
 * 月份归属：文件名「N月份」推导 → progress='YYYY-MM'（缺省当年）。
 */
import path from "node:path";
import { readWorkbook, type CellValue, type SheetData } from "../parse/xlsx";
import { createImportJob, finalizeImportJob, writeStagingRows, type AnyDb, type StagingRowInput } from "../staging";
import type { TransitPayload } from "./transit";

export const DEMAND_TEMPLATE = "demand";
const TARGET_TABLE = "transit_ref";

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

/** 「6月份业务部需求…」→ '2026-06'（年缺省=当前系统年——文件历来只写月份） */
export function monthFromFilename(filePath: string, nowYear: number): string {
  const m = path.basename(filePath).match(/(\d{1,2})\s*月/);
  const mm = m ? String(Number(m[1])).padStart(2, "0") : "01";
  return `${nowYear}-${mm}`;
}

export interface DemandParseResult {
  rows: StagingRowInput[];
  stats: Record<string, number>;
}

export function parseDemandWorkbook(sheets: SheetData[], yearMonth: string): DemandParseResult {
  const rows: StagingRowInput[] = [];
  const stats: Record<string, number> = { demand: 0, borrow_in: 0, borrow_out: 0, skuRows: 0 };
  let rowNo = 0;
  const bySheet = new Map(sheets.map((s) => [s.name.trim(), s]));

  /* ── 库存明细 → demand（SKU×渠道） ── */
  const inv = bySheet.get("库存明细");
  if (inv) {
    const r0 = inv.rows[0] ?? [];
    // 渠道组起点 = 行0 从第12列起的命名单元格（末组「期末结余库存数量」非渠道，排除）
    const groups: { name: string; col: number }[] = [];
    r0.forEach((c, i) => {
      const name = i >= 12 ? str(c) : null;
      if (name && !name.includes("期末结余")) groups.push({ name, col: i });
    });
    for (let r = 2; r < inv.rows.length; r++) {
      const row = inv.rows[r] ?? [];
      const sku = str(row[2]);
      if (!sku || sku === "产品编码") continue;
      if (str(row[0]) === "合计") continue;
      stats.skuRows++;
      const brand = str(row[0]);
      const ptype = str(row[1]);
      const name = str(row[3]);
      const maySales = num(row[5]);
      for (const g of groups) {
        const demand = num(row[g.col]) ?? 0;
        const opening = num(row[g.col + 1]) ?? 0;
        const closing = num(row[g.col + 2]) ?? 0;
        const achieved = num(row[g.col + 6]) ?? 0;
        if (demand === 0 && opening === 0 && closing === 0 && achieved === 0) continue;
        const p: TransitPayload = {
          ...emptyPayload(),
          kind: "demand" as TransitPayload["kind"],
          brandRaw: brand,
          skuCode: sku,
          materialName: name,
          orderType: ptype,
          qty: demand,
          doneQty: achieved,
          remainQty: closing,
          usedQty: opening, // 语义映射：usedQty 槽位承载「期初」——列注见 UI
          follower: g.name, // 渠道
          progress: yearMonth,
          extra: { 五月销量: maySales },
        };
        rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
        stats.demand++;
      }
    }
  }

  /* ── 借入 / 借出（透视：行=SKU，列=对方部门） ── */
  const parseBorrow = (sheetName: string, direction: "借入" | "借出", counterLabel: string) => {
    const sh = bySheet.get(sheetName);
    if (!sh) return;
    const hi = sh.rows.findIndex((r) => r.some((c) => typeof c === "string" && c.includes("商品编码")));
    if (hi < 0) return;
    const hdr = sh.rows[hi] ?? [];
    // 对方部门列 = 表头行中除 商品编码/总计/(空白) 之外的命名列（透视右侧可能拖尾公式列——列名重复时取首段）
    const seen = new Set<string>();
    const deptCols: { name: string; col: number }[] = [];
    hdr.forEach((c, i) => {
      const name = str(c);
      if (!name || i === 0) return;
      if (name.includes("总计") || name.includes("空白") || name === "商品编码") return;
      if (seen.has(name)) return; // 拖尾重复段不取
      seen.add(name);
      deptCols.push({ name, col: i });
    });
    for (let r = hi + 1; r < sh.rows.length; r++) {
      const row = sh.rows[r] ?? [];
      const sku = str(row[0]);
      if (!sku || sku === "总计") continue;
      for (const d of deptCols) {
        const qty = num(row[d.col]);
        if (qty == null || qty === 0) continue;
        const p: TransitPayload = {
          ...emptyPayload(),
          kind: "borrow" as TransitPayload["kind"],
          skuCode: sku,
          orderType: direction,
          qty,
          follower: d.name, // 对方部门
          progress: yearMonth,
          extra: { 对方字段: counterLabel },
        };
        rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
        if (direction === "借入") stats.borrow_in++;
        else stats.borrow_out++;
      }
    }
  };
  parseBorrow("借入", "借入", "借货部门");
  parseBorrow("借出", "借出", "借货来源");

  return { rows, stats };
}

/** 全链路（幂等 supersede）；forceRaw 通道 */
export async function stageDemand(db: AnyDb, filePath: string, userId: number) {
  const wb = await readWorkbook(filePath, { forceRaw: true });
  const ym = monthFromFilename(filePath, new Date().getFullYear());
  const { rows, stats } = parseDemandWorkbook(wb.sheets, ym);
  const job = await createImportJob(db, { template: DEMAND_TEMPLATE, filePath, createdBy: userId });
  await writeStagingRows(db, job.id, rows);
  await finalizeImportJob(db, job.id, { okRows: rows.length, failRows: 0 });
  return { jobId: job.id, stats: { ...stats, stagedRows: rows.length, yearMonth: ym } };
}
