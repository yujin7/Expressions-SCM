/**
 * 过渡期运营需求提报核对（ops_demand_submissions，D55/R3）。
 *
 * - 提报 = 运营按 SKU×渠道×月 提交的需求量（件），append-only：修正 = 新行 supersedes 旧行（表上 UNIQUE 保证链式单向）。
 *   写路径 ops/pmc（admin 兜底），同事务 writeAudit(entity=ops_demand_submission, action=submit)；
 *   受限用户（D62：channelScope 非空且非 admin）**必须**逐行指定范围内渠道，缺渠道或范围外一律 403；
 *   不受限用户可提不分渠道（channel 空）需求。
 * - 导入：CSV 文本（模板列：SKU编码, 渠道编码, 月份, 数量, 依据）直接解析后走同一写路径；错误逐行返回、整批不落。
 * - 核对：提报量并排**系统基线**——月量基线 = rules/forecast.forecastDaily（Holt，近 6 月序列）的 forecastMonthly；
 *   朴素基线 = 近 3 月月均（core/velocity 月窗）。差异% = (提报 − 基线) ÷ 基线；|差异| ≥ ops_demand_diff_pct（缺省 30）标「需核对」。
 *   基线序列按同一 SKU×渠道（channel 空 = 全渠道汇总）取 sales_monthly，与分层/补货同锚点（core/sales-window）。
 * - 提报**只对照不驱动**：本模块不写建议量、不开单（D43/D55）。全表无金额，免脱敏。
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { resolveChannelScope } from "@/server/core/data-scope";
import { dAdd, dCmp, dDiv, dMul, dQty, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { getNumParam } from "@/server/core/params";
import { salesWindow } from "@/server/core/sales-window";
import { type AnyDb, num, r1, resolveDb } from "@/server/core/svc";
import { lastMonths } from "@/server/core/velocity";
import { ApiError } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { forecastDaily } from "@/server/rules/forecast";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const QTY_RE = /^\d+(\.\d{1,4})?$/;

/* ────────────────────────── CSV 模板与解析 ────────────────────────── */

export const OPS_DEMAND_CSV_HEADERS = ["SKU编码", "渠道编码", "月份", "数量", "依据"] as const;

export interface OpsDemandCsvRow {
  line: number;
  skuCode: string;
  channelCode: string | null;
  period: string;
  qty: string;
  basis: string | null;
}

export interface CsvParseResult {
  rows: OpsDemandCsvRow[];
  errors: { line: number; message: string }[];
}

/** 最小 CSV 解析：支持引号与引号内逗号/换行，UTF-8 BOM；首行表头（中文或英文别名均可） */
export function parseOpsDemandCsv(text: string): CsvParseResult {
  const src = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuote = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ",") { cur.push(field); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      cur.push(field); field = "";
      records.push(cur); cur = [];
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); records.push(cur); }

  const errors: CsvParseResult["errors"] = [];
  const rows: OpsDemandCsvRow[] = [];
  const nonEmpty = records.map((r, idx) => ({ r: r.map((c) => c.trim()), line: idx + 1 })).filter((x) => x.r.some((c) => c !== ""));
  if (nonEmpty.length === 0) return { rows, errors: [{ line: 0, message: "文件为空" }] };
  const header = nonEmpty[0].r.map((h) => h.toLowerCase());
  const col = (names: string[]): number => header.findIndex((h) => names.includes(h));
  const iSku = col(["sku编码", "sku_code", "skucode", "sku"]);
  const iCh = col(["渠道编码", "channel_code", "channel", "渠道"]);
  const iPeriod = col(["月份", "period", "year_month", "月"]);
  const iQty = col(["数量", "qty", "quantity"]);
  const iBasis = col(["依据", "basis", "备注", "note"]);
  if (iSku < 0 || iPeriod < 0 || iQty < 0) {
    return { rows, errors: [{ line: nonEmpty[0].line, message: `表头须包含 ${OPS_DEMAND_CSV_HEADERS.slice(0, 4).join("、")}（渠道编码可空）` }] };
  }
  for (const { r, line } of nonEmpty.slice(1)) {
    const skuCode = r[iSku] ?? "";
    const period = r[iPeriod] ?? "";
    const qty = (r[iQty] ?? "").replace(/,/g, "");
    if (!skuCode) { errors.push({ line, message: "SKU编码为空" }); continue; }
    if (!PERIOD_RE.test(period)) { errors.push({ line, message: `月份「${period}」须为 YYYY-MM` }); continue; }
    if (!QTY_RE.test(qty)) { errors.push({ line, message: `数量「${r[iQty] ?? ""}」须为非负数字（最多 4 位小数）` }); continue; }
    rows.push({
      line,
      skuCode,
      channelCode: iCh >= 0 && r[iCh] ? r[iCh] : null,
      period,
      qty: dQty(qty),
      basis: iBasis >= 0 && r[iBasis] ? r[iBasis] : null,
    });
  }
  return { rows, errors };
}

/* ────────────────────────── 提报写路径 ────────────────────────── */

const submitRowSchema = z.object({
  skuId: z.number().int().positive().optional(),
  skuCode: z.string().trim().min(1).optional(),
  channelId: z.number().int().positive().nullable().optional(),
  channelCode: z.string().trim().nullable().optional(),
  period: z.string().regex(PERIOD_RE, "月份须为 YYYY-MM"),
  qty: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((s) => QTY_RE.test(s), "数量须为非负数字"),
  basis: z.string().trim().max(200).nullable().optional(),
});
const submitSchema = z.object({
  rows: z.array(submitRowSchema).min(1, "至少一行").max(2000, "一次最多 2000 行"),
});
export type SubmitOpsDemandInput = z.infer<typeof submitSchema>;

export interface SubmitResult {
  inserted: number;
  superseded: number;
  /** 与当前有效行数量相同、依据相同 → 不重复落行 */
  unchanged: number;
  ids: number[];
}

/**
 * 提报（整批一个事务：任一行无法解析 → 400 并列出行号，整批不落）。
 * 同 SKU×渠道×月 若已有当前有效行，则新行 supersedes 它；数量与依据均相同时不落新行（幂等）。
 */
export async function submitOpsDemand(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<SubmitResult> {
  requireAnyRole(user, "ops", "pmc");
  const v = submitSchema.parse(input);
  const db = await resolveDb(dbArg);
  // D62：受限渠道用户（channelScope 非空且非 admin）提报必须逐行指定范围内渠道——「不分渠道」会越过范围写入全渠道口径
  const channelRequired = resolveChannelScope(user, null).forced;

  // 解析编码 → id（一次查全）
  const skuCodes = [...new Set(v.rows.flatMap((r) => (r.skuId == null && r.skuCode ? [r.skuCode] : [])))];
  const skuIdsGiven = [...new Set(v.rows.flatMap((r) => (r.skuId != null ? [r.skuId] : [])))];
  const skuRows: { id: number; code: string; active: boolean }[] = skuCodes.length || skuIdsGiven.length
    ? await db
        .select({ id: schema.skus.id, code: schema.skus.code, active: schema.skus.active })
        .from(schema.skus)
        .where(skuCodes.length && skuIdsGiven.length
          ? or(inArray(schema.skus.code, skuCodes), inArray(schema.skus.id, skuIdsGiven))
          : skuCodes.length ? inArray(schema.skus.code, skuCodes) : inArray(schema.skus.id, skuIdsGiven))
    : [];
  const skuByCode = new Map(skuRows.map((s) => [s.code, s]));
  const skuById = new Map(skuRows.map((s) => [s.id, s]));
  const chCodes = [...new Set(v.rows.flatMap((r) => (r.channelId == null && r.channelCode ? [r.channelCode] : [])))];
  const chIdsGiven = [...new Set(v.rows.flatMap((r) => (r.channelId != null ? [r.channelId] : [])))];
  const chRows: { id: number; code: string }[] = chCodes.length || chIdsGiven.length
    ? await db.select({ id: schema.channels.id, code: schema.channels.code }).from(schema.channels)
    : [];
  const chByCode = new Map(chRows.map((c) => [c.code, c.id]));
  const chIds = new Set(chRows.map((c) => c.id));

  const errors: string[] = [];
  const resolved: { skuId: number; channelId: number | null; period: string; qty: string; basis: string | null }[] = [];
  v.rows.forEach((r, idx) => {
    const n = idx + 1;
    const sku = r.skuId != null ? skuById.get(r.skuId) : r.skuCode ? skuByCode.get(r.skuCode) : undefined;
    if (!sku) { errors.push(`第 ${n} 行：SKU「${r.skuCode ?? r.skuId ?? ""}」不存在`); return; }
    if (!sku.active) { errors.push(`第 ${n} 行：SKU「${sku.code}」已停用`); return; }
    let channelId: number | null = null;
    if (r.channelId != null) {
      if (!chIds.has(r.channelId)) { errors.push(`第 ${n} 行：渠道 #${r.channelId} 不存在`); return; }
      channelId = r.channelId;
    } else if (r.channelCode) {
      const id = chByCode.get(r.channelCode);
      if (id == null) { errors.push(`第 ${n} 行：渠道编码「${r.channelCode}」不存在`); return; }
      channelId = id;
    }
    if (channelRequired && channelId == null) {
      throw new ApiError(403, `第 ${n} 行：受限渠道用户提报必须指定渠道（仅限本人范围内），不得提报不分渠道需求`);
    }
    try {
      if (channelId != null) resolveChannelScope(user, channelId); // 范围外渠道 → 403
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) throw new ApiError(403, `第 ${n} 行：无权提报该渠道（不在本人渠道范围内）`);
      throw e;
    }
    resolved.push({ skuId: sku.id, channelId, period: r.period, qty: dQty(r.qty), basis: r.basis?.trim() ? r.basis.trim() : null });
  });
  if (errors.length) throw new ApiError(400, `提报未落库（整批回退）：${errors.slice(0, 20).join("；")}${errors.length > 20 ? `…共 ${errors.length} 条` : ""}`);

  // 同批内同键重复：取最后一行
  const byKey = new Map<string, (typeof resolved)[number]>();
  for (const r of resolved) byKey.set(`${r.skuId}|${r.channelId ?? "all"}|${r.period}`, r);
  const items = [...byKey.values()].sort((a, b) => a.skuId - b.skuId || (a.channelId ?? 0) - (b.channelId ?? 0) || a.period.localeCompare(b.period));

  return db.transaction(async (tx: AnyDb) => {
    const t = schema.opsDemandSubmissions;
    const result: SubmitResult = { inserted: 0, superseded: 0, unchanged: 0, ids: [] };
    for (const it of items) {
      const head = await currentHead(tx, it.skuId, it.channelId, it.period);
      if (head && dCmp(head.qty, it.qty) === 0 && (head.basis ?? null) === it.basis) { result.unchanged += 1; continue; }
      const [row] = await tx
        .insert(t)
        .values({ skuId: it.skuId, channelId: it.channelId, period: it.period, qty: it.qty, basis: it.basis, submittedBy: user.id, supersedesId: head?.id ?? null })
        .returning();
      result.inserted += 1;
      if (head) result.superseded += 1;
      result.ids.push(row.id);
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "ops_demand_submission",
      action: "submit",
      after: { rows: items.length, inserted: result.inserted, superseded: result.superseded, unchanged: result.unchanged, ids: result.ids },
    });
    return result;
  });
}

/** 某键当前有效行（supersedes 链尾 = 未被任何行 supersede 的最新行） */
async function currentHead(db: AnyDb, skuId: number, channelId: number | null, period: string): Promise<{ id: number; qty: string; basis: string | null } | null> {
  const t = schema.opsDemandSubmissions;
  const rows: { id: number; qty: string; basis: string | null; supersedesId: number | null }[] = await db
    .select({ id: t.id, qty: t.qty, basis: t.basis, supersedesId: t.supersedesId })
    .from(t)
    .where(and(eq(t.skuId, skuId), channelId == null ? isNull(t.channelId) : eq(t.channelId, channelId), eq(t.period, period)))
    .orderBy(desc(t.id));
  const superseded = new Set(rows.map((r) => r.supersedesId).filter((x): x is number => x != null));
  const head = rows.find((r) => !superseded.has(r.id));
  return head ? { id: head.id, qty: head.qty, basis: head.basis } : null;
}

/* ────────────────────────── 核对读模型 ────────────────────────── */

/* ────────────────────────── W2-#7 提报处置（接受 / 驳回） ────────────────────────── */

/**
 * 事故形状：本模块把提报与基线并排、标出「需核对」，然后**什么也不发生**——
 * 没有接受/驳回、没有责任人、对下游没有任何影响。一块只读看板，标红的行可以标红一整年。
 *
 * 处置（D55 口径不变，仍**不自动驱动建议量**）：
 *  - accept：把运营那个数记为该 SKU×渠道×月**已达成一致的需求**——它从此是计划员看得见、
 *    可据以行动的输入（补货页仍按引擎口径出建议，人工据此决定是否覆盖目标覆盖天数或直接开单）；
 *  - reject：必须写原因（≥5 字），否则驳回等于沉默。
 * 未处置的 flagged 行由 `projectReconcileReviewItems` 投影成 review_items（有责任角色），
 * 于是它们会真的走到某个人面前，而不是停在看板上。
 */
export const DISPOSE_DECISIONS = ["accepted", "rejected"] as const;
export type OpsDemandDecision = (typeof DISPOSE_DECISIONS)[number];

export const disposeOpsDemandSchema = z.object({
  submissionId: z.number().int().positive({ message: "必须指定提报行" }),
  decision: z.enum(DISPOSE_DECISIONS),
  reason: z.string().trim().max(500).nullable().optional(),
});

export interface OpsDemandDispositionDto {
  decision: OpsDemandDecision;
  agreedQty: string | null;
  reason: string | null;
  by: string | null;
  at: string;
}

export interface ReconcileRow {
  submissionId: number;
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  channelId: number | null;
  channelName: string | null;
  period: string;
  /** 提报量（qty scale 4） */
  submittedQty: string;
  basis: string | null;
  submittedBy: string | null;
  submittedAt: string;
  /** 修正次数（链长 − 1） */
  revisions: number;
  /** 系统基线月量（Holt 预测，qty scale 4；无销量序列 = null） */
  baselineQty: string | null;
  baselineMethod: string;
  /** 朴素基线：近 3 月月均 */
  naiveQty: string | null;
  /** (提报 − 基线) ÷ 基线 × 100（1dp；基线 0/缺 → null） */
  diffPct: number | null;
  /** |diffPct| ≥ 阈值，或基线缺失而提报 >0 */
  flagged: boolean;
  flagReason: string | null;
  /** W2-#7 处置结果；未处置 = null */
  disposition: OpsDemandDispositionDto | null;
  /** flagged 且未处置 —— 这些行会被投影成 review_items（有责任角色）送到人面前 */
  needsDisposition: boolean;
}

export interface ReconcileResult {
  period: string;
  periods: string[];
  rows: ReconcileRow[];
  total: number;
  summary: {
    submissions: number; flagged: number; noBaseline: number; submittedQty: string; baselineQty: string;
    /** W2-#7：标红且尚无处置——真正的待办量 */
    needsDisposition: number; accepted: number; rejected: number;
    /** 已接受为「一致需求」的合计（不驱动数量，只是可见输入） */
    agreedQty: string;
  };
  meta: { thresholdPct: number; months6: string[]; months3: string[]; maxYm: string | null; scopeForced: boolean };
}

export interface ReconcileQuery {
  period?: string | null;
  channelId?: number | null;
  q?: string;
  flaggedOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export async function getReconcile(
  user: Pick<SessionUser, "roles" | "channelScope">,
  query: ReconcileQuery,
  dbArg?: AnyDb,
): Promise<ReconcileResult> {
  const db = await resolveDb(dbArg);
  const t = schema.opsDemandSubmissions;
  const scope = resolveChannelScope(user, query.channelId ?? null);
  const thresholdPct = await getNumParam("ops_demand_diff_pct", 30, db);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();

  const periodRows: { period: string }[] = await db.selectDistinct({ period: t.period }).from(t).orderBy(desc(t.period));
  const periods = periodRows.map((r) => r.period);
  const period = query.period && PERIOD_RE.test(query.period) ? query.period : (periods[0] ?? null);
  const { maxYm } = await salesWindow(db);
  const months6 = maxYm ? lastMonths(maxYm, 6) : [];
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const empty: ReconcileResult = {
    period: period ?? "",
    periods,
    rows: [],
    total: 0,
    summary: { submissions: 0, flagged: 0, noBaseline: 0, submittedQty: "0.0000", baselineQty: "0.0000", needsDisposition: 0, accepted: 0, rejected: 0, agreedQty: "0.0000" },
    meta: { thresholdPct, months6, months3, maxYm, scopeForced: scope.forced },
  };
  if (!period) return empty;

  const raw: {
    id: number; skuId: number; code: string; name: string; brand: string | null; channelId: number | null; channelName: string | null;
    qty: string; basis: string | null; submittedBy: string | null; createdAt: Date; supersedesId: number | null;
  }[] = await db
    .select({
      id: t.id, skuId: t.skuId, code: schema.skus.code, name: schema.skus.name, brand: schema.brands.nameCn,
      channelId: t.channelId, channelName: schema.channels.name, qty: t.qty, basis: t.basis,
      submittedBy: schema.users.name, createdAt: t.createdAt, supersedesId: t.supersedesId,
    })
    .from(t)
    .innerJoin(schema.skus, eq(t.skuId, schema.skus.id))
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .leftJoin(schema.channels, eq(t.channelId, schema.channels.id))
    .leftJoin(schema.users, eq(t.submittedBy, schema.users.id))
    .where(eq(t.period, period));

  // 链尾 = 未被 supersede 的行；修正次数 = 沿 supersedesId 回溯链长 − 1
  const superseded = new Set(raw.map((r) => r.supersedesId).filter((x): x is number => x != null));
  const byId = new Map(raw.map((r) => [r.id, r]));
  const chainLen = (r: (typeof raw)[number]): number => {
    let n = 1;
    let cur = r;
    while (cur.supersedesId != null) {
      const prev = byId.get(cur.supersedesId);
      if (!prev) break;
      n += 1;
      cur = prev;
    }
    return n;
  };
  let heads = raw.filter((r) => !superseded.has(r.id));
  // D62：受限用户只见范围内渠道 + 不分渠道；请求了具体渠道则只看该渠道
  if (query.channelId != null) heads = heads.filter((r) => r.channelId === query.channelId);
  else if (scope.channelIds !== null) heads = heads.filter((r) => r.channelId == null || scope.channelIds!.includes(r.channelId));

  /* ── 基线序列：SKU×渠道（channel 空 = 全渠道汇总）近 6 月 ── */
  const skuIds = [...new Set(heads.map((r) => r.skuId))];
  const seriesByKey = new Map<string, number[]>();
  if (skuIds.length && months6.length) {
    const sm = schema.salesMonthly;
    const rows: { skuId: number; channelId: number; ym: string; qty: string | null }[] = await db
      .select({ skuId: sm.skuId, channelId: sm.channelId, ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
      .from(sm)
      .where(and(inArray(sm.skuId, skuIds), inArray(sm.yearMonth, months6)))
      .groupBy(sm.skuId, sm.channelId, sm.yearMonth);
    const idx = new Map(months6.map((m, i) => [m, i]));
    const bump = (key: string, ym: string, qty: number) => {
      let arr = seriesByKey.get(key);
      if (!arr) { arr = new Array(months6.length).fill(0); seriesByKey.set(key, arr); }
      const i = idx.get(ym);
      if (i != null) arr[i] += qty;
    };
    for (const r of rows) {
      bump(`${r.skuId}|${r.channelId}`, r.ym, num(r.qty));
      bump(`${r.skuId}|all`, r.ym, num(r.qty));
    }
  }

  /* W2-#7 处置：按提报行（链尾）取回，未处置 = null */
  const dispositionBySubmission = new Map<number, OpsDemandDispositionDto>();
  if (heads.length) {
    const d = schema.opsDemandDispositions;
    const rows: { submissionId: number; decision: string; agreedQty: string | null; reason: string | null; by: string | null; at: Date }[] = await db
      .select({ submissionId: d.submissionId, decision: d.decision, agreedQty: d.agreedQty, reason: d.reason, by: schema.users.name, at: d.decidedAt })
      .from(d)
      .leftJoin(schema.users, eq(d.decidedBy, schema.users.id))
      .where(inArray(d.submissionId, heads.map((r) => r.id)));
    for (const r of rows) {
      dispositionBySubmission.set(r.submissionId, {
        decision: r.decision as OpsDemandDecision,
        agreedQty: r.agreedQty,
        reason: r.reason,
        by: r.by,
        at: (r.at instanceof Date ? r.at : new Date(r.at)).toISOString(),
      });
    }
  }

  const all: ReconcileRow[] = heads.map((r) => {
    const series = seriesByKey.get(`${r.skuId}|${r.channelId ?? "all"}`) ?? [];
    const hasSeries = series.some((v) => v > 0);
    const fc = hasSeries ? forecastDaily(series) : null;
    const baselineQty = fc ? dQty(String(fc.forecastMonthly)) : null;
    const last3 = series.slice(-3);
    const naiveQty = hasSeries && last3.length ? dDiv(last3.reduce((acc, b) => dAdd(acc, String(b), 6), "0"), String(last3.length), 4) : null;
    let diffPct: number | null = null;
    if (baselineQty != null && dCmp(baselineQty, "0") > 0) {
      diffPct = r1(num(dMul(dDiv(dSub(r.qty, baselineQty, 6), baselineQty, 6), "100", 6)));
    }
    let flagged = false;
    let flagReason: string | null = null;
    if (baselineQty == null || dCmp(baselineQty, "0") <= 0) {
      if (dCmp(r.qty, "0") > 0) { flagged = true; flagReason = "系统无销量序列（新品/未映射），提报量无基线可比"; }
    } else if (diffPct != null && Math.abs(diffPct) >= thresholdPct) {
      flagged = true;
      flagReason = `提报量较系统基线${diffPct > 0 ? "高" : "低"} ${Math.abs(diffPct)}%（阈值 ${thresholdPct}%）`;
    }
    return {
      submissionId: r.id,
      skuId: r.skuId,
      code: r.code,
      name: r.name,
      brand: r.brand,
      channelId: r.channelId,
      channelName: r.channelName,
      period,
      submittedQty: r.qty,
      basis: r.basis,
      submittedBy: r.submittedBy,
      submittedAt: r.createdAt.toISOString(),
      revisions: chainLen(r) - 1,
      baselineQty,
      baselineMethod: fc ? `holt:${fc.method}` : "none",
      naiveQty,
      diffPct,
      flagged,
      flagReason,
      disposition: dispositionBySubmission.get(r.id) ?? null,
      needsDisposition: flagged && !dispositionBySubmission.has(r.id),
    };
  });

  const summary = {
    submissions: all.length,
    flagged: all.filter((r) => r.flagged).length,
    noBaseline: all.filter((r) => r.baselineQty == null).length,
    submittedQty: all.reduce((s, r) => dAdd(s, r.submittedQty, 4), "0.0000"),
    baselineQty: all.reduce((s, r) => dAdd(s, r.baselineQty ?? "0", 4), "0.0000"),
    needsDisposition: all.filter((r) => r.needsDisposition).length,
    accepted: all.filter((r) => r.disposition?.decision === "accepted").length,
    rejected: all.filter((r) => r.disposition?.decision === "rejected").length,
    agreedQty: all.reduce((s, r) => dAdd(s, r.disposition?.decision === "accepted" ? r.disposition.agreedQty ?? "0" : "0", 4), "0.0000"),
  };
  let filtered = all;
  if (query.flaggedOnly) filtered = filtered.filter((r) => r.flagged);
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  filtered.sort((a, b) => Number(b.flagged) - Number(a.flagged) || Math.abs(b.diffPct ?? 0) - Math.abs(a.diffPct ?? 0) || a.code.localeCompare(b.code));
  return {
    ...empty,
    period,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    summary,
  };
}

/* ────────────────────── W2-#7 处置写路径 + 未处置项投影到复核清单 ────────────────────── */

/**
 * 接受 / 驳回一条提报（ops/pmc，admin 兜底；同事务 writeAudit）。
 *
 * - accepted：把提报量记为该 SKU×渠道×月的**已达成一致的需求**（agreed_qty）。
 *   仍**不自动驱动建议量**（D55/D43）——它成为计划员看得见的输入，动不动量由人决定。
 * - rejected：必须写 ≥5 字原因；没有原因的驳回等于沉默，运营下个月还会提同一个数。
 * 只能处置**当前有效行**（supersedes 链尾）：被 supersede 的旧行已经不是待办对象。
 * 处置一旦落下即关掉对应的复核项（review_items）——待办不能在事情办完后还挂着。
 */
export async function disposeOpsDemand(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ submissionId: number; decision: OpsDemandDecision; agreedQty: string | null }> {
  requireAnyRole(user, "ops", "pmc");
  const v = disposeOpsDemandSchema.parse(input);
  const reason = v.reason?.trim() || null;
  if (v.decision === "rejected" && (reason?.length ?? 0) < 5) {
    throw new ApiError(400, "驳回必须写清原因（至少 5 个字）——没有原因的驳回等于沉默，运营下个月还会提同一个数");
  }
  const db = await resolveDb(dbArg);
  const t = schema.opsDemandSubmissions;
  return db.transaction(async (tx: AnyDb) => {
    const [sub] = await tx.select().from(t).where(eq(t.id, v.submissionId)).limit(1);
    if (!sub) throw new ApiError(404, "提报行不存在");
    const [superseder] = await tx.select({ id: t.id }).from(t).where(eq(t.supersedesId, sub.id)).limit(1);
    if (superseder) throw new ApiError(409, `该提报已被 #${superseder.id} 修正，请处置最新一行`);
    if (sub.channelId != null) resolveChannelScope(user, sub.channelId); // 范围外渠道 → 403

    const d = schema.opsDemandDispositions;
    const [existing] = await tx.select().from(d).where(eq(d.submissionId, sub.id)).limit(1);
    const agreedQty = v.decision === "accepted" ? dQty(sub.qty) : null;
    const values = {
      submissionId: sub.id,
      skuId: sub.skuId,
      channelId: sub.channelId,
      period: sub.period,
      decision: v.decision,
      agreedQty,
      reason,
      decidedBy: user.id,
      decidedAt: new Date(),
    };
    if (existing) {
      await tx.update(d).set(values).where(eq(d.id, existing.id));
    } else {
      await tx.insert(d).values(values);
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "ops_demand_disposition",
      entityId: sub.id,
      action: v.decision,
      before: existing ? { decision: existing.decision, agreedQty: existing.agreedQty, reason: existing.reason } : undefined,
      after: { skuId: sub.skuId, channelId: sub.channelId, period: sub.period, decision: v.decision, agreedQty, reason },
    });

    // 事情办完，复核项跟着关掉（open → done），否则待办会在处置之后继续挂着
    await tx
      .update(schema.reviewItems)
      .set({ status: "done", decidedBy: user.id, decidedAt: new Date(), note: `提报已${v.decision === "accepted" ? "接受为一致需求" : "驳回"}${reason ? `：${reason}` : ""}` })
      .where(and(
        eq(schema.reviewItems.category, OPS_DEMAND_REVIEW_CATEGORY),
        eq(schema.reviewItems.refType, "ops_demand_submission"),
        eq(schema.reviewItems.refKey, String(sub.id)),
        eq(schema.reviewItems.status, "open"),
      ));
    return { submissionId: sub.id, decision: v.decision, agreedQty };
  });
}

/** 复核清单里的类别键——与 rules/task-triggers.REVIEW_OWNER_ROLE 的前缀表同源（责任角色 pmc）。 */
export const OPS_DEMAND_REVIEW_CATEGORY = "ops_demand";

export interface ReconcileProjectionResult {
  scanned: number;
  opened: number;
  closed: number;
  period: string | null;
}

/**
 * 把「标红且未处置」的提报行投影成 review_items（幂等，指纹 = refType+refKey）。
 *
 * 为什么必须投影：核对页是一块看板，标红的行可以标红一整年——没有责任人，就没有人处置。
 * review_items 有责任角色（`rules/task-triggers.reviewOwnerRole`，ops_demand → pmc）并被
 * 待办投影消费，于是这些行会真的走到某个人面前。
 * 反向也成立：已处置 / 已不再标红 / 已被新行 supersede 的复核项立刻关掉，
 * 否则清单会攒下一堆早就不成立的待办。
 */
export async function projectReconcileReviewItems(
  period?: string | null,
  dbArg?: AnyDb,
): Promise<ReconcileProjectionResult> {
  const db = await resolveDb(dbArg);
  // 投影是系统行为，取全渠道口径（不按某个人的范围裁剪）
  const model = await getReconcile({ roles: ["admin"] }, { period: period ?? null, pageSize: 500 }, db);
  if (!model.period) return { scanned: 0, opened: 0, closed: 0, period: null };

  const need = model.rows.filter((r) => r.needsDisposition);
  const needKeys = new Set(need.map((r) => String(r.submissionId)));
  const ri = schema.reviewItems;
  const open: { id: number; refKey: string | null }[] = await db
    .select({ id: ri.id, refKey: ri.refKey })
    .from(ri)
    .where(and(eq(ri.category, OPS_DEMAND_REVIEW_CATEGORY), eq(ri.refType, "ops_demand_submission"), eq(ri.status, "open")));
  const openByKey = new Map(open.map((r) => [r.refKey ?? "", r.id]));

  let opened = 0;
  let closed = 0;
  for (const row of need) {
    const key = String(row.submissionId);
    if (openByKey.has(key)) continue;
    await db.insert(ri).values({
      category: OPS_DEMAND_REVIEW_CATEGORY,
      refType: "ops_demand_submission",
      refKey: key,
      title: `运营提报待处置：${row.code} ${row.period}${row.channelName ? `／${row.channelName}` : "／不分渠道"}`,
      detail: `${row.flagReason ?? "与系统基线差异显著"}；提报 ${row.submittedQty}，系统基线 ${row.baselineQty ?? "无序列"}。请在「运营提报核对」页接受为一致需求或驳回并写明原因（接受不自动驱动建议量）。`,
      status: "open",
    });
    opened += 1;
  }
  for (const [key, id] of openByKey) {
    if (needKeys.has(key)) continue;
    await db.update(ri).set({ status: "done", note: "提报已处置或已不再需要核对（自动关闭）" }).where(eq(ri.id, id));
    closed += 1;
  }
  return { scanned: model.rows.length, opened, closed, period: model.period };
}
