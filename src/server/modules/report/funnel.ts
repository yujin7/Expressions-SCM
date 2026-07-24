/**
 * E7-06 全链达成漏斗（只读报表层）：需求 → 计划 → 下单 → 到货 → 动销 五级串成一条链。
 *
 * 数据全部既有，不新增口径；本模块只做「串」和「诚实标注」两件事。
 * 各级取数（照抄各自权威口径，勿在此另立一套）：
 *   ① 需求：transit_refs kind='demand' 的 qty（业务部需求文件，参考层——非系统单据，无审批态）
 *   ② 计划：bh_lines.qty 合计（BH 备货申请单，单据非 void）
 *   ③ 下单：wo_docs.qty 合计（委外工单，状态非 void/draft）
 *   ④ 到货：sh_lines.actualQty 合计（SH 收货单，状态 ∈ approved/in_progress/completed 且 line_type='normal'
 *          ——与 report/wip.ts 的 pendingQty 分子同口径：返工重交冲抵原不合格、备品不占累计）
 *   ⑤ 动销：sales_monthly.qty 合计（月销汇总）
 *
 * ⚠ 时间窗不统一（见 caveat）：①⑤ 是自然月字段（按数据最新月回推），②③④ 是单据创建时间
 * （按当前月回推）。转化率仅供趋势参考，不是精确损耗率。
 */
import { and, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { lastMonths } from "@/server/core/velocity";
import { todayShanghai } from "@/server/modules/master/common";
import { type AnyDb, resolveDb } from "@/server/modules/outsource/common";

/** 与 report/wip.ts ACTIVE_SH_STATUSES 一致（就地声明，避免跨模块 const 数组类型摩擦） */
const ACTIVE_SH_STATUSES = ["approved", "in_progress", "completed"] as const;

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const r2 = (v: number): number => Math.round(v * 100) / 100;

export type FunnelStageKey = "demand" | "plan" | "order" | "receipt" | "sales";

export interface FunnelStage {
  key: FunnelStageKey;
  label: string;
  /** 该级数量合计 */
  qty: number;
  /** 单据数 / 记录数（①⑤ 为记录行数，②④ 为单据数，③ 为工单数） */
  docCount: number;
  /** 口径说明（含时间窗与来源表） */
  note: string;
}

export interface FunnelConversion {
  from: FunnelStageKey;
  to: FunnelStageKey;
  /** to/from（0.85 = 85%）；上游为 0 时 null（不做 0 除） */
  rate: number | null;
}

export interface FunnelResult {
  stages: FunnelStage[];
  conversions: FunnelConversion[];
  /** 窗口月数 */
  months: number;
  /** ①⑤ 使用的自然月列表（升序；无销量数据则为空） */
  monthList: string[];
  /** ②③④ 使用的单据创建时间窗（含 from，不含 to） */
  docWindow: { from: string; to: string };
  caveat: string;
}

const CAVEAT =
  "口径警示：五级并非严格一一对应，也不是同一批货的流转轨迹——同一批货可能跨期（本月下的单下月到货、上季到的货本月才动销），" +
  "且各级时间窗不完全对齐：需求与动销按自然月字段统计（由销量数据最新月回推），计划/下单/到货按单据创建时间统计（由当前月回推）。" +
  "此外需求来自业务部需求文件（参考层，非系统单据），与系统内单据未做行级钩稽。" +
  "因此级间转化率仅供看趋势与量级对比，不可当作精确损耗率或达成率，更不可用于考核。";

/** ym（YYYY-MM）→ 该月 1 日 00:00（Asia/Shanghai）的时刻 */
function monthStart(ym: string): Date {
  return new Date(`${ym}-01T00:00:00+08:00`);
}
/** ym 的下一个月（YYYY-MM） */
function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getFulfillmentFunnel(
  query: { months?: number },
  dbArg?: AnyDb,
): Promise<FunnelResult> {
  const db = await resolveDb(dbArg);
  const months = Math.min(24, Math.max(1, Math.trunc(query.months ?? 3)));

  /* ── 窗口①⑤：自然月（由销量数据最新月回推，core/velocity 唯一口径） ── */
  const sm = schema.salesMonthly;
  const [{ maxYm }]: { maxYm: string | null }[] = await db
    .select({ maxYm: sql<string | null>`max(${sm.yearMonth})` })
    .from(sm);
  const monthList = maxYm ? lastMonths(maxYm, months) : [];
  const monthRange = monthList.length ? `${monthList[0]}~${monthList[monthList.length - 1]}` : "无销量数据";

  /* ── 窗口②③④：单据创建时间（由当前月回推 N 个自然月） ── */
  const docMonths = lastMonths(todayShanghai().slice(0, 7), months);
  const docFromYm = docMonths[0];
  const docToYm = nextMonth(docMonths[docMonths.length - 1]);
  const docFrom = monthStart(docFromYm);
  const docTo = monthStart(docToYm);
  const docRange = `${docFromYm}~${docMonths[docMonths.length - 1]}`;

  /* ── ① 需求：transit_refs kind='demand'（参考层，progress 存 YYYY-MM） ── */
  const tr = schema.transitRefs;
  const [demandAgg]: { qty: string | null; cnt: number }[] = monthList.length
    ? await db
        .select({ qty: sql<string | null>`sum(${tr.qty})`, cnt: sql<number>`count(*)::int` })
        .from(tr)
        .where(and(eq(tr.kind, "demand"), inArray(tr.progress, monthList)))
    : [{ qty: null, cnt: 0 }];

  /* ── ② 计划：BH 单行合计（单据非 void） ── */
  const [planAgg]: { qty: string | null; cnt: number }[] = await db
    .select({
      qty: sql<string | null>`sum(${schema.bhLines.qty})`,
      cnt: sql<number>`count(distinct ${schema.bhDocs.id})::int`,
    })
    .from(schema.bhLines)
    .innerJoin(schema.bhDocs, eq(schema.bhLines.bhId, schema.bhDocs.id))
    .where(and(notInArray(schema.bhDocs.status, ["void"]), gte(schema.bhDocs.createdAt, docFrom), lt(schema.bhDocs.createdAt, docTo)));

  /* ── ③ 下单：WO 数量合计（非 void/draft） ── */
  const [orderAgg]: { qty: string | null; cnt: number }[] = await db
    .select({ qty: sql<string | null>`sum(${schema.woDocs.qty})`, cnt: sql<number>`count(*)::int` })
    .from(schema.woDocs)
    .where(and(notInArray(schema.woDocs.status, ["void", "draft"]), gte(schema.woDocs.createdAt, docFrom), lt(schema.woDocs.createdAt, docTo)));

  /* ── ④ 到货：SH 正常行实收（口径同 report/wip.ts） ── */
  const [receiptAgg]: { qty: string | null; cnt: number }[] = await db
    .select({
      qty: sql<string | null>`sum(${schema.shLines.actualQty})`,
      cnt: sql<number>`count(distinct ${schema.shDocs.id})::int`,
    })
    .from(schema.shLines)
    .innerJoin(schema.shDocs, eq(schema.shLines.shId, schema.shDocs.id))
    .where(and(
      inArray(schema.shDocs.status, [...ACTIVE_SH_STATUSES]),
      eq(schema.shLines.lineType, "normal"),
      gte(schema.shDocs.createdAt, docFrom),
      lt(schema.shDocs.createdAt, docTo),
    ));

  /* ── ⑤ 动销：sales_monthly 窗口内销量合计 ── */
  const [salesAgg]: { qty: string | null; cnt: number }[] = monthList.length
    ? await db
        .select({ qty: sql<string | null>`sum(${sm.qty})`, cnt: sql<number>`count(*)::int` })
        .from(sm)
        .where(inArray(sm.yearMonth, monthList))
    : [{ qty: null, cnt: 0 }];

  const demandQty = num(demandAgg?.qty);
  const demandCnt = demandAgg?.cnt ?? 0;

  const stages: FunnelStage[] = [
    {
      key: "demand",
      label: "需求",
      qty: r2(demandQty),
      docCount: demandCnt,
      note:
        demandCnt === 0
          ? `无需求文件数据（transit_refs kind='demand'，月份 ${monthRange} 无记录）——本级不参与转化率判读`
          : `业务部需求文件（transit_refs kind='demand'）需求量合计，按自然月 ${monthRange}；参考层数据，非系统单据，未与后续单据行级钩稽`,
    },
    {
      key: "plan",
      label: "计划",
      qty: r2(num(planAgg?.qty)),
      docCount: planAgg?.cnt ?? 0,
      note: `BH 备货申请单行数量合计（bh_lines.qty，单据非 void），按单据创建时间 ${docRange}`,
    },
    {
      key: "order",
      label: "下单",
      qty: r2(num(orderAgg?.qty)),
      docCount: orderAgg?.cnt ?? 0,
      note: `委外工单数量合计（wo_docs.qty，状态非 void/draft），按单据创建时间 ${docRange}`,
    },
    {
      key: "receipt",
      label: "到货",
      qty: r2(num(receiptAgg?.qty)),
      docCount: receiptAgg?.cnt ?? 0,
      note: `SH 收货单正常行实收合计（line_type='normal'，状态 ∈ approved/in_progress/completed，与在制看板同口径：返工重交冲抵原不合格、备品不占累计），按单据创建时间 ${docRange}`,
    },
    {
      key: "sales",
      label: "动销",
      qty: r2(num(salesAgg?.qty)),
      docCount: salesAgg?.cnt ?? 0,
      note: `月销量合计（sales_monthly.qty，全渠道），按自然月 ${monthRange}；记录数=SKU×渠道×月 行数`,
    },
  ];

  const conversions: FunnelConversion[] = [];
  for (let i = 0; i + 1 < stages.length; i++) {
    const a = stages[i];
    const b = stages[i + 1];
    conversions.push({ from: a.key, to: b.key, rate: a.qty > 0 ? r2(b.qty / a.qty) : null });
  }

  return {
    stages,
    conversions,
    months,
    monthList,
    docWindow: { from: docFromYm, to: docMonths[docMonths.length - 1] },
    caveat: CAVEAT,
  };
}
