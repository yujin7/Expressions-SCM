import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadInventoryAlerts, refreshInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { pageInventoryAlerts, validateInventoryAlertsQuery } from "@/server/modules/report/inventory-alerts-query";

/**
 * 库存预警表读模型 `inventory-alerts`（D57）。**当前版本号只有一处权威：`INVENTORY_ALERTS_CACHE_KEY`**——
 * 注释里再抄一遍版本枚举（曾写着「v2…v3」而常量早已是 v4）只会漂，改口径的人不会回来改注释。
 * 升版历史见该常量上方的模块注释。?refresh=1 需 pmc/admin 回查。数量口径全员可见。
 * 筛选/分页在服务端（审计 #8）：q / tier / primary / onlyAlert / showC / page / pageSize；totals 始终是读模型全量。
 */
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const refresh = sp.get("refresh") === "1";
    const user = refresh ? await guardFreshWrite() : await guardRead();
    if (refresh) requireAnyRole(user, "pmc", "admin");
    const query = {
      q: sp.get("q") ?? undefined,
      tier: sp.get("tier") ?? undefined,
      primary: sp.get("primary") ?? undefined,
      status: sp.get("status") ?? undefined,
      onlyAlert: sp.get("onlyAlert") ?? undefined,
      showC: sp.get("showC") ?? undefined,
      sort: sp.get("sort") ?? undefined,
      order: sp.get("order") ?? undefined,
      page: Number(sp.get("page")) || undefined,
      pageSize: Number(sp.get("pageSize")) || undefined,
    };
    validateInventoryAlertsQuery(query);
    const db = await getDbAsync();
    const model = refresh ? await refreshInventoryAlerts(db) : await loadInventoryAlerts(db);
    const data = pageInventoryAlerts(model, query);
    const res = NextResponse.json(maskSensitive(data, user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/inventory-alerts", method: "GET" });
  }
}
