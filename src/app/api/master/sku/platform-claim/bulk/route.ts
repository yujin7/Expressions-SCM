import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, readJson } from "@/server/modules/master/common";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { claimPlatformSkusBulk } from "@/server/modules/master/platform-sku-claim";

/**
 * 批量认领天猫平台 SKU（写路径）。
 * 典型用途：对照表里「商家编码与系统编码逐字相等」的行——治理规定外部码不自动认领，
 * 但人复核后可以一次确认一批。每行独立事务与审计，单行冲突不拖累其它行。
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
    const result = await claimPlatformSkusBulk(user, await readJson(req));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/platform-claim/bulk", method: "POST" });
  }
}
