import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getInventoryAnalytics } from "@/server/modules/report/inventory-analytics";

/** E7-04 库存分析三视图（只读；健康散点 × 库存账龄 × 周转指标） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const raw = Number(searchParams.get("windowDays"));
    const windowDays = Number.isFinite(raw) && raw > 0 ? raw : undefined;
    const data = await getInventoryAnalytics({ q, windowDays, page, pageSize });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
