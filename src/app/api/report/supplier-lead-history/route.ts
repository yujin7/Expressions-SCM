import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadSupplierLeadHistory } from "@/server/modules/report/supplier-lead-history";

/**
 * 历史采购交期观察 `supplier-lead-history`（B4，键见 SUPPLIER_LEAD_HISTORY_CACHE_KEY；只读，无金额字段故免脱敏）。
 * `?refresh=1` 强制重算——观察读模型没有写路径，重算只重建缓存，但一次重算是一次全量暂存扫描 + 缓存写，
 * 任何登录用户都能反复触发就是一条自助放大器（安全审计 S4）。因此 refresh 升级为
 * `guardFreshWrite()` + `requireAnyRole(pmc/purchasing)`（admin 由 requireAnyRole 兜底放行），
 * 与 /api/report/inventory-alerts、/api/report/sales-spike 同一套路。
 */
export async function GET(req: NextRequest) {
  try {
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    const user = refresh ? await guardFreshWrite() : await guardRead();
    if (refresh) requireAnyRole(user, "pmc", "purchasing");
    const response = NextResponse.json(await loadSupplierLeadHistory(undefined, { refresh }));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/supplier-lead-history", method: "GET" });
  }
}
