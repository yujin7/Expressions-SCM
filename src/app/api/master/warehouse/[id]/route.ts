import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { updateWarehouse } from "@/server/modules/master/warehouse";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWrite("warehouse");
    const { id } = await ctx.params;
    return NextResponse.json(await updateWarehouse(parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
