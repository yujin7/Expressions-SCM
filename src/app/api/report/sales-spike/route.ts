import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { resolveChannelScope } from "@/server/core/data-scope";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadSalesSpike, refreshSalesSpike } from "@/server/modules/report/sales-spike";
import { pageSalesSpike } from "@/server/modules/report/sales-spike-query";
import { scopeSalesSpikeModel } from "@/server/modules/report/shop-channel-scope";

/** 爆单预警读模型 v3：缺日弃权、逐对象覆盖、T+1 时效；重算需 pmc/ops/admin，渠道裁剪后输出。 */
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const refresh = sp.get("refresh") === "1";
    const user = refresh ? await guardFreshWrite() : await guardRead();
    if (refresh) requireAnyRole(user, "pmc", "ops", "admin");
    const db = await getDbAsync();
    const full = refresh ? await refreshSalesSpike(db) : await loadSalesSpike(db);
    // D62（安全审计 S3）：命中行带店铺名/平台 SKU，受限渠道账号只留能归到自己渠道的行；
    // hitCount / unmappedCount 在裁剪后的模型上计算，免得计数本身把别人家店的行数漏出去。
    const model = await scopeSalesSpikeModel(db, full, resolveChannelScope(user, null));
    const res = NextResponse.json(maskSensitive(pageSalesSpike(model, sp.get("q") ?? ""), user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/sales-spike", method: "GET" });
  }
}
