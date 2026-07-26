import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { maskSensitive } from "@/server/core/dto";
import { getCt } from "@/server/modules/matflow/ct";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getCt(parseId(id)), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
