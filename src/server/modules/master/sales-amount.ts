/**
 * 月度销售金额受控表 sales_amount_monthly 的唯一写路径（D53）。
 *
 * - append-only：修正 = 插入新行并 supersedes_id 指向旧行（表上 UNIQUE(supersedes_id) 保证一行只被替代一次，
 *   并发双写靠约束 23505 → 409，不靠预检）；「当前有效行」= 未被任何行 supersede 的链尾；
 * - 写守卫：finance / admin（pmc 只读）；同事务 writeAudit(entity=sales_amount_monthly)；
 * - 预填：从简道云观察算 天猫（支付 − 成功退款）/ 唯品会销售额 / 拼多多店铺成交额 的自然月合计，
 *   标 source=prefill_observation，**只返回建议值不落库**（前端确认后再走 upsert）；
 * - DTO：金额键名 salesAmount（SENSITIVE_FIELDS），非 PRICE_VISIBLE_ROLES 由 maskSensitive 剥离；
 *   预填载荷的金额同样放在敏感键下。
 * 口径（含税 / 退款 / 平台费）待财务追认——本表只记录数字与来源，不做口径换算。
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dAdd, dMoney, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";

export const SALES_AMOUNT_WRITE_ROLES = ["finance"] as const;
export const SALES_AMOUNT_SCOPE_KINDS = ["company", "brand", "channel"] as const;
export type SalesAmountScopeKind = (typeof SALES_AMOUNT_SCOPE_KINDS)[number];
export const SALES_AMOUNT_SOURCES = ["manual", "prefill_observation"] as const;
export type SalesAmountSource = (typeof SALES_AMOUNT_SOURCES)[number];

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONEY_RE = /^-?\d+(\.\d+)?$/;

export const salesAmountInputSchema = z.object({
  yearMonth: z.string().regex(YEAR_MONTH_RE, "月份须为 YYYY-MM"),
  scopeKind: z.enum(SALES_AMOUNT_SCOPE_KINDS),
  scopeId: z.number().int().positive().nullable().optional(),
  amount: z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!MONEY_RE.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "金额须为十进制数" });
      return z.NEVER;
    }
    return dMoney(s);
  }),
  source: z.enum(SALES_AMOUNT_SOURCES).default("manual"),
  sourceRef: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type SalesAmountInput = z.input<typeof salesAmountInputSchema>;

export interface SalesAmountRow {
  id: number;
  yearMonth: string;
  scopeKind: SalesAmountScopeKind;
  scopeId: number | null;
  scopeName: string | null;
  /** 敏感键：非价格可见角色由 maskSensitive 剥离 */
  salesAmount: string;
  currency: string;
  source: SalesAmountSource;
  sourceRef: string | null;
  note: string | null;
  supersedesId: number | null;
  /** 链尾 = 当前有效；true = 已被后续行替代（仅 includeSuperseded 时出现） */
  superseded: boolean;
  createdBy: number;
  createdByName: string | null;
  createdAt: string;
}

export interface ListSalesAmountOptions {
  yearMonth?: string;
  fromMonth?: string;
  toMonth?: string;
  scopeKind?: SalesAmountScopeKind;
  scopeId?: number | null;
  includeSuperseded?: boolean;
  page?: number;
  pageSize?: number;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function canWrite(user: { roles: string[] }): boolean {
  return user.roles.includes("admin") || SALES_AMOUNT_WRITE_ROLES.some((r) => user.roles.includes(r));
}

function assertWriter(user: { roles: string[] }): void {
  if (!canWrite(user)) throw new ApiError(403, "无权限：录入/修正销售金额需要财务或管理员角色");
}

function toRow(r: Record<string, unknown>): SalesAmountRow {
  return {
    id: Number(r.id),
    yearMonth: String(r.year_month),
    scopeKind: String(r.scope_kind) as SalesAmountScopeKind,
    scopeId: r.scope_id == null ? null : Number(r.scope_id),
    scopeName: r.scope_name == null ? null : String(r.scope_name),
    salesAmount: dMoney(String(r.amount)),
    currency: String(r.currency ?? "CNY"),
    source: String(r.source) as SalesAmountSource,
    sourceRef: r.source_ref == null ? null : String(r.source_ref),
    note: r.note == null ? null : String(r.note),
    supersedesId: r.supersedes_id == null ? null : Number(r.supersedes_id),
    superseded: Boolean(r.superseded),
    createdBy: Number(r.created_by),
    createdByName: r.created_by_name == null ? null : String(r.created_by_name),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** 列表（缺省只返回链尾=当前有效行），按月份降序、范围、范围 id */
export async function listSalesAmountMonthly(
  opts: ListSalesAmountOptions = {},
  dbArg?: AnyDb,
): Promise<{ rows: SalesAmountRow[]; total: number; page: number; pageSize: number }> {
  const db = await resolveDb(dbArg);
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 50));
  const conds = [sql`true`];
  if (opts.yearMonth) {
    if (!YEAR_MONTH_RE.test(opts.yearMonth)) throw new ApiError(400, "月份须为 YYYY-MM");
    conds.push(sql`s.year_month = ${opts.yearMonth}`);
  }
  if (opts.fromMonth) {
    if (!YEAR_MONTH_RE.test(opts.fromMonth)) throw new ApiError(400, "起始月份须为 YYYY-MM");
    conds.push(sql`s.year_month >= ${opts.fromMonth}`);
  }
  if (opts.toMonth) {
    if (!YEAR_MONTH_RE.test(opts.toMonth)) throw new ApiError(400, "截止月份须为 YYYY-MM");
    conds.push(sql`s.year_month <= ${opts.toMonth}`);
  }
  if (opts.scopeKind) {
    if (!SALES_AMOUNT_SCOPE_KINDS.includes(opts.scopeKind)) throw new ApiError(400, "范围类型无效");
    conds.push(sql`s.scope_kind = ${opts.scopeKind}`);
  }
  if (opts.scopeId !== undefined) {
    conds.push(opts.scopeId == null ? sql`s.scope_id IS NULL` : sql`s.scope_id = ${opts.scopeId}`);
  }
  if (!opts.includeSuperseded) conds.push(sql`n.id IS NULL`);
  const where = sql.join(conds, sql` AND `);
  const base = sql`
    FROM sales_amount_monthly s
    LEFT JOIN sales_amount_monthly n ON n.supersedes_id = s.id
    LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN brands b ON s.scope_kind = 'brand' AND b.id = s.scope_id
    LEFT JOIN channels c ON s.scope_kind = 'channel' AND c.id = s.scope_id
    WHERE ${where}`;
  const [cnt] = resultRows<{ n: unknown }>(await db.execute(sql`SELECT count(*)::int AS n ${base}`));
  const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT s.id, s.year_month, s.scope_kind, s.scope_id, s.amount, s.currency, s.source, s.source_ref, s.note,
           s.supersedes_id, s.created_by, s.created_at, u.name AS created_by_name,
           CASE s.scope_kind WHEN 'brand' THEN b.name_cn WHEN 'channel' THEN c.name ELSE NULL END AS scope_name,
           (n.id IS NOT NULL) AS superseded
    ${base}
    ORDER BY s.year_month DESC, s.scope_kind, s.scope_id NULLS FIRST, s.id DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `));
  return { rows: rows.map(toRow), total: Number(cnt?.n ?? 0), page, pageSize };
}

async function currentTail(
  tx: AnyDb,
  key: { yearMonth: string; scopeKind: SalesAmountScopeKind; scopeId: number | null },
): Promise<typeof schema.salesAmountMonthly.$inferSelect | null> {
  const s = schema.salesAmountMonthly;
  const rows: (typeof s.$inferSelect)[] = await tx
    .select()
    .from(s)
    .where(and(
      eq(s.yearMonth, key.yearMonth),
      eq(s.scopeKind, key.scopeKind),
      key.scopeId == null ? isNull(s.scopeId) : eq(s.scopeId, key.scopeId),
      sql`NOT EXISTS (SELECT 1 FROM sales_amount_monthly n WHERE n.supersedes_id = ${s.id})`,
    ))
    .orderBy(desc(s.id))
    .limit(1);
  return rows[0] ?? null;
}

async function assertScope(tx: AnyDb, scopeKind: SalesAmountScopeKind, scopeId: number | null | undefined): Promise<number | null> {
  if (scopeKind === "company") {
    if (scopeId != null) throw new ApiError(400, "公司口径不能带范围 id");
    return null;
  }
  if (scopeId == null) throw new ApiError(400, `${scopeKind === "brand" ? "品牌" : "渠道"}口径必须指定范围 id`);
  if (scopeKind === "brand") {
    const [b] = await tx.select({ id: schema.brands.id }).from(schema.brands).where(eq(schema.brands.id, scopeId));
    if (!b) throw new ApiError(404, "品牌不存在");
  } else {
    const [c] = await tx.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.id, scopeId));
    if (!c) throw new ApiError(404, "渠道不存在");
  }
  return scopeId;
}

/**
 * 新增 / 改写（append-only supersedes 链 + 同事务审计）。
 * 与链尾金额、来源、备注完全一致时不插新行（unchanged=true，不写审计），避免重复提交把链拉长。
 */
export async function upsertSalesAmountMonthly(
  actor: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ row: SalesAmountRow; unchanged: boolean; supersededId: number | null }> {
  assertWriter(actor);
  const v = salesAmountInputSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const scopeId = await assertScope(tx, v.scopeKind, v.scopeId);
    const tail = await currentTail(tx, { yearMonth: v.yearMonth, scopeKind: v.scopeKind, scopeId });
    const note = v.note ?? null;
    const sourceRef = v.sourceRef ?? null;
    if (tail && dMoney(tail.amount) === v.amount && tail.source === v.source && (tail.note ?? null) === note && (tail.sourceRef ?? null) === sourceRef) {
      const { rows } = await listSalesAmountMonthly({ yearMonth: v.yearMonth, scopeKind: v.scopeKind, scopeId, includeSuperseded: true, pageSize: 1 }, tx);
      return { row: rows[0], unchanged: true, supersededId: null };
    }
    const [created] = await tx
      .insert(schema.salesAmountMonthly)
      .values({
        yearMonth: v.yearMonth,
        scopeKind: v.scopeKind,
        scopeId,
        amount: v.amount,
        source: v.source,
        sourceRef,
        note,
        supersedesId: tail?.id ?? null,
        createdBy: actor.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "sales_amount_monthly",
      entityId: created.id,
      action: tail ? "supersede" : "create",
      before: tail ? { id: tail.id, yearMonth: tail.yearMonth, scopeKind: tail.scopeKind, scopeId: tail.scopeId, amount: tail.amount, source: tail.source, sourceRef: tail.sourceRef, note: tail.note } : null,
      after: { id: created.id, yearMonth: created.yearMonth, scopeKind: created.scopeKind, scopeId: created.scopeId, amount: created.amount, source: created.source, sourceRef: created.sourceRef, note: created.note, supersedesId: created.supersedesId },
    });
    const { rows } = await listSalesAmountMonthly({ yearMonth: v.yearMonth, scopeKind: v.scopeKind, scopeId, pageSize: 1 }, tx);
    return { row: rows[0], unchanged: false, supersededId: tail?.id ?? null };
  });
}

/* ────────────────────────── 观察预填（不落库） ────────────────────────── */

export type PrefillPlatform = "天猫" | "唯品会" | "拼多多";
export type PrefillChannelCode = "tmall" | "vip" | "pdd";

export interface PrefillPlatformSuggestion {
  platform: PrefillPlatform;
  channelCode: PrefillChannelCode;
  /** channels 主档里同码渠道（无 = null，只能记 company 或手工选范围） */
  channelId: number | null;
  scopeKind: "channel";
  state: "ready" | "partial" | "insufficient";
  /** 建议金额（scale 2；敏感键）；insufficient → null */
  salesAmount: string | null;
  formula: string;
  /** 分项（敏感：金额类均以 *Amount 结尾但不在黑名单——只在 salesAmount 可见时才随载荷返回，见 stripPrefillDetail） */
  detail: Record<string, string | null>;
  rows: number;
  /** 批次内该平台最晚业务日；晚于月末 = 该月已闭合 */
  coverageThrough: string | null;
  importJobIds: number[];
  sourceRef: string;
  gate: string;
}

export interface PrefillSuggestion {
  yearMonth: string;
  authority: "observation_only";
  source: "prefill_observation";
  platforms: PrefillPlatformSuggestion[];
  company: {
    scopeKind: "company";
    /** 可用平台之和；任一平台 insufficient 时 complete=false（仍给出部分和，由录入人决定） */
    salesAmount: string | null;
    complete: boolean;
    missing: PrefillPlatform[];
    sourceRef: string;
  };
  gate: string;
  limitations: string[];
}

const PLATFORM_STREAMS = {
  tmallSales: { stream: "tmall-sku-sales-observation", table: "jdy_tmall_sku_sales_observation" },
  tmallRefund: { stream: "tmall-sku-refund-observation", table: "jdy_tmall_sku_refund_observation" },
  vip: { stream: "vip-shop-trading-observation", table: "jdy_vip_shop_trading_observation" },
  pdd: { stream: "pdd-shop-daily-observation", table: "jdy_pdd_shop_daily_observation" },
} as const;

/**
 * 最新可用批次（与 channel-observation 的平台日快照口径一致：superseded 不用；
 * qualityBlocked 仅当阻断原因是业务键重复/缺失时仍可用，数值非法/对账不符/有删除的批次不用）。
 * channel-observation 未导出其 latestBatch，这里做最小同口径实现，不改他人文件。
 */
async function latestSnapshotBatch(db: AnyDb, stream: string): Promise<number | null> {
  const [row] = resultRows<{ import_job_id: unknown }>(await db.execute(sql`
    SELECT ir.import_job_id FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream} AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND ij.status <> 'superseded'
      AND (coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
           OR (coalesce((ir.request_scope->'controlSummary'->>'invalidNumericValues')::int, 0) = 0
               AND coalesce((ir.request_scope->'controlSummary'->>'reconciliationMismatchedRows')::int, 0) = 0
               AND coalesce((ir.request_scope->'controlSummary'->>'deletedRows')::int, 0) = 0))
    ORDER BY ir.id DESC LIMIT 1
  `));
  const id = Number(row?.import_job_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

interface MonthSum { amount: string | null; rows: number; through: string | null }

async function monthSum(db: AnyDb, jobId: number | null, table: string, field: string, yearMonth: string): Promise<MonthSum> {
  if (jobId == null) return { amount: null, rows: 0, through: null };
  // 平台日快照按业务键去重（statisticalDate × shopName × skuId|brandName），与 channel-observation 同写法：
  // 放行的「重复业务键」批次不能把建议值算大（审阅 must-fix）。
  const [row] = resultRows<{ amount: unknown; n: unknown; through: unknown }>(await db.execute(sql`
    WITH d AS (
      SELECT DISTINCT ON (
          left(payload->'data'->>'statisticalDate', 10), payload->'data'->>'shopName',
          coalesce(payload->'data'->>'skuId', payload->'data'->>'brandName', ''))
        left(payload->'data'->>'statisticalDate', 10) AS day,
        CASE WHEN trim(coalesce(payload->'data'->>${field}, '')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>${field})::numeric ELSE 0 END AS v
      FROM staging_rows
      WHERE import_job_id = ${jobId} AND target_table = ${table} AND status IN ('pending', 'validated', 'committed')
      ORDER BY left(payload->'data'->>'statisticalDate', 10), payload->'data'->>'shopName',
        coalesce(payload->'data'->>'skuId', payload->'data'->>'brandName', ''), row_no DESC
    )
    SELECT round(coalesce(sum(v) FILTER (WHERE left(day, 7) = ${yearMonth}), 0), 2)::text AS amount,
           count(*) FILTER (WHERE left(day, 7) = ${yearMonth})::int AS n,
           max(day) FILTER (WHERE day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') AS through
    FROM d
  `));
  const n = Number(row?.n ?? 0);
  return { amount: n > 0 ? dMoney(String(row?.amount ?? "0")) : null, rows: n, through: row?.through == null ? null : String(row.through) };
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${ym}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 从外部观察算建议值（不落库，前端确认后再 upsert） */
export async function prefillFromObservation(yearMonth: string, dbArg?: AnyDb): Promise<PrefillSuggestion> {
  if (!YEAR_MONTH_RE.test(yearMonth)) throw new ApiError(400, "月份须为 YYYY-MM");
  const db = await resolveDb(dbArg);
  const monthEnd = lastDayOfMonth(yearMonth);
  const [tmallSalesJob, tmallRefundJob, vipJob, pddJob] = await Promise.all([
    latestSnapshotBatch(db, PLATFORM_STREAMS.tmallSales.stream),
    latestSnapshotBatch(db, PLATFORM_STREAMS.tmallRefund.stream),
    latestSnapshotBatch(db, PLATFORM_STREAMS.vip.stream),
    latestSnapshotBatch(db, PLATFORM_STREAMS.pdd.stream),
  ]);
  const [paid, refund, vip, pdd, pddRefund] = await Promise.all([
    monthSum(db, tmallSalesJob, PLATFORM_STREAMS.tmallSales.table, "paidAmount", yearMonth),
    monthSum(db, tmallRefundJob, PLATFORM_STREAMS.tmallRefund.table, "successRefundAmount", yearMonth),
    monthSum(db, vipJob, PLATFORM_STREAMS.vip.table, "salesAmount", yearMonth),
    monthSum(db, pddJob, PLATFORM_STREAMS.pdd.table, "transactionAmount", yearMonth),
    monthSum(db, pddJob, PLATFORM_STREAMS.pdd.table, "refundAmount", yearMonth),
  ]);
  const channelRows: { id: number; code: string }[] = await db
    .select({ id: schema.channels.id, code: schema.channels.code })
    .from(schema.channels)
    .where(sql`${schema.channels.code} IN ('tmall', 'vip', 'pdd')`);
  const channelId = (code: PrefillChannelCode): number | null => channelRows.find((c) => c.code === code)?.id ?? null;
  const stateOf = (amount: string | null, through: string | null): PrefillPlatformSuggestion["state"] =>
    amount == null ? "insufficient" : through != null && through < monthEnd ? "partial" : "ready";

  const tmallAmount = paid.amount == null ? null : dSub(paid.amount, refund.amount ?? "0", 2);
  const tmallThrough = [paid.through, refund.through].filter((x): x is string => x != null).sort()[0] ?? null;
  const platforms: PrefillPlatformSuggestion[] = [
    {
      platform: "天猫", channelCode: "tmall", channelId: channelId("tmall"), scopeKind: "channel",
      state: stateOf(tmallAmount, tmallThrough), salesAmount: tmallAmount,
      formula: "Σ支付金额 − Σ成功退款金额（SKU 日销 + 退款流，最新成功批次）",
      detail: { paidAmount: paid.amount, successRefundAmount: refund.amount },
      rows: paid.rows + refund.rows, coverageThrough: tmallThrough,
      importJobIds: [tmallSalesJob, tmallRefundJob].filter((x): x is number => x != null),
      sourceRef: `jdy:tmall:sales=${tmallSalesJob ?? "none"}:refund=${tmallRefundJob ?? "none"}:${yearMonth}`,
      gate: paid.amount == null ? "缺天猫日销量成功批次或该月无行。" : refund.amount == null ? "退款流缺该月行，按未扣退款计。" : "支付金额未扣平台费；退款按成功退款金额扣减。",
    },
    {
      platform: "唯品会", channelCode: "vip", channelId: channelId("vip"), scopeKind: "channel",
      state: stateOf(vip.amount, vip.through), salesAmount: vip.amount,
      formula: "Σ销售额（店铺 × 品牌 × 日，平台报表口径）",
      detail: { salesAmount: vip.amount },
      rows: vip.rows, coverageThrough: vip.through,
      importJobIds: vipJob == null ? [] : [vipJob],
      sourceRef: `jdy:vip:trading=${vipJob ?? "none"}:${yearMonth}`,
      gate: vip.amount == null ? "唯品会店铺交易流缺该月行。" : "平台报表销售额，未扣退款。",
    },
    {
      platform: "拼多多", channelCode: "pdd", channelId: channelId("pdd"), scopeKind: "channel",
      state: stateOf(pdd.amount, pdd.through), salesAmount: pdd.amount,
      formula: "Σ店铺成交额（店铺日级；成功退款金额另列不扣）",
      detail: { transactionAmount: pdd.amount, refundAmount: pddRefund.amount },
      rows: pdd.rows, coverageThrough: pdd.through,
      importJobIds: pddJob == null ? [] : [pddJob],
      sourceRef: `jdy:pdd:shop_daily=${pddJob ?? "none"}:${yearMonth}`,
      gate: pdd.amount == null ? "拼多多店铺日级交易流缺该月行。" : "店铺成交额（D53），退款未扣、另列参考。",
    },
  ];
  const available = platforms.filter((p) => p.salesAmount != null);
  const missing = platforms.filter((p) => p.salesAmount == null).map((p) => p.platform);
  const companyAmount = available.length === 0 ? null : available.reduce((acc, p) => dAdd(acc, p.salesAmount as string, 2), "0.00");
  return {
    yearMonth,
    authority: "observation_only",
    source: "prefill_observation",
    platforms,
    company: {
      scopeKind: "company",
      salesAmount: companyAmount,
      complete: missing.length === 0 && platforms.every((p) => p.state === "ready"),
      missing,
      sourceRef: platforms.map((p) => p.sourceRef).join(";"),
    },
    gate: "外部观察预填只是建议值：需财务确认后录入；口径（含税/退款/平台费）待财务追认（D53）；不进入任何补货计算。",
    limitations: [
      "三平台口径不同：天猫 = 支付 − 成功退款；唯品会 = 平台销售额；拼多多 = 店铺成交额（退款另列）。",
      "只覆盖已接入简道云的店铺；线下/私域/其他平台需手工补录。",
      "partial = 批次最晚业务日早于月末，该月尚未闭合。",
    ],
  };
}
