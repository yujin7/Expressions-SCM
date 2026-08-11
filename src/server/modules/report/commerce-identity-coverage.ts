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
  identityExpr: SQL;
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
    identityExpr: sql`CASE
      WHEN trim(coalesce(payload->'data'->>'shopName', '')) = ''
        OR trim(coalesce(payload->'data'->>'platformSkuId', '')) = '' THEN ''
      ELSE trim(payload->'data'->>'shopName') || '|' || trim(payload->'data'->>'platformSkuId')
    END`,
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
    identityExpr: sql`CASE
      WHEN trim(coalesce(payload->'data'->>'shopName', '')) = ''
        OR trim(coalesce(payload->'data'->>'platformSkuId', '')) = '' THEN ''
      ELSE trim(payload->'data'->>'shopName') || '|' || trim(payload->'data'->>'platformSkuId')
    END`,
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
    identityExpr: sql`trim(coalesce(payload->'data'->>'platformProductId', ''))`,
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
}

export interface CommerceIdentityCoverage {
  state: "ready" | "partial" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  gate: string;
  platforms: CommerceIdentityPlatformCoverage[];
  summary: {
    availablePlatforms: number;
    totalPlatforms: number;
    sourceRows: number;
    uniqueIdentities: number;
    mappedIdentities: number;
    identityPct: number | null;
    qualityIssues: number;
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
    };
  }

  const result = await db.execute(sql`
    WITH raw AS (
      SELECT
        ${contract.identityExpr} AS platform_identity,
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
  };
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
  const availablePlatforms = platforms.filter((item) => item.state === "ready").length;
  const sourceRows = platforms.reduce((sum, item) => sum + item.sourceRows, 0);
  const uniqueIdentities = platforms.reduce((sum, item) => sum + item.uniqueIdentities, 0);
  const mappedIdentities = platforms.reduce((sum, item) => sum + item.mappedIdentities, 0);
  const qualityIssues = platforms.reduce(
    (sum, item) => sum + item.invalidIdentityRows + item.duplicateGroups + item.conflictingMappings,
    0,
  );
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
    summary: {
      availablePlatforms,
      totalPlatforms: PLATFORM_CONTRACTS.length,
      sourceRows,
      uniqueIdentities,
      mappedIdentities,
      identityPct: percent(mappedIdentities, uniqueIdentities),
      qualityIssues,
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
    summary: {
      availablePlatforms: 0,
      totalPlatforms: PLATFORM_CONTRACTS.length,
      sourceRows: 0,
      uniqueIdentities: 0,
      mappedIdentities: 0,
      identityPct: null,
      qualityIssues: 0,
    },
    limitations: ["缺少平台身份证据，系统不会用 0% 或历史样本伪装当前覆盖。"],
  };
}
