/**
 * D60 调拨线路读模型（缓存键 `transfer-routes/v1`）——驾驶舱屏 3「各调拨线路批次与均价」与
 * `/inventory/transfer-routes` 页**同读同缓存键**；cockpit 不得自推线路。
 *
 * 线路键 = (from, to, transfer_type)；存量未分类单（transfer_type 为空）归入 type="unclassified" 线路，不丢单。
 * 事实来源：
 * - 正式调拨单：stock_docs subtype=transfer 且 status=completed（完成日 = updated_at，Asia/Shanghai 截日）；
 *   件数 = Σ stock_doc_lines.qty（跨 SKU 直加仅作规模参考）。
 * - 费用：transfer_fees 按单据净额（原行 − 红字），只登记过费用的单才进入基线样本（未登记≠零费用）。
 * 规则只消费 `rules/transfer-cost.ts`（唯一权威）：laneBaseline（数量加权均价/中位数/样本数）、
 * deviation（两档：n<8 最多 watch 并标样本不足；n≥8 走 SPC）、qtyAnomaly、scatteredLane。
 * 逐单判定采用留一法（本单不参与自身基线），避免样本极少时自我印证。
 * 参数（/admin/params 可调）：transfer_cost_window_days / transfer_cost_deviation_pct /
 * transfer_qty_deviation_x / transfer_batch_max_docs。
 *
 * source_binding 绑定 stock_docs（max(id) + 调拨单 max(updated_at)）、transfer_fees max(id)、参数值与 asOf 日期；
 * 任一变化即重算。金额键 unitFee/amount 已在 SENSITIVE_FIELDS，其余金额由 stripLaneMoney 按角色置空。
 * 精度：金额 scale 2、数量 scale 4、单位费用 scale 4；全部 decimal 字符串。
 */
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { dAdd, dCmp } from "@/server/core/decimal";
import { getNumParam } from "@/server/core/params";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import {
  deviation,
  type DeviationLevel,
  laneBaseline,
  qtyAnomaly,
  type QtyAnomalyLevel,
  scatteredLane,
  unitFee,
} from "@/server/rules/transfer-cost";
import { TRANSFER_TYPE_LABELS, isTransferType } from "@/lib/transfer-types";

export const TRANSFER_ROUTES_CACHE_KEY = "transfer-routes/v1";
export const UNCLASSIFIED_TRANSFER_TYPE = "unclassified";

const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
export function shanghaiDate(d: Date | string): string {
  return SHANGHAI_DATE.format(typeof d === "string" ? new Date(d) : d);
}

export interface TransferDocFact {
  id: number;
  docNo: string;
  status: string;
  fromWarehouseId: number;
  toWarehouseId: number;
  fromWarehouse: string;
  toWarehouse: string;
  /** null = 存量未分类 */
  transferType: string | null;
  /** 完成日（completed 取 updated_at）；未完成单取创建日 */
  date: string;
  /** Σ 行件数（scale 4） */
  qty: string;
  /** 费用净额（scale 2）；未登记费用 = "0.00" 且 hasFee=false */
  feeNet: string;
  hasFee: boolean;
  feeCount: number;
}

/** 调拨单事实（唯一取数实现，transfer-fees 的录费提醒也走这里） */
export async function loadTransferDocFacts(
  dbArg: AnyDb | undefined,
  opts: { statuses?: string[]; sinceDate?: string } = {},
): Promise<TransferDocFact[]> {
  const db = await resolveDb(dbArg);
  const statuses = opts.statuses ?? ["completed"];
  const lineAgg = db
    .select({
      stockDocId: schema.stockDocLines.stockDocId,
      fromId: sql<number>`min(${schema.stockDocLines.warehouseId})`.as("tr_from_id"),
      toId: sql<number | null>`min(${schema.stockDocLines.toWarehouseId})`.as("tr_to_id"),
      qty: sql<string>`sum(${schema.stockDocLines.qty})`.as("tr_qty"),
    })
    .from(schema.stockDocLines)
    .groupBy(schema.stockDocLines.stockDocId)
    .as("tr_lines");
  const feeAgg = db
    .select({
      stockDocId: schema.transferFees.stockDocId,
      feeNet: sql<string>`sum(${schema.transferFees.amount})`.as("tr_fee_net"),
      // 有效费用条数 = 原始登记 − 红字作废（作废后 feeCount 归 0 → hasFee=false，不再以 0 元/件参与判定）
      feeCount: sql<number>`(count(*) FILTER (WHERE ${schema.transferFees.reversalOfId} IS NULL) - count(*) FILTER (WHERE ${schema.transferFees.reversalOfId} IS NOT NULL))::int`.as("tr_fee_count"),
    })
    .from(schema.transferFees)
    .groupBy(schema.transferFees.stockDocId)
    .as("tr_fees");
  const fromWh = alias(schema.warehouses, "tr_wh_from");
  const toWh = alias(schema.warehouses, "tr_wh_to");
  const conds = [eq(schema.stockDocs.subtype, "transfer")];
  if (statuses.length === 1) conds.push(eq(schema.stockDocs.status, statuses[0] as "completed"));
  else conds.push(sql`${schema.stockDocs.status} IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`);
  if (opts.sinceDate) conds.push(sql`${schema.stockDocs.updatedAt} >= ${`${opts.sinceDate}T00:00:00+08:00`}::timestamptz`);
  const rows: {
    id: number; docNo: string; status: string; transferType: string | null; createdAt: Date; updatedAt: Date;
    fromId: number | null; toId: number | null; fromName: string | null; toName: string | null;
    qty: string | null; feeNet: string | null; feeCount: number | null;
  }[] = await db
    .select({
      id: schema.stockDocs.id,
      docNo: schema.stockDocs.docNo,
      status: schema.stockDocs.status,
      transferType: schema.stockDocs.transferType,
      createdAt: schema.stockDocs.createdAt,
      updatedAt: schema.stockDocs.updatedAt,
      fromId: lineAgg.fromId,
      toId: lineAgg.toId,
      fromName: fromWh.name,
      toName: toWh.name,
      qty: lineAgg.qty,
      feeNet: feeAgg.feeNet,
      feeCount: feeAgg.feeCount,
    })
    .from(schema.stockDocs)
    .leftJoin(lineAgg, eq(lineAgg.stockDocId, schema.stockDocs.id))
    .leftJoin(feeAgg, eq(feeAgg.stockDocId, schema.stockDocs.id))
    .leftJoin(fromWh, eq(lineAgg.fromId, fromWh.id))
    .leftJoin(toWh, eq(lineAgg.toId, toWh.id))
    .where(and(...conds))
    .orderBy(schema.stockDocs.updatedAt, schema.stockDocs.id);
  const out: TransferDocFact[] = [];
  for (const r of rows) {
    if (r.fromId == null || r.toId == null) continue; // 无行/无转入仓的残单不进线路
    const feeCount = Number(r.feeCount ?? 0);
    out.push({
      id: r.id,
      docNo: r.docNo,
      status: r.status,
      fromWarehouseId: r.fromId,
      toWarehouseId: r.toId,
      fromWarehouse: r.fromName ?? `#${r.fromId}`,
      toWarehouse: r.toName ?? `#${r.toId}`,
      transferType: r.transferType ?? null,
      date: shanghaiDate(r.status === "completed" ? r.updatedAt : r.createdAt),
      qty: dAdd(r.qty ?? "0", "0", 4),
      feeNet: dAdd(r.feeNet ?? "0", "0", 2),
      hasFee: feeCount > 0,
      feeCount,
    });
  }
  return out;
}

export function laneKeyOf(fromId: number, toId: number, transferType: string | null): string {
  return `${fromId}>${toId}:${transferType ?? UNCLASSIFIED_TRANSFER_TYPE}`;
}

export function transferTypeLabel(t: string | null): string {
  if (t == null || t === UNCLASSIFIED_TRANSFER_TYPE) return "未分类（存量）";
  return isTransferType(t) ? TRANSFER_TYPE_LABELS[t] : t;
}

export interface TransferRouteParams {
  windowDays: number;
  deviationPct: number;
  qtyDeviationX: number;
  batchMaxDocs: number;
}

export type LaneStatus = "ok" | "watch" | "alert" | "insufficient" | "no_fee";

export interface TransferLaneRow {
  laneKey: string;
  fromWarehouseId: number;
  toWarehouseId: number;
  fromWarehouse: string;
  toWarehouse: string;
  transferType: string;
  transferTypeLabel: string;
  /** 窗口内已完成单数 */
  docCount: number;
  /** 近 30 天单数（零散判定） */
  docCount30: number;
  /** 窗口内 Σ件（scale 4） */
  totalQty: string;
  /** 窗口内 Σ费用净额（scale 2，仅登记过费用的单；角色不可见时 null） */
  amount: string | null;
  /** 数量加权均价 元/件（scale 4；角色不可见时 null） */
  avgUnitFee: string | null;
  /** 单位费用中位数（scale 4；角色不可见时 null） */
  medianUnitFee: string | null;
  /** 有费用登记的样本数（随数值一起输出） */
  samples: number;
  /** 件数中位数（scale 4） */
  medianQty: string | null;
  scattered: boolean;
  /** 最近一单的判定 */
  status: LaneStatus;
  latestDocNo: string | null;
  latestDate: string | null;
  latestDeviationPct: string | null;
  latestZ: number | null;
  statusReason: string;
  recentDocs: TransferLaneRecentDoc[];
}

export interface TransferLaneRecentDoc {
  docId: number;
  docNo: string;
  date: string;
  qty: string;
  /** scale 2；未登记 = null */
  amount: string | null;
  /** scale 4；未登记/件数 0 = null（SENSITIVE 键，按角色剥离） */
  unitFee: string | null;
}

export interface TransferAnomalyRow {
  docId: number;
  docNo: string;
  laneKey: string;
  fromWarehouse: string;
  toWarehouse: string;
  transferType: string;
  transferTypeLabel: string;
  date: string;
  qty: string;
  amount: string | null;
  unitFee: string | null;
  /** 费用偏差判定 */
  feeLevel: DeviationLevel;
  feePctDev: string | null;
  feeZ: number | null;
  feeSamples: number;
  feeInsufficient: boolean;
  feeReason: string;
  /** 数量异常判定 */
  qtyLevel: QtyAnomalyLevel;
  qtyMedian: string | null;
  qtyRatio: string | null;
  qtySamples: number;
  qtyReason: string;
  /** 汇总级别：alert > watch */
  level: "alert" | "watch";
}

export interface TransferRoutesModel {
  key: string;
  builtAt: string;
  asOf: string;
  params: TransferRouteParams;
  windowStart: string;
  summary: {
    laneCount: number;
    docCount: number;
    feeDocCount: number;
    unclassifiedDocCount: number;
    anomalyCount: number;
    alertCount: number;
    scatteredLaneCount: number;
    totalQty: string;
    /** 窗口内 Σ费用（scale 2；角色不可见时 null） */
    amount: string | null;
  };
  lanes: TransferLaneRow[];
  anomalies: TransferAnomalyRow[];
  limitations: string[];
}

async function loadParams(db: AnyDb): Promise<TransferRouteParams> {
  const [windowDays, deviationPct, qtyDeviationX, batchMaxDocs] = await Promise.all([
    getNumParam("transfer_cost_window_days", 180, db),
    getNumParam("transfer_cost_deviation_pct", 20, db),
    getNumParam("transfer_qty_deviation_x", 3, db),
    getNumParam("transfer_batch_max_docs", 4, db),
  ]);
  return { windowDays, deviationPct, qtyDeviationX, batchMaxDocs };
}

function shiftDay(ymd: string, delta: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** 绑定 stock_docs/transfer_fees 的 max(id)、调拨单 max(updated_at)、参数值与 asOf */
export async function transferRoutesBinding(db: AnyDb, params: TransferRouteParams, asOf: string): Promise<string> {
  const [sd] = resultRows<{ max_id: unknown; max_updated: unknown }>(await db.execute(sql`
    SELECT max(id) AS max_id, max(updated_at) AS max_updated FROM stock_docs WHERE subtype = 'transfer'
  `));
  const [tf] = resultRows<{ max_id: unknown }>(await db.execute(sql`SELECT max(id) AS max_id FROM transfer_fees`));
  const upd = sd?.max_updated ? new Date(sd.max_updated as string).toISOString() : "-";
  return `sd:${sd?.max_id ?? 0}:${upd}|tf:${tf?.max_id ?? 0}|p:${params.windowDays},${params.deviationPct},${params.qtyDeviationX},${params.batchMaxDocs}|asOf:${asOf}`;
}

export function computeTransferRoutes(
  facts: TransferDocFact[],
  params: TransferRouteParams,
  asOf: string,
): Omit<TransferRoutesModel, "key" | "builtAt"> {
  const windowStart = shiftDay(asOf, -Math.max(0, Math.trunc(params.windowDays)) + 1);
  const start30 = shiftDay(asOf, -29);
  const inWindow = facts.filter((f) => f.status === "completed" && f.date >= windowStart && f.date <= asOf);
  const byLane = new Map<string, TransferDocFact[]>();
  for (const f of inWindow) {
    const k = laneKeyOf(f.fromWarehouseId, f.toWarehouseId, f.transferType);
    const arr = byLane.get(k) ?? [];
    arr.push(f);
    byLane.set(k, arr);
  }

  const lanes: TransferLaneRow[] = [];
  const anomalies: TransferAnomalyRow[] = [];
  let feeDocCount = 0;
  let unclassifiedDocCount = 0;
  let totalQtyAll = "0.0000";
  let amountAll = "0.00";
  let alertCount = 0;
  let scatteredLaneCount = 0;

  for (const [laneKey, docs] of byLane) {
    docs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    const first = docs[0];
    const typeKey = first.transferType ?? UNCLASSIFIED_TRANSFER_TYPE;
    const feeDocs = docs.filter((d) => d.hasFee);
    const history = feeDocs.map((d) => ({ date: d.date, qty: d.qty, feeTotal: d.feeNet }));
    const base = laneBaseline(history, params.windowDays, asOf);
    let totalQty = "0.0000";
    let amount = "0.00";
    for (const d of docs) {
      totalQty = dAdd(totalQty, d.qty, 4);
      if (d.transferType == null) unclassifiedDocCount += 1;
    }
    for (const d of feeDocs) amount = dAdd(amount, d.feeNet, 2);
    feeDocCount += feeDocs.length;
    totalQtyAll = dAdd(totalQtyAll, totalQty, 4);
    amountAll = dAdd(amountAll, amount, 2);
    const docs30 = docs.filter((d) => d.date >= start30).length;
    const scattered = scatteredLane(docs30, params.batchMaxDocs);
    if (scattered.scattered) scatteredLaneCount += 1;
    const qtyMedian = qtyAnomaly("0", docs.map((d) => ({ qty: d.qty })), params.qtyDeviationX).median;

    /* 逐单判定（留一法） */
    let latestStatus: LaneStatus = feeDocs.length === 0 ? "no_fee" : "ok";
    let latestReason = feeDocs.length === 0 ? "本线路尚未登记费用，无法判定成本" : "";
    let latestPct: string | null = null;
    let latestZ: number | null = null;
    for (const d of docs) {
      const others = feeDocs.filter((o) => o.id !== d.id).map((o) => ({ date: o.date, qty: o.qty, feeTotal: o.feeNet }));
      const ownBase = laneBaseline(others, params.windowDays, asOf);
      const uf = d.hasFee ? unitFee({ feeTotal: d.feeNet, qty: d.qty }) : null;
      const dev = deviation(uf, ownBase, { thresholdPct: params.deviationPct });
      const qa = qtyAnomaly(d.qty, docs.filter((o) => o.id !== d.id).map((o) => ({ qty: o.qty })), params.qtyDeviationX);
      if (d.hasFee) {
        latestStatus = dev.level === "ok" && dev.insufficient ? "insufficient" : dev.level;
        latestReason = dev.reason;
        latestPct = dev.pctDev;
        latestZ = dev.z;
      }
      if (dev.level !== "ok" || qa.level === "watch") {
        const level: "alert" | "watch" = dev.level === "alert" ? "alert" : "watch";
        if (level === "alert") alertCount += 1;
        anomalies.push({
          docId: d.id,
          docNo: d.docNo,
          laneKey,
          fromWarehouse: d.fromWarehouse,
          toWarehouse: d.toWarehouse,
          transferType: typeKey,
          transferTypeLabel: transferTypeLabel(typeKey),
          date: d.date,
          qty: d.qty,
          amount: d.hasFee ? d.feeNet : null,
          unitFee: uf,
          feeLevel: dev.level,
          feePctDev: dev.pctDev,
          feeZ: dev.z,
          feeSamples: dev.samples,
          feeInsufficient: dev.insufficient,
          feeReason: dev.reason,
          qtyLevel: qa.level,
          qtyMedian: qa.median,
          qtyRatio: qa.ratio,
          qtySamples: qa.samples,
          qtyReason: qa.reason,
          level,
        });
      }
    }
    const latest = docs[docs.length - 1];
    const recentDocs: TransferLaneRecentDoc[] = docs.slice(-5).reverse().map((d) => ({
      docId: d.id,
      docNo: d.docNo,
      date: d.date,
      qty: d.qty,
      amount: d.hasFee ? d.feeNet : null,
      unitFee: d.hasFee ? unitFee({ feeTotal: d.feeNet, qty: d.qty }) : null,
    }));
    lanes.push({
      laneKey,
      fromWarehouseId: first.fromWarehouseId,
      toWarehouseId: first.toWarehouseId,
      fromWarehouse: first.fromWarehouse,
      toWarehouse: first.toWarehouse,
      transferType: typeKey,
      transferTypeLabel: transferTypeLabel(typeKey),
      docCount: docs.length,
      docCount30: docs30,
      totalQty,
      amount: feeDocs.length ? amount : null,
      avgUnitFee: base.avgUnitFee,
      medianUnitFee: base.median,
      samples: base.samples,
      medianQty: qtyMedian,
      scattered: scattered.scattered,
      status: latestStatus,
      latestDocNo: latest?.docNo ?? null,
      latestDate: latest?.date ?? null,
      latestDeviationPct: latestPct,
      latestZ,
      statusReason: latestReason,
      recentDocs,
    });
  }

  const rank: Record<LaneStatus, number> = { alert: 0, watch: 1, insufficient: 2, ok: 3, no_fee: 4 };
  lanes.sort((a, b) => b.docCount30 - a.docCount30 || rank[a.status] - rank[b.status] || b.docCount - a.docCount || a.laneKey.localeCompare(b.laneKey));
  anomalies.sort((a, b) => (a.level === b.level ? (a.date < b.date ? 1 : a.date > b.date ? -1 : b.docId - a.docId) : a.level === "alert" ? -1 : 1));

  return {
    asOf,
    params,
    windowStart,
    summary: {
      laneCount: lanes.length,
      docCount: inWindow.length,
      feeDocCount,
      unclassifiedDocCount,
      anomalyCount: anomalies.length,
      alertCount,
      scatteredLaneCount,
      totalQty: totalQtyAll,
      amount: feeDocCount > 0 ? amountAll : null,
    },
    lanes,
    anomalies,
    limitations: [
      `线路 = (转出仓, 转入仓, 调拨类型)；基线 = 同线路近 ${params.windowDays} 天已完成单据的数量加权均价（只计登记过费用的单）。`,
      `偏差 > ${params.deviationPct}% 提醒不阻断；样本 < 8 只提醒并标样本不足，≥ 8 走中位数+MAD 统计判定。`,
      `数量异常 = 本单件数 > 同线路件数中位数 × ${params.qtyDeviationX}（样本 < 8 不判定）；零散 = 近 30 天同线路 > ${params.batchMaxDocs} 单。`,
      "件数为跨 SKU 直加仅作规模参考；费用从上线起累计，不跨线路轧差、不进库存成本。",
      "存量未分类调拨单（transfer_type 为空）归入「未分类」线路，回填后自动归位。",
    ],
  };
}

/** 直接计算并写缓存（看门狗/refresh=1 用） */
export async function refreshTransferRoutes(dbArg?: AnyDb, opts: { asOf?: string } = {}): Promise<TransferRoutesModel> {
  const db = await resolveDb(dbArg);
  const asOf = opts.asOf ?? shanghaiDate(new Date());
  const params = await loadParams(db);
  const binding = await transferRoutesBinding(db, params, asOf);
  const facts = await loadTransferDocFacts(db, { statuses: ["completed"] });
  const model: TransferRoutesModel = { key: TRANSFER_ROUTES_CACHE_KEY, builtAt: new Date().toISOString(), ...computeTransferRoutes(facts, params, asOf) };
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${TRANSFER_ROUTES_CACHE_KEY}, ${binding}, ${JSON.stringify(model)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return model;
}

/** 读模型：命中缓存（key + source_binding）直接返回，否则重算 */
export async function loadTransferRoutes(dbArg?: AnyDb, opts: { asOf?: string; refresh?: boolean } = {}): Promise<TransferRoutesModel> {
  const db = await resolveDb(dbArg);
  const asOf = opts.asOf ?? shanghaiDate(new Date());
  if (!opts.refresh) {
    const params = await loadParams(db);
    const binding = await transferRoutesBinding(db, params, asOf);
    const [row] = resultRows<{ payload: unknown }>(await db.execute(sql`
      SELECT payload FROM report_read_model_cache WHERE key = ${TRANSFER_ROUTES_CACHE_KEY} AND source_binding = ${binding} LIMIT 1
    `));
    const payload = row?.payload;
    const parsed = typeof payload === "string" ? safeJson(payload) : payload;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Partial<TransferRoutesModel>).lanes)) {
      return parsed as TransferRoutesModel;
    }
  }
  return refreshTransferRoutes(db, { asOf });
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** 金额出口：非 PRICE_VISIBLE_ROLES 时把线路级金额置空（unitFee/amount 键另由 maskSensitive 剥离） */
export function stripLaneMoney(model: TransferRoutesModel): TransferRoutesModel {
  return {
    ...model,
    summary: { ...model.summary, amount: null },
    lanes: model.lanes.map((l) => ({
      ...l,
      amount: null,
      avgUnitFee: null,
      medianUnitFee: null,
      latestDeviationPct: null,
      latestZ: null,
      recentDocs: l.recentDocs.map((d) => ({ ...d, amount: null, unitFee: null })),
    })),
    anomalies: model.anomalies.map((a) => ({ ...a, amount: null, unitFee: null, feePctDev: null, feeZ: null })),
  };
}

/** 页面筛选：from/to/type 精确匹配（不改缓存） */
export function filterTransferRoutes(
  model: TransferRoutesModel,
  f: { fromWarehouseId?: number; toWarehouseId?: number; transferType?: string; level?: string },
): TransferRoutesModel {
  const laneOk = (l: { fromWarehouseId: number; toWarehouseId: number; transferType: string }) =>
    (!f.fromWarehouseId || l.fromWarehouseId === f.fromWarehouseId)
    && (!f.toWarehouseId || l.toWarehouseId === f.toWarehouseId)
    && (!f.transferType || l.transferType === f.transferType);
  const lanes = model.lanes.filter(laneOk);
  const keys = new Set(lanes.map((l) => l.laneKey));
  const anomalies = model.anomalies.filter((a) => keys.has(a.laneKey) && (!f.level || a.level === f.level));
  return { ...model, lanes, anomalies };
}

/** 供 cockpit 汇总：线路 TopN（按近 30 天单数） */
export function topLanes(model: TransferRoutesModel, n = 20): TransferLaneRow[] {
  return model.lanes.slice(0, Math.max(0, n));
}

export function hasPositiveFee(lane: TransferLaneRow): boolean {
  return lane.amount != null && dCmp(lane.amount, 0) > 0;
}
