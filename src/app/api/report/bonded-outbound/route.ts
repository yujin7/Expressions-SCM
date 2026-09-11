import { NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";
import { loadBondedOutbound } from "@/server/modules/report/bonded-outbound";

/** 保税仓日出库观察（保税订单流，SKU × 批次 × 效期）——只读观察口径，无金额字段 */
export async function GET() {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...PRICE_VISIBLE_ROLES); // 与同页 channel-observation 路由一致（D62）
    const db = await getDbAsync();
    const response = NextResponse.json(maskSensitive(await loadBondedOutbound(db), user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/bonded-outbound", method: "GET" });
  }
}
