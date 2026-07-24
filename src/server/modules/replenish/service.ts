/**
 * R11 补货建议（成品维度，报表层）。
 *
 * 口径纪律：
 * - R13 doctrine：本页只呈现建议，不自动开单——「生成草稿」由人工点击（人工闸），产物为 BH 草稿走正常审批；
 * - 在库 = 全网口径（D20）：Σ stock_balances（实时账）+ 快照仓最新快照（latest-snapshot 模式与驾驶舱同口径，
 *   本地重实现，不 import report/dashboard.ts）；
 * - 在途 = 已审批/执行中 PO 实物行未收量（基础单位 = qty×uomFactor − receivedQty，逐行下限 0）。
 *   v1 诚实标注：不含 WO/JG 计划产出——成品在途主要来自委外产出，PO 口径偏保守（可能高估需求）；
 * - 日均销 = 近3月销量 ÷ 91（窗口由 sales_monthly max(yearMonth) 动态回推，与驾驶舱同法，本地重推导）；
 * - 建议量 = R11 纯函数（rules/netreq.ts）：净需求 = 毛需求(日均×目标覆盖天数) − 在库 − 在途，
 *   MOQ/订货倍数取 uom_convs 首行（按 id）兜底——与 wo.ts 快照同一 PoC 口径（值按基础单位解释）；无行则纯净需求向上取整由 dQty 收口。
 * - 全表无金额字段，免脱敏。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dDiv, dMul, dQty, dSub } from "@/server/core/decimal";
import { suggestQty } from "@/server/rules/netreq";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { createBh } from "@/server/modules/outsource/bh";
import { requireAnyRole } from "@/server/modules/outsource/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

async function resolveDb(db?: AnyDb): Promise<AnyDb> {
  return db ?? (await getDbAsync());
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const r1 = (v: number): number => Math.round(v * 10) / 10;

/** 由数据最新月动态回推 N 个月（与驾驶舱同法，本地重实现） */
function lastMonths(maxYm: string, n: number): string[] {
  const [y, m] = maxYm.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out.reverse();
}

/** 快照仓最新快照（wh,sku）→ qty（D20；与驾驶舱同模式，本地重实现） */
async function latestSnapshotRows(
  db: AnyDb,
  skuIds: number[],
): Promise<{ warehouseId: number; skuId: number; qty: string; bizDate: string }[]> {
  const s = schema.stockSnapshots;
  const latest = db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, maxDate: sql<string>`max(${s.bizDate})`.as("max_date") })
    .from(s)
    .where(inArray(s.skuId, skuIds))
    .groupBy(s.warehouseId, s.skuId)
    .as("latest");
  return db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, qty: s.qty, bizDate: s.bizDate })
    .from(s)
    .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)));
}

export interface ReplenishRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  /** 全网在库（展示口径，1dp） */
  onHand: number;
  /** PO 在途（展示口径，1dp） */
  inTransit: number;
  /** 近3月日均销（1dp） */
  daily: number;
  /** 可销天数（1dp；日均=0 → null） */
  daysCover: number | null;
  /** R11 建议补货量（qty scale=4）；未触发预警为 null */
  suggestQty: string | null;
}

export interface ReplenishResult {
  rows: ReplenishRow[];
  total: number;
  meta: {
    coverDaysTarget: number;
    minCoverAlert: number;
    months3: string[];
    snapDate: string | null;
    /** 全部成品中触发建议的 SKU 数（不受分页影响） */
    suggestCount: number;
  };
}

export interface ReplenishQuery {
  coverDaysTarget?: number;
  minCoverAlert?: number;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function getReplenishSuggestions(query: ReplenishQuery, dbArg?: AnyDb): Promise<ReplenishResult> {
  const db = await resolveDb(dbArg);
  const coverDaysTarget = Math.min(365, Math.max(1, Math.floor(query.coverDaysTarget ?? 45)));
  const minCoverAlert = Math.min(365, Math.max(1, Math.floor(query.minCoverAlert ?? 30)));
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(999, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim();

  /* ── 成品 SKU（active） ── */
  const conds = [eq(schema.skus.skuType, "finished" as const), eq(schema.skus.active, true)];
  if (q) {
    conds.push(sql`(${schema.skus.code} ILIKE ${"%" + q + "%"} OR ${schema.skus.name} ILIKE ${"%" + q + "%"})`);
  }
  const skuRows: { id: number; code: string; name: string; baseUom: string; brand: string | null }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      baseUom: schema.skus.baseUom,
      brand: schema.brands.nameCn,
    })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(and(...conds));
  if (skuRows.length === 0) {
    return { rows: [], total: 0, meta: { coverDaysTarget, minCoverAlert, months3: [], snapDate: null, suggestCount: 0 } };
  }
  const skuIds = skuRows.map((s) => s.id);

  /* ── 在库：实时账 Σbalances + 快照仓最新快照（全网口径 D20） ── */
  const balRows: { skuId: number; qty: string | null }[] = await db
    .select({ skuId: schema.stockBalances.skuId, qty: sql<string | null>`sum(${schema.stockBalances.qty})` })
    .from(schema.stockBalances)
    .where(inArray(schema.stockBalances.skuId, skuIds))
    .groupBy(schema.stockBalances.skuId);
  const onHandBySku = new Map<number, string>(balRows.map((r) => [r.skuId, r.qty ?? "0"]));
  const snapRows = await latestSnapshotRows(db, skuIds);
  let snapDate: string | null = null;
  for (const r of snapRows) {
    onHandBySku.set(r.skuId, dAdd(onHandBySku.get(r.skuId) ?? "0", r.qty, 6));
    if (snapDate == null || r.bizDate > snapDate) snapDate = r.bizDate;
  }

  /* ── 在途：已审批/执行中 PO 未收量（基础单位，逐行下限 0；与 wo.ts 快照同口径） ── */
  const transitRows: { skuId: number; qty: string; uomFactor: string; receivedQty: string }[] = await db
    .select({
      skuId: schema.poLines.skuId,
      qty: schema.poLines.qty,
      uomFactor: schema.poLines.uomFactor,
      receivedQty: schema.poLines.receivedQty,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .where(and(inArray(schema.poLines.skuId, skuIds), inArray(schema.poDocs.status, ["approved", "in_progress"])));
  const inTransitBySku = new Map<number, string>();
  for (const r of transitRows) {
    const remain = dSub(dMul(r.qty, r.uomFactor, 6), r.receivedQty, 6);
    if (dCmp(remain, "0") <= 0) continue; // 超收行不抵扣其他行
    inTransitBySku.set(r.skuId, dAdd(inTransitBySku.get(r.skuId) ?? "0", remain, 6));
  }

  /* ── 销速：近3月（窗口由 max(yearMonth) 动态回推） ── */
  const sm = schema.salesMonthly;
  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const salesRows: { skuId: number; qty: string | null }[] = months3.length
    ? await db
        .select({ skuId: sm.skuId, qty: sql<string | null>`sum(${sm.qty})` })
        .from(sm)
        .where(and(inArray(sm.skuId, skuIds), inArray(sm.yearMonth, months3)))
        .groupBy(sm.skuId)
    : [];
  const sales3mBySku = new Map<number, string>(salesRows.map((r) => [r.skuId, r.qty ?? "0"]));

  /* ── MOQ/订货倍数：uom_convs 首行（按 id）兜底，值按基础单位解释（与 wo.ts PoC 口径一致） ── */
  const uomRows: { skuId: number; moq: string | null; orderMultiple: string | null }[] = await db
    .select({ skuId: schema.uomConvs.skuId, moq: schema.uomConvs.moq, orderMultiple: schema.uomConvs.orderMultiple })
    .from(schema.uomConvs)
    .where(inArray(schema.uomConvs.skuId, skuIds))
    .orderBy(asc(schema.uomConvs.id));
  const uomBySku = new Map<number, { moq: string | null; orderMultiple: string | null }>();
  for (const u of uomRows) if (!uomBySku.has(u.skuId)) uomBySku.set(u.skuId, u);

  /* ── 逐 SKU 计算（decimal 计算、展示层 Number） ── */
  const all: (ReplenishRow & { _cover: number | null })[] = skuRows.map((s) => {
    const onHand = dQty(onHandBySku.get(s.id) ?? "0");
    const inTransit = dQty(inTransitBySku.get(s.id) ?? "0");
    const sales3m = sales3mBySku.get(s.id) ?? "0";
    const dailyDec = dCmp(sales3m, "0") > 0 ? dDiv(sales3m, "91", 6) : "0";
    const dailyNum = num(dailyDec);
    const cover = dailyNum > 0 ? (num(onHand) + num(inTransit)) / dailyNum : null;

    let suggest: string | null = null;
    if (cover != null && cover < minCoverAlert) {
      const uom = uomBySku.get(s.id);
      const suggested = suggestQty({
        grossReq: dMul(dailyDec, String(coverDaysTarget), 6),
        onHand,
        inTransit,
        moq: uom?.moq ?? null,
        orderMultiple: uom?.orderMultiple ?? null,
      });
      if (dCmp(suggested, "0") > 0) suggest = suggested;
    }
    return {
      skuId: s.id,
      code: s.code,
      name: s.name,
      brand: s.brand,
      baseUom: s.baseUom,
      onHand: r1(num(onHand)),
      inTransit: r1(num(inTransit)),
      daily: r1(dailyNum),
      daysCover: cover == null ? null : r1(cover),
      suggestQty: suggest,
      _cover: cover,
    };
  });

  // 可销天数升序（越紧急越靠前）；无动销（daily=0）排最后，再按编码稳定排序
  all.sort((a, b) => {
    if (a._cover == null && b._cover == null) return a.code.localeCompare(b.code);
    if (a._cover == null) return 1;
    if (b._cover == null) return -1;
    return a._cover - b._cover || a.code.localeCompare(b.code);
  });
  const suggestCount = all.filter((r) => r.suggestQty != null).length;
  const rows: ReplenishRow[] = all.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
    skuId: r.skuId,
    code: r.code,
    name: r.name,
    brand: r.brand,
    baseUom: r.baseUom,
    onHand: r.onHand,
    inTransit: r.inTransit,
    daily: r.daily,
    daysCover: r.daysCover,
    suggestQty: r.suggestQty,
  }));
  return { rows, total: all.length, meta: { coverDaysTarget, minCoverAlert, months3, snapDate, suggestCount } };
}

/* ────────────────────────── 生成 BH 草稿（R13 人工闸） ────────────────────────── */

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字")
  .refine((s) => dCmp(s, "0") > 0, "数量必须大于 0");

export const createReplenishDraftSchema = z.object({
  remark: z.string().trim().max(500).optional(),
  items: z
    .array(z.object({ skuId: z.number().int().positive({ message: "必须选择 SKU" }), qty: decStr }))
    .min(1, "至少选择一项建议")
    .max(200, "一次最多 200 项"),
});
export type CreateReplenishDraftInput = z.infer<typeof createReplenishDraftSchema>;

/**
 * 将勾选的补货建议生成 ONE 张 BH 备货申请草稿（复用 outsource/bh.createBh，走正常审批流）。
 * 权限：pmc（admin 兜底）——本函数即人工闸的授权边界；createBh 内的 ops 门针对 BH 直录路径，
 * 故以补充 ops 角色的委托身份调用（审计仍记真实 userId，另落 replenish 来源审计）。
 */
export async function createReplenishDraft(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ id: number; docNo: string }> {
  requireAnyRole(user, "pmc");
  const v = createReplenishDraftSchema.parse(input);
  const db = await resolveDb(dbArg);

  const delegate: SessionUser = user.roles.includes("ops")
    ? user
    : { ...user, roles: [...user.roles, "ops"] };
  const doc = await createBh(
    delegate,
    {
      remark: v.remark?.trim() ? v.remark.trim() : "由补货建议页生成（R11，人工确认）",
      lines: v.items.map((i) => ({ skuId: i.skuId, qty: i.qty })),
    },
    db,
  );
  // createBh 内已按 bh 实体留痕；此处补一条来源审计（replenish → bh）
  await writeAudit(db, {
    userId: user.id,
    entity: "replenish",
    entityId: doc.id,
    action: "draft_bh",
    after: { docNo: doc.docNo, lineCount: v.items.length, source: "replenish_suggestion" },
  });
  return { id: doc.id, docNo: doc.docNo };
}
