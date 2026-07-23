import { NextResponse } from "next/server";
import { ZodError } from "zod";

/** 业务错误：service 层抛出，route 层统一转 JSON */
export class ApiError extends Error {
  /** 可选机器码（如 SURPLUS_UNACKED）——W5：前端不再靠报文文案判别 */
  public code?: string;
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
}

/** 统一错误响应：{error} + 400/404/409/500 */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json(e.code ? { error: e.message, code: e.code } : { error: e.message }, { status: e.status });
  }
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；");
    return NextResponse.json({ error: `参数校验失败：${msg}` }, { status: 400 });
  }
  if (isUniqueViolation(e)) {
    return NextResponse.json({ error: "编码或关键字段已存在，请修改后重试" }, { status: 409 });
  }
  console.error("[api/master] 未预期错误:", e);
  return NextResponse.json({ error: "服务器内部错误——请截图本页面并联系管理员" }, { status: 500 });
}

export interface ListQuery {
  q: string;
  page: number;
  pageSize: number;
  searchParams: URLSearchParams;
}

export function parseListQuery(url: string): ListQuery {
  const searchParams = new URL(url).searchParams;
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const pageSize = Math.min(999, Math.max(1, Number(searchParams.get("pageSize")) || 20));
  return { q: (searchParams.get("q") ?? "").trim(), page, pageSize, searchParams };
}

export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "无效的 ID");
  return id;
}

/** 业务日期统一 Asia/Shanghai（CLAUDE.md 约定） */
export function todayShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

// ---------- 权限守卫（集成层：《01》§6 功能矩阵） ----------
import { getSessionUser, requireRole } from "@/server/core/dto";

/** 写权限映射（admin 始终放行——requireRole 内置 admin 兜底；空数组=仅 admin） */
const WRITE_ROLES: Record<string, string[]> = {
  spu: ["pmc"],
  sku: ["pmc"],
  category: ["pmc"],
  supplier: ["purchasing"],
  warehouse: [],
  bom: ["pmc"],
};

export type SessionUser = { id: number; name: string; roles: string[]; isApprover: boolean };

export async function guardRead(): Promise<SessionUser> {
  try {
    return await getSessionUser();
  } catch {
    throw new ApiError(401, "未登录");
  }
}

export async function guardWrite(entity: keyof typeof WRITE_ROLES): Promise<SessionUser> {
  // 写操作回查 DB 新鲜身份（体检 #5）
  let user: SessionUser;
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    user = await getFreshSessionUser();
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
  try {
    requireRole(user, ...(WRITE_ROLES[entity] ?? []));
  } catch {
    throw new ApiError(403, "无权限执行此操作");
  }
  return user;
}


/** 路由级审计（体检 #1）：主数据写路径统一落 audit_logs（详情级 before/after 由 service 层按需补充） */
import { getDbAsync } from "@/db";
import { writeAudit } from "@/server/core/audit";

export async function auditFromRoute(
  user: SessionUser,
  entity: string,
  entityId: number | null | undefined,
  action: string,
  after?: unknown,
): Promise<void> {
  await writeAudit(await getDbAsync(), { userId: user.id, entity, entityId: entityId ?? null, action, after });
}
