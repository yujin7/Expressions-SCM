/**
 * reconcile-jst（W4，《02》§5 / DoD-2）：每日 SKU 级对账，纯函数、可直接单测。
 *
 * 口径（《01》§7.2 + 《02》§6.2）：
 * - sys 侧 = 自有仓发货：stock_ledger 中 action='post' AND source_doc_type='sales_out'
 *   且 occurred_at 落在 bizDate 的 Asia/Shanghai 自然日内，按 SKU 求和取正
 *   （sales_out 过账仅允许实时=自有仓，故无须再按仓过滤）；
 * - jst 侧 = 最近一次导入（同日多次重导取 import_job_id 最大者）的 jst_daily_sales
 *   staging 行（validated|pending，error 拒收行不计），按**运行时** aliases(sku_code)
 *   解析归并——staging 后新认领的别名无须重导即可生效；仍解析不到的行计 unresolvedRows；
 * - diff = sys − jst；upsert recon_diffs UNIQUE(biz_date, sku_id)，|diff|>0 → open，
 *   否则 resolved（重跑覆盖，幂等）；
 * - DoD-2 百分比分母 = jst：|sys−jst|/jst；jst=0 且 sys>0 无法取百分比（分母 0），
 *   单独计入 sysOnly，不参与 maxAbsDiffPct。
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { reconDiffs, stagingRows, stockLedger } from "@/db/schema";
import { resolveAlias, type DimDb } from "@/server/modules/dimension/resolver";
import type { AnyDb } from "@/server/import/staging";

const JST_TARGET_TABLE = "jst_daily_sales";

export interface ReconRow {
  skuId: number;
  sysQty: number;
  jstQty: number;
  diffQty: number;
}

export interface ReconSummary {
  bizDate: string;
  /** 参与对账的 SKU 数（sys ∪ jst） */
  skuCount: number;
  /** diff=0 的 SKU 数 */
  matchedCount: number;
  /** diff≠0 的 SKU 数（含 sysOnly） */
  diffCount: number;
  /** jst=0 且 sys>0：分母为 0，无法计百分比，单列 */
  sysOnly: number;
  /** jst 侧 sku_code 别名仍未解析的 staging 行数 */
  unresolvedRows: number;
  /** max(|diff|/jst)×100（%），仅 jst>0 行；无可计行 → null */
  maxAbsDiffPct: number | null;
}

/** bizDate（YYYY-MM-DD）的 Asia/Shanghai 自然日边界 [start, end) */
export function shanghaiDayBounds(bizDate: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bizDate)) throw new Error(`bizDate 格式须为 YYYY-MM-DD: ${bizDate}`);
  const start = new Date(`${bizDate}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) throw new Error(`bizDate 非法: ${bizDate}`);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

/** Asia/Shanghai 今日/偏移日（cron 默认对 T-1 对账） */
export function shanghaiToday(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const fmt = (n: number): string => n.toFixed(4);

/** 纯汇总（GET 路由复用：从已落库的 recon_diffs 行重算 summary，不触发重跑） */
export function summarizeDiffs(
  bizDate: string,
  rows: { sysQty: number; jstQty: number; diffQty: number }[],
  unresolvedRows: number,
): ReconSummary {
  let matched = 0;
  let diff = 0;
  let sysOnly = 0;
  let maxPct: number | null = null;
  for (const r of rows) {
    if (r.diffQty === 0) {
      matched++;
      continue;
    }
    diff++;
    if (r.jstQty === 0 && r.sysQty > 0) {
      sysOnly++; // 分母 0——不参与百分比
      continue;
    }
    if (r.jstQty > 0) {
      const pct = round4((Math.abs(r.diffQty) / r.jstQty) * 100);
      if (maxPct === null || pct > maxPct) maxPct = pct;
    }
  }
  return {
    bizDate,
    skuCount: rows.length,
    matchedCount: matched,
    diffCount: diff,
    sysOnly,
    unresolvedRows,
    maxAbsDiffPct: maxPct,
  };
}

export async function runReconcileJst(db: AnyDb, bizDate: string): Promise<ReconSummary> {
  const { start, end } = shanghaiDayBounds(bizDate);

  // ── sys 侧：自有仓销售出库流水（qty_delta 为负 → 取正出库量） ──
  const ledger: { skuId: number; qtyDelta: string }[] = await db
    .select({ skuId: stockLedger.skuId, qtyDelta: stockLedger.qtyDelta })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.action, "post"),
        eq(stockLedger.sourceDocType, "sales_out"),
        gte(stockLedger.occurredAt, start),
        lt(stockLedger.occurredAt, end),
      ),
    );
  const sys = new Map<number, number>();
  for (const l of ledger) {
    sys.set(l.skuId, round4((sys.get(l.skuId) ?? 0) - Number(l.qtyDelta)));
  }

  // ── jst 侧：staged 行（validated|pending），同日重导只取最新 job ──
  const staged: { importJobId: number; payload: unknown }[] = await db
    .select({ importJobId: stagingRows.importJobId, payload: stagingRows.payload })
    .from(stagingRows)
    .where(
      and(
        eq(stagingRows.targetTable, JST_TARGET_TABLE),
        inArray(stagingRows.status, ["validated", "pending"]),
        sql`${stagingRows.payload}->>'bizDate' = ${bizDate}`,
      ),
    );
  const latestJob = staged.reduce((m, r) => Math.max(m, r.importJobId), 0);
  const jst = new Map<number, number>();
  let unresolvedRows = 0;
  const aliasCache = new Map<string, number | null>();
  for (const r of staged) {
    if (r.importJobId !== latestJob) continue;
    const p = r.payload as { skuCode?: unknown; qty?: unknown };
    const skuCode = typeof p.skuCode === "string" ? p.skuCode : null;
    const qty = typeof p.qty === "number" ? p.qty : Number(p.qty);
    if (skuCode === null || !Number.isFinite(qty)) {
      unresolvedRows++;
      continue;
    }
    let skuId = aliasCache.get(skuCode);
    if (skuId === undefined) {
      skuId = await resolveAlias(db as DimDb, "sku_code", skuCode);
      aliasCache.set(skuCode, skuId);
    }
    if (skuId === null) {
      unresolvedRows++;
      continue;
    }
    jst.set(skuId, round4((jst.get(skuId) ?? 0) + qty));
  }

  // ── 合并 + upsert（UNIQUE(biz_date, sku_id)，重跑幂等覆盖） ──
  const skuIds = [...new Set([...sys.keys(), ...jst.keys()])].sort((a, b) => a - b);
  const rows: ReconRow[] = skuIds.map((skuId) => {
    const s = sys.get(skuId) ?? 0;
    const j = jst.get(skuId) ?? 0;
    return { skuId, sysQty: s, jstQty: j, diffQty: round4(s - j) };
  });
  for (const r of rows) {
    await db
      .insert(reconDiffs)
      .values({
        bizDate,
        skuId: r.skuId,
        sysQty: fmt(r.sysQty),
        jstQty: fmt(r.jstQty),
        diffQty: fmt(r.diffQty),
        status: r.diffQty !== 0 ? "open" : "resolved",
      })
      .onConflictDoUpdate({
        target: [reconDiffs.bizDate, reconDiffs.skuId],
        set: {
          sysQty: fmt(r.sysQty),
          jstQty: fmt(r.jstQty),
          diffQty: fmt(r.diffQty),
          status: r.diffQty !== 0 ? "open" : "resolved",
        },
      });
  }

  return summarizeDiffs(bizDate, rows, unresolvedRows);
}
