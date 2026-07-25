import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
import { updateWarehouse } from "@/server/modules/master/warehouse";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("warehouse");
    const { id } = await ctx.params;
    const result = await updateWarehouse(parseId(id), await readJson(req));
    await auditFromRoute(user, "warehouse", parseId(id), "update", result);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
