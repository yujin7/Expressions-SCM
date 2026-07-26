import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveJg } from "@/server/modules/outsource/jg";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（jg→pmc，seed 待补——见 outsource/common.ts）判定
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveJg(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
