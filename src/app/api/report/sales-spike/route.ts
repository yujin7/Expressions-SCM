import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadSalesSpike, refreshSalesSpike } from "@/server/modules/report/sales-spike";
import { pageSalesSpike } from "@/server/modules/report/sales-spike-query";

/** 爆单预警读模型 `sales-spike/v2`（D56，观察口径；v2 带 reason/gaps/大促预期）。?refresh=1 需 pmc/ops/admin 回查；?q= 服务端筛选（审计 #8）。 */
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const refresh = sp.get("refresh") === "1";
    const user = refresh ? await guardFreshWrite() : await guardRead();
    if (refresh) requireAnyRole(user, "pmc", "ops", "admin");
    const db = await getDbAsync();
    const model = refresh ? await refreshSalesSpike(db) : await loadSalesSpike(db);
    const res = NextResponse.json(maskSensitive(pageSalesSpike(model, sp.get("q") ?? ""), user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/sales-spike", method: "GET" });
  }
}
