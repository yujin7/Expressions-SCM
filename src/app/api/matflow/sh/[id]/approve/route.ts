import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveSh } from "@/server/modules/matflow/sh";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（sh→warehouse）判定；审批仅置 approved，检验前不入库
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveSh(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
