/**
 * D51 库存金额估值——单位成本解析与在库估值的**唯一权威**（core 层，禁止各报表本地重实现）。
 *
 * 单位成本优先级：
 *   1. sku_costs.unit_cost（手工基准，source='sku_costs'，asOf=updated_at）
 *   2. 财务运营成本观察（简道云 finance-operating-cost-observation 最新成功批次的 staging_rows：
 *      payload->'data'->>'productCode' = skus.code，取 useMonth 最新且 operatingCost 数值非空的行；
 *      source='finance_observation'，asOf=useMonth）
 *   3. 两者皆无 → unitCost=null, source=null
 * 批次选择：维表/对照表口径（review/qualityBlocked 不影响），被 supersede 的批次不用（D49）。
 *
 * valueOnHand：Σ在库 × 单位成本（金额 scale 2），并给出按数量的覆盖率——覆盖率 <80%（sys_params，调用方判）时
 * 总额必须标"不完整"，本函数只给数字不做门槛。
 * 返回 Map 仅限 core 层内部消费；进 DTO 前须转 plain object（maskSensitive 不穿透 Map）。
 */
import { inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { type Dec, dAdd, dCmp, dDiv, dMul, dQty } from "@/server/core/decimal";
import type { AnyDb } from "@/server/core/svc";

export const FINANCE_COST_STREAM = "finance-operating-cost-observation";

export type UnitCostSource = "sku_costs" | "finance_observation";

export interface UnitCostResolution {
  /** 单位成本（scale 4）；无来源 → null */
  unitCost: string | null;
  source: UnitCostSource | null;
  /** sku_costs：updated_at ISO；财务观察：useMonth 原文；无 → null */
  asOf: string | null;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** 财务运营成本观察的最新可用批次（维表口径：不看 qualityBlocked；superseded 不用） */
export async function latestFinanceCostBatch(db: AnyDb): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT ir.import_job_id
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${FINANCE_COST_STREAM}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND ij.status <> 'superseded'
    ORDER BY ir.started_at DESC, ir.id DESC
    LIMIT 1
  `);
  const [row] = resultRows<{ import_job_id: unknown }>(result);
  const id = Number(row?.import_job_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function resolveUnitCosts(db: AnyDb, skuIds: number[]): Promise<Map<number, UnitCostResolution>> {
  const out = new Map<number, UnitCostResolution>();
  const ids = [...new Set(skuIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return out;

  const manual: { skuId: number; unitCost: string; updatedAt: Date }[] = await db
    .select({ skuId: schema.skuCosts.skuId, unitCost: schema.skuCosts.unitCost, updatedAt: schema.skuCosts.updatedAt })
    .from(schema.skuCosts)
    .where(inArray(schema.skuCosts.skuId, ids));
  for (const m of manual) {
    out.set(m.skuId, { unitCost: dQty(m.unitCost), source: "sku_costs", asOf: new Date(m.updatedAt).toISOString() });
  }

  const remaining = ids.filter((id) => !out.has(id));
  if (remaining.length > 0) {
    const batch = await latestFinanceCostBatch(db);
    if (batch != null) {
      const idList = sql.join(remaining.map((id) => sql`${id}`), sql`, `);
      const result = await db.execute(sql`
        SELECT DISTINCT ON (s.id) s.id AS sku_id,
          trim(sr.payload->'data'->>'operatingCost') AS operating_cost,
          trim(sr.payload->'data'->>'useMonth') AS use_month
        FROM staging_rows sr
        INNER JOIN skus s ON s.code = trim(sr.payload->'data'->>'productCode')
        WHERE sr.import_job_id = ${batch}
          AND sr.status IN ('pending', 'validated', 'committed')
          AND s.id IN (${idList})
          AND trim(coalesce(sr.payload->'data'->>'operatingCost', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
        ORDER BY s.id, trim(sr.payload->'data'->>'useMonth') DESC NULLS LAST, sr.id DESC
      `);
      for (const r of resultRows<{ sku_id: unknown; operating_cost: string; use_month: string | null }>(result)) {
        const skuId = Number(r.sku_id);
        if (!Number.isFinite(skuId) || out.has(skuId)) continue;
        out.set(skuId, { unitCost: dQty(r.operating_cost), source: "finance_observation", asOf: r.use_month ?? null });
      }
    }
  }

  for (const id of ids) if (!out.has(id)) out.set(id, { unitCost: null, source: null, asOf: null });
  return out;
}

export interface OnHandRow {
  skuId: number;
  qty: Dec;
}

export interface SourceBucket {
  /** 金额 scale 2 */
  amount: string;
  /** 数量 scale 4 */
  qty: string;
  skus: number;
}

export interface ValuationResult {
  /** 有成本 SKU 的 Σ数量 × 单位成本（scale 2） */
  amount: string;
  coveredQty: string;
  uncoveredQty: string;
  /** 按数量的覆盖率 %（2dp）；总量 0 → null */
  coveragePct: number | null;
  coveredSkus: number;
  uncoveredSkus: number;
  /** 无成本的 SKU 清单（补录用） */
  uncoveredSkuIds: number[];
  bySource: Record<UnitCostSource, SourceBucket>;
}

export function valueOnHand(rows: OnHandRow[], unitCosts: Map<number, UnitCostResolution>): ValuationResult {
  const bySource: Record<UnitCostSource, SourceBucket> = {
    sku_costs: { amount: "0.00", qty: "0.0000", skus: 0 },
    finance_observation: { amount: "0.00", qty: "0.0000", skus: 0 },
  };
  const qtyBySku = new Map<number, string>();
  for (const r of rows ?? []) qtyBySku.set(r.skuId, dAdd(qtyBySku.get(r.skuId) ?? "0", r.qty, 4));

  let amount = "0.00";
  let coveredQty = "0.0000";
  let uncoveredQty = "0.0000";
  const uncoveredSkuIds: number[] = [];
  for (const [skuId, qty] of qtyBySku) {
    const c = unitCosts.get(skuId);
    if (c?.unitCost != null && c.source) {
      const v = dMul(qty, c.unitCost, 2);
      amount = dAdd(amount, v, 2);
      coveredQty = dAdd(coveredQty, qty, 4);
      const b = bySource[c.source];
      b.amount = dAdd(b.amount, v, 2);
      b.qty = dAdd(b.qty, qty, 4);
      b.skus += 1;
    } else {
      uncoveredQty = dAdd(uncoveredQty, qty, 4);
      uncoveredSkuIds.push(skuId);
    }
  }
  const totalQty = dAdd(coveredQty, uncoveredQty, 4);
  const coveragePct = dCmp(totalQty, 0) > 0 ? Number(dMul(dDiv(coveredQty, totalQty, 6), 100, 2)) : null;
  return {
    amount,
    coveredQty,
    uncoveredQty,
    coveragePct,
    coveredSkus: qtyBySku.size - uncoveredSkuIds.length,
    uncoveredSkus: uncoveredSkuIds.length,
    uncoveredSkuIds: uncoveredSkuIds.sort((a, b) => a - b),
    bySource,
  };
}
