import { ROLE_LABELS } from "@/server/core/constants";
import { getDbAsync } from "@/db";
import type { AnyDb } from "@/server/docflow/doc-no";
import { ApprovalError } from "@/server/docflow/approval";
import { ApiError } from "@/server/modules/master/common";
import type { SessionUser } from "@/server/core/dto";

/**
 * W3 委外链公共工具（模块私有）。
 * 审批配置依赖（单一权威=approval_configs，seed 为准）：
 *   bh→pmc / wo→pmc / po→purchasing / pc→purchasing 已在 src/db/seed.ts；
 *   ⚠ jg→pmc 目前 seed 缺失（本模块 approveJg 走 docType "jg"）——集成阶段须补 seed，
 *   否则生产环境审批 JG 报 NO_CONFIG。测试自行种入配置不受影响。
 */
export const REQUIRED_APPROVAL_CONFIGS: Record<string, string> = {
  bh: "pmc",
  wo: "pmc",
  jg: "pmc", // ← seed 待补（见上）
  po: "purchasing",
  pc: "purchasing",
};

export type { AnyDb };

export async function resolveDb(db?: AnyDb): Promise<AnyDb> {
  return db ?? (await getDbAsync());
}

/** 写守卫：回查 DB 新鲜身份（体检 #5）；具体角色校验在各 service 内做 */
export async function guardFreshWrite(): Promise<SessionUser> {
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    return await getFreshSessionUser();
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
}

/** 任一角色（admin 兜底放行），否则 403 */
export function requireAnyRole(user: SessionUser, ...roles: string[]): void {
  if (user.roles.includes("admin")) return;
  if (roles.some((r) => user.roles.includes(r))) return;
  const labels = roles.map((r) => ROLE_LABELS[r as keyof typeof ROLE_LABELS] ?? r);
  throw new ApiError(403, `无权限执行此操作：需要${labels.join("/")}角色`);
}

const APPROVAL_STATUS: Record<string, number> = {
  NO_CONFIG: 500,
  ROLE_FORBIDDEN: 403,
  NOT_APPROVER: 403,
  SELF_APPROVAL: 403,
  NOT_FOUND: 404,
  BAD_STATUS: 409,
  VERSION_CONFLICT: 409,
};

/** ApprovalError → ApiError（message 始终携带 code，与 inventory 模块一致） */
export function mapApprovalError(e: ApprovalError): ApiError {
  const msg = e.message === e.code ? e.code : `${e.code}：${e.message}`;
  return new ApiError(APPROVAL_STATUS[e.code] ?? 500, msg);
}

/** service 层统一把 ApprovalError 转 ApiError */
export function rethrowApproval(e: unknown): never {
  if (e instanceof ApprovalError) throw mapApprovalError(e);
  throw e;
}
