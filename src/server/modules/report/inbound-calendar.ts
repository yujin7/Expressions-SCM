/**
 * E4-03 到货日历（只读报表层）——把散落在 PO/WO/存量单里的到货日汇成一张「本周到什么货」的收货计划。
 *
 * 解决的问题：仓库现在每天被动开门收货。PO 有 expectedDate（头交期/行交期）、供应商门户还在回填
 * 逐行交期、WO 有 dueDate，但这些日期从不汇总——没人能提前一周看到「周三到 8 个 SKU、共 12000 件」。
 *
 * 取数纪律：**必须复用** core/supply.ts 的 getOpenSupplyLines（未结供给唯一定义，含 po/wo/legacy_fg
 * 三源、逐行下限 0、行交期优先于头交期）。本模块只做「按到货日分桶」，不重实现四段 join
 * （口径漂移根因，CLAUDE.md 同纪律）。on_order（在订未出）无到货日概念，默认不含（不传 includeOnOrder）。
 *
 * 口径诚实（务必与 UI 说明一致）：
 * - **undatedLines 是真实盲区**：无确认到货日的未结供给根本不会出现在日历上。日历越"空"越可能
 *   不是没货要来，而是交期没录。故该数必须回传并在页面顶部明示，不得只在服务端算完就丢掉。
 * - WO 以计划产出量计（未净已收部分批），in_progress 单残余会高估——同 core/supply 列注。
 * - legacy_fg 属参考层登记（外部台账导入、只读），到货日可信度低于记账层单据。
 * - 逾期不补算：到货日早于 from 的未结供给不会被"堆到今天"，它们落在区间外就是不显示；
 *   要看逾期请把 from 往前调（本页支持任意区间，不强制从今天起）。
 *
 * 只读：不写库、不开单、不落审计。无金额字段，免脱敏。
 */
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { dAdd, dQty } from "@/server/core/decimal";
import { getOpenSupplyLines, type SupplySource } from "@/server/core/supply";
import { ApiError, todayShanghai } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 区间上限：日历是「看得完」的计划视图，过长区间既无阅读价值又白算（超出报 400，不静默截断） */
const MAX_RANGE_DAYS = 366;
/** 默认前瞻窗口（今天 + 14 天，共 15 个自然日） */
const DEFAULT_HORIZON_DAYS = 14;

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 来源中文名（与 UI 共用一套词，避免前后端各起一个） */
export const SUPPLY_SOURCE_LABELS: Record<string, string> = {
  po: "采购在途",
  wo: "委外在制",
  legacy_fg: "存量单",
  on_order: "在订未出",
};

export interface InboundCalendarLine {
  skuId: number;
  code: string;
  name: string;
  /** 预计到货量（基础单位） */
  qty: number;
  uom: string;
  source: SupplySource;
  /** 单号/审批号；参考层可能缺号 = null */
  ref: string | null;
}

export interface InboundCalendarDay {
  /** YYYY-MM-DD */
  date: string;
  /** 周一…周日（中文） */
  weekday: string;
  /** 当日预计到货行（按 SKU 编码 → 来源 → 单号 稳定排序）；空数组 = 当天无到货（占位日，不跳过） */
  lines: InboundCalendarLine[];
  totalQty: number;
  lineCount: number;
}

export interface InboundCalendarResult {
  from: string;
  to: string;
  days: InboundCalendarDay[];
  summary: {
    /** 区间内预计到货条数 */
    totalLines: number;
    /** 区间内预计到货总量（基础单位合计，跨 SKU 相加仅作规模感，不是可比业务量） */
    totalQty: number;
    /**
     * 无确认到货日的未结供给**条数**（全量，不受区间限制）。
     * 这些货不会出现在日历上——"看不见的到货"，是本页最重要的诚实项，UI 必须明示。
     */
    undatedLines: number;
    /** 区间内按来源拆分的**数量**（与 core/supply.summarizeSupply 同口径：值是数量不是条数） */
    bySource: Record<string, number>;
  };
}

export interface InboundCalendarQuery {
  /** 起始日 YYYY-MM-DD，默认今天（Asia/Shanghai） */
  from?: string;
  /** 结束日 YYYY-MM-DD（含），默认今天 +14 天 */
  to?: string;
  /**
   * 收货仓筛选——**当前不可用**，传入即报 400（宁可报错也不静默返回未筛选数据）。
   * 原因：三个供给源都没有收货仓维度——po_docs/po_lines、wo_docs、transit_refs 均不登记仓库，
   * 收货仓要到 SH/RK 收货单开立时才确定。保留入参是为将来 PO 增列收货仓后不改签名。
   */
  warehouseId?: number;
}

/** YYYY-MM-DD 加天数（纯 UTC 运算，避开本地时区跨日；业务日已由 todayShanghai 定锚） */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → 中文星期（纯函数） */
export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

/** 两个日期相差天数（b − a），纯函数 */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const assertDate = (v: string, label: string): string => {
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new ApiError(400, `${label}格式不正确（应为 YYYY-MM-DD）`);
  }
  return v;
};

/**
 * 装配到货日历：区间内每一天一个桶（无到货的日子也保留空桶，让"空档"可见）。
 */
export async function getInboundCalendar(
  query: InboundCalendarQuery,
  dbArg?: AnyDb,
): Promise<InboundCalendarResult> {
  if (query.warehouseId != null) {
    throw new ApiError(
      400,
      "到货日历暂不支持按收货仓筛选：PO/WO/存量单均未登记收货仓（收货仓在 SH/RK 收货单开立时才确定）",
    );
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = todayShanghai();
  const from = assertDate(query.from?.trim() || today, "起始日期");
  const to = assertDate(query.to?.trim() || addDays(today, DEFAULT_HORIZON_DAYS), "结束日期");
  if (to < from) throw new ApiError(400, "结束日期不能早于起始日期");
  const span = diffDays(from, to) + 1;
  if (span > MAX_RANGE_DAYS) throw new ApiError(400, `查询区间过长（最多 ${MAX_RANGE_DAYS} 天）`);

  /* ── 全部在用 SKU（停用 SKU 的在途走完即止，不再排进收货计划） ── */
  const skuRows: { id: number; code: string; name: string; baseUom: string }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      baseUom: schema.skus.baseUom,
    })
    .from(schema.skus)
    .where(eq(schema.skus.active, true));
  const skuById = new Map(skuRows.map((s) => [s.id, s]));

  /* ── 未结供给唯一入口（core/supply）：po + wo + legacy_fg，不含 on_order（无到货日概念） ── */
  const supplyLines = await getOpenSupplyLines(db, skuRows.map((s) => s.id));

  /* ── 分桶：区间内按日归集；区间外仅统计不展示；无日期的单独计数（真实盲区） ── */
  const byDate = new Map<string, InboundCalendarLine[]>();
  for (let d = from; d <= to; d = addDays(d, 1)) byDate.set(d, []);
  let undatedLines = 0;
  let totalQtyDec = "0";
  const bySourceDec: Record<string, string> = {};
  for (const l of supplyLines) {
    if (l.expectDate == null) {
      undatedLines += 1;
      continue;
    }
    const bucket = byDate.get(l.expectDate);
    if (!bucket) continue; // 区间外（含逾期）：不堆到今天，也不计入本页统计
    const sku = skuById.get(l.skuId);
    if (!sku) continue; // 理论不达（供给行由 active SKU 列表反查而来），防御性跳过
    bucket.push({
      skuId: l.skuId,
      code: sku.code,
      name: sku.name,
      qty: l.qty,
      uom: sku.baseUom,
      source: l.source,
      ref: l.ref,
    });
    totalQtyDec = dAdd(totalQtyDec, String(l.qty));
    bySourceDec[l.source] = dAdd(bySourceDec[l.source] ?? "0", String(l.qty));
  }

  const days: InboundCalendarDay[] = [];
  let totalLines = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const lines = byDate.get(d) ?? [];
    lines.sort(
      (a, b) => a.code.localeCompare(b.code) || a.source.localeCompare(b.source) || (a.ref ?? "").localeCompare(b.ref ?? ""),
    );
    let dayQty = "0";
    for (const l of lines) dayQty = dAdd(dayQty, String(l.qty));
    totalLines += lines.length;
    days.push({ date: d, weekday: weekdayOf(d), lines, totalQty: Number(dQty(dayQty)), lineCount: lines.length });
  }

  const bySource: Record<string, number> = {};
  for (const [k, v] of Object.entries(bySourceDec)) bySource[k] = Number(dQty(v));

  return {
    from,
    to,
    days,
    summary: { totalLines, totalQty: Number(dQty(totalQtyDec)), undatedLines, bySource },
  };
}
