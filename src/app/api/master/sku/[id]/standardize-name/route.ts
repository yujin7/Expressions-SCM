import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardWrite, parseId } from "@/server/modules/master/common";
import { applySkuStandardName } from "@/server/modules/master/sku";

/** PMC 明确采用服务端重算的标准名；稳定 SKU 主码永不在此路径变更。 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("sku");
    const { id } = await ctx.params;
    return NextResponse.json(await applySkuStandardName(parseId(id), user));
  } catch (error) {
    return errorResponse(error);
  }
}
