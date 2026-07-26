import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { listAuditLogs } from "@/server/modules/admin/audit";

/** GET /api/admin/audit：审计日志分页查询（admin/finance；新鲜身份） */
export async function GET(req: NextRequest) {
  try {
    let user;
    try {
      user = await getFreshSessionUser();
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    const sp = new URL(req.url).searchParams;
    const query = {
      entity: sp.get("entity") || undefined,
      entityId: sp.get("entityId") || undefined,
      userId: sp.get("userId") || undefined,
      action: sp.get("action") || undefined,
      from: sp.get("from") || undefined,
      to: sp.get("to") || undefined,
      q: sp.get("q") || undefined,
      page: sp.get("page") || undefined,
      pageSize: sp.get("pageSize") || undefined,
    };
    return NextResponse.json(await listAuditLogs(user, query));
  } catch (e) {
    return errorResponse(e);
  }
}
