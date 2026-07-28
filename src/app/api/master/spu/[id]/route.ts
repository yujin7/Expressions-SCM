import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardWrite } from "@/server/modules/master/common";
import { updateSpu } from "@/server/modules/master/spu";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("spu");
    const { id } = await ctx.params;
    const parsedId = parseId(id);
    const result = await updateSpu(parsedId, await readJson(req), user);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
