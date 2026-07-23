import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { submitJs } from "@/server/modules/settlement/js";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await submitJs(user, parseId(id), await req.json()), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
