import { NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { loadBondedOutbound } from "@/server/modules/report/bonded-outbound";

/** 保税仓日出库观察（保税订单流，SKU × 批次 × 效期）——只读观察口径，无金额字段 */
export async function GET() {
  try {
    const user = await guardFreshWrite();
    const db = await getDbAsync();
    const response = NextResponse.json(maskSensitive(await loadBondedOutbound(db), user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/bonded-outbound", method: "GET" });
  }
}
