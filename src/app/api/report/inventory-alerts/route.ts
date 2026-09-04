import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadInventoryAlerts, refreshInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { pageInventoryAlerts } from "@/server/modules/report/inventory-alerts-query";

/**
 * 库存预警表读模型 `inventory-alerts`（D57，键见 INVENTORY_ALERTS_CACHE_KEY；v2 接未结供给/临期/积压/学习交期观察，v3 绑定补业务日、临期收口盘点期）。?refresh=1 需 pmc/admin 回查。数量口径全员可见。
 * 筛选/分页在服务端（审计 #8）：q / tier / primary / onlyAlert / showC / page / pageSize；totals 始终是读模型全量。
 */
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const refresh = sp.get("refresh") === "1";
    const user = refresh ? await guardFreshWrite() : await guardRead();
    if (refresh) requireAnyRole(user, "pmc", "admin");
    const db = await getDbAsync();
    const model = refresh ? await refreshInventoryAlerts(db) : await loadInventoryAlerts(db);
    const data = pageInventoryAlerts(model, {
      q: sp.get("q") ?? undefined,
      tier: sp.get("tier") ?? undefined,
      primary: sp.get("primary") ?? undefined,
      onlyAlert: sp.get("onlyAlert") ?? undefined,
      showC: sp.get("showC") ?? undefined,
      page: Number(sp.get("page")) || undefined,
      pageSize: Number(sp.get("pageSize")) || undefined,
    });
    const res = NextResponse.json(maskSensitive(data, user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/inventory-alerts", method: "GET" });
  }
}
