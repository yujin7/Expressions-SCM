import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
import { updateCategory } from "@/server/modules/master/category";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("category");
    const { id } = await ctx.params;
    const result = await updateCategory(parseId(id), await readJson(req));
    await auditFromRoute(user, "category", parseId(id), "update", result);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
