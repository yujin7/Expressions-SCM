import { NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { loadPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { getDbAsync } from "@/db";

/** 天猫平台 SKU 身份缺口（按销售额排序，附认领建议）——只读观察口径 */
export async function GET() {
  try {
    await guardRead();
    const db = await getDbAsync();
    const response = NextResponse.json(await loadPlatformSkuIdentityGap(db));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/platform-sku-identity-gap", method: "GET" });
  }
}
