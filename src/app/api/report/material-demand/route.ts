import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getMaterialDemand } from "@/server/modules/report/material-demand";

/** E2-07 物料需求展开（MRP）：成品需求经生效 BOM 展开为物料相关需求（只读，不开单） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const horizonRaw = Number(searchParams.get("horizonDays"));
    const horizonDays = Number.isFinite(horizonRaw) && horizonRaw > 0 ? horizonRaw : undefined;
    const data = await getMaterialDemand({ q, page, pageSize, horizonDays });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
