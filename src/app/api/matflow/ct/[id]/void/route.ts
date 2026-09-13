import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { voidCt } from "@/server/modules/matflow/ct";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(), { id } = await ctx.params;
    return NextResponse.json(await voidCt(user, parseId(id), await readJson(req)), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
