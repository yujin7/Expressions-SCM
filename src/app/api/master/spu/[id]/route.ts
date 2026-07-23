import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { updateSpu } from "@/server/modules/master/spu";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWrite("spu");
    const { id } = await ctx.params;
    return NextResponse.json(await updateSpu(parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
