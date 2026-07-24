import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getSalesBridge, type BridgeDim } from "@/server/modules/report/sales-bridge";

/** E7-03：销量变化瀑布 + 异动自动归因（只读；sales_monthly 单源，两期差分解） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const data = await getSalesBridge({
      dim: (sp.get("dim") ?? undefined) as BridgeDim | undefined,
      fromYm: sp.get("fromYm") ?? undefined,
      toYm: sp.get("toYm") ?? undefined,
    });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
