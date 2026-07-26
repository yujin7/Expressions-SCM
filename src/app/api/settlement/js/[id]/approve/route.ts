import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveJs } from "@/server/modules/settlement/js";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（js→finance，seed 已含）判定
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveJs(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
