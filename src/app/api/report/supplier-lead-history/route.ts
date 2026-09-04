import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { loadSupplierLeadHistory } from "@/server/modules/report/supplier-lead-history";

/**
 * 历史采购交期观察 `supplier-lead-history/v1`（B4；只读，无金额字段故免脱敏）。
 * `?refresh=1` 强制重算——观察读模型没有写路径，重算只重建缓存。
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    const response = NextResponse.json(await loadSupplierLeadHistory(undefined, { refresh }));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/supplier-lead-history", method: "GET" });
  }
}
