import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { checkRecentOrders } from "@/server/modules/outsource/duplicate-guard";

/** E3-03 重复下单守卫（只读提示，不阻断）：?skuIds=1,2,3&days=7 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const skuIds = (sp.get("skuIds") ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 500);
    const days = Math.min(60, Math.max(1, Number(sp.get("days") ?? 7) || 7));
    return NextResponse.json(await checkRecentOrders(skuIds, days));
  } catch (e) {
    return errorResponse(e);
  }
}
