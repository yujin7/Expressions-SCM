import { NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { listAuditEntities } from "@/server/modules/admin/audit";

/** GET /api/admin/audit/entities：审计对象去重列表（筛选下拉数据源；admin/finance） */
export async function GET() {
  try {
    let user;
    try {
      user = await getFreshSessionUser();
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    return NextResponse.json({ entities: await listAuditEntities(user) });
  } catch (e) {
    return errorResponse(e);
  }
}
