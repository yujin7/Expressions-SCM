import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getSalesBridge, type BridgeDim } from "@/server/modules/report/sales-bridge";

/** E7-03：销量变化瀑布 + 异动自动归因（只读；sales_monthly 单源，两期差分解） */
export async function GET(req: NextRequest) {
  try {
    // D62：身份交给服务层——受限用户（JWT 载荷带范围；范围变更即 bump session_version 失效）按渠道裁剪
    const user = await guardRead();
    const sp = new URL(req.url).searchParams;
    const data = await getSalesBridge({
      dim: (sp.get("dim") ?? undefined) as BridgeDim | undefined,
      fromYm: sp.get("fromYm") ?? undefined,
      toYm: sp.get("toYm") ?? undefined,
    }, undefined, user);
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
