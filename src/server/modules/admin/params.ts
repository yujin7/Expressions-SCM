/**
 * 运行参数维护（D39 阈值参数化 + 既有 R 规则参数统一入口）。
 * 白名单制：仅暴露登记过的 global 参数；写=admin，读=admin/pmc/purchasing/finance。
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { sysParams } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { clearParamCache } from "@/server/core/params";
import { ApiError, type SessionUser } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface ParamDef {
  key: string;
  label: string;
  fallback: number;
  min: number;
  max: number;
  unit: string;
  note: string;
}

/** 白名单（含缺省与边界；D 号=裁决出处） */
export const PARAM_DEFS: ParamDef[] = [
  { key: "price_tolerance_pct", label: "价格异动容差", fallback: 3, min: 0, max: 50, unit: "%", note: "R1 比价硬门（D4，UAT 校准）" },
  { key: "over_receive_tolerance_pct", label: "超收容差", fallback: 0, min: 0, max: 20, unit: "%", note: "收货超单比例上限" },
  { key: "concession_price_ratio", label: "让步默认价率", fallback: 100, min: 0, max: 100, unit: "%", note: "让步接收结算价比例（D6）" },
  { key: "slow_days_threshold", label: "滞销警戒阈值", fallback: 180, min: 30, max: 720, unit: "天", note: "可销天数超过即判滞销（D39/0724 会议）" },
  { key: "cover_alert_days", label: "断货预警阈值", fallback: 30, min: 3, max: 180, unit: "天", note: "可销天数低于即预警（R11/驾驶舱）" },
  { key: "cover_target_days", label: "补货目标覆盖", fallback: 45, min: 7, max: 365, unit: "天", note: "补货建议的目标覆盖天数（R11）" },
  { key: "auto_wo_on_bh", label: "BH审批自动建WO", fallback: 0, min: 0, max: 1, unit: "", note: "D33 自动链开关①（0=关；上线前须预演验证——spec/11）" },
  { key: "auto_jg_on_ready", label: "齐套自动JG草稿", fallback: 0, min: 0, max: 1, unit: "", note: "D33 自动链开关②（0=关；自动仅产草稿，审批留人工闸）" },
];

export async function listParams(dbArg?: AnyDb): Promise<(ParamDef & { value: number; isDefault: boolean })[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: { key: string; value: string }[] = await db
    .select({ key: sysParams.key, value: sysParams.value })
    .from(sysParams)
    .where(eq(sysParams.scope, "global"));
  const byKey = new Map(rows.map((r) => [r.key, Number(r.value)]));
  return PARAM_DEFS.map((d) => {
    const v = byKey.get(d.key);
    const ok = v != null && Number.isFinite(v);
    return { ...d, value: ok ? (v as number) : d.fallback, isDefault: !ok };
  });
}

const updateSchema = z.object({ key: z.string(), value: z.number().finite() });

export async function updateParam(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<void> {
  if (!user.roles.includes("admin")) throw new ApiError(403, "仅管理员可修改运行参数");
  const v = updateSchema.parse(input);
  const def = PARAM_DEFS.find((d) => d.key === v.key);
  if (!def) throw new ApiError(400, "未登记的参数键");
  if (v.value < def.min || v.value > def.max) {
    throw new ApiError(400, `「${def.label}」取值须在 ${def.min}–${def.max}${def.unit} 之间`);
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [old] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, "global"), eq(sysParams.key, v.key)));
  await db
    .insert(sysParams)
    .values({ scope: "global", key: v.key, value: String(v.value), note: def.label })
    .onConflictDoUpdate({ target: [sysParams.scope, sysParams.key], set: { value: String(v.value) } });
  clearParamCache();
  await writeAudit(db, {
    userId: user.id,
    entity: "sys_param",
    action: "update",
    before: { key: v.key, value: old?.value ?? null },
    after: { key: v.key, value: v.value },
  });
}
