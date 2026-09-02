import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, readJson } from "@/server/modules/master/common";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { claimPlatformSku } from "@/server/modules/master/platform-sku-claim";

/**
 * 把天猫平台 SKU 认领到系统 SKU（写路径）。
 * 权限与别名认领一致：pmc / purchasing / warehouse（admin 兜底），写守卫回查 DB。
 */
export async function POST(req: NextRequest) {
  try {
    let user;
    try {
      user = await getFreshSessionUser();
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    try {
      requireRole(user, "pmc", "purchasing", "warehouse");
    } catch {
      throw new ApiError(403, "无权限认领平台 SKU");
    }
    const result = await claimPlatformSku(user, await readJson(req));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/platform-claim", method: "POST" });
  }
}
