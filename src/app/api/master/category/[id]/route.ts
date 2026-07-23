import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { updateCategory } from "@/server/modules/master/category";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWrite("category");
    const { id } = await ctx.params;
    return NextResponse.json(await updateCategory(parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
