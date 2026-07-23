import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approvePo } from "@/server/modules/outsource/po";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（po→purchasing）判定
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approvePo(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
