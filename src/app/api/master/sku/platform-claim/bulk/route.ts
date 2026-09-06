import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardPlatformIdentityWriter } from "@/server/modules/master/platform-identity-access";
import { claimPlatformSkusBulk } from "@/server/modules/master/platform-sku-claim";

/**
 * 批量认领天猫平台 SKU（写路径）。
 * 典型用途：对照表里「商家编码与系统编码逐字相等」的行——治理规定外部码不自动认领，
 * 但人复核后可以一次确认一批。每行独立事务与审计，单行冲突不拖累其它行。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardPlatformIdentityWriter();
    const result = await claimPlatformSkusBulk(user, await readJson(req));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/platform-claim/bulk", method: "POST" });
  }
}
