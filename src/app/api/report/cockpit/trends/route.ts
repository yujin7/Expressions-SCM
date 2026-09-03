import { NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getCockpitTrends } from "@/server/modules/report/cockpit-trends";

/**
 * 驾驶舱「趋势与交叉」补充块（BI 深化）。只读；金额在服务层按角色剥离，出口再经 maskSensitive 兜底；
 * 受限渠道账号只拿到按渠道映射裁剪后的店铺行（D62）。
 */
export async function GET() {
  try {
    const user = await guardRead();
    const db = await getDbAsync();
    const data = await getCockpitTrends(user, db);
    const res = NextResponse.json(maskSensitive(data, user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/cockpit/trends", method: "GET" });
  }
}
