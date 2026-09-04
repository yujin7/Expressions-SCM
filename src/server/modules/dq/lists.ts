/**
 * C10 数据质量页的两条「最后的死号码」清单：
 * - 手工改写（DQ-6）：`sales_amount_monthly` 里 source='manual' 且 supersedes_id 非空的修正行，
 *   即「有人把一个已登记的销售金额改写成另一个值」。之前只有按期计数、点不进去。
 * - 低于量下限（below_floor）：销量一致性里两侧都低于 `minBaseQty` 的 SKU × 完整月行，
 *   它们**不进一致率分母**，所以在总览上只有一个计数；这里给出逐行清单以便判断阈值是否合理。
 *
 * 口径全部沿用既有唯一权威：一致性判定走 `report/sales-consistency.ts`（本模块不重算），
 * 金额只对 PRICE_VISIBLE_ROLES 可见（路由出口再经 maskSensitive 兜底）。
 */
import { sql } from "drizzle-orm";
import { canSeePrices } from "@/server/core/dto";
import { type AnyDb } from "@/server/core/svc";
import {
  computeSalesConsistency,
  type SalesConsistencyRow,
  type SalesConsistencyThresholds,
} from "@/server/modules/report/sales-consistency";

export const DQ_LIST_MAX_PAGE_SIZE = 200;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
}

export interface ManualOverrideRow {
  id: number;
  yearMonth: string;
  scopeKind: string;
  scopeLabel: string;
  /** 改写后的金额；非价格角色 null */
  amount: string | null;
  /** 被替代行的金额；非价格角色 null */
  previousAmount: string | null;
  currency: string;
  note: string | null;
  supersedesId: number;
  createdByName: string | null;
  createdAt: string;
}

export interface ManualOverrideList {
  rows: ManualOverrideRow[];
  total: number;
  page: number;
  pageSize: number;
  moneyVisible: boolean;
  caliber: string;
}

/** 手工改写清单（分页；scopeLabel 由品牌/渠道主档回填，缺失时保留 id 不编名字） */
export async function listManualOverrides(
  db: AnyDb,
  query: { page?: number; pageSize?: number; yearMonth?: string },
  roles: string[],
): Promise<ManualOverrideList> {
  const moneyVisible = canSeePrices(roles);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(DQ_LIST_MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));
  const ym = (query.yearMonth ?? "").trim();
  const ymFilter = /^\d{4}-\d{2}$/.test(ym) ? sql` AND s.year_month = ${ym}` : sql``;

  const [count] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n FROM sales_amount_monthly s
    WHERE s.source = 'manual' AND s.supersedes_id IS NOT NULL${ymFilter}`));
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT s.id, s.year_month, s.scope_kind, s.scope_id, s.amount::text AS amount, s.currency, s.note,
           s.supersedes_id, p.amount::text AS prev_amount,
           u.name AS created_by_name, s.created_at::text AS created_at,
           b.name_cn AS brand_name, c.name AS channel_name
    FROM sales_amount_monthly s
    LEFT JOIN sales_amount_monthly p ON p.id = s.supersedes_id
    LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN brands b ON s.scope_kind = 'brand' AND b.id = s.scope_id
    LEFT JOIN channels c ON s.scope_kind = 'channel' AND c.id = s.scope_id
    WHERE s.source = 'manual' AND s.supersedes_id IS NOT NULL${ymFilter}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`));

  return {
    rows: rows.map((r) => ({
      id: int(r.id),
      yearMonth: str(r.year_month),
      scopeKind: str(r.scope_kind),
      scopeLabel: r.scope_kind === "company"
        ? "全公司"
        : str(r.brand_name) || str(r.channel_name) || `${str(r.scope_kind)}#${int(r.scope_id)}`,
      amount: moneyVisible ? str(r.amount) : null,
      previousAmount: moneyVisible ? (r.prev_amount == null ? null : str(r.prev_amount)) : null,
      currency: str(r.currency) || "CNY",
      note: r.note == null ? null : str(r.note),
      supersedesId: int(r.supersedes_id),
      createdByName: r.created_by_name == null ? null : str(r.created_by_name),
      createdAt: str(r.created_at),
    })),
    total: int(count?.n),
    page,
    pageSize,
    moneyVisible,
    caliber: "手工改写 = sales_amount_monthly 里 source='manual' 且替代了既有行的修正行（append-only 链，原行保留）；独立计数，不进任何准确率分子分母（DQ-6）。",
  };
}

export interface BelowFloorList {
  rows: SalesConsistencyRow[];
  total: number;
  page: number;
  pageSize: number;
  thresholds: SalesConsistencyThresholds;
  months: string[];
  anchorDate: string | null;
  state: "ready" | "insufficient";
  gate: string | null;
  caliber: string;
}

/**
 * 低于量下限清单：直接用一致性读模型的**同一判定函数**实时重算后过滤 below_floor
 * （读模型 payload 只保存例外行，不保存 below_floor 行；这里不另立判定，只是换了个过滤条件）。
 */
export async function listBelowFloor(
  db: AnyDb,
  query: { page?: number; pageSize?: number; month?: string },
): Promise<BelowFloorList> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(DQ_LIST_MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));
  const model = await computeSalesConsistency(db, { keepBelowFloor: true });
  const month = (query.month ?? "").trim();
  const all = (model.belowFloor ?? []).filter((r) => !month || r.month === month);
  return {
    rows: all.slice((page - 1) * pageSize, page * pageSize),
    total: all.length,
    page,
    pageSize,
    thresholds: model.thresholds,
    months: model.comparedMonths,
    anchorDate: model.anchorDate,
    state: model.state,
    gate: model.gate,
    caliber: `低于量下限 = 内部与天猫观察两侧都 < ${model.thresholds.minBaseQty} 件的 SKU × 完整月；这些行不进一致率分母（小样本会同时抬高与拉低一致率）。本清单实时重算，与总览缓存可能相差一次批次。`,
  };
}
