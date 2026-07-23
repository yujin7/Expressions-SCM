import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { updateSupplier } from "@/server/modules/master/supplier";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWrite("supplier");
    const { id } = await ctx.params;
    return NextResponse.json(await updateSupplier(parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
