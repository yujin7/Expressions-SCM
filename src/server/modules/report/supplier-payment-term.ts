/**
 * D64 供应商账期读模型 `supplier-payment-term/v3`（记分卡页「账期候选」Tab + 第 4 屏部门目标 auto 来源）。
 *
 * 口径（D64；参数 payment_term_min_years / payment_term_target_min_days / payment_term_target_max_days）：
 * - 年采购额 = 该年 **审批通过** PO 的行未税金额（同 purchase-order-metrics 口径，去税/补税唯一实现 `rules/price.ts` normalizeLineNetGross）
 *   + 该年生效 JS 结算金额（settle_amount，
 *   供应商取 jg_docs.supplier_id）；两者并列后相加为 total。
 * - 分池排名：processor（含加工厂 kinds）→ OA 加工厂池；packaging → 包材池；其余 → 原料池。池内按年 total 降序 1-based。
 * - 候选 = 合作 ≥ payment_term_min_years 年 **且** 当年排名较上一年上升（两年均有排名）。
 *   合作起始日：suppliers 无 cooperation_since 列（0048 待编排方定），此处按最早已批 PO / 已批 JG 建单日 **系统推算**并标 source。
 * - 当前账期：suppliers.payment_term_type / credit_days / payment_term_effective_from（写路径 master/supplier.ts）。
 *   按上海业务日判生效；未来条款 pending、缺类型/生效日 unknown；有效月结且天数足够才达标。
 * - 达成率 = 候选中已达标 ÷ 候选数（SPT-5：department_goals(purchasing) auto 实际值来源）。
 * - 账期类采购额占比 = 当前有效月结供应商当年采购额 ÷ 全部当年采购额；非零采购额存在未知分类时弃权。
 * - 金额只对 PRICE_VISIBLE_ROLES 可见（stripSupplierPaymentTermMoney）；名次保留。
 * - 缓存：source_binding 绑事实、三项账期参数及上海业务日（改口径/跨生效日即失效重算）。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getDbAsync } from "@/db";
import { dAdd, dCmp, dDiv, dMul } from "@/server/core/decimal";
import { canSeePrices } from "@/server/core/dto";
import { getNumParam } from "@/server/core/params";
import { type AnyDb } from "@/server/core/svc";
import { shanghaiDay } from "@/server/rules/po-cycle";
import { normalizeLineNetGross } from "@/server/rules/price";
import { ORDERED_PO_STATUSES } from "./purchase-order-metrics";

export const SUPPLIER_PAYMENT_TERM_KEY = "supplier-payment-term/v3";
const ACTIVE_JS_STATUSES = ["approved", "in_progress", "completed"] as const;
const ACTIVE_JG_STATUSES = ["approved", "in_progress", "completed", "closed"] as const;

export type SupplierPool = "processor" | "packaging" | "raw";
export const SUPPLIER_POOL_LABELS: Record<SupplierPool, string> = { processor: "OA 加工厂", packaging: "包材厂", raw: "原料商" };
export type PaymentTermType = "prepay" | "on_delivery" | "monthly_credit";
export const PAYMENT_TERM_TYPE_LABELS: Record<PaymentTermType, string> = { prepay: "预付", on_delivery: "款到发货", monthly_credit: "月结" };
export type AttainmentStatus = "attained" | "below_target" | "not_credit" | "unknown" | "pending";
export type PaymentTermState = "effective" | "pending" | "unknown";
export type RankTrend = "up" | "down" | "flat" | "unknown";

export interface SupplierYearSpend {
  year: number;
  poNet: string | null;
  jsSettle: string | null;
  total: string | null;
  rank: number | null;
  /** 池内参与排名的供应商数 */
  rankOf: number;
}

export interface SupplierPaymentTermRow {
  supplierId: number;
  code: string;
  name: string;
  kinds: string[];
  status: string;
  pool: SupplierPool;
  cooperationSince: string | null;
  cooperationSource: "system_inferred" | null;
  cooperationYears: number | null;
  spend: SupplierYearSpend[];
  hasCurrentYearSpend: boolean;
  rankTrend: RankTrend;
  candidate: boolean;
  candidateReason: string;
  paymentTermType: PaymentTermType | null;
  creditDays: number | null;
  paymentTermEffectiveFrom: string | null;
  paymentTermText: string | null;
  attainment: AttainmentStatus;
  termState: PaymentTermState;
}

export interface PoolSummary {
  pool: SupplierPool;
  label: string;
  suppliers: number;
  candidates: number;
  candidatesAttained: number;
  attainmentRate: number | null;
  totalSpend: string | null;
  creditTermSpend: string | null;
  creditTermSpendSharePct: string | null;
  unclassifiedSpendSuppliers: number;
}

export interface SupplierPaymentTermModel {
  key: typeof SUPPLIER_PAYMENT_TERM_KEY;
  authority: "ledger";
  sourceBinding: string;
  builtAt: string;
  asOf: string;
  year: number;
  moneyVisible: boolean;
  params: { minYears: number; targetMinDays: number; targetMaxDays: number };
  summary: {
    suppliers: number;
    withSpend: number;
    candidates: number;
    candidatesAttained: number;
    /** 候选达成率（0–1，4 位小数）；候选为 0 → null */
    attainmentRate: number | null;
    creditTermSuppliers: number;
    totalSpend: string | null;
    creditTermSpend: string | null;
    /** 账期类采购额占比（百分数 scale 2）；总额非正或存在非零采购额的未知分类 → null */
    creditTermSpendSharePct: string | null;
    unclassifiedSpendSuppliers: number;
    byPool: PoolSummary[];
  };
  rows: SupplierPaymentTermRow[];
  limitations: string[];
}

function poolOf(kinds: string[]): SupplierPool {
  if (kinds.includes("processor")) return "processor";
  if (kinds.includes("packaging")) return "packaging";
  return "raw";
}

function yearsBetween(from: string, to: string): number {
  if (from > to) return -yearsBetween(to, from);
  const [year, month, day] = from.split("-").map(Number);
  const end = Date.parse(`${to}T00:00:00Z`);
  // 按业务日周年判整年；2月29日在非闰年按2月末。小数年按相邻周年间实际日数折算。
  const anniversary = (y: number) => Date.UTC(y, month - 1, Math.min(day, new Date(Date.UTC(y, month, 0)).getUTCDate()));
  let fullYears = Number(to.slice(0, 4)) - year;
  if (anniversary(year + fullYears) > end) fullYears--;
  const start = anniversary(year + fullYears);
  const next = anniversary(year + fullYears + 1);
  return fullYears + (end - start) / (next - start);
}

function attainmentOf(type: PaymentTermType | null, creditDays: number | null, targetMin: number, state: PaymentTermState): AttainmentStatus {
  if (state === "pending") return "pending";
  if (state === "unknown" || type == null) return "unknown";
  if (type !== "monthly_credit") return "not_credit";
  if (creditDays == null) return "unknown";
  return creditDays >= targetMin ? "attained" : "below_target";
}

interface PaymentTermParams {
  minYears: number;
  targetMinDays: number;
  targetMaxDays: number;
}

/** 账期参数（sys_params，PARAM_DEFS 已登记；测试传 db 走实时不走缓存） */
async function readPaymentTermParams(db: AnyDb): Promise<PaymentTermParams> {
  // 同一快照事务只有一个连接，逐次读取，避免 pg 客户端并发 query 的弃用行为。
  const minYears = await getNumParam("payment_term_min_years", 2, db);
  const targetMinDays = await getNumParam("payment_term_target_min_days", 45, db);
  const targetMaxDays = await getNumParam("payment_term_target_max_days", 60, db);
  return { minYears, targetMinDays, targetMaxDays };
}

/** 一条SQL快照覆盖所有被消费字段，已有单据改价/流转/JG首单变化也必须失效。 */
async function sourceBinding(db: AnyDb, year: number, p: PaymentTermParams, today: string): Promise<string> {
  const result = await db.execute(sql`select
    (select md5(coalesce(string_agg(md5(json_build_array(
      ${schema.poDocs.id}, ${schema.poDocs.supplierId}, ${schema.poDocs.status}, ${schema.poDocs.createdAt}
    )::text), '' order by ${schema.poDocs.id}), '')) from ${schema.poDocs}) as po,
    (select md5(coalesce(string_agg(md5(json_build_array(
      ${schema.poLines.id}, ${schema.poLines.poId}, ${schema.poLines.qty}, ${schema.poLines.price},
      ${schema.poLines.taxIncluded}, ${schema.poLines.taxRatePct}
    )::text), '' order by ${schema.poLines.id}), '')) from ${schema.poLines}) as pol,
    (select md5(coalesce(string_agg(md5(json_build_array(
      ${schema.jgDocs.id}, ${schema.jgDocs.supplierId}, ${schema.jgDocs.status}, ${schema.jgDocs.createdAt}
    )::text), '' order by ${schema.jgDocs.id}), '')) from ${schema.jgDocs}) as jg,
    (select md5(coalesce(string_agg(md5(json_build_array(
      ${schema.jsDocs.id}, ${schema.jsDocs.jgId}, ${schema.jsDocs.status}, ${schema.jsDocs.createdAt}, ${schema.jsDocs.settleAmount}
    )::text), '' order by ${schema.jsDocs.id}), '')) from ${schema.jsDocs}) as js,
    (select md5(coalesce(string_agg(md5(json_build_array(
      ${schema.approvals.id}, ${schema.approvals.docId}, ${schema.approvals.action}, ${schema.approvals.createdAt}
    )::text), '' order by ${schema.approvals.id}), '')) from ${schema.approvals}
      where ${schema.approvals.docType} = 'po') as appr,
    (select md5(coalesce(string_agg(md5(json_build_array(
      ${schema.suppliers.id}, ${schema.suppliers.code}, ${schema.suppliers.name}, ${schema.suppliers.kinds},
      ${schema.suppliers.status}, ${schema.suppliers.paymentTerm}, ${schema.suppliers.paymentTermType}, ${schema.suppliers.creditDays},
      ${schema.suppliers.paymentTermEffectiveFrom}
    )::text), '' order by ${schema.suppliers.id}), '')) from ${schema.suppliers}) as sup`);
  const r = result.rows[0] as Record<string, string>;
  return `v3|po:${r.po}|pol:${r.pol}|jg:${r.jg}|js:${r.js}|appr:${r.appr}|sup:${r.sup}|year:${year}|pt:${p.minYears}/${p.targetMinDays}/${p.targetMaxDays}|day:${today}`;
}

/** 供只读目标消费复核：日期或源事实已变时拒绝旧缓存，不在目标页偷偷重建报表。 */
export async function isSupplierPaymentTermBindingCurrent(db: AnyDb, binding: string): Promise<boolean> {
  const today = shanghaiDay(new Date())!;
  return binding === await sourceBinding(db, Number(today.slice(0, 4)), await readPaymentTermParams(db), today);
}

export async function computeSupplierPaymentTerm(db: AnyDb, opts: { asOf?: Date; year?: number } = {}): Promise<SupplierPaymentTermModel> {
  // 数值和sourceBinding必须来自同一快照，避免旧计算结果被盖上新指纹。
  return db.transaction((tx: AnyDb) => computeSupplierPaymentTermSnapshot(tx, opts), {
    isolationLevel: "repeatable read", accessMode: "read only",
  });
}

async function computeSupplierPaymentTermSnapshot(db: AnyDb, opts: { asOf?: Date; year?: number }): Promise<SupplierPaymentTermModel> {
  const today = shanghaiDay(opts.asOf ?? new Date())!;
  const year = opts.year ?? Number(today.slice(0, 4));
  const years = [year, year - 1, year - 2];
  const params = await readPaymentTermParams(db);
  const { minYears, targetMinDays, targetMaxDays } = params;

  const suppliers: {
    id: number; code: string; name: string; kinds: string[]; status: string; paymentTerm: string | null;
    paymentTermType: PaymentTermType | null; creditDays: number | null; paymentTermEffectiveFrom: string | null;
  }[] = await db
    .select({
      id: schema.suppliers.id,
      code: schema.suppliers.code,
      name: schema.suppliers.name,
      kinds: schema.suppliers.kinds,
      status: schema.suppliers.status,
      paymentTerm: schema.suppliers.paymentTerm,
      paymentTermType: schema.suppliers.paymentTermType,
      creditDays: schema.suppliers.creditDays,
      paymentTermEffectiveFrom: schema.suppliers.paymentTermEffectiveFrom,
    })
    .from(schema.suppliers)
    .orderBy(schema.suppliers.code);

  /* PO 未税额：按审批通过时点归年 */
  const ordered: { docId: number; orderedAt: Date | string }[] = await db
    .select({ docId: schema.approvals.docId, orderedAt: sql<Date | string>`max(${schema.approvals.createdAt})` })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.docType, "po"), eq(schema.approvals.action, "approve")))
    .groupBy(schema.approvals.docId);
  const orderedDay = new Map<number, string>();
  for (const r of ordered) {
    const d = shanghaiDay(r.orderedAt);
    if (d) orderedDay.set(r.docId, d);
  }
  const poLines: {
    poId: number; supplierId: number; createdAt: Date | string; qty: string; price: string; taxIncluded: boolean; taxRatePct: string;
  }[] = await db
    .select({
      poId: schema.poLines.poId,
      supplierId: schema.poDocs.supplierId,
      createdAt: schema.poDocs.createdAt,
      qty: schema.poLines.qty,
      price: schema.poLines.price,
      taxIncluded: schema.poLines.taxIncluded,
      taxRatePct: schema.poLines.taxRatePct,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .where(inArray(schema.poDocs.status, [...ORDERED_PO_STATUSES]));

  /* JS 结算额：按 JS 建单日归年（结算单无独立审批时点字段） */
  const jsRows: { supplierId: number; createdAt: Date | string; settleAmount: string }[] = await db
    .select({ supplierId: schema.jgDocs.supplierId, createdAt: schema.jsDocs.createdAt, settleAmount: schema.jsDocs.settleAmount })
    .from(schema.jsDocs)
    .innerJoin(schema.jgDocs, eq(schema.jsDocs.jgId, schema.jgDocs.id))
    .where(inArray(schema.jsDocs.status, [...ACTIVE_JS_STATUSES]));

  /* 合作起始：最早已批 PO / 已批 JG 建单日 */
  const jgFirst: { supplierId: number; firstAt: Date | string }[] = await db
    .select({ supplierId: schema.jgDocs.supplierId, firstAt: sql<Date | string>`min(${schema.jgDocs.createdAt})` })
    .from(schema.jgDocs)
    .where(inArray(schema.jgDocs.status, [...ACTIVE_JG_STATUSES]))
    .groupBy(schema.jgDocs.supplierId);

  const poNet = new Map<string, string>(); // `${supplierId}:${year}`
  const jsSettle = new Map<string, string>();
  const firstDay = new Map<number, string>();
  const bump = (m: Map<number, string>, id: number, day: string | null) => {
    if (!day) return;
    const cur = m.get(id);
    if (cur == null || day < cur) m.set(id, day);
  };
  for (const l of poLines) {
    const day = orderedDay.get(l.poId);
    bump(firstDay, l.supplierId, shanghaiDay(l.createdAt));
    if (!day) continue;
    const y = Number(day.slice(0, 4));
    if (!years.includes(y)) continue;
    const { net } = normalizeLineNetGross({ price: l.price, qty: l.qty, taxIncluded: l.taxIncluded, taxRatePct: l.taxRatePct });
    const k = `${l.supplierId}:${y}`;
    poNet.set(k, dAdd(poNet.get(k) ?? "0", net, 2));
  }
  for (const j of jsRows) {
    const day = shanghaiDay(j.createdAt);
    if (!day) continue;
    const y = Number(day.slice(0, 4));
    if (!years.includes(y)) continue;
    const k = `${j.supplierId}:${y}`;
    jsSettle.set(k, dAdd(jsSettle.get(k) ?? "0", j.settleAmount, 2));
  }
  for (const g of jgFirst) bump(firstDay, g.supplierId, shanghaiDay(g.firstAt));

  /* 分池按年排名 */
  const spendOf = (id: number, y: number) => {
    const p = poNet.get(`${id}:${y}`);
    const j = jsSettle.get(`${id}:${y}`);
    return { poNet: p ?? null, jsSettle: j ?? null, total: p == null && j == null ? null : dAdd(p ?? "0", j ?? "0", 2) };
  };
  const rank = new Map<string, { rank: number; of: number }>(); // `${supplierId}:${year}`
  for (const pool of ["processor", "packaging", "raw"] as SupplierPool[]) {
    for (const y of years) {
      const ranked = suppliers
        .filter((s) => poolOf(s.kinds) === pool)
        .map((s) => ({ id: s.id, total: spendOf(s.id, y).total }))
        .filter((s) => s.total != null && dCmp(s.total, 0) > 0)
        .sort((a, b) => dCmp(b.total!, a.total!) || a.id - b.id);
      ranked.forEach((s, i) => rank.set(`${s.id}:${y}`, { rank: i + 1, of: ranked.length }));
    }
  }

  const rows: SupplierPaymentTermRow[] = suppliers.map((s) => {
    const effectiveDay = shanghaiDay(s.paymentTermEffectiveFrom);
    const termState: PaymentTermState = !s.paymentTermType || !effectiveDay
      || (s.paymentTermType === "monthly_credit" && s.creditDays == null) ? "unknown"
      : effectiveDay > today ? "pending" : "effective";
    const pool = poolOf(s.kinds);
    const spend: SupplierYearSpend[] = years.map((y) => {
      const r = rank.get(`${s.id}:${y}`);
      return { year: y, ...spendOf(s.id, y), rank: r?.rank ?? null, rankOf: r?.of ?? 0 };
    });
    const rCur = spend[0].rank;
    const rPrev = spend[1].rank;
    const rankTrend: RankTrend = rCur == null || rPrev == null ? "unknown" : rCur < rPrev ? "up" : rCur > rPrev ? "down" : "flat";
    const since = firstDay.get(s.id) ?? null;
    const preciseYears = since ? yearsBetween(since, today) : null;
    const cooperationYears = preciseYears == null ? null : Math.round(preciseYears * 100) / 100;
    const longEnough = preciseYears != null && preciseYears >= minYears;
    const candidate = longEnough && rankTrend === "up";
    const reasons: string[] = [];
    if (cooperationYears == null) reasons.push("无已批 PO/JG，合作起始日不可推算");
    else reasons.push(`自 ${since} 合作约 ${cooperationYears} 年（按业务日核算，${longEnough ? "已满" : "未满"} ${minYears} 年）`);
    reasons.push(
      rankTrend === "unknown"
        ? `${year} 或 ${year - 1} 年无池内排名`
        : `池内排名 ${year - 1} 年第 ${rPrev} → ${year} 年第 ${rCur}（${rankTrend === "up" ? "上升" : rankTrend === "down" ? "下降" : "持平"}）`,
    );
    return {
      supplierId: s.id,
      code: s.code,
      name: s.name,
      kinds: s.kinds,
      status: s.status,
      pool,
      cooperationSince: since,
      cooperationSource: since ? "system_inferred" : null,
      cooperationYears,
      spend,
      hasCurrentYearSpend: spend[0].total != null,
      rankTrend,
      candidate,
      candidateReason: reasons.join("；"),
      paymentTermType: s.paymentTermType,
      creditDays: s.creditDays,
      paymentTermEffectiveFrom: s.paymentTermEffectiveFrom,
      paymentTermText: s.paymentTerm,
      attainment: attainmentOf(s.paymentTermType, s.creditDays, targetMinDays, termState),
      termState,
    };
  });

  const poolSummary = (pool: SupplierPool | null): PoolSummary => {
    const subset = pool ? rows.filter((r) => r.pool === pool) : rows;
    let total = "0.00";
    let credit = "0.00";
    let anySpend = false;
    let unclassifiedSpendSuppliers = 0;
    for (const r of subset) {
      const t = r.spend[0].total;
      if (t == null) continue;
      anySpend = true;
      total = dAdd(total, t, 2);
      if (r.termState !== "effective" && dCmp(t, 0) !== 0) unclassifiedSpendSuppliers++;
      if (r.termState === "effective" && r.paymentTermType === "monthly_credit") credit = dAdd(credit, t, 2);
    }
    const candidates = subset.filter((r) => r.candidate);
    const attained = candidates.filter((r) => r.attainment === "attained");
    return {
      pool: pool ?? "raw",
      label: pool ? SUPPLIER_POOL_LABELS[pool] : "全部",
      suppliers: subset.length,
      candidates: candidates.length,
      candidatesAttained: attained.length,
      attainmentRate: candidates.length === 0 ? null : Math.round((attained.length / candidates.length) * 10_000) / 10_000,
      totalSpend: anySpend ? total : null,
      creditTermSpend: anySpend ? credit : null,
      creditTermSpendSharePct: anySpend && unclassifiedSpendSuppliers === 0 && dCmp(total, 0) > 0 ? dMul(dDiv(credit, total, 6), 100, 2) : null,
      unclassifiedSpendSuppliers,
    };
  };
  const all = poolSummary(null);

  return {
    key: SUPPLIER_PAYMENT_TERM_KEY,
    authority: "ledger",
    sourceBinding: await sourceBinding(db, year, params, today),
    builtAt: new Date().toISOString(),
    asOf: today,
    year,
    moneyVisible: true,
    params,
    summary: {
      suppliers: rows.length,
      withSpend: rows.filter((r) => r.spend[0].total != null).length,
      candidates: all.candidates,
      candidatesAttained: all.candidatesAttained,
      attainmentRate: all.attainmentRate,
      creditTermSuppliers: rows.filter((r) => r.termState === "effective" && r.paymentTermType === "monthly_credit").length,
      totalSpend: all.totalSpend,
      creditTermSpend: all.creditTermSpend,
      creditTermSpendSharePct: all.creditTermSpendSharePct,
      unclassifiedSpendSuppliers: all.unclassifiedSpendSuppliers,
      byPool: (["processor", "packaging", "raw"] as SupplierPool[]).map(poolSummary),
    },
    rows: rows.sort((a, b) => Number(b.candidate) - Number(a.candidate) || dCmp(b.spend[0].total ?? "0", a.spend[0].total ?? "0") || a.code.localeCompare(b.code)),
    limitations: [
      `年采购额 = 当年审批通过 PO 行未税额 + 当年生效 JS 结算额（采购订单/结算口径，非应付、非已付）；覆盖 ${year - 2}–${year} 年 SCM 内事实。`,
      "合作起始日由最早已批 PO / JG 建单日系统推算（suppliers 暂无合作起始日列），可能晚于真实合作时间；历史采购额（外部导入）未接入排名。",
      "合作年限按起始业务日周年核算，2月29日在非闰年按2月末；小数年按相邻周年间实际日数折算。展示值四舍五入，但不参与门槛判定。",
      `候选 = 合作 ≥ ${minYears} 年且 ${year} 年池内排名较 ${year - 1} 年上升；分池按 kinds（processor → OA 加工厂，packaging → 包材厂，其余 → 原料商）。`,
      `达标 = 截至 ${today} 已生效的月结且账期 ≥ ${targetMinDays} 天（目标区间 ${targetMinDays}–${targetMaxDays} 天）；未来条款待生效，缺类型/生效日待核对，不提前计达标。达成率仍为已确认达标数÷候选总数。`,
      "档案保存的是最近登记条款，待生效时不猜测此前有效账期；需核对原协议。不是历史条款时间线，也不是谈判关案率。",
      "账期类采购额占比为代理指标（当前有效月结供应商当年采购额 ÷ 全部当年采购额），不是逐单账期或应付余额占比；有采购额的供应商当前条款待核对/待生效时占比留空。已确认月结采购额仅为已分类小计。",
    ],
  };
}

export async function refreshSupplierPaymentTerm(dbArg?: AnyDb): Promise<SupplierPaymentTermModel> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const model = await computeSupplierPaymentTerm(db);
  await db
    .insert(schema.reportReadModelCache)
    .values({ key: SUPPLIER_PAYMENT_TERM_KEY, sourceBinding: model.sourceBinding, payload: model, builtAt: new Date() })
    .onConflictDoUpdate({
      target: schema.reportReadModelCache.key,
      set: { sourceBinding: model.sourceBinding, payload: model, builtAt: new Date() },
    });
  return model;
}

export async function loadSupplierPaymentTerm(dbArg?: AnyDb): Promise<SupplierPaymentTermModel> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = shanghaiDay(new Date())!;
  const year = Number(today.slice(0, 4));
  const binding = await sourceBinding(db, year, await readPaymentTermParams(db), today);
  const [row] = await db
    .select({ payload: schema.reportReadModelCache.payload, sourceBinding: schema.reportReadModelCache.sourceBinding })
    .from(schema.reportReadModelCache)
    .where(eq(schema.reportReadModelCache.key, SUPPLIER_PAYMENT_TERM_KEY));
  if (row && row.sourceBinding === binding) {
    const payload = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Partial<SupplierPaymentTermModel>;
    if (payload?.key === SUPPLIER_PAYMENT_TERM_KEY && payload.summary && payload.rows) return payload as SupplierPaymentTermModel;
  }
  return refreshSupplierPaymentTerm(db);
}

/** 金额出口：非价格角色剥掉采购额（名次、候选、账期保留） */
export function stripSupplierPaymentTermMoney(model: SupplierPaymentTermModel, roles: string[]): SupplierPaymentTermModel {
  if (canSeePrices(roles)) return { ...model, moneyVisible: true };
  const stripPool = (p: PoolSummary): PoolSummary => ({ ...p, totalSpend: null, creditTermSpend: null });
  return {
    ...model,
    moneyVisible: false,
    summary: { ...model.summary, totalSpend: null, creditTermSpend: null, byPool: model.summary.byPool.map(stripPool) },
    rows: model.rows.map((r) => ({ ...r, spend: r.spend.map((s) => ({ ...s, poNet: null, jsSettle: null, total: null })) })),
  };
}
