import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardWrite, parseId } from "@/server/modules/master/common";
import { regroupSkus } from "@/server/modules/master/spu";

/** SPU 批量归组：{skuIds, mode:"move-in"}（写守卫 pmc/admin；service 事务内 writeAudit before/after） */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("spu");
    const { id } = await ctx.params;
    return NextResponse.json(await regroupSkus(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
