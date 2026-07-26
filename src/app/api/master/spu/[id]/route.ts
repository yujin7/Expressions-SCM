import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardWrite } from "@/server/modules/master/common";
import { updateSpu } from "@/server/modules/master/spu";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("spu");
    const { id } = await ctx.params;
    const result = await updateSpu(parseId(id), await readJson(req));
    await auditFromRoute(user, "spu", parseId(id), "update", result);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
