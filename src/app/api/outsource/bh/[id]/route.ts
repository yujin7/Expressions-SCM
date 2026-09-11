import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { maskSensitive } from "@/server/core/dto";
import { getBh, updateBh } from "@/server/modules/outsource/bh";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // Read-only action hints need the same current identity as the subsequent write.
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getBh(parseId(id), undefined, user), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await updateBh(user, parseId(id), await readJson(req)));
  } catch (e) { return errorResponse(e); }
}
