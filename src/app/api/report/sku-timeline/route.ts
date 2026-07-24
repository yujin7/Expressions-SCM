import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getSkuTimeline } from "@/server/modules/report/sku-timeline";

/** SKU 360 · 事件时间轴（只读；四源融合：流水×在途×效期×处置） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sku = new URL(req.url).searchParams.get("sku")?.trim();
    if (!sku) throw new Error("缺少 sku 参数");
    const data = await getSkuTimeline(sku);
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
