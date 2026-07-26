import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { maskSensitive } from "@/server/core/dto";
import { getStockDoc } from "@/server/modules/inventory/stock-doc";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const { id } = await ctx.params;
    // R9 落地（体检 #3）：期初成本单价等敏感字段在序列化边界按角色脱敏
    return NextResponse.json(maskSensitive(await getStockDoc(parseId(id)), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
