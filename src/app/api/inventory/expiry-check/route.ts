import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead } from "@/server/modules/master/common";
import { expiryCheck } from "@/server/modules/replenish/expiry";

/**
 * R15 临期/过期批次检查（v1 提示告警，不拦截）。
 * GET /api/inventory/expiry-check?skuIds=1,2,3&warehouseId=N（warehouseId 省略=全仓）
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    if ([...sp.keys()].some(k => !["skuIds", "warehouseId"].includes(k)) || sp.getAll("skuIds").length !== 1 || sp.getAll("warehouseId").length > 1) {
      throw new ApiError(400, "效期检查参数重复或不支持，请重新选择 SKU 和仓库");
    }
    const id = (value: string) => {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) throw new ApiError(400, "SKU 或仓库编号无效，请重新选择");
      return Number(value);
    };
    const parts = sp.get("skuIds")!.split(",");
    if (parts.length > 200) throw new ApiError(400, "效期检查每批最多 200 个 SKU，请分批查询");
    const skuIds = [...new Set(parts.map(s => id(s.trim())))];
    const warehouseId = sp.has("warehouseId") ? id(sp.get("warehouseId")!) : null;
    return NextResponse.json(await expiryCheck({ skuIds, warehouseId }), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const response = errorResponse(e, { path: "/api/inventory/expiry-check", method: "GET" });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
