import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { maskSensitive } from "@/server/core/dto";
import { getWo } from "@/server/modules/outsource/wo";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const { id } = await ctx.params;
    // feeRatePlan 敏感（R9）——在此序列化边界按角色剥离
    return NextResponse.json(maskSensitive(await getWo(parseId(id)), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
