import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardPlatformIdentityWriter } from "@/server/modules/master/platform-identity-access";
import { claimPlatformSku } from "@/server/modules/master/platform-sku-claim";

/**
 * 把天猫平台 SKU 认领到系统 SKU（写路径）。
 * 权限与别名认领一致：pmc / purchasing / warehouse（admin 兜底），写守卫回查 DB。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardPlatformIdentityWriter();
    const result = await claimPlatformSku(user, await readJson(req));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/platform-claim", method: "POST" });
  }
}
