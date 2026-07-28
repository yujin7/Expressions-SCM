/**
 * 「未结供给」（open supply lines）唯一权威（E8-03——终结"在途"四套口径散落四处）。
 *
 * 纪律：全系统"在途/在制/要来的货"必须走本模块装配（补货建议、库存曲线、齐套、未来的调拨），
 * 消费方禁止本地重实现四段 join（口径漂移根因，同 core/velocity 的约束）。
 * 本模块纯装配、只读：不做建议、不写库、不判断够不够。
 *
 * ── 四种来源与信任层级 ──
 * 【记账层单据】——系统内开立、有状态机与审批留痕，可直接驱动决策：
 *  1) po        采购在途：po_lines 未收量 = qty×uomFactor − receivedQty（基础单位），
 *               仅 po_docs.status ∈ (approved, in_progress)；**逐行下限 0**（超收/收满行跳过，
 *               绝不与同 SKU 其他行轧差——与 CLAUDE.md「R5 禁止跨物料/跨行轧差」同纪律）。
 *               到货日：优先 po_lines.expected_date（func#11 供应商按行回交期），
 *               回退 po_docs.expected_date（头交期），皆无则 null。
 *  2) wo        在制委外产出：wo_docs 计划产出 qty，仅 status ∈ (approved, in_progress) 且 is_paused=false
 *               （暂停单不算供给）。到货日取 due_date；无则 null。
 *               口径诚实：以 WO 计划量计，未净部分批已收 → in_progress 单残余会高估（同 func#1 列注）。
 * 【参考层登记】——外部台账导入（transit_refs，只读登记、绝不入账），仅供人工参考、不应单独驱动开单：
 *  3) legacy_fg 存量单在途：transit_refs kind=fg_order 未入库余量 = qty − inbound_qty − closed_qty，
 *               逐行下限 0（已入库/已关单行跳过）。到货日取 expect_date；无则 null。
 *  4) on_order  在订未出：transit_refs kind=stock_summary 的 inbound_qty（总库存明细「已下单未出货」）。
 *               参考层中最弱的一档（时点快照、可能与 po/legacy_fg 重叠计数），**默认不返回**，
 *               需显式 opts.includeOnOrder=true；无到货日概念，expectDate 恒为 null。
 *
 * 重叠提示：on_order 与 po/legacy_fg 口径上可能指向同一批货，调用方若同时启用须自行说明"参考口径"。
 */
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dSub, dMul, dCmp, dQty } from "@/server/core/decimal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 供给来源：po/wo=记账层单据；legacy_fg/on_order=参考层登记 */
export type SupplySource = "po" | "wo" | "legacy_fg" | "on_order";

export interface OpenSupplyLine {
  skuId: number;
  /** 剩余未到量（基础单位，恒 > 0——逐行下限 0，不轧差） */
  qty: number;
  /** 预计到货日 YYYY-MM-DD；null = 无确认到货日（不进曲线，单独提示） */
  expectDate: string | null;
  source: SupplySource;
  /** 单号/审批号，便于追溯；参考层可能缺号 = null */
  ref: string | null;
  /** 原始单据/登记主键；供不可变决策证据反查，不替代 ref 的人类可读单号 */
  sourceDocId: number;
  /** 有行级事实时保留行主键（PO）；头级供给（WO/登记）为 null */
  sourceLineId: number | null;
}

export interface SupplyOptions {
  /** 是否包含「在订未出」（参考层最弱档，可能与 po/legacy_fg 重叠）；默认 false */
  includeOnOrder?: boolean;
}

export interface SupplySummary {
  /** 全部未结供给量 */
  total: number;
  /** 其中有确认到货日的部分 */
  dated: number;
  /** 其中无到货日的部分（曲线无法安放，须人工催交期） */
  undated: number;
  /** 按来源拆分（key = SupplySource） */
  bySource: Record<string, number>;
}

/** 数量口径统一 scale=4 后转展示数字（禁 float 中间运算，CLAUDE.md） */
const q4 = (dec: string): number => Number(dQty(dec));
const decOf = (v: unknown): string => (v == null ? "0" : String(v));

/**
 * 装配指定 SKU 集合的全部「未结供给行」。
 * 无排序依赖的调用方也能得到稳定结果：按 skuId → 到货日（无日期排最后）→ 来源 → 单号 排序。
 */
export async function getOpenSupplyLines(
  db: AnyDb,
  skuIds: number[],
  opts?: SupplyOptions,
): Promise<OpenSupplyLine[]> {
  const ids = Array.from(new Set(skuIds.filter((n) => Number.isFinite(n))));
  if (ids.length === 0) return [];
  const lines: OpenSupplyLine[] = [];

  /* ① po 采购在途：已审批/执行中 PO 行未收量（基础单位 = qty×uomFactor − receivedQty，逐行下限 0） */
  const poRows: {
    docId: number;
    lineId: number;
    skuId: number;
    qty: string;
    uomFactor: string;
    receivedQty: string;
    lineDate: string | null;
    docDate: string | null;
    docNo: string;
  }[] = await db
    .select({
      docId: schema.poDocs.id,
      lineId: schema.poLines.id,
      skuId: schema.poLines.skuId,
      qty: schema.poLines.qty,
      uomFactor: schema.poLines.uomFactor,
      receivedQty: schema.poLines.receivedQty,
      lineDate: schema.poLines.expectedDate,
      docDate: schema.poDocs.expectedDate,
      docNo: schema.poDocs.docNo,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .where(and(inArray(schema.poLines.skuId, ids), inArray(schema.poDocs.status, ["approved", "in_progress"])));
  for (const r of poRows) {
    const remain = dSub(dMul(decOf(r.qty), decOf(r.uomFactor), 6), decOf(r.receivedQty), 6);
    if (dCmp(remain, "0") <= 0) continue; // 超收/已收满行跳过，不与其他行轧差
    lines.push({
      skuId: r.skuId,
      qty: q4(remain),
      expectDate: r.lineDate ?? r.docDate ?? null, // 行级交期优先于头交期（func#11）
      source: "po",
      ref: r.docNo,
      sourceDocId: r.docId,
      sourceLineId: r.lineId,
    });
  }

  /* ② wo 在制委外产出：已审批/执行中且未暂停的 WO 计划产出，due_date 作到货日 */
  const woRows: { docId: number; skuId: number; qty: string; dueDate: string | null; docNo: string }[] = await db
    .select({
      docId: schema.woDocs.id,
      skuId: schema.woDocs.productSkuId,
      qty: schema.woDocs.qty,
      dueDate: schema.woDocs.dueDate,
      docNo: schema.woDocs.docNo,
    })
    .from(schema.woDocs)
    .where(
      and(
        inArray(schema.woDocs.productSkuId, ids),
        inArray(schema.woDocs.status, ["approved", "in_progress"]),
        eq(schema.woDocs.isPaused, false),
      ),
    );
  for (const r of woRows) {
    const remain = dQty(decOf(r.qty));
    if (dCmp(remain, "0") <= 0) continue;
    lines.push({
      skuId: r.skuId,
      qty: q4(remain),
      expectDate: r.dueDate ?? null,
      source: "wo",
      ref: r.docNo,
      sourceDocId: r.docId,
      sourceLineId: null,
    });
  }

  /* ③④ 参考层 transit_refs：fg_order 存量单在途（恒取），stock_summary 在订未出（默认关闭） */
  const tr = schema.transitRefs;
  const kinds = opts?.includeOnOrder ? ["fg_order", "stock_summary"] : ["fg_order"];
  const refRows: {
    id: number;
    kind: string;
    skuId: number | null;
    qty: string | null;
    inboundQty: string | null;
    closedQty: string | null;
    expectDate: string | null;
    externalNo: string | null;
    approvalNo: string | null;
  }[] = await db
    .select({
      id: tr.id,
      kind: tr.kind,
      skuId: tr.skuId,
      qty: tr.qty,
      inboundQty: tr.inboundQty,
      closedQty: tr.closedQty,
      expectDate: tr.expectDate,
      externalNo: tr.externalNo,
      approvalNo: tr.approvalNo,
    })
    .from(tr)
    .where(and(inArray(tr.kind, kinds), inArray(tr.skuId, ids)));
  for (const r of refRows) {
    if (r.skuId == null) continue; // 未解析到 SKU 的登记行不进供给（仅台账展示）
    const ref = r.externalNo ?? r.approvalNo ?? null;
    if (r.kind === "fg_order") {
      if (r.qty == null) continue;
      const remain = dSub(dSub(decOf(r.qty), decOf(r.inboundQty), 6), decOf(r.closedQty), 6);
      if (dCmp(remain, "0") <= 0) continue; // 已入库/已关单的存量单不再算在途
      lines.push({
        skuId: r.skuId,
        qty: q4(remain),
        expectDate: r.expectDate ?? null,
        source: "legacy_fg",
        ref,
        sourceDocId: r.id,
        sourceLineId: null,
      });
    } else {
      // stock_summary：inbound_qty = 已下单未出货；时点快照，无到货日
      if (r.inboundQty == null) continue;
      const remain = dQty(decOf(r.inboundQty));
      if (dCmp(remain, "0") <= 0) continue;
      lines.push({
        skuId: r.skuId,
        qty: q4(remain),
        expectDate: null,
        source: "on_order",
        ref,
        sourceDocId: r.id,
        sourceLineId: null,
      });
    }
  }

  const srcOrder: Record<SupplySource, number> = { po: 0, wo: 1, legacy_fg: 2, on_order: 3 };
  lines.sort(
    (a, b) =>
      a.skuId - b.skuId ||
      (a.expectDate == null ? 1 : 0) - (b.expectDate == null ? 1 : 0) ||
      (a.expectDate ?? "").localeCompare(b.expectDate ?? "") ||
      srcOrder[a.source] - srcOrder[b.source] ||
      (a.ref ?? "").localeCompare(b.ref ?? ""),
  );
  return lines;
}

/** 逐 SKU 汇总未结供给：总量 / 有日期 / 无日期 / 按来源（纯函数，可对任意子集调用） */
export function summarizeSupply(lines: OpenSupplyLine[]): Map<number, SupplySummary> {
  const out = new Map<number, SupplySummary>();
  for (const l of lines) {
    let s = out.get(l.skuId);
    if (!s) {
      s = { total: 0, dated: 0, undated: 0, bySource: {} };
      out.set(l.skuId, s);
    }
    s.total = q4(String(s.total + l.qty));
    if (l.expectDate) s.dated = q4(String(s.dated + l.qty));
    else s.undated = q4(String(s.undated + l.qty));
    s.bySource[l.source] = q4(String((s.bySource[l.source] ?? 0) + l.qty));
  }
  return out;
}
