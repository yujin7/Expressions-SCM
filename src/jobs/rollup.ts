/**
 * E7-01 预聚合构建任务（夜间物化）。
 *
 * 三张汇总表全量重建（幂等 upsert，重跑不产生重复行）：
 * - rollup_sku_month：SKU×月 销量/出入库
 * - rollup_warehouse_sku：仓×SKU 在库 + 近90天出库（调拨建议的需求代理）
 * - rollup_supplier_lead：供应商×SKU 交期分布（**含 leadStdevDays——安全库存的交期波动项**）
 *
 * 纪律：
 * - 汇总是派生数据，可随时重建；真相仍在台账/单据，消费方必须显示 builtAt「数据截至」。
 * - 全量重建而非增量：数据量在十万级，全量更简单且不会因增量漏算而静默失真。
 * - 交期样本口径**复用 leadtime-learning 的既有判定**（PO 创建 → 最早生效 SH 建单），
 *   不另立一套，否则交期学习页与安全库存会各说各话。
 */
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { leadTimeStats } from "@/server/rules/leadtime-stats";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const dec = (v: number | null): string | null => (v == null ? null : String(Math.round(v * 100) / 100));

export interface RollupSummary {
  supplierLeadRows: number;
  builtAt: string;
}

/** 近 N 天的起点（Asia/Shanghai 日界近似用 UTC 偏移，与既有任务同准） */
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

export async function runRollup(db: AnyDb, opts?: { months?: number }): Promise<RollupSummary> {
  const months = Math.max(1, opts?.months ?? 24);
  const now = new Date();

  /* ── ①② 已删除（迁移 0018）──
     原先还构建 rollup_sku_month（2436 行）与 rollup_warehouse_sku（344 行），
     连跑 8 轮、**零读取方**：立项理由「BI 靠 60s 缓存硬撑」经核实不成立
     （那个缓存从未生效），而实测报表 32ms/105ms/23ms 本就不慢。
     汇总表是派生数据可随时重建，将来真有性能证据再按 skill `measure-first` 加回。 ── */

  /* ── ③ 供应商 × SKU 交期分布（安全库存的交期波动来源） ──── */
  // 样本：PO 创建 → 该 (PO,SKU) 最早一张生效 SH 建单（与 leadtime-learning 同口径）
  const poRows: {
    poId: number; supplierId: number; skuId: number; poCreatedAt: Date;
    promised: string | null;
  }[] = await db
    .select({
      poId: schema.poDocs.id,
      supplierId: schema.poDocs.supplierId,
      skuId: schema.poLines.skuId,
      poCreatedAt: schema.poDocs.createdAt,
      promised: sql<string | null>`coalesce(${schema.poLines.expectedDate}, ${schema.poDocs.expectedDate})`,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id));

  const shRows: { poId: number; skuId: number; receivedAt: Date }[] = await db
    .select({
      poId: schema.shDocs.sourceId,
      skuId: schema.shLines.skuId,
      receivedAt: schema.shDocs.createdAt,
    })
    .from(schema.shLines)
    .innerJoin(schema.shDocs, eq(schema.shLines.shId, schema.shDocs.id))
    .where(and(
      eq(schema.shDocs.sourceType, "po"),
      inArray(schema.shDocs.status, ["approved", "in_progress", "completed"]),
    ));
  const earliestReceipt = new Map<string, number>();
  for (const r of shRows) {
    const k = `${r.poId}:${r.skuId}`;
    const t = new Date(r.receivedAt).getTime();
    const cur = earliestReceipt.get(k);
    if (cur == null || t < cur) earliestReceipt.set(k, t);
  }

  const samplesByPair = new Map<string, { supplierId: number; skuId: number; s: { promisedDays: number | null; actualDays: number }[] }>();
  for (const p of poRows) {
    const t = earliestReceipt.get(`${p.poId}:${p.skuId}`);
    if (t == null) continue;
    const start = new Date(p.poCreatedAt).getTime();
    const actualDays = Math.round((t - start) / 86_400_000);
    if (actualDays < 0) continue; // 收货早于制单：历史补录脏数据，丢弃
    const promisedDays = p.promised
      ? Math.round((Date.parse(`${p.promised}T00:00:00Z`) - start) / 86_400_000)
      : null;
    const k = `${p.supplierId}:${p.skuId}`;
    let e = samplesByPair.get(k);
    if (!e) { e = { supplierId: p.supplierId, skuId: p.skuId, s: [] }; samplesByPair.set(k, e); }
    e.s.push({ promisedDays: promisedDays != null && promisedDays >= 0 ? promisedDays : null, actualDays });
  }

  let supplierLeadRows = 0;
  for (const e of samplesByPair.values()) {
    const st = leadTimeStats(e.s);
    await db
      .insert(schema.rollupSupplierLead)
      .values({
        supplierId: e.supplierId, skuId: e.skuId, samples: st.n,
        leadP50Days: dec(st.p50), leadP90Days: dec(st.p90), leadStdevDays: dec(st.stdev),
        onTimeRate: st.onTimeRate == null ? null : String(Math.round(st.onTimeRate * 10000) / 10000),
        builtAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.rollupSupplierLead.supplierId, schema.rollupSupplierLead.skuId],
        set: {
          samples: st.n, leadP50Days: dec(st.p50), leadP90Days: dec(st.p90), leadStdevDays: dec(st.stdev),
          onTimeRate: st.onTimeRate == null ? null : String(Math.round(st.onTimeRate * 10000) / 10000),
          builtAt: now,
        },
      });
    supplierLeadRows++;
  }

  void months;
  void isNotNull;
  return { supplierLeadRows, builtAt: now.toISOString() };
}
