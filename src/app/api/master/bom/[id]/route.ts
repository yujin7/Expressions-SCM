import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { getBom, updateBom } from "@/server/modules/master/bom";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(await getBom(parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWrite("bom");
    const { id } = await ctx.params;
    return NextResponse.json(await updateBom(parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
