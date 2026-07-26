import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveWo } from "@/server/modules/outsource/wo";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（wo→pmc）判定；通过时同事务落 wo_line 快照
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveWo(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
