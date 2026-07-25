import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
import { updateSku } from "@/server/modules/master/sku";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("sku");
    const { id } = await ctx.params;
    const result = await updateSku(parseId(id), await readJson(req));
    await auditFromRoute(user, "sku", parseId(id), "update", result);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
