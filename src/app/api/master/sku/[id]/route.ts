import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { updateSku } from "@/server/modules/master/sku";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWrite("sku");
    const { id } = await ctx.params;
    return NextResponse.json(await updateSku(parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
