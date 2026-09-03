import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadInventoryAlerts, refreshInventoryAlerts } from "@/server/modules/report/inventory-alerts";

/** 库存预警表读模型 `inventory-alerts/v2`（D57；v2 接未结供给/临期/积压/学习交期观察）。?refresh=1 需 pmc/admin 回查。数量口径全员可见。 */
export async function GET(req: NextRequest) {
  try {
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    const user = refresh ? await guardFreshWrite() : await guardRead();
    if (refresh) requireAnyRole(user, "pmc", "admin");
    const db = await getDbAsync();
    const data = refresh ? await refreshInventoryAlerts(db) : await loadInventoryAlerts(db);
    const res = NextResponse.json(maskSensitive(data, user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/inventory-alerts", method: "GET" });
  }
}
