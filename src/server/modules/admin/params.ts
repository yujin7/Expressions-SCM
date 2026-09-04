/**
 * 运行参数维护（D39 阈值参数化 + 既有 R 规则参数统一入口）。
 * 白名单制：仅暴露登记过的参数；读=admin/pmc/purchasing/finance。
 * 写权限按**键组**（D59：补货规则单一主体 = pmc）：`replenish` 组 pmc 可写（admin 兜底），其余仅 admin；审计不变。
 *
 * 白名单本体与缺省值在 `core/param-defs.ts`（零依赖纯常量，缺省值唯一权威）；本模块只做读写与权限。
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { sysParams } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { clearParamCache } from "@/server/core/params";
import { PARAM_CATEGORY_OPTIONS, PARAM_DEFS, PMC_WRITABLE_PARAM_KEYS, paramDef, type EnumParamDef, type NumParamDef, type ParamDef } from "@/server/core/param-defs";
import { ApiError, type SessionUser } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export { PARAM_DEFS, PMC_WRITABLE_PARAM_KEYS };
export type { EnumParamDef, NumParamDef, ParamDef };

/** 该角色集合能否写某键：admin 恒可；pmc 仅限 replenish 键组 */
export function canWriteParam(roles: readonly string[], key: string): boolean {
  if (roles.includes("admin")) return true;
  if (roles.includes("pmc")) return PMC_WRITABLE_PARAM_KEYS.includes(key);
  return false;
}

export type ParamRow = ParamDef & {
  /** 全局层当前值；enum 参数为字符串 */
  value: number | string;
  isDefault: boolean;
  lastChangedBy: string | null;
  lastChangedAt: string | null;
  writableBy: "admin" | "pmc";
  /** 该键在 sku/brand/segment/category 层的覆盖行数（页面在全局行上提示「有 N 处覆盖」） */
  overrideCount: number;
  /**
   * 该键可维护的作用域层（页面据此渲染「分域覆盖」表单，不在客户端另写一份判定）：
   * 品类参数只有 category；枚举开关不分域（空数组）；其余数值参数三层可覆盖。
   */
  scopeKinds: ("sku" | "brand" | "segment" | "category")[];
  /** scopeKinds 含 category 时的可选品类（唯一权威 core/param-defs） */
  categoryOptions: readonly { value: string; label: string }[];
};

/** 某参数允许的分域层（服务端唯一口径；与 scoped-params 的 assertScopeAllowedForDef 同源） */
export function scopeKindsFor(def: ParamDef): ParamRow["scopeKinds"] {
  if (def.kind === "enum") return [];
  return def.scope === "category" ? ["category"] : ["sku", "brand", "segment"];
}

function parseValue(def: ParamDef, raw: string | undefined): { value: number | string; isDefault: boolean } {
  if (raw == null) return { value: def.fallback, isDefault: true };
  if (def.kind === "enum") {
    const v = raw.trim();
    return def.options.some((o) => o.value === v) ? { value: v, isDefault: false } : { value: def.fallback, isDefault: true };
  }
  const n = Number(raw);
  return Number.isFinite(n) ? { value: n, isDefault: false } : { value: def.fallback, isDefault: true };
}

export async function listParams(dbArg?: AnyDb): Promise<ParamRow[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: { key: string; value: string }[] = await db
    .select({ key: sysParams.key, value: sysParams.value })
    .from(sysParams)
    .where(eq(sysParams.scope, "global"));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  /* 分域覆盖计数：全局层以外的所有行（sku:/brand:/segment:/category:） */
  const overrideRows: { key: string; n: number }[] = await db
    .select({ key: sysParams.key, n: sql<number>`count(*)::int` })
    .from(sysParams)
    .where(ne(sysParams.scope, "global"))
    .groupBy(sysParams.key);
  const overrideByKey = new Map(overrideRows.map((r) => [r.key, Number(r.n)]));
  /* #17：最近修改人/时间——audit_log entity=sys_param 逐键取最新一条 */
  const auditRows: { after: unknown; createdAt: Date; name: string | null }[] = await db
    .select({ after: schema.auditLogs.after, createdAt: schema.auditLogs.createdAt, name: schema.users.name })
    .from(schema.auditLogs)
    .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
    .where(eq(schema.auditLogs.entity, "sys_param"))
    .orderBy(desc(schema.auditLogs.id));
  const lastByKey = new Map<string, { by: string | null; at: string }>();
  for (const a of auditRows) {
    const key = (a.after as { key?: string } | null)?.key;
    if (key && !lastByKey.has(key)) lastByKey.set(key, { by: a.name, at: a.createdAt.toISOString().slice(0, 16).replace("T", " ") });
  }
  return PARAM_DEFS.map((d) => {
    const parsed = parseValue(d, byKey.get(d.key));
    const last = lastByKey.get(d.key);
    return {
      ...d,
      value: parsed.value,
      isDefault: parsed.isDefault,
      lastChangedBy: last?.by ?? null,
      lastChangedAt: last?.at ?? null,
      writableBy: PMC_WRITABLE_PARAM_KEYS.includes(d.key) ? "pmc" : "admin",
      overrideCount: overrideByKey.get(d.key) ?? 0,
      scopeKinds: scopeKindsFor(d),
      categoryOptions: PARAM_CATEGORY_OPTIONS,
    };
  });
}

const updateSchema = z.object({ key: z.string(), value: z.union([z.number().finite(), z.string().trim().min(1).max(50)]) });

/** 按定义校验取值；返回落库字符串。数值参数拒绝字符串，枚举参数拒绝选项外取值 */
export function validateParamValue(def: ParamDef, value: number | string): string {
  if (def.kind === "enum") {
    const v = String(value);
    if (!def.options.some((o) => o.value === v)) {
      throw new ApiError(400, `「${def.label}」只能取 ${def.options.map((o) => o.value).join(" / ")}`);
    }
    return v;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiError(400, `「${def.label}」须为数值`);
  if (value < def.min || value > def.max) {
    throw new ApiError(400, `「${def.label}」取值须在 ${def.min}–${def.max}${def.unit} 之间`);
  }
  return String(value);
}

export async function updateParam(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<void> {
  const v = updateSchema.parse(input);
  const def = paramDef(v.key);
  if (!def) throw new ApiError(400, "未登记的参数键");
  if (!canWriteParam(user.roles, v.key)) {
    throw new ApiError(403, PMC_WRITABLE_PARAM_KEYS.includes(v.key) ? "仅生产计划（pmc）或管理员可修改补货参数" : "仅管理员可修改该参数");
  }
  if (def.scope === "category") {
    throw new ApiError(400, `「${def.label}」只按品类维护，请在「分域覆盖」里按品类填写（结算不读全局值）`);
  }
  const stored = validateParamValue(def, v.value);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [old] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, "global"), eq(sysParams.key, v.key)));
  if (v.key === "batch_posting_enabled" && stored !== (old?.value ?? String(def.fallback))) {
    if (v.value === 1) {
      throw new ApiError(409, "批次过账必须通过同页「上线体检」确认后启用，不能作为普通参数直接修改");
    }
    throw new ApiError(409, "批次过账启用后不可直接关闭；回退必须走库存迁移与专项变更流程");
  }
  await db
    .insert(sysParams)
    .values({ scope: "global", key: v.key, value: stored, note: def.label })
    .onConflictDoUpdate({ target: [sysParams.scope, sysParams.key], set: { value: stored } });
  clearParamCache();
  await writeAudit(db, {
    userId: user.id,
    entity: "sys_param",
    action: "update",
    before: { key: v.key, value: old?.value ?? null },
    after: { key: v.key, value: v.value },
  });
}
