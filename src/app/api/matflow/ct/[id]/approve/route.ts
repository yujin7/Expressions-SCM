import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveCt } from "@/server/modules/matflow/ct";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（ct→warehouse）判定；过账+已收数回冲同事务
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveCt(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
