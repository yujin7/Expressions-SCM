import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadInventoryPosition, refreshInventoryPosition } from "@/server/modules/report/inventory-position";

/**
 * 库存日级 / 月级读模型 `inventory-position/v1`（D51/D52）。
 * 数量全员可见；金额（`amount` 键）由 maskSensitive 按 PRICE_VISIBLE_ROLES 剥离。
 * `?refresh=1` 强制重算（pmc / finance / admin，回查 DB 新鲜身份）。
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";
    const historyRaw = url.searchParams.get("months");
    const historyMonths = historyRaw == null ? undefined : Math.max(0, Math.min(60, Number(historyRaw) || 0));
    const db = await getDbAsync();
    let user;
    let data;
    if (refresh) {
      user = await guardFreshWrite();
      requireAnyRole(user, "pmc", "finance");
      data = await refreshInventoryPosition(db, { historyMonths });
    } else {
      user = await guardRead();
      data = await loadInventoryPosition(db, { historyMonths });
    }
    const res = NextResponse.json(maskSensitive(data, user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/inventory-position", method: "GET" });
  }
}
