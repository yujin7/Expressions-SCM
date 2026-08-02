import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { log, persistErrorLog } from "@/server/core/logger";

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

/** 500 留档上下文（可选——现有调用方无须改动；path 为 null 亦可接受 v1） */
export interface ErrorCtx {
  path?: string;
  method?: string;
  userId?: number;
}

/** 统一错误响应：{error} + 400/404/409/500；未预期 500 额外落 error_logs（best-effort） */
export function errorResponse(e: unknown, ctx?: ErrorCtx): NextResponse {
  if (e instanceof SessionAuthError) {
    return NextResponse.json({ error: e.message }, { status: 401 });
  }
  if (e instanceof ApiError) {
    return NextResponse.json(e.code ? { error: e.message, code: e.code } : { error: e.message }, { status: e.status });
  }
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；");
    return NextResponse.json({ error: `参数校验失败：${msg}` }, { status: 400 });
  }
  if (
    e instanceof Error
    && e.name === "PostingError"
    && ["NEGATIVE_STOCK", "SNAPSHOT_WAREHOUSE", "LOCATED_STOCK"].includes(
      String((e as Error & { code?: string }).code ?? ""),
    )
  ) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
  if (isUniqueViolation(e)) {
    return NextResponse.json({ error: "编码或关键字段已存在，请修改后重试" }, { status: 409 });
  }
  // 未预期 500：生成 errorId 落结构化日志，报文回显错误码供用户转述——业务错误（ApiError）不在此收口，防日志噪音
  const errorId = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  log({
    level: "error",
    msg: "api 未预期错误",
    errorId,
    error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    stack: e instanceof Error ? e.stack : undefined,
    path: ctx?.path,
    method: ctx?.method,
  });
  // 落库留档（fire-and-forget：绝不阻塞/破坏响应；失败在 persistErrorLog 内吞掉）
  void persistErrorLog({
    errorId,
    message: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    stack: e instanceof Error ? (e.stack ?? null) : null,
    path: ctx?.path ?? null,
    method: ctx?.method ?? null,
    userId: ctx?.userId ?? null,
  });
  return NextResponse.json(
    { error: `系统错误，请联系管理员（错误码 ${errorId}）`, errorId },
    { status: 500 },
  );
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
import { getSessionUser, requireRole, SessionAuthError } from "@/server/core/dto";

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


/**
 * 读取并解析请求体。**所有写路由都必须走这里，禁止裸 `await req.json()`。**
 *
 * 裸调的问题：空体或坏 JSON 会让 `req.json()` 抛 `SyntaxError`，而 errorResponse
 * 只分流 ApiError / ZodError / 23505，SyntaxError 落进兜底分支——于是
 * **客户端发错请求，系统却回 500、并往 error_logs 插一条带 errorId 的记录**。
 * 后果有两层：① 用户看到「系统错误，请联系管理员」而不是「请求体不合法」；
 * ② `/api/public/po-confirm/[token]` 是匿名可达的，坏 body 在 token 校验之前就抛，
 * 等于**一条无需登录即可持续写 error_logs 的通道**，还会污染 /admin/health 的错误计数。
 */
export async function readJson<T = unknown>(req: { json: () => Promise<unknown> }): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, "请求体不是合法的 JSON");
  }
}

/**
 * 允许空请求体的写端点专用：空体归一为 `{}`，非空坏 JSON 仍返回 400。
 * 目前仅用于“BOM 生效”这类 body 完全可选的命令，避免用 `.catch(() => ({}))`
 * 把“格式损坏”和“确实为空”混为一谈。
 */
export async function readOptionalJson<T = Record<string, never>>(
  req: { text: () => Promise<string> },
): Promise<T> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    throw new ApiError(400, "无法读取请求体");
  }
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(400, "请求体不是合法的 JSON");
  }
}
