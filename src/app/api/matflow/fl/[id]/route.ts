import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { maskSensitive } from "@/server/core/dto";
import { getFl } from "@/server/modules/matflow/fl";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // Current identity for read-only action hints and masking.
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getFl(parseId(id), undefined, user), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
