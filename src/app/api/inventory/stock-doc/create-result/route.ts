import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { guardWarehouseWrite } from "@/server/modules/inventory/stock-doc";
import { getStockCreateResult } from "@/server/modules/inventory/stock-create-request";

export async function GET(req: NextRequest) {
  try {
    const user = await guardWarehouseWrite(), params = req.nextUrl.searchParams;
    if (params.getAll("requestKey").length !== 1 || [...params.keys()].some(k => k !== "requestKey")) throw new ApiError(400, "请提供唯一的原创建请求编号");
    return NextResponse.json(await getStockCreateResult(user, params.get("requestKey")!), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
