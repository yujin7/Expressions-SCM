import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveBh } from "@/server/modules/outsource/bh";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（bh→pmc）判定；写路径用新鲜身份
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveBh(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
