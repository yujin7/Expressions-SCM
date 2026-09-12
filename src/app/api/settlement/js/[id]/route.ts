import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getJs } from "@/server/modules/settlement/js";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // Current identity for read-only action hints and masking.
    const { id } = await ctx.params;
    // feePayable/settleAmount/deductPrice/deductAmount 等敏感（R9）——此边界按角色剥离
    return NextResponse.json(maskSensitive(await getJs(parseId(id), undefined, user), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
