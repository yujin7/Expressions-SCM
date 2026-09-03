import { NextRequest, NextResponse } from "next/server";
import { canSeePrices, getFreshSessionUser, maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { filterTransferRoutes, loadTransferRoutes, stripLaneMoney } from "@/server/modules/report/transfer-routes";

const num = (v: string | null): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** D60 调拨线路读模型（transfer-routes/v1）；元/件与费用按【新鲜】角色剥离，单数/件数全员 */
export async function GET(req: NextRequest) {
  try {
    const reader = await guardRead();
    requireAnyRole(reader, "warehouse", "pmc", "finance", "admin"); // 与 route-access 注册一致（D60/D62）
    const fresh = await getFreshSessionUser();
    const sp = req.nextUrl.searchParams;
    const model = await loadTransferRoutes(undefined, { refresh: sp.get("refresh") === "1" });
    const filtered = filterTransferRoutes(model, {
      fromWarehouseId: num(sp.get("from")),
      toWarehouseId: num(sp.get("to")),
      transferType: sp.get("type")?.trim() || undefined,
      level: sp.get("level")?.trim() || undefined,
    });
    const visible = canSeePrices(fresh.roles) ? filtered : stripLaneMoney(filtered);
    const response = NextResponse.json({ ...maskSensitive(visible, fresh.roles), moneyVisible: canSeePrices(fresh.roles) });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/transfer-routes", method: "GET" });
  }
}
