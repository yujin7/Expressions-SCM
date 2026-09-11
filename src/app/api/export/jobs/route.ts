import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getFreshSessionUser } from "@/server/core/dto";
import { ApiError, errorResponse, readJson } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { EXPORT_KIND_LABELS, EXPORT_KINDS } from "@/server/modules/report/export";
import { createExportJob, ensureExportWorkerStarted, listExportJobs } from "@/jobs/export-worker";

const createSchema = z.object({
  kind: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

/** POST /api/export/jobs {kind, params}：创建异步导出任务（角色门禁与同步导出一致） */
export async function POST(req: NextRequest) {
  try {
    let user;
    try {
      user = await getFreshSessionUser(); // 写路径→新鲜身份
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    const v = createSchema.parse(await readJson(req));
    const def = EXPORT_KINDS[v.kind];
    if (!def) throw new ApiError(400, `未知导出类型：${v.kind}`);
    if (def.roles?.length) requireAnyRole(user, ...def.roles);
    const job = await createExportJob(user, v.kind, v.params ?? {});
    ensureExportWorkerStarted();
    return NextResponse.json({ job }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/export/jobs：我的任务列表（admin 可见全部；最新在前） */
export async function GET() {
  try {
    let user;
    try { user = await getFreshSessionUser(); } catch { throw new ApiError(401, "未登录或会话已失效，请重新登录"); }
    ensureExportWorkerStarted(); // 开发模式兜底：确保有人在消费队列
    /* 标签由服务端下发：客户端页面禁止 import 服务端模块（会把 auth/pg/argon2 拖进客户端包） */
    const rows = (await listExportJobs(user)).map((r) => ({ ...r, kindLabel: EXPORT_KIND_LABELS[r.kind] ?? r.kind }));
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
