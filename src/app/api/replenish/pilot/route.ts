import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadReplenishPilot } from "@/server/modules/report/replenish-pilot";

/**
 * 补货试点读模型 replenish-pilot/v2（只读；v2 并列金额口径分层对照）。
 * `?refresh=1` 会重跑分层与试点漏斗重建并写缓存：与 supplier-lead-history 同因（安全审计 S4），
 * 重算升级为 `guardFreshWrite()` + `requireAnyRole(pmc)`（admin 兜底），只读路径不变。
 */
export async function GET(req: NextRequest) {
  try {
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    const user = refresh ? await guardFreshWrite() : await guardRead();
    if (refresh) requireAnyRole(user, "pmc");
    return NextResponse.json(await loadReplenishPilot(undefined, { refresh }));
  } catch (e) {
    return errorResponse(e, { path: "/api/replenish/pilot", method: "GET" });
  }
}
