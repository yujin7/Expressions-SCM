import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { loadPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { getDbAsync } from "@/db";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { platformSkuIdentityView } from "@/server/modules/report/platform-sku-identity-view";
import { resolveChannelScope, resolveDeptScope } from "@/server/core/data-scope";

/** 天猫平台 SKU 身份缺口（按销售额排序，附认领建议）——只读观察口径 */
export async function GET() {
  try {
    const user = await guardFreshWrite();
    // Identity governance is registered as scopedMode=denied. The global
    // cached totals cannot be made channel-safe by filtering just the top rows.
    if (resolveChannelScope(user).forced || resolveDeptScope(user).forced) {
      throw new ApiError(403, "当前账号的数据范围不开放跨店铺身份核对，请联系身份治理负责人");
    }
    const db = await getDbAsync();
    const response = NextResponse.json(platformSkuIdentityView(await loadPlatformSkuIdentityGap(db), user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/platform-sku-identity-gap", method: "GET" });
  }
}
