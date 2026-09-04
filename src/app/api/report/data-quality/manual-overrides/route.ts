import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { listManualOverrides } from "@/server/modules/dq/lists";

const VIEW_ROLES = ["pmc", "finance", "warehouse", "purchasing"];

/**
 * C10 数据质量「手工改写」逐条清单（DQ-6）。只读；金额在服务层按角色剥离，出口再经 maskSensitive 兜底。
 * 与总览页同一批可见角色（/api/report/data-quality）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...VIEW_ROLES);
    const db = await getDbAsync();
    // 列表参数统一走仓库既有解析器（安全审计 S6）：`?page=x` 曾经 Number("x") = NaN 一路绑进
    // LIMIT/OFFSET，每次请求 500 并写一条 error_logs；parseListQuery 的 `Number(...) || 1` 兜住 NaN。
    const { page, pageSize, searchParams: params } = parseListQuery(req.url);
    const payload = await listManualOverrides(db, {
      page,
      pageSize,
      yearMonth: params.get("yearMonth") ?? undefined,
    }, user.roles);
    const response = NextResponse.json(maskSensitive(payload, user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/data-quality/manual-overrides", method: "GET" });
  }
}
