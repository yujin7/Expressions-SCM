import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
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
    const user = await guardWrite("bom");
    const { id } = await ctx.params;
    const result = await updateBom(parseId(id), await readJson(req));
    await auditFromRoute(user, "bom", parseId(id), "update", result);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
