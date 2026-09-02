import { NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { loadChannelObservation } from "@/server/modules/report/channel-observation";
import { getDbAsync } from "@/db";
import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";
import { maskSensitive } from "@/server/core/dto";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";

/** 全渠道外部观察（天猫 / 拼多多 / 唯品会 近 30 天 + 天猫宝贝损益）——只读观察口径 */
export async function GET() {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...PRICE_VISIBLE_ROLES);
    const db = await getDbAsync();
    const response = NextResponse.json(maskSensitive(await loadChannelObservation(db), user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/channel-observation", method: "GET" });
  }
}
