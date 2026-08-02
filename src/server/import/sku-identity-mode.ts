import { and, eq, inArray } from "drizzle-orm";

import * as schema from "@/db/schema";
import { normalizeAliasText } from "@/server/modules/dimension/resolver";
import { ApiError } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- release engine accepts PGlite and PostgreSQL Drizzle connections
type AnyDb = any;

export const SKU_IMPORT_IDENTITY_MODES = ["historical_preserve", "new_master"] as const;
export type SkuImportIdentityMode = (typeof SKU_IMPORT_IDENTITY_MODES)[number];

export const LEGACY_LOCAL_IDENTITY_MIGRATION_CONFIRMATION =
  "I_UNDERSTAND_THIS_REWRITES_LOCAL_IDENTITY" as const;

/**
 * Old one-shot population helpers predate job-scoped identity decisions. They are deliberately
 * unavailable to HTTP routes and may only run in tests or against an explicitly confirmed local
 * PGlite database. A production DATABASE_URL can never be opted into this compatibility path.
 */
export function assertLegacyLocalIdentityMigrationAllowed(): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (
    process.env.SCM_ALLOW_LEGACY_LOCAL_MIGRATION
    !== LEGACY_LOCAL_IDENTITY_MIGRATION_CONFIRMATION
  ) {
    throw new ApiError(
      403,
      `旧版身份迁移默认禁用；仅本地 PGlite 可显式设置 SCM_ALLOW_LEGACY_LOCAL_MIGRATION=${LEGACY_LOCAL_IDENTITY_MIGRATION_CONFIRMATION}`,
    );
  }
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl.startsWith("pglite:")) {
    throw new ApiError(403, "旧版身份迁移只允许本地 PGlite，禁止连接 PostgreSQL/生产数据库");
  }
}

const BOM_JOB_ALIAS_PREFIX = "BOM_JOB:";

export interface BomJobIdentityRef {
  jobId: number;
  sourceCode: string;
}

export function bomJobIdentityAliasScope(jobId: number): string {
  return `${BOM_JOB_ALIAS_PREFIX}${jobId}`;
}

export function bomJobIdentityKey(jobId: number, sourceCode: string): string {
  return `${jobId}\0${normalizeAliasText(sourceCode)}`;
}

export function skuImportIdentityModeOf(scope: unknown): SkuImportIdentityMode | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const mode = (scope as Record<string, unknown>).identityMode;
  return SKU_IMPORT_IDENTITY_MODES.includes(mode as SkuImportIdentityMode)
    ? mode as SkuImportIdentityMode
    : null;
}

/**
 * Resolve the identity contract for an explicitly selected release batch.
 *
 * Production callers must always provide jobIds. The separately named local migration wrappers
 * never call this function; missing, unknown or mixed modes therefore fail closed here.
 */
export async function requireSkuImportIdentityMode(
  db: AnyDb,
  jobIds: number[],
): Promise<SkuImportIdentityMode> {
  if (!Array.isArray(jobIds)) {
    throw new ApiError(400, "SKU/BOM 放行必须显式绑定导入任务");
  }
  const selectedIds = [...new Set(jobIds)];
  if (selectedIds.length === 0) throw new ApiError(400, "至少选择一个导入任务");
  const jobs: { id: number; template: string; status: string; scope: unknown }[] = await db
    .select({
      id: schema.importJobs.id,
      template: schema.importJobs.template,
      status: schema.importJobs.status,
      scope: schema.importJobs.scope,
    })
    .from(schema.importJobs)
    .where(inArray(schema.importJobs.id, selectedIds));
  const found = new Set(jobs.map((job) => job.id));
  const missingJobs = selectedIds.filter((id) => !found.has(id));
  if (missingJobs.length > 0) {
    throw new ApiError(404, `导入任务不存在：${missingJobs.join(", ")}`);
  }
  const wrongTemplate = jobs.filter((job) => job.template !== "bom").map((job) => job.id);
  if (wrongTemplate.length > 0) {
    throw new ApiError(409, `导入任务 ${wrongTemplate.join(", ")} 不是 BOM 模板，不能进入 SKU/BOM 身份放行`);
  }
  const unfinished = jobs.filter((job) => job.status !== "done").map((job) => job.id);
  if (unfinished.length > 0) {
    throw new ApiError(409, `导入任务 ${unfinished.join(", ")} 尚未解析完成，不能进入 SKU/BOM 身份放行`);
  }
  const missingMode = jobs.filter((job) => skuImportIdentityModeOf(job.scope) == null).map((job) => job.id);
  if (missingMode.length > 0) {
    throw new ApiError(
      409,
      `导入任务 ${missingMode.join(", ")} 未声明 SKU 身份模式；请重新导入并明确 historical_preserve 或 new_master`,
    );
  }
  const modes = [...new Set(jobs.map((job) => skuImportIdentityModeOf(job.scope)!))];
  if (modes.length !== 1) {
    throw new ApiError(409, "所选导入任务混合了历史保留与新主档模式；请分批预演和放行");
  }
  return modes[0];
}

/**
 * Persist the selected BOM job's source-code → governed SKU decision.
 * The scoped alias is deliberately job-local: the same source code in another workbook must
 * earn its own release decision instead of inheriting a coincidental global match.
 */
export async function registerBomJobIdentityMapping(
  db: AnyDb,
  input: BomJobIdentityRef & { targetId: number; userId: number },
): Promise<void> {
  const rawValue = normalizeAliasText(input.sourceCode);
  if (!rawValue) throw new ApiError(400, "BOM 来源编码不能为空");
  const scope = bomJobIdentityAliasScope(input.jobId);
  await db
    .insert(schema.aliases)
    .values({
      aliasType: "sku_code",
      scope,
      rawValue,
      targetId: input.targetId,
      note: "BOM SKU 身份放行映射",
      createdBy: input.userId,
    })
    .onConflictDoNothing({
      target: [schema.aliases.aliasType, schema.aliases.scope, schema.aliases.rawValue],
    });
  const [stored] = await db
    .select({ targetId: schema.aliases.targetId })
    .from(schema.aliases)
    .where(and(
      eq(schema.aliases.aliasType, "sku_code"),
      eq(schema.aliases.scope, scope),
      eq(schema.aliases.rawValue, rawValue),
    ));
  if (!stored || stored.targetId !== input.targetId) {
    throw new ApiError(409, `BOM 任务 ${input.jobId} 的来源编码 ${rawValue} 已被裁决到其他 SKU`);
  }
}

export async function loadBomJobIdentityMappings(
  db: AnyDb,
  refs: BomJobIdentityRef[],
): Promise<Map<string, number>> {
  const normalized = refs
    .map((ref) => ({ ...ref, sourceCode: normalizeAliasText(ref.sourceCode) }))
    .filter((ref) => ref.sourceCode);
  if (normalized.length === 0) return new Map();
  const scopes = [...new Set(normalized.map((ref) => bomJobIdentityAliasScope(ref.jobId)))];
  const codes = [...new Set(normalized.map((ref) => ref.sourceCode))];
  const rows: { scope: string; rawValue: string; targetId: number }[] = await db
    .select({
      scope: schema.aliases.scope,
      rawValue: schema.aliases.rawValue,
      targetId: schema.aliases.targetId,
    })
    .from(schema.aliases)
    .where(and(
      eq(schema.aliases.aliasType, "sku_code"),
      inArray(schema.aliases.scope, scopes),
      inArray(schema.aliases.rawValue, codes),
    ));
  const requested = new Set(normalized.map((ref) => bomJobIdentityKey(ref.jobId, ref.sourceCode)));
  const result = new Map<string, number>();
  for (const row of rows) {
    const jobId = Number(row.scope.slice(BOM_JOB_ALIAS_PREFIX.length));
    const key = bomJobIdentityKey(jobId, row.rawValue);
    if (requested.has(key)) result.set(key, row.targetId);
  }
  return result;
}
