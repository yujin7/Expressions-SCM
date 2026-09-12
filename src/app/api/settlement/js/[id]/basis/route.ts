import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getJsBasis, refreshJsBasis } from "@/server/modules/settlement/js";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(), { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getJsBasis(user, parseId(id)), user.roles));
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(), { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await refreshJsBasis(user, parseId(id), await readJson(req)), user.roles));
  } catch (error) { return errorResponse(error); }
}
