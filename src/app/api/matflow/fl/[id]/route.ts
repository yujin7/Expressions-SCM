import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { maskSensitive } from "@/server/core/dto";
import { getFl, updateFl } from "@/server/modules/matflow/fl";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // Current identity for read-only action hints and masking.
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getFl(parseId(id), undefined, user), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await updateFl(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
