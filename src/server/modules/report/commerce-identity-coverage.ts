/**
 * 简道云多平台商品身份覆盖。
 *
 * 只聚合每条对照契约的最新成功、不可变 staging 批次。这里回答的是“平台商品能否
 * 精确归属系统 SKU”，而不是把平台商品表提升为主数据；重复、冲突、缺桥或陈旧都会
 * 显式留在门禁中，绝不按名称猜测或自动覆盖 SCM 主档。
 */
import { sql, type SQL } from "drizzle-orm";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

type PlatformKey = "tmall" | "pdd" | "vip";

interface PlatformContract {
  key: PlatformKey;
  platform: string;
  stream: string;
  targetTable: string;
  freshnessMaxAgeDays: number;
  bridgeLabel: string;
  bridgeCanClaim: boolean;
  identityExpr: SQL;
  shopExpr: SQL;
  externalIdExpr: SQL;
  productNameExpr: SQL;
  bridgeExpr: SQL;
  bridgePolicy: string;
}

const PLATFORM_CONTRACTS: PlatformContract[] = [
  {
    key: "tmall",
    platform: "天猫",
    stream: "tmall-sku-crosswalk-observation",
    targetTable: "jdy_tmall_sku_crosswalk_observation",
    freshnessMaxAgeDays: 45,
    bridgeLabel: "条码",
    bridgeCanClaim: true,
    identityExpr: sql`CASE
      WHEN trim(coalesce(payload->'data'->>'shopName', '')) = ''
        OR trim(coalesce(payload->'data'->>'platformSkuId', '')) = '' THEN ''
      ELSE trim(payload->'data'->>'shopName') || '|' || trim(payload->'data'->>'platformSkuId')
    END`,
    shopExpr: sql`nullif(trim(payload->'data'->>'shopName'), '')`,
    externalIdExpr: sql`nullif(trim(payload->'data'->>'platformSkuId'), '')`,
    productNameExpr: sql`coalesce(
      nullif(trim(payload->'data'->>'relatedGoods'), ''),
      nullif(trim(payload->'data'->>'merchantSkuCode'), '')
    )`,
    bridgeExpr: sql`nullif(trim(payload->'data'->>'barcode'), '')`,
    bridgePolicy: "条码只做精确唯一匹配；缺条码的身份不能归属系统 SKU。",
  },
  {
    key: "pdd",
    platform: "拼多多",
    stream: "pdd-sku-crosswalk-observation",
    targetTable: "jdy_pdd_sku_crosswalk_observation",
    freshnessMaxAgeDays: 45,
    bridgeLabel: "商家 SKU 编码（观察）",
    bridgeCanClaim: false,
    identityExpr: sql`CASE
      WHEN trim(coalesce(payload->'data'->>'shopName', '')) = ''
        OR trim(coalesce(payload->'data'->>'platformSkuId', '')) = '' THEN ''
      ELSE trim(payload->'data'->>'shopName') || '|' || trim(payload->'data'->>'platformSkuId')
    END`,
    shopExpr: sql`nullif(trim(payload->'data'->>'shopName'), '')`,
    externalIdExpr: sql`nullif(trim(payload->'data'->>'platformSkuId'), '')`,
    productNameExpr: sql`nullif(trim(payload->'data'->>'productName'), '')`,
    bridgeExpr: sql`nullif(trim(payload->'data'->>'merchantSkuCode'), '')`,
    bridgePolicy: "商家 SKU 编码与 SCM 编码是不同命名空间；未经业务确认，不自动匹配。",
  },
  {
    key: "vip",
    platform: "唯品会",
    stream: "vip-product-crosswalk-observation",
    targetTable: "jdy_vip_product_crosswalk_observation",
    freshnessMaxAgeDays: 45,
    bridgeLabel: "条码",
    bridgeCanClaim: true,
    identityExpr: sql`trim(coalesce(payload->'data'->>'platformProductId', ''))`,
    shopExpr: sql`NULL`,
    externalIdExpr: sql`nullif(trim(payload->'data'->>'platformProductId'), '')`,
    productNameExpr: sql`nullif(trim(payload->'data'->>'productName'), '')`,
    bridgeExpr: sql`nullif(trim(payload->'data'->>'barcode'), '')`,
    bridgePolicy: "条码只做精确唯一匹配；一条码多 SKU 时保持冲突并交人工裁决。",
  },
];

interface LatestBatch {
  importJobId: number;
  sourceAsOf: string | null;
}

export interface CommerceIdentityPlatformCoverage {
  key: PlatformKey;
  platform: string;
  state: "ready" | "insufficient";
  authority: "observation_only";
  releaseState: "blocked";
  gate: string;
  sourceAsOf: string | null;
  ageDays: number | null;
  freshnessMaxAgeDays: number;
  fresh: boolean | null;
  bridgeLabel: string;
  bridgePolicy: string;
  sourceRows: number;
  invalidIdentityRows: number;
  uniqueIdentities: number;
  mappedIdentities: number;
  identityPct: number | null;
  bridgeIdentities: number;
  bridgePct: number | null;
  duplicateGroups: number;
  duplicateRows: number;
  conflictingMappings: number;
  repairBacklog: number;
}

export type CommerceIdentityIssue =
  | "conflicting_mapping"
  | "conflicting_bridge"
  | "unmapped_with_bridge"
  | "missing_bridge"
  | "duplicate_source";

export interface CommerceIdentityRepairItem {
  platformKey: PlatformKey;
  platform: string;
  shopName: string | null;
  externalId: string;
  productName: string | null;
  bridgeLabel: string;
  bridgeValue: string | null;
  exceptionId: number | null;
  exceptionStatus: "open" | "resolved" | "ignored" | null;
  sourceRows: number;
  issue: CommerceIdentityIssue;
  priority: 1 | 2 | 3 | 4;
  action: string;
  claimable: boolean;
}

export interface CommerceIdentityCoverage {
  state: "ready" | "partial" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  gate: string;
  platforms: CommerceIdentityPlatformCoverage[];
  repairQueue: CommerceIdentityRepairItem[];
  summary: {
    availablePlatforms: number;
    totalPlatforms: number;
    sourceRows: number;
    uniqueIdentities: number;
    mappedIdentities: number;
    identityPct: number | null;
    qualityIssues: number;
    repairBacklog: number;
  };
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

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function ageDays(sourceAsOf: string | null, now: Date): number | null {
  if (!sourceAsOf) return null;
  const parsed = new Date(sourceAsOf);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 86_400_000));
}

async function latestBatch(db: ReadDb, stream: string): Promise<LatestBatch | null> {
  const result = await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
    ORDER BY ir.id DESC
    LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  const importJobId = intValue(row?.import_job_id);
  return importJobId > 0
    ? { importJobId, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) }
    : null;
}

async function loadPlatform(
  db: ReadDb,
  contract: PlatformContract,
  batch: LatestBatch | null,
  now: Date,
): Promise<CommerceIdentityPlatformCoverage> {
  const age = ageDays(batch?.sourceAsOf ?? null, now);
  const base = {
    key: contract.key,
    platform: contract.platform,
    authority: "observation_only" as const,
    releaseState: "blocked" as const,
    sourceAsOf: batch?.sourceAsOf ?? null,
    ageDays: age,
    freshnessMaxAgeDays: contract.freshnessMaxAgeDays,
    fresh: age == null ? null : age <= contract.freshnessMaxAgeDays,
    bridgeLabel: contract.bridgeLabel,
    bridgePolicy: contract.bridgePolicy,
  };
  if (!batch) {
    return {
      ...base,
      state: "insufficient",
      gate: "缺少最新成功同步批次；不能把缺失显示为零覆盖。",
      sourceRows: 0,
      invalidIdentityRows: 0,
      uniqueIdentities: 0,
      mappedIdentities: 0,
      identityPct: null,
      bridgeIdentities: 0,
      bridgePct: null,
      duplicateGroups: 0,
      duplicateRows: 0,
      conflictingMappings: 0,
      repairBacklog: 0,
    };
  }

  const result = await db.execute(sql`
    WITH raw AS (
      SELECT
        ${contract.identityExpr} AS platform_identity,
        ${contract.shopExpr} AS shop_name,
        ${contract.externalIdExpr} AS external_id,
        ${contract.productNameExpr} AS product_name,
        ${contract.bridgeExpr} AS bridge_value,
        CASE WHEN coalesce(payload->'_identity'->>'skuId', '') ~ '^[0-9]+$'
          THEN (payload->'_identity'->>'skuId')::int ELSE NULL END AS scm_sku_id
      FROM staging_rows
      WHERE import_job_id = ${batch.importJobId}
        AND target_table = ${contract.targetTable}
        AND status IN ('pending', 'validated', 'committed')
    ), grouped AS (
      SELECT
        platform_identity,
        count(*)::int AS source_rows,
        count(DISTINCT bridge_value) FILTER (WHERE bridge_value IS NOT NULL)::int AS bridge_values,
        count(DISTINCT scm_sku_id) FILTER (WHERE scm_sku_id IS NOT NULL)::int AS mapped_values
      FROM raw
      WHERE platform_identity <> ''
      GROUP BY platform_identity
    )
    SELECT
      (SELECT count(*)::int FROM raw) AS source_rows,
      (SELECT count(*)::int FROM raw WHERE platform_identity = '') AS invalid_identity_rows,
      count(*)::int AS unique_identities,
      count(*) FILTER (WHERE mapped_values = 1)::int AS mapped_identities,
      count(*) FILTER (WHERE bridge_values > 0)::int AS bridge_identities,
      count(*) FILTER (WHERE source_rows > 1)::int AS duplicate_groups,
      coalesce(sum(source_rows - 1) FILTER (WHERE source_rows > 1), 0)::int AS duplicate_rows,
      count(*) FILTER (WHERE mapped_values > 1)::int AS conflicting_mappings
      , count(*) FILTER (
        WHERE mapped_values <> 1 OR source_rows > 1 OR bridge_values > 1
      )::int AS repair_backlog
    FROM grouped
  `);
  const [row = {}] = resultRows<Record<string, unknown>>(result);
  const sourceRows = intValue(row.source_rows);
  const invalidIdentityRows = intValue(row.invalid_identity_rows);
  const uniqueIdentities = intValue(row.unique_identities);
  const mappedIdentities = intValue(row.mapped_identities);
  const bridgeIdentities = intValue(row.bridge_identities);
  const duplicateGroups = intValue(row.duplicate_groups);
  const duplicateRows = intValue(row.duplicate_rows);
  const conflictingMappings = intValue(row.conflicting_mappings);
  const repairBacklog = intValue(row.repair_backlog);
  const qualityIssues = invalidIdentityRows + duplicateGroups + conflictingMappings;
  const identityPct = percent(mappedIdentities, uniqueIdentities);
  const fresh = age == null ? null : age <= contract.freshnessMaxAgeDays;
  const gate = uniqueIdentities === 0
    ? "最新批次没有有效平台身份；保持关闭。"
    : fresh == null
      ? "批次缺少业务截止日；无法判断新鲜度，禁止放行。"
      : !fresh
      ? `数据已超过 ${contract.freshnessMaxAgeDays} 天新鲜度门槛；保持观察且禁止放行。`
      : qualityIssues > 0
        ? `发现 ${qualityIssues} 个缺键、重复组或冲突映射；覆盖可观察，但禁止进入正式事实。`
        : (identityPct ?? 0) < 80
          ? `系统 SKU 身份覆盖 ${identityPct?.toFixed(1) ?? "未知"}%，低于 80% 运营门槛。`
          : "覆盖可供人工核对；完成平台总量对账、业务 UAT 与审批前仍禁止放行。";

  return {
    ...base,
    fresh,
    state: uniqueIdentities > 0 ? "ready" : "insufficient",
    gate,
    sourceRows,
    invalidIdentityRows,
    uniqueIdentities,
    mappedIdentities,
    identityPct,
    bridgeIdentities,
    bridgePct: percent(bridgeIdentities, uniqueIdentities),
    duplicateGroups,
    duplicateRows,
    conflictingMappings,
    repairBacklog,
  };
}

function repairAction(
  issue: CommerceIdentityIssue,
  contract: PlatformContract,
  exceptionStatus: CommerceIdentityRepairItem["exceptionStatus"],
): { action: string; claimable: boolean } {
  if (issue === "conflicting_mapping") {
    return { action: "裁决同一平台身份的多 SKU 归属", claimable: false };
  }
  if (issue === "conflicting_bridge") {
    return { action: `回源修正同一身份的多个${contract.bridgeLabel}`, claimable: false };
  }
  if (issue === "unmapped_with_bridge" && contract.bridgeCanClaim) {
    if (exceptionStatus === "open") {
      return { action: `按唯一${contract.bridgeLabel}进入人工认领`, claimable: true };
    }
    if (exceptionStatus === "resolved") {
      return { action: "已认领；重新同步对照批次取得系统 SKU 归属", claimable: false };
    }
    if (exceptionStatus === "ignored") {
      return { action: "异常已忽略；回源核对后决定是否重新开放", claimable: false };
    }
    return { action: "先同步生成开放异常，再进入人工认领", claimable: false };
  }
  if (issue === "unmapped_with_bridge") {
    return { action: "先确认外部编码命名空间，再登记受治理别名", claimable: false };
  }
  if (issue === "missing_bridge") {
    return { action: `回源补齐${contract.bridgeLabel}或已确认对照`, claimable: false };
  }
  return { action: "合并或解释重复来源记录", claimable: false };
}

async function loadRepairQueue(
  db: ReadDb,
  contract: PlatformContract,
  batch: LatestBatch | null,
): Promise<CommerceIdentityRepairItem[]> {
  if (!batch) return [];
  const result = await db.execute(sql`
    WITH raw AS (
      SELECT
        ${contract.identityExpr} AS platform_identity,
        ${contract.shopExpr} AS shop_name,
        ${contract.externalIdExpr} AS external_id,
        ${contract.productNameExpr} AS product_name,
        ${contract.bridgeExpr} AS bridge_value,
        CASE WHEN coalesce(payload->'_identity'->>'skuId', '') ~ '^[0-9]+$'
          THEN (payload->'_identity'->>'skuId')::int ELSE NULL END AS scm_sku_id
      FROM staging_rows
      WHERE import_job_id = ${batch.importJobId}
        AND target_table = ${contract.targetTable}
        AND status IN ('pending', 'validated', 'committed')
    ), grouped AS (
      SELECT
        platform_identity,
        max(shop_name) AS shop_name,
        max(external_id) AS external_id,
        max(product_name) AS product_name,
        CASE WHEN count(DISTINCT bridge_value) FILTER (WHERE bridge_value IS NOT NULL) = 1
          THEN max(bridge_value) ELSE NULL END AS bridge_value,
        count(*)::int AS source_rows,
        count(DISTINCT bridge_value) FILTER (WHERE bridge_value IS NOT NULL)::int AS bridge_values,
        count(DISTINCT scm_sku_id) FILTER (WHERE scm_sku_id IS NOT NULL)::int AS mapped_values
      FROM raw
      WHERE platform_identity <> ''
      GROUP BY platform_identity
    ), classified AS (
      SELECT *, CASE
        WHEN mapped_values > 1 THEN 'conflicting_mapping'
        WHEN bridge_values > 1 THEN 'conflicting_bridge'
        WHEN mapped_values = 0 AND bridge_values = 1 THEN 'unmapped_with_bridge'
        WHEN mapped_values = 0 THEN 'missing_bridge'
        ELSE 'duplicate_source'
      END AS issue,
      CASE
        WHEN mapped_values > 1 OR bridge_values > 1 THEN 1
        WHEN mapped_values = 0 AND bridge_values = 1 THEN 2
        WHEN mapped_values = 0 THEN 3
        ELSE 4
      END AS priority
      FROM grouped
      WHERE mapped_values <> 1 OR source_rows > 1 OR bridge_values > 1
    )
    SELECT c.shop_name, c.external_id, c.product_name, c.bridge_value,
      c.source_rows, c.issue, c.priority,
      ae.id AS exception_id, ae.status AS exception_status
    FROM classified c
    LEFT JOIN alias_exceptions ae
      ON ${contract.bridgeCanClaim} = true
      AND ae.alias_type = 'sku_barcode'
      AND ae.scope = 'JIANDAOYUN'
      AND ae.raw_value = c.bridge_value
    ORDER BY priority, source_rows DESC, platform_identity
    LIMIT 20
  `);

  return resultRows<Record<string, unknown>>(result).map((row) => {
    const rawIssue = String(row.issue ?? "missing_bridge") as CommerceIdentityIssue;
    const issue: CommerceIdentityIssue = [
      "conflicting_mapping", "conflicting_bridge", "unmapped_with_bridge",
      "missing_bridge", "duplicate_source",
    ].includes(rawIssue) ? rawIssue : "missing_bridge";
    const exceptionStatus = row.exception_status === "open"
      || row.exception_status === "resolved"
      || row.exception_status === "ignored"
      ? row.exception_status
      : null;
    const { action, claimable } = repairAction(issue, contract, exceptionStatus);
    const rawPriority = intValue(row.priority);
    const priority = (rawPriority >= 1 && rawPriority <= 4 ? rawPriority : 4) as 1 | 2 | 3 | 4;
    return {
      platformKey: contract.key,
      platform: contract.platform,
      shopName: row.shop_name == null ? null : String(row.shop_name),
      externalId: String(row.external_id ?? ""),
      productName: row.product_name == null ? null : String(row.product_name),
      bridgeLabel: contract.bridgeLabel,
      bridgeValue: row.bridge_value == null ? null : String(row.bridge_value),
      exceptionId: row.exception_id == null ? null : intValue(row.exception_id),
      exceptionStatus,
      sourceRows: intValue(row.source_rows),
      issue,
      priority,
      action,
      claimable,
    };
  });
}

export async function loadCommerceIdentityCoverage(
  db: ReadDb,
  options: { now?: Date } = {},
): Promise<CommerceIdentityCoverage> {
  const now = options.now ?? new Date();
  const batches = await Promise.all(PLATFORM_CONTRACTS.map((item) => latestBatch(db, item.stream)));
  const platforms = await Promise.all(
    PLATFORM_CONTRACTS.map((item, index) => loadPlatform(db, item, batches[index], now)),
  );
  const repairQueue = (await Promise.all(
    PLATFORM_CONTRACTS.map((item, index) => loadRepairQueue(db, item, batches[index])),
  )).flat().sort((a, b) => a.priority - b.priority
    || b.sourceRows - a.sourceRows
    || a.platform.localeCompare(b.platform, "zh-CN")
    || a.externalId.localeCompare(b.externalId));
  const availablePlatforms = platforms.filter((item) => item.state === "ready").length;
  const sourceRows = platforms.reduce((sum, item) => sum + item.sourceRows, 0);
  const uniqueIdentities = platforms.reduce((sum, item) => sum + item.uniqueIdentities, 0);
  const mappedIdentities = platforms.reduce((sum, item) => sum + item.mappedIdentities, 0);
  const qualityIssues = platforms.reduce(
    (sum, item) => sum + item.invalidIdentityRows + item.duplicateGroups + item.conflictingMappings,
    0,
  );
  const repairBacklog = platforms.reduce((sum, item) => sum + item.repairBacklog, 0);
  const state = availablePlatforms === PLATFORM_CONTRACTS.length
    ? "ready"
    : availablePlatforms > 0 ? "partial" : "insufficient";

  return {
    state,
    authority: "observation_only",
    source: "JIANDAOYUN",
    gate: state === "insufficient"
      ? "三个平台都缺少可用身份批次，身份分析保持关闭。"
      : state === "partial"
        ? `仅 ${availablePlatforms}/${PLATFORM_CONTRACTS.length} 个平台有可用批次；不得跨平台推断完整覆盖。`
        : "三平台身份批次可观察；每个平台仍须分别通过新鲜度、唯一性、覆盖、对账和 UAT 门禁。",
    platforms,
    repairQueue,
    summary: {
      availablePlatforms,
      totalPlatforms: PLATFORM_CONTRACTS.length,
      sourceRows,
      uniqueIdentities,
      mappedIdentities,
      identityPct: percent(mappedIdentities, uniqueIdentities),
      qualityIssues,
      repairBacklog,
    },
    limitations: [
      "这是简道云只读观察，不是 SCM 商品主档、聚水潭履约事实或用友财务事实。",
      "覆盖率按各平台自己的业务键去重后计算；跨平台身份不可相互替代或直接相加成 SKU 数。",
      "名称、规格、商家编码不会被模糊匹配；只有经批准的精确条码/别名才能建立系统 SKU 身份。",
      "最新成功批次参与计算，历史批次继续作为审计证据保留，不重复累计。",
    ],
  };
}

export function emptyCommerceIdentityCoverage(): CommerceIdentityCoverage {
  return {
    state: "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    gate: "尚未取得可用的平台商品身份批次。",
    platforms: [],
    repairQueue: [],
    summary: {
      availablePlatforms: 0,
      totalPlatforms: PLATFORM_CONTRACTS.length,
      sourceRows: 0,
      uniqueIdentities: 0,
      mappedIdentities: 0,
      identityPct: null,
      qualityIssues: 0,
      repairBacklog: 0,
    },
    limitations: ["缺少平台身份证据，系统不会用 0% 或历史样本伪装当前覆盖。"],
  };
}
