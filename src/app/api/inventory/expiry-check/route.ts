import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { expiryCheck } from "@/server/modules/replenish/expiry";

/**
 * R15 临期/过期批次检查（v1 提示告警，不拦截）。
 * GET /api/inventory/expiry-check?skuIds=1,2,3&warehouseId=N（warehouseId 省略=全仓）
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const skuIds = (sp.get("skuIds") ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    const whRaw = Number(sp.get("warehouseId"));
    const warehouseId = Number.isInteger(whRaw) && whRaw > 0 ? whRaw : null;
    return NextResponse.json(await expiryCheck({ skuIds, warehouseId }));
  } catch (e) {
    return errorResponse(e);
  }
}
