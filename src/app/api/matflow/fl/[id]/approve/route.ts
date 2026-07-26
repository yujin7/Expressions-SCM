import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveFl } from "@/server/modules/matflow/fl";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（fl→warehouse）判定；超发须管理员（service 内）
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveFl(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
