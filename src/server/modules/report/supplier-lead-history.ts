/**
 * 历史采购交期观察 `supplier-lead-history/v2`（B4）。
 *
 * 为什么需要它：本系统今年只有 1 张 PO，`rollup_supplier_lead`（「系统学习交期」）几乎无样本，
 * 于是安全库存与预警阈值只能信人工档案值。而简道云的两条历史流
 * `purchase-order-observation` / `purchase-receipt-observation` 早已同步进 staging、
 * **一个读模型都没有读过**（2026-09-04 BI 审计 Part 2/Part 3）：那里有真实的
 * 「下单 → 入库」历史，是本系统自身 PO 记录之前唯一的交期证据。
 *
 * ── 纪律（不可协商）──
 *   - `authority: "observation_only"`：只提示、只对照，**绝不写 sku_params / rollup_supplier_lead
 *     或任何主档**，也绝不进补货数量与安全库存（D55）。本模块没有任何写路径。
 *   - 与本系统自己的 `rollup_supplier_lead` **并列展示、绝不合并**：两条证据线口径不同
 *     （系统学习 = po_docs.created_at → sh_docs.created_at；历史观察 = 简道云单据日期），
 *     合并会造出一个谁都无法追溯的「平均交期」。
 *   - 外部身份不自动认领：供应商用同步期已解析的 `_identity.supplierId`，未解析的按源名称单列；
 *     子表商品编码与 `skus.code` 精确相等才算映射（与 core/valuation 的财务成本观察同法），
 *     不按名称猜、不写 platform_sku_claim。
 *   - 无任何金额字段进入读模型（源单据有金额，本模块一律不取）→ 免脱敏。
 *
 * ── 样本口径（字段名全部取自 integrations/jiandaoyun-contracts.ts，未自造）──
 *   起算日：采购订单 `signedAt`（签订日期）；缺失时回落 `approvedAt`（审批通过日期），
 *           两者皆缺 → 该单不产生样本（不猜）。
 *   承诺到货日：采购订单 `deliveryAt`（交货日期）；缺失 → 该样本只进交期分布，不进准时率/延误分母。
 *   实际收货日：采购入库 `receivedAt`（入库日期）；缺失时回落 `inspectedAt`（验货日期）。
 *              同一单据键的多次入库取**最早**一次（首批到货即视为交付达成，与
 *              report/leadtime-learning 的系统侧口径一致，避免尾批拖尾污染分布）。
 *   单据键：入库单 `purchaseOrderNo` = 采购订单 `orderNo`（契约里两张表唯一的显式关联）。
 *   SKU 粒度：订单子表 `lines[].productCode` 与入库子表 `lines[].productCode` 相等时，
 *            按 (orderNo, productCode) 取该品的最早入库日；否则只出供应商粒度。
 *   负交期（收货早于下单，多为历史补录）直接丢弃。
 *   日期归一：简道云给的是 ISO UTC 时刻串，统一按 Asia/Shanghai 取日界后再相减。
 *
 * ── 批次口径 ──
 *   两条契约都无 `contract.window`（全量快照），旧批次会被 supersede 退役，因此只取
 *   **成功且未被 supersede** 的批次，跨批次按 `sourceRecordId` 去重取最新。
 *   这里**不**按 `qualityBlocked` 拦批：生产实核的质量问题是「表头/明细金额不一致」
 *   （21 单中 15 单），而本读模型一个金额字段都不取，日期/数量不受该缺陷影响；
 *   金额缺陷仍由数据质量页与放行门负责，不在此处二次裁决。
 */
import { sql, type SQL } from "drizzle-orm";

import { getNumParam } from "@/server/core/params";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import {
  alertDays as computeAlertDays, leadBasisText, leadCompareText,
  type LearnedLead, type LearnedLeadObservation, type ObservedLeadHistory, type ObservedLeadObservation,
} from "@/server/rules/alert-threshold";
import { leadTimeStats, type LeadTimeSample } from "@/server/rules/leadtime-stats";

/**
 * v2（口径升版，旧缓存不再命中）：
 * - 供应商行的样本加权准时率改用**可评样本**作分母（`rollup_supplier_lead.on_time_rate` 可空，
 *   此前未测量的对子照样进分母，把「1 对已测 100%、1 对未测」渲染成 50%）；
 * - source_binding 补上 sys_params 运行参数与 skus 指纹（见 `binding()`）。
 */
export const SUPPLIER_LEAD_HISTORY_CACHE_KEY = "supplier-lead-history/v2";

const ORDER_STREAM = "purchase-order-observation";
const RECEIPT_STREAM = "purchase-receipt-observation";
const ORDER_TABLE = "jdy_purchase_order_observation";
const RECEIPT_TABLE = "jdy_purchase_receipt_observation";
/** 供应商 × SKU 行上限（页面展示用；供应商粒度不截断） */
const MAX_SKU_ROWS = 500;
/** 出分布的最小样本数（低于此仍展示，但标注样本不足） */
export const LEAD_HISTORY_MIN_SAMPLES = 3;

/** 交期分布（复用 rules/leadtime-stats，口径与系统侧学习交期同一套统计） */
export interface LeadHistoryStats {
  samples: number;
  /** 有承诺交货日、可判准时的样本数 */
  promisedSamples: number;
  p50: number | null;
  p90: number | null;
  mean: number | null;
  stdev: number | null;
  onTimeRate: number | null;
  avgDelayDays: number | null;
}

/** 系统侧（rollup_supplier_lead）同粒度对照值；无物化结果 = null */
export interface SystemLeadSide {
  samples: number;
  p50: number | null;
  p90: number | null;
  stdev: number | null;
  onTimeRate: number | null;
}

export interface SupplierLeadHistoryRow {
  /** 稳定行键：解析到系统供应商用 `id:<n>`，否则 `name:<源名称>` */
  supplierKey: string;
  /** 同步期 `_identity.supplierId`；未认领 = null（不猜） */
  supplierId: number | null;
  supplierName: string;
  supplierCode: string | null;
  /** 观察到的采购订单数（去重后，且有可用下单日——无下单日的单不进任何分母） */
  orders: number;
  /** 其中匹配到入库观察的订单数 */
  ordersWithReceipt: number;
  observed: LeadHistoryStats;
  firstReceiptDate: string | null;
  lastReceiptDate: string | null;
  /**
   * 系统侧对照：rollup_supplier_lead 是 (供应商 × SKU) 粒度，**分布无法向上聚合**，
   * 故供应商行只给对数与样本合计，以及样本加权准时率（比率可加权，分位数不可）。
   * `on_time_rate` 可空（该对子没测出准时率）：这些样本计入 `samples`，但**不进加权分母**——
   * 分母只用 `ratedSamples`，否则未测量的对子会被当成 0% 把准时率系统性拉低。
   */
  system: { pairs: number; samples: number; ratedSamples: number; onTimeRate: number | null } | null;
}

export interface SupplierSkuLeadHistoryRow {
  key: string;
  supplierKey: string;
  supplierId: number | null;
  supplierName: string;
  /** 源子表商品编码（原值回显） */
  productCode: string;
  productName: string | null;
  /** 与 skus.code 精确相等时的系统 SKU；未映射 = null */
  skuId: number | null;
  skuCode: string | null;
  skuName: string | null;
  observed: LeadHistoryStats;
  firstReceiptDate: string | null;
  lastReceiptDate: string | null;
  /** 系统侧 rollup_supplier_lead 同 (供应商, SKU) 行；无 = null */
  system: SystemLeadSide | null;
  /** 档案加工周期（sku_params.normal_lead_days）；未映射/未维护 = null */
  archiveLeadDays: number | null;
  /** 现行预警阈值（rules/alert-threshold，**本模块不改它**） */
  alertDays: number | null;
  /** 阈值依据文案（含三来源并列段） */
  alertBasis: string | null;
  /** 「档案 X / 系统学习 Y(n=..) / 历史观察 Z(n=..)」；无观察项命中 = null */
  leadCompare: string | null;
  learned: LearnedLeadObservation | null;
  observedObservation: ObservedLeadObservation | null;
}

export interface SupplierLeadHistory {
  key: typeof SUPPLIER_LEAD_HISTORY_CACHE_KEY;
  authority: "observation_only";
  source: "JIANDAOYUN";
  streams: [typeof ORDER_STREAM, typeof RECEIPT_STREAM];
  state: "ready" | "insufficient";
  builtAt: string;
  sourceBinding: string;
  sourceAsOf: string | null;
  batches: { orders: number; receipts: number };
  minSamples: number;
  totals: {
    /** 去重后、有可用下单日的订单数（无下单日的单既不进分子也不进分母） */
    orders: number;
    ordersWithReceipt: number;
    receipts: number;
    /** 供应商粒度样本数（= 匹配到入库的订单数） */
    samples: number;
    suppliers: number;
    /** 其中已解析到系统供应商主档的行数 */
    suppliersMapped: number;
    skuPairs: number;
    skuPairsMapped: number;
    /** 订单匹配到入库观察的比例（%，1dp）；无订单 = null */
    matchRatePct: number | null;
  };
  bySupplier: SupplierLeadHistoryRow[];
  bySupplierSku: SupplierSkuLeadHistoryRow[];
  gate: string;
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown): number | null => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const text = (v: unknown): string | null => { const t = v == null ? "" : String(v).trim(); return t ? t : null; };
const r1 = (v: number): number => Math.round(v * 10) / 10;

/** 简道云日期串 → Asia/Shanghai 日界 date；无法解析 → NULL（不猜、不补零） */
function shanghaiDate(expr: SQL): SQL {
  return sql`CASE
    WHEN ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN ((${expr})::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
    WHEN left(${expr}, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN left(${expr}, 10)::date
    ELSE NULL END`;
}

/** 成功且未被 supersede 的批次（全量快照契约：不做时间回看窗口） */
async function eligibleBatches(db: AnyDb, stream: string): Promise<{ importJobId: number; sourceAsOf: string | null }[]> {
  const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND ij.status <> 'superseded'
    ORDER BY ir.import_job_id DESC
  `));
  return rows
    .map((r) => ({ importJobId: num(r.import_job_id), sourceAsOf: r.source_as_of == null ? null : String(r.source_as_of).slice(0, 10) }))
    .filter((r) => r.importJobId > 0);
}

interface OrderLineRow {
  order_no: string | null;
  supplier_name: string | null;
  supplier_code: string | null;
  supplier_id: number | null;
  ordered_on: string | null;
  promised_on: string | null;
  product_code: string | null;
  product_name: string | null;
}

interface ReceiptLineRow {
  order_no: string | null;
  receipt_no: string | null;
  received_on: string | null;
  product_code: string | null;
}

const DEDUPE_KEY = sql`coalesce(payload->>'sourceRecordId', import_job_id::text || ':' || row_no::text)`;

function empty(gate: string, batches: { orders: number; receipts: number }): SupplierLeadHistory {
  return {
    key: SUPPLIER_LEAD_HISTORY_CACHE_KEY, authority: "observation_only", source: "JIANDAOYUN",
    streams: [ORDER_STREAM, RECEIPT_STREAM], state: "insufficient",
    builtAt: new Date().toISOString(), sourceBinding: "", sourceAsOf: null, batches,
    minSamples: LEAD_HISTORY_MIN_SAMPLES,
    totals: { orders: 0, ordersWithReceipt: 0, receipts: 0, samples: 0, suppliers: 0, suppliersMapped: 0, skuPairs: 0, skuPairsMapped: 0, matchRatePct: null },
    bySupplier: [], bySupplierSku: [], gate, limitations: [gate],
  };
}

function toStats(samples: LeadTimeSample[]): LeadHistoryStats {
  const s = leadTimeStats(samples);
  return {
    samples: s.n,
    promisedSamples: samples.filter((x) => x.promisedDays != null).length,
    p50: s.p50, p90: s.p90, mean: s.mean, stdev: s.stdev, onTimeRate: s.onTimeRate, avgDelayDays: s.avgDelayDays,
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export async function computeSupplierLeadHistory(dbArg?: AnyDb): Promise<SupplierLeadHistory> {
  const db = await resolveDb(dbArg);
  const [orderBatches, receiptBatches] = await Promise.all([
    eligibleBatches(db, ORDER_STREAM),
    eligibleBatches(db, RECEIPT_STREAM),
  ]);
  const batches = { orders: orderBatches.length, receipts: receiptBatches.length };
  if (orderBatches.length === 0 || receiptBatches.length === 0) {
    return empty("历史采购订单/入库观察尚未同步（两条流都要有可用批次），历史交期观察保持关闭。", batches);
  }
  const orderJobs = sql.join(orderBatches.map((b) => sql`${b.importJobId}`), sql`, `);
  const receiptJobs = sql.join(receiptBatches.map((b) => sql`${b.importJobId}`), sql`, `);

  const orderRows = resultRows<OrderLineRow>(await db.execute(sql`
    WITH raw AS (
      SELECT DISTINCT ON (${DEDUPE_KEY}) payload
      FROM staging_rows
      WHERE import_job_id IN (${orderJobs}) AND target_table = ${ORDER_TABLE}
        AND status IN ('pending', 'validated', 'committed')
      ORDER BY ${DEDUPE_KEY}, import_job_id DESC, row_no DESC
    )
    SELECT
      nullif(trim(raw.payload->'data'->>'orderNo'), '') AS order_no,
      nullif(trim(raw.payload->'data'->>'supplierName'), '') AS supplier_name,
      nullif(trim(raw.payload->'data'->>'supplierCode'), '') AS supplier_code,
      (raw.payload->'_identity'->>'supplierId')::int AS supplier_id,
      coalesce(
        ${shanghaiDate(sql`nullif(trim(raw.payload->'data'->>'signedAt'), '')`)},
        ${shanghaiDate(sql`nullif(trim(raw.payload->'data'->>'approvedAt'), '')`)}
      )::text AS ordered_on,
      (${shanghaiDate(sql`nullif(trim(raw.payload->'data'->>'deliveryAt'), '')`)})::text AS promised_on,
      nullif(trim(l.item->>'productCode'), '') AS product_code,
      nullif(trim(l.item->>'productName'), '') AS product_name
    FROM raw
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(raw.payload->'data'->'lines') = 'array' THEN raw.payload->'data'->'lines' ELSE '[]'::jsonb END
    ) AS l(item) ON true
  `));

  const receiptRows = resultRows<ReceiptLineRow>(await db.execute(sql`
    WITH raw AS (
      SELECT DISTINCT ON (${DEDUPE_KEY}) payload
      FROM staging_rows
      WHERE import_job_id IN (${receiptJobs}) AND target_table = ${RECEIPT_TABLE}
        AND status IN ('pending', 'validated', 'committed')
      ORDER BY ${DEDUPE_KEY}, import_job_id DESC, row_no DESC
    )
    SELECT
      nullif(trim(raw.payload->'data'->>'purchaseOrderNo'), '') AS order_no,
      nullif(trim(raw.payload->'data'->>'receiptNo'), '') AS receipt_no,
      coalesce(
        ${shanghaiDate(sql`nullif(trim(raw.payload->'data'->>'receivedAt'), '')`)},
        ${shanghaiDate(sql`nullif(trim(raw.payload->'data'->>'inspectedAt'), '')`)}
      )::text AS received_on,
      nullif(trim(l.item->>'productCode'), '') AS product_code
    FROM raw
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(raw.payload->'data'->'lines') = 'array' THEN raw.payload->'data'->'lines' ELSE '[]'::jsonb END
    ) AS l(item) ON true
  `));

  /* ── 订单表头（去重）与订单行 ── */
  interface OrderHead { orderNo: string; supplierKey: string; supplierId: number | null; supplierName: string; supplierCode: string | null; orderedOn: string; promisedOn: string | null; products: Set<string>; productNames: Map<string, string> }
  const orders = new Map<string, OrderHead>();
  for (const r of orderRows) {
    const orderNo = text(r.order_no);
    const orderedOn = text(r.ordered_on);
    if (!orderNo || !orderedOn) continue; // 无单号或无下单日 → 不产生样本
    const supplierId = numOrNull(r.supplier_id);
    const supplierName = text(r.supplier_name) ?? (supplierId != null ? `#${supplierId}` : "(未填供应商)");
    const head = orders.get(orderNo) ?? {
      orderNo,
      supplierKey: supplierId != null ? `id:${supplierId}` : `name:${supplierName}`,
      supplierId, supplierName, supplierCode: text(r.supplier_code),
      orderedOn, promisedOn: text(r.promised_on),
      products: new Set<string>(), productNames: new Map<string, string>(),
    };
    const code = text(r.product_code);
    if (code) {
      head.products.add(code);
      const nm = text(r.product_name);
      if (nm && !head.productNames.has(code)) head.productNames.set(code, nm);
    }
    orders.set(orderNo, head);
  }

  /* ── 入库：按单号取最早收货日；按 (单号, 商品编码) 取该品最早收货日 ── */
  const receiptByOrder = new Map<string, string>();
  const receiptByOrderProduct = new Map<string, string>();
  const receiptDocs = new Set<string>();
  for (const r of receiptRows) {
    const orderNo = text(r.order_no);
    const receivedOn = text(r.received_on);
    if (text(r.receipt_no)) receiptDocs.add(String(r.receipt_no));
    if (!orderNo || !receivedOn) continue;
    const prev = receiptByOrder.get(orderNo);
    if (!prev || receivedOn < prev) receiptByOrder.set(orderNo, receivedOn);
    const code = text(r.product_code);
    if (code) {
      const k = `${orderNo}|${code}`;
      const p = receiptByOrderProduct.get(k);
      if (!p || receivedOn < p) receiptByOrderProduct.set(k, receivedOn);
    }
  }

  /* ── 逐供应商 / 逐 (供应商, 商品) 归集样本 ── */
  interface Agg { samples: LeadTimeSample[]; first: string | null; last: string | null }
  const mkAgg = (): Agg => ({ samples: [], first: null, last: null });
  const push = (agg: Agg, sample: LeadTimeSample, receivedOn: string): void => {
    agg.samples.push(sample);
    if (!agg.first || receivedOn < agg.first) agg.first = receivedOn;
    if (!agg.last || receivedOn > agg.last) agg.last = receivedOn;
  };
  const bySupplier = new Map<string, { head: OrderHead; agg: Agg; orders: number; matched: number }>();
  const bySupplierProduct = new Map<string, { head: OrderHead; productCode: string; productName: string | null; agg: Agg }>();

  for (const head of orders.values()) {
    const sup = bySupplier.get(head.supplierKey) ?? { head, agg: mkAgg(), orders: 0, matched: 0 };
    sup.orders += 1;
    const receivedOn = receiptByOrder.get(head.orderNo) ?? null;
    if (receivedOn) {
      const actualDays = daysBetween(head.orderedOn, receivedOn);
      if (Number.isFinite(actualDays) && actualDays >= 0) {
        const promisedDays = head.promisedOn ? daysBetween(head.orderedOn, head.promisedOn) : null;
        sup.matched += 1;
        push(sup.agg, { promisedDays: promisedDays != null && promisedDays >= 0 ? promisedDays : null, actualDays }, receivedOn);
      }
    }
    bySupplier.set(head.supplierKey, sup);

    for (const code of head.products) {
      const lineReceived = receiptByOrderProduct.get(`${head.orderNo}|${code}`);
      if (!lineReceived) continue;
      const actualDays = daysBetween(head.orderedOn, lineReceived);
      if (!Number.isFinite(actualDays) || actualDays < 0) continue;
      const promisedDays = head.promisedOn ? daysBetween(head.orderedOn, head.promisedOn) : null;
      const key = `${head.supplierKey}|${code}`;
      const cur = bySupplierProduct.get(key) ?? { head, productCode: code, productName: head.productNames.get(code) ?? null, agg: mkAgg() };
      push(cur.agg, { promisedDays: promisedDays != null && promisedDays >= 0 ? promisedDays : null, actualDays }, lineReceived);
      bySupplierProduct.set(key, cur);
    }
  }

  /* ── 商品编码 → 系统 SKU（精确相等，不猜；与 core/valuation 财务成本观察同法） ── */
  const codes = [...new Set([...bySupplierProduct.values()].map((p) => p.productCode))];
  const skuByCode = new Map<string, { id: number; code: string; name: string }>();
  if (codes.length > 0) {
    const rows = resultRows<{ id: unknown; code: string; name: string }>(await db.execute(sql`
      SELECT id, code, name FROM skus WHERE code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`));
    for (const r of rows) skuByCode.set(r.code, { id: num(r.id), code: r.code, name: r.name });
  }
  const skuIds = [...skuByCode.values()].map((s) => s.id);

  /* ── 系统侧对照：rollup_supplier_lead + sku_params 档案交期 ── */
  const rollupRows = resultRows<{ supplier_id: unknown; sku_id: unknown; samples: unknown; p50: string | null; p90: string | null; stdev: string | null; otr: string | null }>(await db.execute(sql`
    SELECT supplier_id, sku_id, samples, lead_p50_days AS p50, lead_p90_days AS p90, lead_stdev_days AS stdev, on_time_rate AS otr
    FROM rollup_supplier_lead`));
  const rollupByPair = new Map<string, SystemLeadSide>();
  const rollupBySupplier = new Map<number, { pairs: number; samples: number; ratedSamples: number; weighted: number }>();
  for (const r of rollupRows) {
    const supplierId = num(r.supplier_id);
    const skuId = num(r.sku_id);
    const samples = num(r.samples);
    rollupByPair.set(`${supplierId}|${skuId}`, {
      samples, p50: numOrNull(r.p50), p90: numOrNull(r.p90), stdev: numOrNull(r.stdev), onTimeRate: numOrNull(r.otr),
    });
    const acc = rollupBySupplier.get(supplierId) ?? { pairs: 0, samples: 0, ratedSamples: 0, weighted: 0 };
    acc.pairs += 1;
    acc.samples += samples;
    const otr = numOrNull(r.otr);
    // 加权分子与分母必须同进同出：未测出准时率的对子既不进 weighted 也不进 ratedSamples
    if (otr != null) {
      acc.ratedSamples += samples;
      acc.weighted += otr * samples;
    }
    rollupBySupplier.set(supplierId, acc);
  }

  const paramRows = skuIds.length > 0
    ? resultRows<{ sku_id: unknown; normal: unknown; logistics: unknown; purchase: unknown }>(await db.execute(sql`
        SELECT sku_id, normal_lead_days AS normal, logistics_lead_days AS logistics, purchase_lead_days AS purchase
        FROM sku_params WHERE sku_id IN (${sql.join(skuIds.map((id) => sql`${id}`), sql`, `)})`))
    : [];
  const paramsBySku = new Map(paramRows.map((r) => [num(r.sku_id), {
    normal: numOrNull(r.normal), logistics: numOrNull(r.logistics), purchase: numOrNull(r.purchase),
  }]));

  const [productionDefault, logisticsDefault, bufferDays, learnedToleranceDays] = await Promise.all([
    getNumParam("default_production_lead_days", 30, db),
    getNumParam("default_logistics_lead_days", 15, db),
    getNumParam("alert_buffer_days", 5, db),
    getNumParam("alert_learned_lead_tolerance_days", 3, db),
  ]);

  /* ── 输出行 ── */
  const supplierRows: SupplierLeadHistoryRow[] = [...bySupplier.values()].map((s) => {
    const sys = s.head.supplierId != null ? rollupBySupplier.get(s.head.supplierId) ?? null : null;
    return {
      supplierKey: s.head.supplierKey,
      supplierId: s.head.supplierId,
      supplierName: s.head.supplierName,
      supplierCode: s.head.supplierCode,
      orders: s.orders,
      ordersWithReceipt: s.matched,
      observed: toStats(s.agg.samples),
      firstReceiptDate: s.agg.first,
      lastReceiptDate: s.agg.last,
      system: sys
        ? {
          pairs: sys.pairs,
          samples: sys.samples,
          ratedSamples: sys.ratedSamples,
          onTimeRate: sys.ratedSamples > 0 ? Math.round((sys.weighted / sys.ratedSamples) * 10000) / 10000 : null,
        }
        : null,
    };
  }).sort((a, b) => b.observed.samples - a.observed.samples || a.supplierName.localeCompare(b.supplierName));

  const skuRows: SupplierSkuLeadHistoryRow[] = [...bySupplierProduct.values()].map((p) => {
    const sku = skuByCode.get(p.productCode) ?? null;
    const stats = toStats(p.agg.samples);
    const system = sku && p.head.supplierId != null ? rollupByPair.get(`${p.head.supplierId}|${sku.id}`) ?? null : null;
    const params = sku ? paramsBySku.get(sku.id) ?? null : null;
    const learned: LearnedLead | null = system ? { p50: system.p50, p90: system.p90, samples: system.samples, onTimeRate: system.onTimeRate } : null;
    const observedHistory: ObservedLeadHistory = {
      p50: stats.p50, p90: stats.p90, samples: stats.samples, onTimeRate: stats.onTimeRate,
      firstReceiptDate: p.agg.first, lastReceiptDate: p.agg.last,
    };
    /*
     * 走 rules/alert-threshold 唯一权威：历史观察只作为**第二条只观察来源**进入 basis，
     * days（= 加工 + 在途 + 缓冲）与本模块接入前完全一致——阈值没有被历史数据改动。
     */
    const ad = sku
      ? computeAlertDays({
        normalLeadDays: params?.normal ?? null,
        logisticsLeadDays: params?.logistics ?? null,
        purchaseLeadDays: params?.purchase ?? null,
        defaults: { production: productionDefault, logistics: logisticsDefault },
        bufferDays,
        learned,
        learnedToleranceDays,
        observedHistory,
      })
      : null;
    return {
      key: `${p.head.supplierKey}|${p.productCode}`,
      supplierKey: p.head.supplierKey,
      supplierId: p.head.supplierId,
      supplierName: p.head.supplierName,
      productCode: p.productCode,
      productName: p.productName,
      skuId: sku?.id ?? null,
      skuCode: sku?.code ?? null,
      skuName: sku?.name ?? null,
      observed: stats,
      firstReceiptDate: p.agg.first,
      lastReceiptDate: p.agg.last,
      system,
      archiveLeadDays: params?.normal ?? null,
      alertDays: ad?.days ?? null,
      alertBasis: ad ? leadBasisText(ad) : null,
      leadCompare: ad ? leadCompareText(ad) : null,
      learned: ad?.learned ?? null,
      observedObservation: ad?.observed ?? null,
    };
  }).sort((a, b) => b.observed.samples - a.observed.samples || a.productCode.localeCompare(b.productCode));

  const ordersTotal = orders.size;
  const ordersWithReceipt = supplierRows.reduce((acc, r) => acc + r.ordersWithReceipt, 0);
  const sourceAsOf = [...orderBatches, ...receiptBatches].map((b) => b.sourceAsOf).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const samples = supplierRows.reduce((acc, r) => acc + r.observed.samples, 0);
  const state: SupplierLeadHistory["state"] = samples > 0 ? "ready" : "insufficient";
  const gate = samples > 0
    ? `观察口径：简道云历史采购订单「签订日期」→ 采购入库「入库日期」（同单号最早一次），共 ${ordersWithReceipt}/${ordersTotal} 单可配对、${samples} 个交期样本，覆盖 ${supplierRows.length} 家供应商。只作对照，不改阈值、不进补货数量。`
    : "历史采购订单与入库观察已同步，但没有一单能按单号配对出交期样本（多为单号缺失或日期缺失），历史交期观察保持关闭。";

  return {
    key: SUPPLIER_LEAD_HISTORY_CACHE_KEY,
    authority: "observation_only",
    source: "JIANDAOYUN",
    streams: [ORDER_STREAM, RECEIPT_STREAM],
    state,
    builtAt: new Date().toISOString(),
    sourceBinding: "",
    sourceAsOf,
    batches,
    minSamples: LEAD_HISTORY_MIN_SAMPLES,
    totals: {
      orders: ordersTotal,
      ordersWithReceipt,
      receipts: receiptDocs.size,
      samples,
      suppliers: supplierRows.length,
      suppliersMapped: supplierRows.filter((r) => r.supplierId != null).length,
      skuPairs: skuRows.length,
      skuPairsMapped: skuRows.filter((r) => r.skuId != null).length,
      matchRatePct: ordersTotal > 0 ? r1((ordersWithReceipt / ordersTotal) * 100) : null,
    },
    bySupplier: supplierRows,
    bySupplierSku: skuRows.slice(0, MAX_SKU_ROWS),
    gate,
    limitations: [
      "authority = observation_only：只作对照与提示，绝不写 sku_params / rollup_supplier_lead，也不进安全库存与补货数量（D55）。",
      "与系统侧「学习交期」（rollup_supplier_lead）并列而不合并：前者来自本系统 po_docs→sh_docs 履约，后者来自简道云历史单据，两套单据体系不可相加。",
      "起算日 = 采购订单签订日期（缺则审批通过日），实际收货日 = 采购入库的入库日期（缺则验货日期），同单号多次入库取最早一次；负交期（收货早于下单）丢弃。",
      "承诺交期 = 订单交货日期；缺失的单只进交期分布，不进准时率与平均延误分母（准时率样本数单列）。",
      "SKU 粒度依赖订单/入库子表商品编码相等，且商品编码与 skus.code 精确相等才映射；未映射行按源编码单列，绝不按名称猜、不自动认领（外部身份治理）。",
      "供应商粒度的系统侧只给对数、样本合计与样本加权准时率——rollup_supplier_lead 是 (供应商 × SKU) 粒度，分位数无法向上聚合；加权分母只算已测出准时率的样本（ratedSamples），未测量的对子不按 0% 计。",
      "源数据实核为 2023–2024 历史归档（生产实测两条流落后约 777 天），是历史参照而非当前交期；页面必须显示最早/最晚收货日。",
      "本读模型不取任何金额字段，故不因源单据「表头/明细金额不一致」拦批；金额缺陷仍由数据质量页与放行门负责。",
    ],
  };
}

/**
 * 进入 `alertDays()` 的运行参数键（sys_params global）——与 replenish-pilot 的
 * `PILOT_BINDING_PARAM_KEYS` 同一手法。本读模型把 `alertDays` / `alertBasis` / `leadCompare`
 * 直接publish 到页面上：任一参数改了而绑定不变，页面就会继续引用旧阈值。
 */
export const LEAD_HISTORY_BINDING_PARAM_KEYS = [
  "default_production_lead_days", "default_logistics_lead_days",
  "alert_buffer_days", "alert_learned_lead_tolerance_days",
] as const;

/**
 * 来源绑定：**读到的每一样输入都要在里面**。
 * 组成 = 订单批次 | 入库批次 | rollup_supplier_lead | sku_params | skus 指纹 | 运行参数当前值。
 * skus 指纹：商品编码 → 系统 SKU 的映射（`skus.code` 精确相等）与档案交期的挂接都依赖它，
 * 新增/改码/停用都会改变 bySupplierSku 的映射结果。
 */
async function binding(db: AnyDb): Promise<string> {
  const [orderBatches, receiptBatches] = await Promise.all([
    eligibleBatches(db, ORDER_STREAM),
    eligibleBatches(db, RECEIPT_STREAM),
  ]);
  const [rl] = resultRows<{ built: string | null; rows: number }>(await db.execute(sql`
    SELECT coalesce(max(built_at)::text, '') AS built, count(*)::int AS rows FROM rollup_supplier_lead`));
  const [sp] = resultRows<{ updated: string | null; rows: number }>(await db.execute(sql`
    SELECT coalesce(max(updated_at)::text, '') AS updated, count(*)::int AS rows FROM sku_params`));
  const [sk] = resultRows<{ updated: string | null; rows: number; maxid: number }>(await db.execute(sql`
    SELECT coalesce(max(updated_at)::text, '') AS updated, count(*)::int AS rows, coalesce(max(id), 0)::int AS maxid FROM skus`));
  const paramRows = resultRows<{ key: string; value: string }>(await db.execute(sql`
    SELECT key, value FROM sys_params
    WHERE scope = 'global' AND key IN (${sql.join(LEAD_HISTORY_BINDING_PARAM_KEYS.map((k) => sql`${k}`), sql`, `)})`));
  const paramValues = new Map(paramRows.map((r) => [String(r.key), String(r.value)]));
  const params = LEAD_HISTORY_BINDING_PARAM_KEYS.map((k) => `${k}=${paramValues.get(k) ?? "default"}`).join(",");
  return [
    `po:${orderBatches.map((b) => b.importJobId).join(",") || "none"}`,
    `sh:${receiptBatches.map((b) => b.importJobId).join(",") || "none"}`,
    `rl:${rl?.built ?? ""}/${rl?.rows ?? 0}`,
    `sp:${sp?.updated ?? ""}/${sp?.rows ?? 0}`,
    `sk:${sk?.updated ?? ""}/${sk?.rows ?? 0}/${sk?.maxid ?? 0}`,
    `params:${params}`,
  ].join("|");
}

export async function loadSupplierLeadHistory(dbArg?: AnyDb, opts: { refresh?: boolean } = {}): Promise<SupplierLeadHistory> {
  const db = await resolveDb(dbArg);
  const key = await binding(db);
  if (!opts.refresh) {
    const [cached] = resultRows<{ payload: unknown }>(await db.execute(sql`
      SELECT payload FROM report_read_model_cache WHERE key = ${SUPPLIER_LEAD_HISTORY_CACHE_KEY} AND source_binding = ${key} LIMIT 1`));
    const payload = cached?.payload;
    const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload) as unknown; } catch { return null; } })() : payload;
    if (parsed && typeof parsed === "object"
      && (parsed as Partial<SupplierLeadHistory>).key === SUPPLIER_LEAD_HISTORY_CACHE_KEY
      && Array.isArray((parsed as Partial<SupplierLeadHistory>).bySupplier)) {
      return parsed as SupplierLeadHistory;
    }
  }
  const model = await computeSupplierLeadHistory(db);
  model.sourceBinding = key;
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${SUPPLIER_LEAD_HISTORY_CACHE_KEY}, ${key}, ${JSON.stringify(model)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return model;
}

/** 页面/读模型用：外部观察缺席不能把内部报表拖垮 */
export async function loadSupplierLeadHistorySafe(dbArg?: AnyDb): Promise<SupplierLeadHistory> {
  try {
    return await loadSupplierLeadHistory(dbArg);
  } catch (error) {
    return empty(`历史交期观察读模型不可用：${(error as Error).message}`, { orders: 0, receipts: 0 });
  }
}

/**
 * 供未来接入库存预警行的取数入口（B4 第 3 条）：按 SKU 取样本最多的一条历史观察，
 * 直接喂给 `rules/alert-threshold.alertDays({ observedHistory })`。
 * **只观察**：调用方拿到的是 basis 里的解释段，阈值 days 不会因此改变。
 */
export function observedLeadForSku(model: SupplierLeadHistory, skuId: number): ObservedLeadHistory | null {
  let best: SupplierSkuLeadHistoryRow | null = null;
  for (const row of model.bySupplierSku) {
    if (row.skuId !== skuId) continue;
    if (!best || row.observed.samples > best.observed.samples) best = row;
  }
  if (!best) return null;
  return {
    p50: best.observed.p50, p90: best.observed.p90, samples: best.observed.samples, onTimeRate: best.observed.onTimeRate,
    firstReceiptDate: best.firstReceiptDate, lastReceiptDate: best.lastReceiptDate,
  };
}
