import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { maskSensitive } from "@/server/core/dto";
import { getWo } from "@/server/modules/outsource/wo";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // Current identity for action hints and masking; this remains read-only.
    const { id } = await ctx.params;
    // feeRatePlan 敏感（R9）——在此序列化边界按角色剥离
    return NextResponse.json(maskSensitive(await getWo(parseId(id), undefined, user), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
