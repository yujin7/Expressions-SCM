import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { listBelowFloor } from "@/server/modules/dq/lists";

const VIEW_ROLES = ["pmc", "finance", "warehouse", "purchasing"];

/**
 * C10 数据质量「低于量下限」逐条清单：两侧都低于 minBaseQty、不进一致率分母的 SKU × 完整月行。
 * 判定沿用 report/sales-consistency 的同一函数（本路由不另立口径）；全表无金额，出口仍走 maskSensitive。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...VIEW_ROLES);
    const db = await getDbAsync();
    // 列表参数统一走仓库既有解析器（安全审计 S6）：`?page=x` 曾经 Number("x") = NaN 一路绑进
    // LIMIT/OFFSET，每次请求 500 并写一条 error_logs；parseListQuery 的 `Number(...) || 1` 兜住 NaN。
    const { page, pageSize, searchParams: params } = parseListQuery(req.url);
    const payload = await listBelowFloor(db, {
      page,
      pageSize,
      month: params.get("month") ?? undefined,
    });
    const response = NextResponse.json(maskSensitive(payload, user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/data-quality/below-floor", method: "GET" });
  }
}
