/**
 * 外部观察销速：按系统 SKU 汇总的天猫+拼多多近 7/15/30/90 天净需求（观察口径）。
 *
 * 为什么需要它（2026-09-02 实测）：内部销量事实 `sales_monthly` 停在 2026-06，
 * 而简道云天猫日销量已到 2026-09-01。销速、可销天数、滞销、临期风险、补货建议全部基于
 * 内部事实——晚了 3 个月。最直接的决策损失：内部判"无动销"、外部其实天天在卖的 SKU
 * 会被错误地打折或报废。
 *
 * 带来源截止、覆盖与门禁；D55允许合格观察参与预警，但绝不写 sales_monthly、
 * 不替代内部事实、不驱动补货数量或自动开单。
 *
 * 身份走两条桥：简道云对照表的唯一 skuId + 业务直接认领（sku_identifiers external/JIANDAOYUN:TMALL）。
 * 未映射的平台 SKU 不计入任何系统 SKU（不按名称猜）。
 */
import { sql, type SQL } from "drizzle-orm";
import { dQty, dSub } from "@/server/core/decimal";
import { pddDemandEligibilitySql } from "@/server/rules/pdd-demand";
import { tmallStreamsCoverSameHorizon } from "./tmall-observation-horizon";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

/** 缓存键（口径升版时随 /vN 变更；部门目标 auto 来源引用它，不得前缀猜测） */
export const EXTERNAL_VELOCITY_CACHE_KEY = "jiandaoyun-external-velocity/v14";
const READ_MODEL_CACHE_KEY = EXTERNAL_VELOCITY_CACHE_KEY;
const PLATFORM_SKU_IDENTIFIER_SCOPE = "JIANDAOYUN:TMALL";

export const EXTERNAL_DEMAND_WINDOWS = [7, 15, 30, 90] as const;
export type ExternalDemandWindowDays = typeof EXTERNAL_DEMAND_WINDOWS[number];
export interface ExternalDemandWindow {
  days: ExternalDemandWindowDays;
  startDay: string | null;
  endDay: string | null;
  complete: boolean;
  /** Only qualified totals; incomplete observations are never filled with zero. */
  net: string | null;
  requiredSequences: number;
  completeSequences: number;
}

export interface ExternalVelocityBySku {
  paid30: string;
  refund30: string;
  net30: string | null;
  paid90: string;
  refund90: string;
  net90: string | null;
  /** 最近一次有支付件数的业务日 */
  lastSoldDate: string | null;
  /** 近 90 天有支付的天数 */
  activeDays90: number;
  /** 归到该 SKU 的平台 SKU 个数（跨店铺） */
  platformSkus: number;
  /** 已观察到的分平台净量，仅用于诊断；未通过覆盖检验时不等于合格总量。 */
  tmallNet30: string;
  pddNet30: string;
  tmallNet90: string;
  pddNet90: string;
  /** 已有受控拼多多身份；即使当前净量为 0，也仍受拼多多观察窗口完整性约束。 */
  pddIdentityCovered: boolean;
  windows: Record<ExternalDemandWindowDays, ExternalDemandWindow>;
}

export interface ExternalVelocity {
  state: "ready" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  platform: "天猫+拼多多";
  gate: string;
  sourceAsOf: string | null;
  pddSourceAsOf: string | null;
  /** 观察窗口锚点 = 各参与平台共同完整覆盖到的最后业务日；30/90 天窗口都从它往回数 */
  anchorDate: string | null;
  coverage: {
    platformSkus: number;
    mappedPlatformSkus: number;
    /** 经天猫组合表拆到组件的平台 SKU（含在 mappedPlatformSkus 内） */
    bundlePlatformSkus: number;
    mappedSkus: number;
    pddObservedDays30: number;
    pddWindowComplete30: boolean;
    pddObservedDays90: number;
    pddWindowComplete90: boolean;
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
function qtyValue(value: unknown): string {
  const candidate = value == null ? "" : String(value).trim();
  return /^-?\d+(\.\d+)?$/.test(candidate) ? dQty(candidate) : "0.0000";
}

/**
 * 最新可用批次。事实流（销量/退款/订单）遇到 qualityBlocked 批次一律不用（fail closed）；
 * 对照表这类**身份维表**例外：它只经 `_identity`（同步时的身份治理结果）被引用，2026-09-03 实测
 * 一批 3,648 行里 2 行缺业务键就被标成 review，而上一批已被 supersede（可用行为 0），
 * 若照旧过滤，外部销速会静默退化成"只剩直接认领"（1,703 → 681 个平台 SKU）。
 * 被 supersede 的批次任何情况下都不再当作可用批次。
 */
async function latestBatch(
  db: ReadDb,
  stream: string,
  options: { allowQualityBlocked?: boolean | "snapshot" } = {},
): Promise<{ importJobId: number; sourceAsOf: string | null } | null> {
  // "snapshot"：平台日快照的 review 若只是业务键重复/缺失仍可用（读模型按业务键去重）；数值非法/对账不符/有删除仍不用
  const qualityFilter = options.allowQualityBlocked === true
    ? sql`true`
    : options.allowQualityBlocked === "snapshot"
      ? sql`(coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
             OR (coalesce((ir.request_scope->'controlSummary'->>'invalidNumericValues')::int, 0) = 0
                 AND coalesce((ir.request_scope->'controlSummary'->>'reconciliationMismatchedRows')::int, 0) = 0
                 AND coalesce((ir.request_scope->'controlSummary'->>'deletedRows')::int, 0) = 0))`
      : sql`coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'`;
  const result = await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND ij.status <> 'superseded'
      AND ${qualityFilter}
      -- 滚动订单流的空窗口本身是有效观察；只有完整快照的空读不能覆盖旧事实。
      AND (${stream} = 'pdd-order-observation' OR coalesce(ir.request_scope->>'emptySource', 'false') = 'false')
      -- 与实际聚合的 90 天保留集一致；越过边界后 binding 会变为 none，旧 ready 缓存不能继续命中。
      AND (${stream} <> 'pdd-order-observation' OR ir.finished_at > now() - interval '90 days')
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
  const [sales, refunds, crosswalk, pddOrders, pddCrosswalk, bundle, direct, pddRetained] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-refund-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "pdd-order-observation"),
    latestBatch(db, "pdd-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "tmall-bundle-detail-observation", { allowQualityBlocked: true }),
    db.execute(sql`SELECT count(*)::int AS n, coalesce(max(id), 0)::int AS max_id, coalesce(max(updated_at), 'epoch')::text AS updated
      FROM sku_identifiers WHERE kind = 'external' AND scope IN (${PLATFORM_SKU_IDENTIFIER_SCOPE}, 'JIANDAOYUN:PDD')`),
    db.execute(sql`
      SELECT coalesce(string_agg(
        ir.id::text || ':' || ir.import_job_id::text || ':' || ir.finished_at::text || ':' || coalesce(ir.request_scope::text, '{}'),
        ',' ORDER BY ir.id
      ), 'none') AS retained
      FROM integration_runs ir
      WHERE ir.connector = 'jdy' AND ir.stream = 'pdd-order-observation'
        AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
        AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
        AND ir.finished_at > now() - interval '90 days'`),
  ]);
  if (!sales && !pddOrders) return null;
  const [d] = resultRows<Record<string, unknown>>(direct);
  const [retained] = resultRows<Record<string, unknown>>(pddRetained);
  return `sales:${sales?.importJobId ?? "none"}|refunds:${refunds?.importJobId ?? "none"}|crosswalk:${crosswalk?.importJobId ?? "none"}|pdd:${String(retained?.retained ?? "none")}:${pddCrosswalk?.importJobId ?? "none"}|bundle:${bundle?.importJobId ?? "none"}|direct:${intValue(d?.n)}:${intValue(d?.max_id)}:${String(d?.updated ?? "")}`;
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
    coverage: {
      platformSkus: 0,
      mappedPlatformSkus: 0,
      bundlePlatformSkus: 0,
      mappedSkus: 0,
      pddObservedDays30: 0,
      pddWindowComplete30: false,
      pddObservedDays90: 0,
      pddWindowComplete90: false,
    },
    bySku: {},
    limitations: [gate],
  };
}

export async function computeExternalVelocity(db: ReadDb): Promise<ExternalVelocity> {
  const [sales, refunds, crosswalk, pddOrders, pddCrosswalk, bundle] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-refund-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "pdd-order-observation"),
    latestBatch(db, "pdd-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "tmall-bundle-detail-observation", { allowQualityBlocked: true }),
  ]);
  const tmallReady = sales && refunds
    ? await tmallStreamsCoverSameHorizon(db, sales.importJobId, refunds.importJobId)
    : false;
  if (!tmallReady && !pddOrders) {
    return emptyExternalVelocity(
      sales && refunds
        ? "天猫退款观察时点落后于销量观察，净需求保持关闭。"
        : sales && !refunds
          ? "缺少天猫成功退款成功批次，净需求保持关闭。"
        : "缺少天猫日销量和拼多多订单的成功批次，外部销速保持关闭。",
    );
  }

  // 全部在 SQL 里做：身份映射（对照表唯一 skuId ∪ 直接认领）→ 按 SKU × 窗口聚合。
  // 页面复用版本化缓存；新窗口逻辑的性能须在对应候选上测量，不继承旧版本耗时。
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
        AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL
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
    -- 第三条天猫桥（2026-09-03，观察口径）：对照表「商家编码/关联货品」= 天猫货品编码，
    -- 数据中台「天猫组合详情列表」把货品编码拆成子货品编码 × 数量，子货品编码 = 系统编码。
    -- 只对前两条桥都没有归属的平台 SKU 生效；组件有一个解析不到系统 SKU 的组合不拆；两列指向不同组合视为歧义。
    bom AS (
      SELECT nullif(trim(payload->'data'->>'bundleCode'), '') AS bc,
             nullif(trim(payload->'data'->>'subproductCode'), '') AS sub,
             min(CASE WHEN trim(coalesce(payload->'data'->>'quantity','')) ~ '^[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'quantity')::numeric ELSE 1 END) AS qty
      FROM staging_rows
      WHERE import_job_id = ${bundle?.importJobId ?? -1}
        AND target_table = 'jdy_tmall_bundle_detail_observation'
        AND status IN ('pending', 'validated', 'committed')
      GROUP BY 1, 2
    ),
    bom_resolved AS (
      SELECT b.bc, k.id AS sku_id, greatest(1, round(b.qty)) AS qty,
             bool_and(k.id IS NOT NULL) OVER (PARTITION BY b.bc) AS complete
      FROM bom b LEFT JOIN skus k ON k.code = b.sub AND k.active = true
      WHERE b.bc IS NOT NULL
    ),
    cwx AS (
      SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'platformSkuId' AS psku,
             max(nullif(trim(payload->'data'->>'merchantSkuCode'), '')) AS mcode,
             max(nullif(trim(payload->'data'->>'relatedGoods'), '')) AS rg
      FROM staging_rows
      WHERE import_job_id = ${crosswalk?.importJobId ?? -1}
        AND target_table = 'jdy_tmall_sku_crosswalk_observation'
        AND status IN ('pending', 'validated', 'committed')
      GROUP BY 1, 2
    ),
    bundle_map AS (
      SELECT c.shop, c.psku, r.sku_id, r.qty
      FROM cwx c
      JOIN (SELECT DISTINCT bc FROM bom_resolved WHERE complete) codes ON codes.bc IN (c.mcode, c.rg)
      JOIN bom_resolved r ON r.bc = codes.bc AND r.sku_id IS NOT NULL
      WHERE NOT EXISTS (SELECT 1 FROM map m WHERE m.shop = c.shop AND m.psku = c.psku AND m.sku_id IS NOT NULL)
        AND (SELECT count(DISTINCT bc) FROM bom_resolved b2 WHERE b2.complete AND b2.bc IN (c.mcode, c.rg)) = 1
    ),
    s_versions AS (
      SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10))
             nullif(trim(payload->>'sourceDeletedAt'), '') AS deleted_at,
             payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku,
             CASE WHEN left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                       AND pg_input_is_valid(left(payload->'data'->>'statisticalDate', 10), 'date')
                  THEN left(payload->'data'->>'statisticalDate', 10)::date END AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'paidNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'paidNumber')::numeric ELSE NULL END AS paid
      FROM staging_rows
      WHERE import_job_id = ${tmallReady ? sales!.importJobId : -1}
        AND target_table = 'jdy_tmall_sku_sales_observation'
        AND status IN ('pending', 'validated', 'committed')
      ORDER BY payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
    ),
    s AS (SELECT * FROM s_versions WHERE deleted_at IS NULL),
    r_versions AS (
      SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10))
             nullif(trim(payload->>'sourceDeletedAt'), '') AS deleted_at,
             payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku,
             CASE WHEN left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                       AND pg_input_is_valid(left(payload->'data'->>'statisticalDate', 10), 'date')
                  THEN left(payload->'data'->>'statisticalDate', 10)::date END AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'successRefundSuborderNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'successRefundSuborderNumber')::numeric ELSE NULL END AS refund
      FROM staging_rows
      WHERE import_job_id = ${tmallReady ? refunds!.importJobId : -1}
        AND target_table = 'jdy_tmall_sku_refund_observation'
        AND status IN ('pending', 'validated', 'committed')
      ORDER BY payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
    ),
    r AS (SELECT * FROM r_versions WHERE deleted_at IS NULL),
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
        AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL
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
    -- 这里把最近 90 天内所有成功批次按业务键（店铺+订单号+商品+商家编码）去重、取最新批次的状态后累加。
    -- 仅计有支付时间或明确已支付状态，且未取消/退款成功的订单。
    pdd_batches AS (
      SELECT ir.import_job_id,
             nullif(ir.request_scope->'window'->>'from', '')::timestamptz AS observed_from_at,
             CASE
               WHEN nullif(ir.request_scope->'window'->>'extractionCutoff', '') IS NULL THEN NULL
               ELSE least(
                 nullif(ir.request_scope->'window'->>'to', '')::timestamptz,
                 nullif(ir.request_scope->'window'->>'extractionCutoff', '')::timestamptz
               )
             END AS observed_through_at
      FROM integration_runs ir
      WHERE ir.connector = 'jdy' AND ir.stream = 'pdd-order-observation'
        AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
        AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
        AND ir.finished_at > now() - interval '90 days'
    ),
    -- 先把每次成功抽取的 updateTime 查询范围合并成连续区间。若停机超过重叠窗口，
    -- 下一次 from 会晚于上次实际抽取 cutoff，形成新岛；缺口之后不能冒充连续覆盖。
    pdd_intervals AS (
      SELECT observed_from_at AS from_at, observed_through_at AS through_at
      FROM pdd_batches
      WHERE observed_from_at IS NOT NULL
        AND observed_through_at IS NOT NULL
        AND observed_from_at <= observed_through_at
    ),
    pdd_ordered_intervals AS (
      SELECT from_at, through_at,
             max(through_at) OVER (
               ORDER BY from_at, through_at
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ) AS prior_max_through
      FROM pdd_intervals
    ),
    pdd_interval_groups AS (
      SELECT from_at, through_at,
             sum(CASE WHEN prior_max_through IS NULL OR from_at > prior_max_through THEN 1 ELSE 0 END)
               OVER (ORDER BY from_at, through_at) AS island_id
      FROM pdd_ordered_intervals
    ),
    pdd_islands AS (
      SELECT min(from_at) AS from_at, max(through_at) AS through_at
      FROM pdd_interval_groups
      GROUP BY island_id
    ),
    pdd_latest_island AS (
      SELECT from_at, through_at
      FROM pdd_islands
      ORDER BY through_at DESC
      LIMIT 1
    ),
    -- 覆盖来自最新连续抽取岛，而不是“有订单的日期”或未来结束的请求范围。
    -- 只计从中国业务日 00:00 到次日 00:00 都被覆盖的完整日：零订单日能推进，
    -- 迟到历史订单不能伪造覆盖，抽取当日未走完也不会提前开门。
    pdd_observation_days AS (
      SELECT DISTINCT day::date AS d
      FROM pdd_latest_island island
      CROSS JOIN LATERAL generate_series(
        (island.from_at + interval '8 hours')::date,
        (island.through_at + interval '8 hours')::date,
        interval '1 day'
      ) AS day
      WHERE (day::date)::timestamp - interval '8 hours' >= island.from_at
        AND ((day::date + 1)::timestamp - interval '8 hours') <= island.through_at
    ),
    pdd_raw AS (
      SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'orderNumber', payload->'data'->>'productId', coalesce(payload->'data'->>'merchantSkuCode', ''))
             payload->'data'->>'shopName' AS shop,
             payload->'data'->>'productId' AS pid,
             nullif(trim(payload->'data'->>'merchantSkuCode'), '') AS mcode,
             CASE WHEN left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                       AND pg_input_is_valid(left(payload->'data'->>'statisticalDate', 10), 'date')
                  THEN left(payload->'data'->>'statisticalDate', 10)::date END AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'productQuantity','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'productQuantity')::numeric ELSE NULL END AS qty,
             coalesce(payload->'data'->>'orderStatus', '') AS status,
             coalesce(payload->'data'->>'afterSalesStatus', '') AS after_sales_status,
             coalesce(payload->'data'->>'paymentTime', '') AS payment_time,
             payload->>'sourceDeletedAt' AS source_deleted_at
      FROM staging_rows
      WHERE import_job_id IN (SELECT import_job_id FROM pdd_batches)
        AND target_table = 'jdy_pdd_order_observation'
        AND status IN ('pending', 'validated', 'committed')
      ORDER BY payload->'data'->>'shopName', payload->'data'->>'orderNumber', payload->'data'->>'productId', coalesce(payload->'data'->>'merchantSkuCode', ''), import_job_id DESC, row_no DESC
    ),
    -- 删除记录必须先参与“最新版本”竞选，再从结果里剔除；否则旧订单会被复活并继续计量。
    pdd AS (
      SELECT shop, pid, mcode, d, qty, status, after_sales_status, payment_time
      FROM pdd_raw
      WHERE nullif(trim(source_deleted_at), '') IS NULL
    ),
    anchor_sources AS (
      SELECT max(d) AS tmall_through FROM s
    ),
    pdd_anchor AS (
      SELECT max(d) AS observed_through FROM pdd_observation_days
    ),
    -- 组合窗口只能锚定在双方都已完整观察的业务日；白天出现的拼多多当日订单
    -- 不能把连续 30 天覆盖挤成 29 天，也不能混入尚未走完的业务日。
    anchor AS (
      SELECT CASE
        WHEN t.tmall_through IS NOT NULL AND p.observed_through IS NOT NULL
          THEN least(t.tmall_through, p.observed_through)
        WHEN t.tmall_through IS NOT NULL THEN t.tmall_through
        WHEN p.observed_through IS NOT NULL THEN p.observed_through
        ELSE (SELECT max(d) FROM pdd)
      END AS d
      FROM anchor_sources t CROSS JOIN pdd_anchor p
    ),
    joined AS (
      SELECT m.sku_id, s.shop, s.psku, s.d, s.paid, 0::numeric AS refund, 'tmall' AS platform FROM s INNER JOIN map m ON m.shop = s.shop AND m.psku = s.psku AND m.sku_id IS NOT NULL
      UNION ALL
      SELECT m.sku_id, r.shop, r.psku, r.d, 0::numeric, r.refund, 'tmall' FROM r INNER JOIN map m ON m.shop = r.shop AND m.psku = r.psku AND m.sku_id IS NOT NULL
      UNION ALL
      SELECT bm.sku_id, s.shop, s.psku, s.d, s.paid * bm.qty, 0::numeric, 'tmall' FROM s INNER JOIN bundle_map bm ON bm.shop = s.shop AND bm.psku = s.psku
      UNION ALL
      SELECT bm.sku_id, r.shop, r.psku, r.d, 0::numeric, r.refund * bm.qty, 'tmall' FROM r INNER JOIN bundle_map bm ON bm.shop = r.shop AND bm.psku = r.psku
      UNION ALL
      SELECT pm.sku_id, p.shop, coalesce(p.mcode, p.pid), p.d,
             CASE WHEN ${pddDemandEligibilitySql({
               paymentTime: sql`p.payment_time`,
               orderStatus: sql`p.status`,
               afterSalesStatus: sql`p.after_sales_status`,
             })} THEN p.qty ELSE 0 END,
             0::numeric, 'pdd'
      FROM pdd p INNER JOIN pdd_identity pm ON pm.shop = p.shop AND pm.pid = p.pid AND pm.mcode IS NOT DISTINCT FROM p.mcode AND pm.sku_id IS NOT NULL
    ),
    pdd_cov AS (
      SELECT count(DISTINCT o.d) FILTER (WHERE o.d > a.d - 30 AND o.d <= a.d)::int AS observed_days30,
             count(DISTINCT o.d) FILTER (WHERE o.d > a.d - 90 AND o.d <= a.d)::int AS observed_days90
      FROM anchor a LEFT JOIN pdd_observation_days o ON true
    ),
    report_skus AS (
      SELECT DISTINCT sku_id FROM joined
      UNION
      SELECT DISTINCT sku_id FROM pdd_identity WHERE sku_id IS NOT NULL
      UNION
      SELECT DISTINCT sku_id FROM map WHERE sku_id IS NOT NULL
      UNION
      SELECT DISTINCT sku_id FROM bundle_map
    ),
    per_sku AS (
      SELECT rs.sku_id,
        sum(j.paid) FILTER (WHERE j.d > a.d - 30 AND j.d <= a.d AND j.platform = 'tmall') AS tmall_paid30,
        sum(j.refund) FILTER (WHERE j.d > a.d - 30 AND j.d <= a.d AND j.platform = 'tmall') AS tmall_refund30,
        sum(j.paid) FILTER (WHERE j.d > a.d - 30 AND j.d <= a.d AND j.platform = 'pdd') AS pdd_net30,
        sum(j.paid) FILTER (WHERE j.d > a.d - 90 AND j.d <= a.d AND j.platform = 'tmall') AS tmall_paid90,
        sum(j.refund) FILTER (WHERE j.d > a.d - 90 AND j.d <= a.d AND j.platform = 'tmall') AS tmall_refund90,
        sum(j.paid) FILTER (WHERE j.d > a.d - 90 AND j.d <= a.d AND j.platform = 'pdd') AS pdd_net90,
        sum(j.paid) FILTER (WHERE j.d > a.d - 30 AND j.d <= a.d) AS paid30,
        sum(j.refund) FILTER (WHERE j.d > a.d - 30 AND j.d <= a.d) AS refund30,
        sum(j.paid) FILTER (WHERE j.d > a.d - 90 AND j.d <= a.d) AS paid90,
        sum(j.refund) FILTER (WHERE j.d > a.d - 90 AND j.d <= a.d) AS refund90,
        max(j.d) FILTER (WHERE j.paid > 0 AND j.d <= a.d) AS last_sold,
        count(DISTINCT j.d) FILTER (WHERE j.paid > 0 AND j.d > a.d - 90 AND j.d <= a.d) AS active_days90,
        count(DISTINCT (j.shop, j.psku)) FILTER (WHERE j.shop IS NOT NULL AND j.psku IS NOT NULL) AS platform_skus
      FROM report_skus rs LEFT JOIN joined j ON j.sku_id = rs.sku_id CROSS JOIN anchor a
      GROUP BY rs.sku_id
    ),
    demand_windows(days) AS (VALUES (7), (15), (30), (90)),
    tmall_identities AS (
      SELECT sku_id, shop, psku FROM map WHERE sku_id IS NOT NULL
      UNION
      SELECT sku_id, shop, psku FROM bundle_map
    ),
    tmall_days AS (
      SELECT coalesce(s.shop, r.shop) AS shop, coalesce(s.psku, r.psku) AS psku,
             coalesce(s.d, r.d) AS d, s.paid, r.refund
      FROM s FULL JOIN r ON r.shop = s.shop AND r.psku = s.psku AND r.d = s.d
    ),
    -- 每条店铺×平台SKU独立需要销量与退款的逐日证据；不同店铺不能互补缺日。
    tmall_sequence_windows AS (
      SELECT i.sku_id, w.days, i.shop, i.psku,
             count(t.paid) = w.days AND count(t.refund) = w.days
             AND NOT EXISTS (SELECT 1 FROM tmall_days bad WHERE bad.shop = i.shop AND bad.psku = i.psku AND bad.d IS NULL) AS complete
      FROM tmall_identities i CROSS JOIN demand_windows w CROSS JOIN anchor a
      LEFT JOIN tmall_days t ON t.shop = i.shop AND t.psku = i.psku AND t.d > a.d - w.days AND t.d <= a.d
      GROUP BY i.sku_id, w.days, i.shop, i.psku
    ),
    pdd_window_coverage AS (
      SELECT w.days, count(o.d) = w.days AS complete
      FROM demand_windows w CROSS JOIN anchor a
      LEFT JOIN pdd_observation_days o ON o.d > a.d - w.days AND o.d <= a.d
      GROUP BY w.days
    ),
    sequence_windows AS (
      SELECT sku_id, days, complete FROM tmall_sequence_windows
      UNION ALL
      SELECT i.sku_id, c.days, c.complete AND NOT EXISTS (
        SELECT 1 FROM pdd p CROSS JOIN anchor a
        WHERE p.shop = i.shop AND p.pid = i.pid AND p.mcode IS NOT DISTINCT FROM i.mcode
          AND (p.d IS NULL OR (p.d > a.d - c.days AND p.d <= a.d AND p.qty IS NULL))
      )
      FROM pdd_identity i CROSS JOIN pdd_window_coverage c WHERE i.sku_id IS NOT NULL
    ),
    window_qualification AS (
      SELECT sku_id, days, count(*)::int AS required_sequences,
             count(*) FILTER (WHERE complete)::int AS complete_sequences,
             bool_and(complete) AS complete
      FROM sequence_windows GROUP BY sku_id, days
    ),
    window_totals AS (
      SELECT rs.sku_id, w.days, a.d AS end_day, a.d - w.days + 1 AS start_day,
             coalesce(sum(j.paid), 0) - coalesce(sum(j.refund), 0) AS observed_net
      FROM report_skus rs CROSS JOIN demand_windows w CROSS JOIN anchor a
      LEFT JOIN joined j ON j.sku_id = rs.sku_id AND j.d > a.d - w.days AND j.d <= a.d
      GROUP BY rs.sku_id, w.days, a.d
    ),
    qualified_windows AS (
      SELECT t.sku_id, jsonb_object_agg(t.days::text, jsonb_build_object(
        'days', t.days, 'startDay', t.start_day::text, 'endDay', t.end_day::text,
        'complete', coalesce(q.complete, false),
        'net', CASE WHEN q.complete THEN t.observed_net::text ELSE NULL END,
        'requiredSequences', coalesce(q.required_sequences, 0),
        'completeSequences', coalesce(q.complete_sequences, 0)
      )) AS windows
      FROM window_totals t LEFT JOIN window_qualification q ON q.sku_id = t.sku_id AND q.days = t.days
      GROUP BY t.sku_id
    ),
    cov AS (
      SELECT count(DISTINCT (s.shop, s.psku)) AS platform_skus,
             count(DISTINCT (s.shop, s.psku)) FILTER (WHERE m.sku_id IS NOT NULL OR bm.psku IS NOT NULL) AS mapped_platform_skus,
             count(DISTINCT (s.shop, s.psku)) FILTER (WHERE m.sku_id IS NULL AND bm.psku IS NOT NULL) AS bundle_platform_skus
      FROM s LEFT JOIN map m ON m.shop = s.shop AND m.psku = s.psku
      LEFT JOIN (SELECT DISTINCT shop, psku FROM bundle_map) bm ON bm.shop = s.shop AND bm.psku = s.psku
    )
    SELECT 'anchor' AS kind, a.d::text AS anchor, NULL::int AS sku_id, NULL::numeric AS paid30, NULL::numeric AS refund30, NULL::numeric AS paid90, NULL::numeric AS refund90,
           NULL::text AS last_sold, NULL::int AS active_days90, cov.platform_skus::int AS platform_skus, cov.mapped_platform_skus::int AS mapped_platform_skus,
           NULL::numeric AS tmall_paid30, NULL::numeric AS tmall_refund30, NULL::numeric AS pdd_net30, NULL::numeric AS tmall_paid90, NULL::numeric AS tmall_refund90, NULL::numeric AS pdd_net90,
           NULL::boolean AS pdd_identity_covered,
           pdd_cov.observed_days30, pdd_cov.observed_days90, cov.bundle_platform_skus::int AS bundle_platform_skus, NULL::jsonb AS windows
    FROM anchor a CROSS JOIN cov CROSS JOIN pdd_cov
    UNION ALL
    SELECT 'sku', NULL, p.sku_id, coalesce(p.paid30, 0), coalesce(p.refund30, 0), coalesce(p.paid90, 0), coalesce(p.refund90, 0),
           p.last_sold::text, p.active_days90::int, p.platform_skus::int, NULL,
           coalesce(p.tmall_paid30, 0), coalesce(p.tmall_refund30, 0), coalesce(p.pdd_net30, 0), coalesce(p.tmall_paid90, 0), coalesce(p.tmall_refund90, 0), coalesce(p.pdd_net90, 0),
           EXISTS (SELECT 1 FROM pdd_identity pi WHERE pi.sku_id = p.sku_id),
           NULL::int, NULL::int, NULL::int, qw.windows
    FROM per_sku p INNER JOIN qualified_windows qw ON qw.sku_id = p.sku_id
  `);

  const rows = resultRows<Record<string, unknown>>(result);
  const anchorRow = rows.find((r) => r.kind === "anchor");
  const anchorDate = anchorRow?.anchor ? String(anchorRow.anchor).slice(0, 10) : null;
  const pddObservedDays30 = intValue(anchorRow?.observed_days30);
  const pddWindowComplete30 = !pddOrders || pddObservedDays30 >= 30;
  const pddObservedDays90 = intValue(anchorRow?.observed_days90);
  const pddWindowComplete90 = !pddOrders || pddObservedDays90 >= 90;
  const bySku: Record<string, ExternalVelocityBySku> = {};
  for (const row of rows) {
    if (row.kind !== "sku") continue;
    const skuId = intValue(row.sku_id);
    if (skuId <= 0) continue;
    const paid30 = qtyValue(row.paid30), refund30 = qtyValue(row.refund30);
    const paid90 = qtyValue(row.paid90), refund90 = qtyValue(row.refund90);
    const tmallNet30 = dSub(qtyValue(row.tmall_paid30), qtyValue(row.tmall_refund30), 4);
    const tmallNet90 = dSub(qtyValue(row.tmall_paid90), qtyValue(row.tmall_refund90), 4);
    const pddNet30 = qtyValue(row.pdd_net30);
    const pddNet90 = qtyValue(row.pdd_net90);
    const pddIdentityCovered = row.pdd_identity_covered === true;
    const windows = row.windows as ExternalVelocityBySku["windows"];
    for (const days of EXTERNAL_DEMAND_WINDOWS) {
      if (windows[days].net != null) windows[days].net = dQty(windows[days].net!);
    }
    bySku[String(skuId)] = {
      // 拼多多身份只要参与该 SKU，30 天连续覆盖不足时组合总量就是未知；
      // 即使当前只有取消/未付款/窗口外订单，也绝不能把聚合出的 0 发布给 dashboard / risk。
      paid30, refund30,
      net30: windows[30].net,
      paid90, refund90,
      // 有拼多多身份但 90 天抽取不连续时，组合 90 天总量未知；绝不把缺失日当 0。
      net90: windows[90].net,
      tmallNet30, pddNet30, tmallNet90, pddNet90,
      pddIdentityCovered,
      windows,
      lastSoldDate: row.last_sold ? String(row.last_sold).slice(0, 10) : null,
      activeDays90: intValue(row.active_days90),
      platformSkus: intValue(row.platform_skus),
    };
  }
  const mappedSkus = Object.keys(bySku).length;
  const platformSkus = intValue(anchorRow?.platform_skus);
  const mappedPlatformSkus = intValue(anchorRow?.mapped_platform_skus);
  const bundlePlatformSkus = intValue(anchorRow?.bundle_platform_skus);
  const ready = anchorDate != null && mappedSkus > 0;
  return {
    state: ready ? "ready" : "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫+拼多多",
    gate: ready
      ? `观察口径：天猫支付件数 − 成功退款子订单数 + 拼多多已付款有效订单件数，锚点 ${anchorDate}；只覆盖已映射到系统 SKU 的平台 SKU（天猫 ${mappedPlatformSkus}/${platformSkus}${bundlePlatformSkus ? `，其中 ${bundlePlatformSkus} 个经组合表拆到组件` : ""}${pddOrders ? "，拼多多按对照表身份" : "，拼多多订单未同步"}）。`
      : "最新可用批次里没有能归到系统 SKU 的天猫/拼多多需求，外部销速保持关闭。",
    sourceAsOf: tmallReady ? sales!.sourceAsOf : null,
    pddSourceAsOf: pddOrders?.sourceAsOf ?? null,
    anchorDate,
    coverage: {
      platformSkus,
      mappedPlatformSkus,
      bundlePlatformSkus,
      mappedSkus,
      pddObservedDays30,
      pddWindowComplete30,
      pddObservedDays90,
      pddWindowComplete90,
    },
    bySku,
    limitations: [
      "观察数据只辅助解释与合格预警，不写 sales_monthly、不驱动补货数量；内部事实与外部观察时点不同。",
      "7/15/30/90日净量各自校验窗口：天猫每条已认领店铺×平台SKU须有逐日支付与退款证据，拼多多须有连续抽取覆盖。未知不补零，完整仅指已认领序列，不证明全渠道覆盖。",
      "未映射的平台 SKU 不计入任何系统 SKU，故某 SKU 的外部数字可能偏低；覆盖率见决策工作室「平台身份覆盖」。",
      "净需求仅含有支付时间或明确已支付状态的订单，不含待付款、取消、退款成功、换货与平台时间差。",
      !pddOrders ? "尚无可用拼多多订单抽取批次，不代表零需求或已经覆盖。" : !pddWindowComplete30
        ? `拼多多在共同锚点前 30 天内仅观测到 ${pddObservedDays30} 个业务日；包含拼多多的 SKU 暂不发布组合 30 天净需求。`
        : "拼多多近 30 天观测窗口已达到折算日均的要求。",
      !pddOrders ? "拼多多90日覆盖未知。" : !pddWindowComplete90
        ? `拼多多在共同锚点前 90 天内仅观测到 ${pddObservedDays90} 个业务日；包含拼多多的 SKU 暂不发布组合 90 天净需求。`
        : "拼多多近 90 天观测窗口已达到汇总要求。",
    ],
  };
}

export async function loadExternalVelocity(db: ReadDb): Promise<ExternalVelocity> {
  const key = await binding(db);
  if (!key) return emptyExternalVelocity("缺少天猫日销量和拼多多订单的成功批次，外部销速保持关闭。");
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
  if (!key) return emptyExternalVelocity("缺少天猫日销量和拼多多订单的成功批次，外部销速保持关闭。");
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
