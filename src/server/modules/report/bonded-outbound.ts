/**
 * 保税仓日出库观察（/v1）：数据中台「绍兴保税仓_保税订单」按 SKU / 批次 / 效期 汇总发货数量。
 *
 * 为什么需要它：保税仓是快照仓（只有每日照片、没有流水账），驾驶舱第 3 屏「各仓库存明细」的
 * 「出库」列对快照仓只能显示「无流水」。保税订单流给了一条**观察口径**的出库序列——
 * 发货时间为准的日出库件数，能到 SKU × 批次 × 效期。
 *
 * 纪律：
 *   - observation_only：不过账、不改 stock_balances/batch_stocks、不进销速与补货定量（D43/D55）；
 *   - 契约为全量观察（2026-09-04 起；源表为归档）：读模型从最近 120 天内成功、未被
 *     supersede 且符合质量条件的批次按源记录 id（sourceRecordId）去重、取最新批次的状态；
 *     7/30 天发货统计以最新有效发货日而非今天为锚点，不代表数据已更新到当前日期；
 *   - 身份：`_identity.skuId` 由同步期解析（sku_code 别名 → 条码精确唯一命中），未映射行
 *     保留原始商品编码单列，绝不按名称猜；
 *   - 出库判定：有发货时间（YYYY-MM-DD 前缀可解析）且订单状态不含「取消」；状态分布随数值输出供业务复核；
 *   - 数量 decimal(14,4) 字符串，禁 float 累加；无金额字段，免脱敏。
 */
import { sql, type SQL } from "drizzle-orm";

import { dAdd, dCmp, dQty } from "@/server/core/decimal";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const READ_MODEL_CACHE_KEY = "bonded-outbound/v1";
const STREAM = "bonded-warehouse-order-observation";
const TARGET_TABLE = "jdy_bonded_warehouse_order_observation";
/** 可用同步批次的完成时间回看范围；不是契约拉取时间窗，也不是源数据新鲜度证明。 */
const BATCH_LOOKBACK_DAYS = 120;
export const BONDED_OUTBOUND_WINDOW_DAYS = 30;
const MAX_SKU_BATCH_ROWS = 500;

export interface BondedOutboundDailyPoint {
  date: string;
  /** 当日发货件数（decimal 字符串，scale 4） */
  qty: string;
  orders: number;
  lines: number;
}

export interface BondedOutboundWarehouseRow {
  warehouseName: string;
  /** 同步期按 warehouse 别名解析到的系统仓库；未认领为 null */
  warehouseId: number | null;
  qty30: string;
  qty7: string;
  orders30: number;
  lastShipDate: string | null;
  daily: BondedOutboundDailyPoint[];
}

export interface BondedOutboundSkuBatchRow {
  skuId: number | null;
  /** 已映射时为系统 SKU 编码；未映射时回显源商品编码 */
  skuCode: string;
  skuName: string | null;
  brand: string | null;
  productCodeRaw: string;
  barcode: string | null;
  batch: string | null;
  validityPeriod: string | null;
  warehouseName: string;
  qty30: string;
  qty7: string;
  orders30: number;
  lastShipDate: string | null;
}

export interface BondedOutbound {
  state: "ready" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  stream: typeof STREAM;
  windowDays: typeof BONDED_OUTBOUND_WINDOW_DAYS;
  sourceAsOf: string | null;
  /** 锚点 = 去重后最大发货日；30/7 天窗口从它往回数 */
  anchorDate: string | null;
  windowFrom: string | null;
  batches: number;
  totals: {
    qty30: string;
    qty7: string;
    orders30: number;
    lines30: number;
    /** 窗口内发货行里 `_identity.skuId` 已解析的行数占比（%），null = 无行 */
    skuMappedPct: number | null;
    mappedLines30: number;
  };
  daily: BondedOutboundDailyPoint[];
  byWarehouse: BondedOutboundWarehouseRow[];
  bySkuBatch: BondedOutboundSkuBatchRow[];
  byPlatform: { platform: string; qty30: string; orders30: number }[];
  /** 去重后全部订单行的状态分布（含未发货/取消，供业务确认哪些状态该算出库） */
  byStatus: { status: string; lines: number; shipped: boolean }[];
  gate: string;
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const qty = (v: unknown): string => {
  const t = v == null ? "" : String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? dQty(t) : "0.0000";
};
const text = (v: unknown): string | null => { const t = v == null ? "" : String(v).trim(); return t ? t : null; };

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 可用批次：最近 120 天内成功、未被 supersede 的批次。订单级观察流按「平台日快照」三档里的
 * 宽松档处理——review 若只因业务键重复/缺失仍可用（同单同品多行是源表真实形态），
 * 数值非法 / 对账不符 / 有删除的批次不用。
 */
async function eligibleBatches(db: ReadDb): Promise<{ importJobId: number; sourceAsOf: string | null }[]> {
  const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${STREAM}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND ij.status <> 'superseded'
      AND ir.finished_at > now() - (${BATCH_LOOKBACK_DAYS}::int * interval '1 day')
      AND (coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
           OR (coalesce((ir.request_scope->'controlSummary'->>'invalidNumericValues')::int, 0) = 0
               AND coalesce((ir.request_scope->'controlSummary'->>'reconciliationMismatchedRows')::int, 0) = 0
               AND coalesce((ir.request_scope->'controlSummary'->>'deletedRows')::int, 0) = 0))
    ORDER BY ir.import_job_id DESC
  `));
  return rows
    .map((r) => ({ importJobId: num(r.import_job_id), sourceAsOf: r.source_as_of == null ? null : String(r.source_as_of).slice(0, 10) }))
    .filter((r) => r.importJobId > 0);
}

function empty(gate: string, batches = 0): BondedOutbound {
  return {
    state: "insufficient", authority: "observation_only", source: "JIANDAOYUN", stream: STREAM,
    windowDays: BONDED_OUTBOUND_WINDOW_DAYS, sourceAsOf: null, anchorDate: null, windowFrom: null, batches,
    totals: { qty30: "0.0000", qty7: "0.0000", orders30: 0, lines30: 0, skuMappedPct: null, mappedLines30: 0 },
    daily: [], byWarehouse: [], bySkuBatch: [], byPlatform: [], byStatus: [],
    gate,
    limitations: [gate],
  };
}

export async function computeBondedOutbound(db: ReadDb): Promise<BondedOutbound> {
  const batches = await eligibleBatches(db);
  if (batches.length === 0) return empty("保税订单流尚未同步（或最近 120 天没有可用批次），保税仓出库观察保持关闭。");
  const jobIds = batches.map((b) => b.importJobId);
  const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
    WITH raw AS (
      SELECT DISTINCT ON (coalesce(payload->>'sourceRecordId', import_job_id::text || ':' || row_no::text))
             nullif(trim(payload->'data'->>'systemOrderNumber'), '') AS order_no,
             nullif(trim(payload->'data'->>'platformName'), '') AS platform,
             coalesce(nullif(trim(payload->'data'->>'orderStatus'), ''), '(空)') AS status,
             CASE WHEN left(coalesce(payload->'data'->>'shipmentTime', ''), 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN left(payload->'data'->>'shipmentTime', 10)::date ELSE NULL END AS ship_date,
             CASE WHEN left(coalesce(payload->'data'->>'statisticalDate', ''), 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN left(payload->'data'->>'statisticalDate', 10)::date ELSE NULL END AS stat_date,
             nullif(trim(payload->'data'->>'productCode'), '') AS product_code,
             nullif(trim(payload->'data'->>'barcode'), '') AS barcode,
             nullif(trim(payload->'data'->>'batch'), '') AS batch,
             nullif(trim(payload->'data'->>'validityPeriod'), '') AS validity,
             coalesce(nullif(trim(payload->'data'->>'warehouseName'), ''), '(未填仓库)') AS wh_name,
             (payload->'_identity'->>'skuId')::int AS sku_id,
             (payload->'_identity'->>'warehouseId')::int AS wh_id,
             CASE WHEN trim(coalesce(payload->'data'->>'shipmentQuantity','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'shipmentQuantity')::numeric ELSE 0 END AS qty
      FROM staging_rows
      WHERE import_job_id IN (${sql.join(jobIds.map((id) => sql`${id}`), sql`, `)})
        AND target_table = ${TARGET_TABLE}
        AND status IN ('pending', 'validated', 'committed')
      ORDER BY coalesce(payload->>'sourceRecordId', import_job_id::text || ':' || row_no::text), import_job_id DESC, row_no DESC
    ),
    shipped AS (
      SELECT r.*, coalesce(k.code, r.product_code, '(无编码)') AS sku_code, k.name AS sku_name, b.code AS brand
      FROM raw r
      LEFT JOIN skus k ON k.id = r.sku_id
      LEFT JOIN brands b ON b.id = k.brand_id
      WHERE r.ship_date IS NOT NULL AND r.status NOT LIKE '%取消%'
    ),
    a AS (SELECT max(ship_date) AS d FROM shipped),
    w AS (SELECT s.* FROM shipped s CROSS JOIN a WHERE s.ship_date > a.d - ${BONDED_OUTBOUND_WINDOW_DAYS}::int)
    SELECT 'anchor' AS kind, a.d::text AS k1, NULL::text AS k2, NULL::text AS k3, NULL::text AS k4, NULL::text AS k5, NULL::text AS k6,
           NULL::int AS id1, NULL::int AS id2, NULL::numeric AS qty30, NULL::numeric AS qty7, NULL::int AS orders30, NULL::int AS lines30,
           (SELECT count(*) FROM w WHERE w.sku_id IS NOT NULL)::int AS mapped_lines, (SELECT count(*) FROM w)::int AS all_lines, NULL::text AS last_ship
    FROM a
    UNION ALL
    SELECT 'daily', w.ship_date::text, w.wh_name, NULL, NULL, NULL, NULL, NULL, NULL,
           sum(w.qty), NULL, count(DISTINCT w.order_no)::int, count(*)::int, NULL, NULL, NULL
    FROM w GROUP BY w.ship_date, w.wh_name
    UNION ALL
    SELECT 'warehouse', w.wh_name, NULL, NULL, NULL, NULL, NULL, max(w.wh_id), NULL,
           sum(w.qty), sum(w.qty) FILTER (WHERE w.ship_date > a.d - 7), count(DISTINCT w.order_no)::int, count(*)::int, NULL, NULL, max(w.ship_date)::text
    FROM w CROSS JOIN a GROUP BY w.wh_name
    UNION ALL
    SELECT 'sku', w.sku_code, w.product_code, w.batch, w.validity, w.wh_name, w.barcode, w.sku_id, NULL,
           sum(w.qty), sum(w.qty) FILTER (WHERE w.ship_date > a.d - 7), count(DISTINCT w.order_no)::int, count(*)::int, NULL, NULL, max(w.ship_date)::text
    FROM w CROSS JOIN a GROUP BY w.sku_code, w.product_code, w.batch, w.validity, w.wh_name, w.barcode, w.sku_id
    UNION ALL
    SELECT 'skumeta', w.sku_code, max(w.sku_name), max(w.brand), NULL, NULL, NULL, w.sku_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM w WHERE w.sku_id IS NOT NULL GROUP BY w.sku_code, w.sku_id
    UNION ALL
    SELECT 'platform', coalesce(w.platform, '(未填平台)'), NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           sum(w.qty), NULL, count(DISTINCT w.order_no)::int, count(*)::int, NULL, NULL, NULL
    FROM w GROUP BY coalesce(w.platform, '(未填平台)')
    UNION ALL
    SELECT 'status', r.status, CASE WHEN r.ship_date IS NOT NULL AND r.status NOT LIKE '%取消%' THEN 'y' ELSE 'n' END, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, count(*)::int, NULL, NULL, NULL
    FROM raw r GROUP BY r.status, CASE WHEN r.ship_date IS NOT NULL AND r.status NOT LIKE '%取消%' THEN 'y' ELSE 'n' END
  `));
  const anchorRow = rows.find((r) => r.kind === "anchor");
  const anchorDate = text(anchorRow?.k1);
  const sourceAsOf = batches.map((b) => b.sourceAsOf).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const byStatus = rows.filter((r) => r.kind === "status")
    .map((r) => ({ status: String(r.k1 ?? "(空)"), lines: num(r.lines30), shipped: r.k2 === "y" }))
    .sort((x, y) => y.lines - x.lines);
  if (!anchorDate) {
    const model = empty("最近批次里没有带发货时间的保税订单行，出库观察保持关闭；请核对订单状态分布。", batches.length);
    model.byStatus = byStatus;
    model.sourceAsOf = sourceAsOf;
    return model;
  }

  // 日序列：按仓拆的日行 → 汇总日 + 逐仓日
  const dailyMap = new Map<string, BondedOutboundDailyPoint>();
  const whDaily = new Map<string, Map<string, BondedOutboundDailyPoint>>();
  for (const r of rows) {
    if (r.kind !== "daily") continue;
    const date = String(r.k1), wh = String(r.k2 ?? "");
    const q = qty(r.qty30);
    const d = dailyMap.get(date) ?? { date, qty: "0.0000", orders: 0, lines: 0 };
    d.qty = dAdd(d.qty, q, 4); d.orders += num(r.orders30); d.lines += num(r.lines30);
    dailyMap.set(date, d);
    const perWh = whDaily.get(wh) ?? new Map<string, BondedOutboundDailyPoint>();
    perWh.set(date, { date, qty: q, orders: num(r.orders30), lines: num(r.lines30) });
    whDaily.set(wh, perWh);
  }
  const daily = [...dailyMap.values()].sort((x, y) => x.date.localeCompare(y.date));

  const byWarehouse: BondedOutboundWarehouseRow[] = rows.filter((r) => r.kind === "warehouse").map((r) => ({
    warehouseName: String(r.k1 ?? ""),
    warehouseId: r.id1 == null ? null : num(r.id1),
    qty30: qty(r.qty30), qty7: qty(r.qty7), orders30: num(r.orders30),
    lastShipDate: text(r.last_ship),
    daily: [...(whDaily.get(String(r.k1 ?? ""))?.values() ?? [])].sort((x, y) => x.date.localeCompare(y.date)),
  })).sort((x, y) => dCmp(y.qty30, x.qty30));

  const meta = new Map<string, { name: string | null; brand: string | null }>();
  for (const r of rows) if (r.kind === "skumeta") meta.set(`${r.id1}`, { name: text(r.k2), brand: text(r.k3) });
  const bySkuBatchAll: BondedOutboundSkuBatchRow[] = rows.filter((r) => r.kind === "sku").map((r) => {
    const skuId = r.id1 == null ? null : num(r.id1);
    const m = skuId == null ? null : meta.get(String(skuId));
    return {
      skuId, skuCode: String(r.k1 ?? ""), skuName: m?.name ?? null, brand: m?.brand ?? null,
      productCodeRaw: String(r.k2 ?? ""), batch: text(r.k3), validityPeriod: text(r.k4), warehouseName: String(r.k5 ?? ""), barcode: text(r.k6),
      qty30: qty(r.qty30), qty7: qty(r.qty7), orders30: num(r.orders30), lastShipDate: text(r.last_ship),
    };
  }).sort((x, y) => dCmp(y.qty30, x.qty30) || x.skuCode.localeCompare(y.skuCode));
  const byPlatform = rows.filter((r) => r.kind === "platform")
    .map((r) => ({ platform: String(r.k1 ?? ""), qty30: qty(r.qty30), orders30: num(r.orders30) }))
    .sort((x, y) => dCmp(y.qty30, x.qty30));

  const qty30 = byWarehouse.reduce((acc, w) => dAdd(acc, w.qty30, 4), "0.0000");
  const qty7 = byWarehouse.reduce((acc, w) => dAdd(acc, w.qty7, 4), "0.0000");
  const lines30 = num(anchorRow?.all_lines);
  const mappedLines30 = num(anchorRow?.mapped_lines);
  const totalOrders30 = byPlatform.reduce((acc, p) => acc + p.orders30, 0);
  return {
    state: "ready", authority: "observation_only", source: "JIANDAOYUN", stream: STREAM,
    windowDays: BONDED_OUTBOUND_WINDOW_DAYS, sourceAsOf, anchorDate, windowFrom: shiftDate(anchorDate, -(BONDED_OUTBOUND_WINDOW_DAYS - 1)),
    batches: batches.length,
    totals: {
      qty30, qty7, orders30: totalOrders30, lines30,
      skuMappedPct: lines30 > 0 ? Math.round((mappedLines30 / lines30) * 1000) / 10 : null,
      mappedLines30,
    },
    daily,
    byWarehouse,
    bySkuBatch: bySkuBatchAll.slice(0, MAX_SKU_BATCH_ROWS),
    byPlatform,
    byStatus,
    gate: `观察口径：保税订单「发货时间」所在日的发货数量（剔除状态含「取消」的订单），锚点 ${anchorDate}，近 ${BONDED_OUTBOUND_WINDOW_DAYS} 天 ${qty30} 件 / ${totalOrders30} 单；商品编码已映射系统 SKU 的行 ${mappedLines30}/${lines30}。只作快照仓「出库」列旁证，不过账、不进销速。`,
    limitations: [
      "保税仓为快照仓：本序列来自订单流的发货时间，不是仓库流水；与 batch_stocks / 快照在库不能相减推算期初。",
      "契约为全量观察（源表实核为一次性归档：507 行、统计日期全为 2026-03-01）：跨批次按源记录去重后取最新状态；数据不是当前出库，仅作历史旁证，是否续推待业务确认。",
      "订单状态语义未经业务确认：当前只剔除状态含「取消」的行，状态分布随数值输出，请业务复核哪些状态不应计出库。",
      "未映射到系统 SKU 的商品编码按源编码单列（不按名称猜）；认领走「简道云身份认领」队列。",
      byPlatform.length > 0 ? `订单跨 ${byPlatform.length} 个平台名称；平台名称是源系统原值，未映射到渠道主档。` : "窗口内无平台名称。",
    ],
  };
}

async function binding(db: ReadDb): Promise<string> {
  const batches = await eligibleBatches(db);
  return `bonded:${batches.length}:${batches.map((b) => b.importJobId).join(",") || "none"}`;
}

export async function loadBondedOutbound(db: ReadDb): Promise<BondedOutbound> {
  const key = await binding(db);
  const cached = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${READ_MODEL_CACHE_KEY} AND source_binding = ${key} LIMIT 1`))[0];
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<BondedOutbound>).authority === "observation_only" && Array.isArray((parsed as Partial<BondedOutbound>).byWarehouse)) {
    return parsed as BondedOutbound;
  }
  return refreshBondedOutbound(db);
}

export async function refreshBondedOutbound(db: ReadDb): Promise<BondedOutbound> {
  const key = await binding(db);
  const result = await computeBondedOutbound(db);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${READ_MODEL_CACHE_KEY}, ${key}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return result;
}

/** 页面用：外部观察缺席不能把内部报表拖垮 */
export async function loadBondedOutboundSafe(db: ReadDb): Promise<BondedOutbound> {
  try {
    return await loadBondedOutbound(db);
  } catch (error) {
    return empty(`保税仓出库读模型不可用：${(error as Error).message}`);
  }
}

/**
 * 第 3 屏「各仓库存明细」出库列的取数入口：按系统仓库 id 或仓库名称取该仓的近 30/7 天出库。
 * 仓库名称匹配为源值精确匹配（同步期 warehouse 别名解析到的 warehouseId 优先）。
 */
export function bondedOutboundForWarehouse(
  model: BondedOutbound,
  ref: { warehouseId?: number | null; warehouseName?: string | null },
): { qty30: string; qty7: string; lastShipDate: string | null; source: "bonded_order_observation" } | null {
  if (model.state !== "ready") return null;
  const row = model.byWarehouse.find((w) =>
    (ref.warehouseId != null && w.warehouseId === ref.warehouseId)
    || (ref.warehouseName != null && w.warehouseName === ref.warehouseName.trim()));
  return row ? { qty30: row.qty30, qty7: row.qty7, lastShipDate: row.lastShipDate, source: "bonded_order_observation" } : null;
}
