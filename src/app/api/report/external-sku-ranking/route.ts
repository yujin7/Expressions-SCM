import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  filterExternalSkuRanking,
  loadExternalSkuRanking,
  type ExternalSkuRankPlatformFilter,
} from "@/server/modules/report/external-sku-ranking";

/**
 * SKU 外部销量排名（天猫+拼多多观察口径，件数为主）——只读；
 * 守卫回查 DB 新鲜身份（与全渠道观察路由一致），件数全员可见，出口仍经 maskSensitive。
 */
export async function GET(request: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const params = request.nextUrl.searchParams;
    const platformRaw = params.get("platform")?.trim();
    const platform: ExternalSkuRankPlatformFilter = platformRaw === "tmall" || platformRaw === "pdd" ? platformRaw : "all";
    const limitRaw = Number(params.get("limit"));
    const db = await getDbAsync();
    const model = await loadExternalSkuRanking(db);
    const filtered = filterExternalSkuRanking(model, {
      brand: params.get("brand")?.trim() || null,
      platform,
      q: params.get("q"),
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : null,
    });
    const response = NextResponse.json(maskSensitive(filtered, user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/external-sku-ranking", method: "GET" });
  }
}
