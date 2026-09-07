import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listSupplyParams, SUPPLY_PARAM_DIM_LABELS } from "@/server/modules/master/sku-supply-params-fill";

/** 周期主数据补录列表（只读；成本只给有无，不给金额） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const blocked = searchParams.get("blockedOnly");
    if (blocked != null && !["", "0", "1"].includes(blocked)) throw new ApiError(400, "只看阻塞筛选值无效");
    const data = await listSupplyParams({
      q,
      skuType: searchParams.get("skuType") ?? undefined,
      missing: searchParams.get("missing") ?? undefined,
      tier: searchParams.get("tier") ?? undefined,
      brandId: searchParams.get("brandId") ? Number(searchParams.get("brandId")) : undefined,
      blockedOnly: searchParams.get("blockedOnly") === "1",
      page,
      pageSize,
    });
    return NextResponse.json({ ...data, dimLabels: SUPPLY_PARAM_DIM_LABELS });
  } catch (e) {
    return errorResponse(e);
  }
}
