import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadInventorySalesRatio, refreshInventorySalesRatio } from "@/server/modules/report/inventory-sales-ratio";

/**
 * 库存占比读模型 `inventory-sales-ratio/v1`（D54）。
 * 占比 = 库存金额（A2）÷ 销售金额（A3），可见性取交集：仅 PRICE_VISIBLE_ROLES（采购/PMC/财务/管理员）；
 * 其他角色 403，前端显示无权限空态。金额键仍经 maskSensitive（对可见角色为幂等）。
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";
    const historyRaw = url.searchParams.get("months");
    const historyMonths = historyRaw == null ? undefined : Math.max(0, Math.min(60, Number(historyRaw) || 0));
    const db = await getDbAsync();
    const user = refresh ? await guardFreshWrite() : await guardRead();
    requireAnyRole(user, ...PRICE_VISIBLE_ROLES);
    const full = refresh ? await refreshInventorySalesRatio(db) : await loadInventorySalesRatio(db);
    // 读模型固定 24 月窗口；?months= 只切片（含当月），不打穿缓存
    const data = historyMonths == null ? full : { ...full, rows: full.rows.slice(-(historyMonths + 1)) };
    const res = NextResponse.json(maskSensitive(data, user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/inventory-sales-ratio", method: "GET" });
  }
}
