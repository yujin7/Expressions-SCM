/**
 * 适配器⑦：成品在途订单实时进度表（新版，11 工作表）→ staging(transit_ref)。
 *
 * 取用（D16 参考层口径——存量单旧流程收尾，只登记不入账）：
 * - 成品跟进表（全量登记：单号/数量/完工/入库/关单/进度）
 *   ⊕「成品」活动表按 钉钉审批号+商品编码 联查富化（预计入仓/异常/包材进度/需求交期）
 * - 包材跟进表（包材在途明细）
 * - 包材备货表（备料池：备货/使用/剩余）
 * - OEM供应商维护（成品→加工厂归属及有效期）
 * 弃用并记明（拒收道语义）：Sheet2=会议随笔、111=工作暂存表、下拉选项=词表
 * （订单进度词表与 04 §2.5 十一态一致，登记于 CURRENT 备注）；
 * 生产周期明细 → 既有 leadtime 适配器（sku_leadtime），另由 releaseFinishedMoq 取起订量。
 */
import { normalizeDateCell, readWorkbook, type CellValue, type SheetData } from "../parse/xlsx";
import { resolveReferenceAliases } from "../reference-aliases";
import {
  createImportJob,
  failImportJob,
  finalizeImportJob,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "../staging";

export const TRANSIT_TEMPLATE = "transit";
const TARGET_TABLE = "transit_ref";

const str = (v: CellValue): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: CellValue): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
};

function headerIndex(sheet: SheetData, mustContain: string[]): { hi: number; col: Map<string, number> } {
  const hi = sheet.rows.findIndex((r) =>
    mustContain.every((k) => r.some((c) => typeof c === "string" && c.replace(/\s/g, "").includes(k))),
  );
  if (hi < 0) throw new Error(`表头未找到（需含 ${mustContain.join("/")}）`);
  const col = new Map<string, number>();
  (sheet.rows[hi] ?? []).forEach((c, i) => {
    if (typeof c === "string") col.set(c.replace(/\s/g, ""), i);
  });
  return { hi, col };
}

export interface TransitPayload {
  kind: "fg_order" | "pkg_order" | "pkg_stock" | "oem_map" | "demand" | "borrow" | "pallet" | "npd_node" | "npd_role" | "stock_summary";
  brandRaw: string | null;
  skuCode: string | null;
  materialCode: string | null;
  materialName: string | null;
  oemRaw: string | null;
  externalNo: string | null;
  approvalNo: string | null;
  feishuNo: string | null;
  orderType: string | null;
  qty: number | null;
  doneQty: number | null;
  inboundQty: number | null;
  closedQty: number | null;
  usedQty: number | null;
  remainQty: number | null;
  orderDate: string | null;
  needDate: string | null;
  replyDate: string | null;
  revisedDate: string | null;
  expectDate: string | null;
  startDate: string | null;
  progress: string | null;
  urgentDept: string | null;
  follower: string | null;
  exception: string | null;
  extra: Record<string, unknown> | null;
}

const empty = (): Omit<TransitPayload, "kind"> => ({
  brandRaw: null, skuCode: null, materialCode: null, materialName: null, oemRaw: null,
  externalNo: null, approvalNo: null, feishuNo: null, orderType: null,
  qty: null, doneQty: null, inboundQty: null, closedQty: null, usedQty: null, remainQty: null,
  orderDate: null, needDate: null, replyDate: null, revisedDate: null, expectDate: null, startDate: null,
  progress: null, urgentDept: null, follower: null, exception: null, extra: null,
});

export interface TransitParseResult {
  rows: StagingRowInput[];
  stats: Record<string, number>;
}

export function parseTransitWorkbook(sheets: SheetData[]): TransitParseResult {
  const rows: StagingRowInput[] = [];
  const stats: Record<string, number> = { fg_order: 0, pkg_order: 0, pkg_stock: 0, oem_map: 0, skipped: 0 };
  let rowNo = 0;
  const bySheet = new Map(sheets.map((s) => [s.name.trim(), s]));

  /* ── 「成品」活动表 → 富化索引（钉钉审批号|商品编码 → 补充字段） ── */
  const enrich = new Map<string, Partial<TransitPayload>>();
  const active = bySheet.get("成品");
  if (active) {
    const { hi, col } = headerIndex(active, ["商品编码", "订单数量"]);
    const c = (k: string) => col.get(k) ?? -1;
    for (let i = hi + 1; i < active.rows.length; i++) {
      const r = active.rows[i] ?? [];
      const sku = str(r[c("商品编码")]);
      if (!sku) continue;
      const key = `${str(r[c("钉钉审批号")]) ?? ""}|${sku}`;
      enrich.set(key, {
        expectDate: normalizeDateCell(r[c("预计入仓时间")] ?? null),
        needDate: normalizeDateCell(r[c("运营需求交期")] ?? null),
        exception: str(r[c("异常情况")]),
        extra: { 包材进度: str(r[c("包材进度")]), 紧急需求部门: str(r[c("紧急需求部门")]) },
        urgentDept: str(r[c("紧急需求部门")]),
      });
    }
  }

  /* ── 成品跟进表 → fg_order ── */
  const fg = bySheet.get("成品跟进表");
  if (fg) {
    const { hi, col } = headerIndex(fg, ["商品编码", "订单数量", "订单实时进度"]);
    const c = (k: string) => col.get(k) ?? -1;
    for (let i = hi + 1; i < fg.rows.length; i++) {
      const r = fg.rows[i] ?? [];
      const sku = str(r[c("商品编码")]);
      const qty = num(r[c("订单数量")]);
      if (!sku && qty == null) continue;
      if (!sku) { stats.skipped++; continue; }
      const approvalNo = str(r[c("钉钉审批号")]);
      const e = enrich.get(`${approvalNo ?? ""}|${sku}`) ?? {};
      const p: TransitPayload = {
        ...empty(),
        kind: "fg_order",
        brandRaw: str(r[c("品牌")]),
        skuCode: sku,
        materialName: str(r[c("物料名称")]),
        oemRaw: str(r[c("OEM")]),
        externalNo: str(r[c("用友订单号")]),
        approvalNo,
        orderType: str(r[c("订单类型")]),
        qty,
        doneQty: num(r[c("已完工数")]),
        inboundQty: num(r[c("已入库数")]),
        closedQty: num(r[c("关单数量")]),
        orderDate: normalizeDateCell(r[c("运营下单日期")] ?? null),
        progress: str(r[c("订单实时进度")]),
        urgentDept: str(r[c("紧急需求部门")]),
        ...e,
        extra: {
          未完工数量: num(r[c("未完工数量")]),
          未入库数: num(r[c("未入库数")]),
          订单完成率: str(r[c("订单完成率")]),
          紧急标识: str(r[c("紧急标识")]),
          ...(e.extra ?? {}),
        },
      };
      rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
      stats.fg_order++;
    }
  }

  /* ── 包材跟进表 → pkg_order ── */
  const pkg = bySheet.get("包材跟进表");
  if (pkg) {
    const { hi, col } = headerIndex(pkg, ["物料编码", "下单数量"]);
    const c = (k: string) => col.get(k) ?? -1;
    for (let i = hi + 1; i < pkg.rows.length; i++) {
      const r = pkg.rows[i] ?? [];
      const mat = str(r[c("物料编码")]);
      if (!mat) continue;
      const p: TransitPayload = {
        ...empty(),
        kind: "pkg_order",
        brandRaw: str(r[c("品牌")]),
        skuCode: str(r[c("成品编码")]),
        materialCode: mat,
        materialName: str(r[c("物料名称")]),
        oemRaw: str(r[c("供应商")]),
        externalNo: str(r[c("用友订单号")]),
        feishuNo: str(r[c("飞书订单编号")]),
        orderType: str(r[c("首单or返单")]),
        qty: num(r[c("下单数量")]),
        orderDate: normalizeDateCell(r[c("运营下单日期")] ?? null),
        needDate: normalizeDateCell(r[c("需求交货日期")] ?? null),
        replyDate: normalizeDateCell(r[c("采购回复交期")] ?? r[c("回复交期")] ?? null),
        revisedDate: normalizeDateCell(r[c("采购二次修改")] ?? null),
        follower: str(r[c("跟进人")]),
        exception: str(r[c("异常原因")]),
        extra: { 类型: str(r[c("类型")]), 剩余交货天数: num(r[c("剩余交货天数")]) },
      };
      rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
      stats.pkg_order++;
    }
  }

  /* ── 包材备货表 → pkg_stock ── */
  const stock = bySheet.get("包材备货表");
  if (stock) {
    const { hi, col } = headerIndex(stock, ["物料编码", "备货数量"]);
    const c = (k: string) => col.get(k) ?? -1;
    for (let i = hi + 1; i < stock.rows.length; i++) {
      const r = stock.rows[i] ?? [];
      const mat = str(r[c("物料编码")]);
      if (!mat) continue;
      const p: TransitPayload = {
        ...empty(),
        kind: "pkg_stock",
        brandRaw: str(r[c("品牌")]),
        skuCode: str(r[c("成品编码")]),
        materialCode: mat,
        materialName: str(r[c("物料名称")]),
        approvalNo: str(r[c("审批单号")]),
        qty: num(r[c("备货数量")]),
        usedQty: num(r[c("使用数量")]),
        remainQty: num(r[c("剩余数量")]),
        orderDate: normalizeDateCell(r[c("运营下单日期")] ?? null),
        expectDate: normalizeDateCell(r[c("成品使用时间")] ?? null),
        follower: str(r[c("备货部门")]),
        extra: { 用于成品订单号: str(r[c("用于成品订单号")]), 备注: str(r[c("备注")]) },
      };
      rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
      stats.pkg_stock++;
    }
  }

  /* ── OEM供应商维护 → oem_map ── */
  const oem = bySheet.get("OEM供应商维护");
  if (oem) {
    const { hi, col } = headerIndex(oem, ["成品编码", "加工厂"]);
    const c = (k: string) => col.get(k) ?? -1;
    for (let i = hi + 1; i < oem.rows.length; i++) {
      const r = oem.rows[i] ?? [];
      const sku = str(r[c("成品编码")]);
      const factory = str(r[c("加工厂")]);
      if (!sku || !factory) continue;
      const p: TransitPayload = {
        ...empty(),
        kind: "oem_map",
        skuCode: sku,
        materialName: str(r[c("成品名称")]),
        oemRaw: factory,
        startDate: normalizeDateCell(r[c("开始时间")] ?? null),
        expectDate: normalizeDateCell(r[c("结束时间")] ?? null),
        extra: { 规格: str(r[c("规格")]) },
      };
      rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
      stats.oem_map++;
    }
  }

  return { rows, stats };
}

/** 全链路：createImportJob（幂等 supersede）→ 解析 → staging → finalize */
export async function stageTransit(db: AnyDb, filePath: string, userId: number) {
  const wb = await readWorkbook(filePath);
  const { rows, stats } = parseTransitWorkbook(wb.sheets);
  if (rows.length === 0) throw new Error("在途文件未解析到任何成品、包材、备货或 OEM 映射行");
  const job = await createImportJob(db, { template: TRANSIT_TEMPLATE, filePath, createdBy: userId });
  try {
    const aliased = await resolveReferenceAliases(db, {
      filePath,
      template: TRANSIT_TEMPLATE,
      rows,
      aliasRefs: (row) => {
        const p = row.payload as TransitPayload;
        return [
          { field: "brand", aliasType: "brand", value: p.brandRaw },
          { field: "sku", aliasType: "sku_code", value: p.skuCode },
          { field: "materialSku", aliasType: "sku_code", value: p.materialCode },
          { field: "supplier", aliasType: "supplier_oem", value: p.oemRaw },
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
