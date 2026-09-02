/**
 * 外部观察销速：按系统 SKU 汇总的天猫近 30 / 90 天净需求（观察口径）。
 *
 * 为什么需要它（2026-09-02 实测）：内部销量事实 `sales_monthly` 停在 2026-06，
 * 而简道云天猫日销量已到 2026-09-01。销速、可销天数、滞销、临期风险、补货建议全部基于
 * 内部事实——晚了 3 个月。最直接的决策损失：内部判"无动销"、外部其实天天在卖的 SKU
 * 会被错误地打折或报废。
 *
 * 这不是替代：它**只作为影子列并排显示**，带来源截止、覆盖与门禁；绝不写 sales_monthly、
 * 不改销速口径（core/velocity.ts 仍是唯一权威）、不驱动自动补货。
 *
 * 身份走两条桥：简道云对照表的唯一 skuId + 业务直接认领（sku_identifiers external/JIANDAOYUN:TMALL）。
 * 未映射的平台 SKU 不计入任何系统 SKU（不按名称猜）。
 */
import { sql, type SQL } from "drizzle-orm";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const READ_MODEL_CACHE_KEY = "jiandaoyun-external-velocity/v1";
const PLATFORM_SKU_IDENTIFIER_SCOPE = "JIANDAOYUN:TMALL";

export interface ExternalVelocityBySku {
  paid30: number;
  refund30: number;
  net30: number;
  paid90: number;
  refund90: number;
  net90: number;
  /** 最近一次有支付件数的业务日 */
  lastSoldDate: string | null;
  /** 近 90 天有支付的天数 */
  activeDays90: number;
  /** 归到该 SKU 的平台 SKU 个数（跨店铺） */
  platformSkus: number;
  /** 分平台拆解（净需求）；总量 net30/net90 = 天猫 + 拼多多 */
  tmallNet30: number;
  pddNet30: number;
  tmallNet90: number;
  pddNet90: number;
}

export interface ExternalVelocity {
  state: "ready" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  platform: "天猫+拼多多";
  gate: string;
  sourceAsOf: string | null;
  pddSourceAsOf: string | null;
  /** 观察窗口锚点 = 批次内最大业务日；30/90 天窗口都从它往回数 */
  anchorDate: string | null;
  coverage: {
    platformSkus: number;
    mappedPlatformSkus: number;
    mappedSkus: number;
  };
  bySku: Record<string, ExternalVelocityBySku>;
  limitations: string[];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}
function intValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

async function latestBatch(db: ReadDb, stream: string): Promise<{ importJobId: number; sourceAsOf: string | null } | null> {
  const result = await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
    ORDER BY ir.started_at DESC, ir.id DESC
    LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  const importJobId = intValue(row?.import_job_id);
  return importJobId > 0
    ? { importJobId, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) }
    : null;
}

async function binding(db: ReadDb): Promise<string | null> {
  const [sales, refunds, crosswalk, pddOrders, pddCrosswalk, direct] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation"),
    latestBatch(db, "tmall-sku-refund-observation"),
    latestBatch(db, "tmall-sku-crosswalk-observation"),
    latestBatch(db, "pdd-order-observation"),
    latestBatch(db, "pdd-sku-crosswalk-observation"),
    db.execute(sql`SELECT count(*)::int AS n, coalesce(max(id), 0)::int AS max_id, coalesce(max(updated_at), 'epoch')::text AS updated
      FROM sku_identifiers WHERE kind = 'external' AND scope IN (${PLATFORM_SKU_IDENTIFIER_SCOPE}, 'JIANDAOYUN:PDD')`),
  ]);
  if (!sales) return null;
  const [d] = resultRows<Record<string, unknown>>(direct);
  return `sales:${sales.importJobId}|refunds:${refunds?.importJobId ?? "none"}|crosswalk:${crosswalk?.importJobId ?? "none"}|pdd:${pddOrders?.importJobId ?? "none"}:${pddCrosswalk?.importJobId ?? "none"}|direct:${intValue(d?.n)}:${intValue(d?.max_id)}:${String(d?.updated ?? "")}`;
}

export function emptyExternalVelocity(gate: string): ExternalVelocity {
  return {
    state: "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫+拼多多",
    gate,
    sourceAsOf: null,
    pddSourceAsOf: null,
    anchorDate: null,
    coverage: { platformSkus: 0, mappedPlatformSkus: 0, mappedSkus: 0 },
    bySku: {},
    limitations: [gate],
  };
}

export async function computeExternalVelocity(db: ReadDb): Promise<ExternalVelocity> {
  const [sales, refunds, crosswalk, pddOrders, pddCrosswalk] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation"),
    latestBatch(db, "tmall-sku-refund-observation"),
    latestBatch(db, "tmall-sku-crosswalk-observation"),
    latestBatch(db, "pdd-order-observation"),
    latestBatch(db, "pdd-sku-crosswalk-observation"),
  ]);
  if (!sales) return emptyExternalVelocity("缺少天猫日销量的成功批次，外部销速保持关闭。");

  // 全部在 SQL 里做：身份映射（对照表唯一 skuId ∪ 直接认领）→ 按 SKU × 窗口聚合。
  // 每批 6.8 万行，聚合约 0.3 s；页面永远只读缓存。
  const result = await db.execute(sql`
    WITH cw AS (
      SELECT payload->'data'->>'shopName' AS shop,
             payload->'data'->>'platformSkuId' AS psku,
             max((payload->'_identity'->>'skuId')::int) AS sku_id,
             count(DISTINCT payload->'_identity'->>'skuId') AS n
      FROM staging_rows
      WHERE import_job_id = ${crosswalk?.importJobId ?? -1}
        AND target_table = 'jdy_tmall_sku_crosswalk_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND payload->'_identity'->>'skuId' IS NOT NULL
      GROUP BY 1, 2
    ),
    direct AS (
      SELECT split_part(value, '|', 1) AS shop, split_part(value, '|', 2) AS psku, sku_id
      FROM sku_identifiers
      WHERE kind = 'external' AND scope = ${PLATFORM_SKU_IDENTIFIER_SCOPE} AND active = true
    ),
    map AS (
      SELECT coalesce(cw.shop, d.shop) AS shop, coalesce(cw.psku, d.psku) AS psku,
             CASE
               WHEN cw.n = 1 THEN cw.sku_id
               WHEN cw.n IS NULL THEN d.sku_id
               ELSE NULL
             END AS sku_id
      FROM cw FULL JOIN direct d ON d.shop = cw.shop AND d.psku = cw.psku
    ),
    s AS (
      SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku,
             left(payload->'data'->>'statisticalDate', 10)::date AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'paidNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'paidNumber')::numeric ELSE 0 END AS paid
      FROM staging_rows
      WHERE import_job_id = ${sales.importJobId}
        AND target_table = 'jdy_tmall_sku_sales_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    ),
    r AS (
      SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku,
             left(payload->'data'->>'statisticalDate', 10)::date AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'successRefundSuborderNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'successRefundSuborderNumber')::numeric ELSE 0 END AS refund
      FROM staging_rows
      WHERE import_job_id = ${refunds?.importJobId ?? -1}
        AND target_table = 'jdy_tmall_sku_refund_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    ),
    pdd_map AS (
      SELECT payload->'data'->>'shopName' AS shop,
             payload->'data'->>'platformProductId' AS pid,
             nullif(trim(payload->'data'->>'merchantSkuCode'), '') AS mcode,
             max((payload->'_identity'->>'skuId')::int) AS sku_id,
             count(DISTINCT payload->'_identity'->>'skuId') AS n
      FROM staging_rows
      WHERE import_job_id = ${pddCrosswalk?.importJobId ?? -1}
        AND target_table = 'jdy_pdd_sku_crosswalk_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND payload->'_identity'->>'skuId' IS NOT NULL
      GROUP BY 1, 2, 3
    ),
    pdd_direct AS (
      SELECT split_part(value, '|', 1) AS shop, split_part(value, '|', 2) AS pid, nullif(split_part(value, '|', 3), '') AS mcode, sku_id
      FROM sku_identifiers WHERE kind = 'external' AND scope = 'JIANDAOYUN:PDD' AND active = true
    ),
    pdd_identity AS (
      SELECT coalesce(m.shop, d.shop) AS shop, coalesce(m.pid, d.pid) AS pid, coalesce(m.mcode, d.mcode) AS mcode,
             CASE WHEN m.n = 1 THEN m.sku_id WHEN m.n IS NULL THEN d.sku_id ELSE NULL END AS sku_id
      FROM pdd_map m FULL JOIN pdd_direct d ON d.shop = m.shop AND d.pid = m.pid AND d.mcode IS NOT DISTINCT FROM m.mcode
    ),
    -- 拼多多订单：每批只是最近 3 天的滚动快照（每天 3~6 千行明细，全量超安全页上限），
    -- 这里把最近 90 天内所有成功批次按业务键（订单号+商品+商家编码）去重、取最新批次的状态后累加。
    -- 已取消/退款成功的订单不算需求；发货与否不影响需求口径。
    pdd_batches AS (
      SELECT ir.import_job_id
      FROM integration_runs ir
      WHERE ir.connector = 'jdy' AND ir.stream = 'pdd-order-observation'
        AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
        AND ir.finished_at > now() - interval '90 days'
    ),
    pdd_raw AS (
      SELECT DISTINCT ON (payload->'data'->>'orderNumber', payload->'data'->>'productId', coalesce(payload->'data'->>'merchantSkuCode', ''))
             payload->'data'->>'shopName' AS shop,
             payload->'data'->>'productId' AS pid,
             nullif(trim(payload->'data'->>'merchantSkuCode'), '') AS mcode,
             left(payload->'data'->>'statisticalDate', 10)::date AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'productQuantity','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'productQuantity')::numeric ELSE 0 END AS qty,
             coalesce(payload->'data'->>'orderStatus', '') AS status
      FROM staging_rows
      WHERE import_job_id IN (SELECT import_job_id FROM pdd_batches)
        AND target_table = 'jdy_pdd_order_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ORDER BY payload->'data'->>'orderNumber', payload->'data'->>'productId', coalesce(payload->'data'->>'merchantSkuCode', ''), import_job_id DESC
    ),
    pdd AS (SELECT shop, pid, mcode, d, qty, status FROM pdd_raw),
    anchor AS (SELECT greatest(max(s.d), (SELECT max(d) FROM pdd)) AS d FROM s),
    joined AS (
      SELECT m.sku_id, s.shop, s.psku, s.d, s.paid, 0::numeric AS refund, 'tmall' AS platform FROM s INNER JOIN map m ON m.shop = s.shop AND m.psku = s.psku AND m.sku_id IS NOT NULL
      UNION ALL
      SELECT m.sku_id, r.shop, r.psku, r.d, 0::numeric, r.refund, 'tmall' FROM r INNER JOIN map m ON m.shop = r.shop AND m.psku = r.psku AND m.sku_id IS NOT NULL
      UNION ALL
      SELECT pm.sku_id, p.shop, coalesce(p.mcode, p.pid), p.d,
             CASE WHEN p.status LIKE '%取消%' OR p.status LIKE '%退款成功%' THEN 0 ELSE p.qty END,
             0::numeric, 'pdd'
      FROM pdd p INNER JOIN pdd_identity pm ON pm.shop = p.shop AND pm.pid = p.pid AND pm.mcode IS NOT DISTINCT FROM p.mcode AND pm.sku_id IS NOT NULL
    ),
    per_sku AS (
      SELECT j.sku_id,
        sum(j.paid) FILTER (WHERE j.d > a.d - 30 AND j.platform = 'tmall') AS tmall_paid30,
        sum(j.refund) FILTER (WHERE j.d > a.d - 30 AND j.platform = 'tmall') AS tmall_refund30,
        sum(j.paid) FILTER (WHERE j.d > a.d - 30 AND j.platform = 'pdd') AS pdd_net30,
        sum(j.paid) FILTER (WHERE j.d > a.d - 90 AND j.platform = 'tmall') AS tmall_paid90,
        sum(j.refund) FILTER (WHERE j.d > a.d - 90 AND j.platform = 'tmall') AS tmall_refund90,
        sum(j.paid) FILTER (WHERE j.d > a.d - 90 AND j.platform = 'pdd') AS pdd_net90,
        sum(j.paid) FILTER (WHERE j.d > a.d - 30) AS paid30,
        sum(j.refund) FILTER (WHERE j.d > a.d - 30) AS refund30,
        sum(j.paid) FILTER (WHERE j.d > a.d - 90) AS paid90,
        sum(j.refund) FILTER (WHERE j.d > a.d - 90) AS refund90,
        max(j.d) FILTER (WHERE j.paid > 0) AS last_sold,
        count(DISTINCT j.d) FILTER (WHERE j.paid > 0 AND j.d > a.d - 90) AS active_days90,
        count(DISTINCT (j.shop, j.psku)) AS platform_skus
      FROM joined j CROSS JOIN anchor a
      GROUP BY j.sku_id
    ),
    cov AS (
      SELECT count(DISTINCT (s.shop, s.psku)) AS platform_skus,
             count(DISTINCT (s.shop, s.psku)) FILTER (WHERE m.sku_id IS NOT NULL) AS mapped_platform_skus
      FROM s LEFT JOIN map m ON m.shop = s.shop AND m.psku = s.psku
    )
    SELECT 'anchor' AS kind, a.d::text AS anchor, NULL::int AS sku_id, NULL::numeric AS paid30, NULL::numeric AS refund30, NULL::numeric AS paid90, NULL::numeric AS refund90,
           NULL::text AS last_sold, NULL::int AS active_days90, cov.platform_skus::int AS platform_skus, cov.mapped_platform_skus::int AS mapped_platform_skus,
           NULL::numeric AS tmall_paid30, NULL::numeric AS tmall_refund30, NULL::numeric AS pdd_net30, NULL::numeric AS tmall_paid90, NULL::numeric AS tmall_refund90, NULL::numeric AS pdd_net90
    FROM anchor a CROSS JOIN cov
    UNION ALL
    SELECT 'sku', NULL, p.sku_id, coalesce(p.paid30, 0), coalesce(p.refund30, 0), coalesce(p.paid90, 0), coalesce(p.refund90, 0),
           p.last_sold::text, p.active_days90::int, p.platform_skus::int, NULL,
           coalesce(p.tmall_paid30, 0), coalesce(p.tmall_refund30, 0), coalesce(p.pdd_net30, 0), coalesce(p.tmall_paid90, 0), coalesce(p.tmall_refund90, 0), coalesce(p.pdd_net90, 0)
    FROM per_sku p
  `);

  const rows = resultRows<Record<string, unknown>>(result);
  const anchorRow = rows.find((r) => r.kind === "anchor");
  const anchorDate = anchorRow?.anchor ? String(anchorRow.anchor).slice(0, 10) : null;
  const bySku: Record<string, ExternalVelocityBySku> = {};
  for (const row of rows) {
    if (row.kind !== "sku") continue;
    const skuId = intValue(row.sku_id);
    if (skuId <= 0) continue;
    const paid30 = Number(row.paid30), refund30 = Number(row.refund30);
    const paid90 = Number(row.paid90), refund90 = Number(row.refund90);
    const tmallNet30 = Number(row.tmall_paid30) - Number(row.tmall_refund30);
    const tmallNet90 = Number(row.tmall_paid90) - Number(row.tmall_refund90);
    bySku[String(skuId)] = {
      paid30, refund30, net30: paid30 - refund30,
      paid90, refund90, net90: paid90 - refund90,
      tmallNet30, pddNet30: Number(row.pdd_net30), tmallNet90, pddNet90: Number(row.pdd_net90),
      lastSoldDate: row.last_sold ? String(row.last_sold).slice(0, 10) : null,
      activeDays90: intValue(row.active_days90),
      platformSkus: intValue(row.platform_skus),
    };
  }
  const mappedSkus = Object.keys(bySku).length;
  const platformSkus = intValue(anchorRow?.platform_skus);
  const mappedPlatformSkus = intValue(anchorRow?.mapped_platform_skus);
  const ready = anchorDate != null && mappedSkus > 0;
  return {
    state: ready ? "ready" : "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫+拼多多",
    gate: ready
      ? `观察口径：天猫支付件数 − 成功退款子订单数 + 拼多多有效订单件数（剔除已取消/退款成功），锚点 ${anchorDate}；只覆盖已映射到系统 SKU 的平台 SKU（天猫 ${mappedPlatformSkus}/${platformSkus}${pddOrders ? "，拼多多按对照表身份" : "，拼多多订单未同步"}）。`
      : "最新批次里没有能归到系统 SKU 的天猫销量，外部销速保持关闭。",
    sourceAsOf: sales.sourceAsOf,
    pddSourceAsOf: pddOrders?.sourceAsOf ?? null,
    anchorDate,
    coverage: { platformSkus, mappedPlatformSkus, mappedSkus },
    bySku,
    limitations: [
      "只是影子列：不改销速口径、不写 sales_monthly、不驱动补货；内部事实与外部观察时点不同。",
      "未映射的平台 SKU 不计入任何系统 SKU，故某 SKU 的外部数字可能偏低；覆盖率见决策工作室「平台身份覆盖」。",
      "净需求不含取消未付款、换货与平台时间差。",
    ],
  };
}

export async function loadExternalVelocity(db: ReadDb): Promise<ExternalVelocity> {
  const key = await binding(db);
  if (!key) return emptyExternalVelocity("缺少天猫日销量的成功批次，外部销速保持关闭。");
  const cached = await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${READ_MODEL_CACHE_KEY} AND source_binding = ${key} LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(cached);
  const payload = row?.payload;
  const parsed = typeof payload === "string" ? safeJson(payload) : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<ExternalVelocity>).authority === "observation_only" && (parsed as Partial<ExternalVelocity>).bySku) {
    return parsed as ExternalVelocity;
  }
  return refreshExternalVelocity(db);
}

export async function refreshExternalVelocity(db: ReadDb): Promise<ExternalVelocity> {
  const key = await binding(db);
  if (!key) return emptyExternalVelocity("缺少天猫日销量的成功批次，外部销速保持关闭。");
  const result = await computeExternalVelocity(db);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${READ_MODEL_CACHE_KEY}, ${key}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return result;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** 页面用：拿不到时返回空模型而不是抛错——外部观察缺席不能把内部报表拖垮 */
export async function loadExternalVelocitySafe(db: ReadDb): Promise<ExternalVelocity> {
  try {
    return await loadExternalVelocity(db);
  } catch (error) {
    return emptyExternalVelocity(`外部销速读模型不可用：${(error as Error).message}`);
  }
}
