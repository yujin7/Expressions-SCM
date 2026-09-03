import { NextRequest, NextResponse } from "next/server";
import { canSeePrices, getFreshSessionUser, maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { loadWarehouseInventory, normalizeWindow } from "@/server/modules/report/warehouse-inventory";

/** D60 / IAL-05 各地各仓库存明细与周转（warehouse-inventory/v1）；数量全员，金额按【新鲜】角色剥离 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const fresh = await getFreshSessionUser();
    const sp = req.nextUrl.searchParams;
    const model = await loadWarehouseInventory(undefined, {
      windowDays: normalizeWindow(sp.get("window")),
      refresh: sp.get("refresh") === "1",
    });
    const response = NextResponse.json({ ...maskSensitive(model, fresh.roles), moneyVisible: canSeePrices(fresh.roles) });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/warehouse-inventory", method: "GET" });
  }
}
