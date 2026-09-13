import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { maskSensitive } from "@/server/core/dto";
import { getCt, updateCt } from "@/server/modules/matflow/ct";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getCt(parseId(id), undefined, user), user.roles), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(), { id } = await ctx.params;
    return NextResponse.json(await updateCt(user, parseId(id), await readJson(req)));
  } catch (e) { return errorResponse(e); }
}
