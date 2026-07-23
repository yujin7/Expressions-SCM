import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { getJs } from "@/server/modules/settlement/js";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const { id } = await ctx.params;
    // feePayable/settleAmount/deductPrice/deductAmount 等敏感（R9）——此边界按角色剥离
    return NextResponse.json(maskSensitive(await getJs(parseId(id)), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
