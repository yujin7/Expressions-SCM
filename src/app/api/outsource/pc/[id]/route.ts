import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getPc } from "@/server/modules/outsource/pc-detail";

/** PC 详情（W3-UI 契约缺口 #3 补齐：审批时间线可达） */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // Current identity for read-only action hints and masking.
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getPc(parseId(id), user), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
