import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { getSkuPanorama } from "@/server/modules/master/sku-panorama";

/** SKU 360° 全景（只读；纯数量口径，maskSensitive 双保险） */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const { id } = await ctx.params;
    const data = await getSkuPanorama(parseId(id));
    return NextResponse.json(maskSensitive(data, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
