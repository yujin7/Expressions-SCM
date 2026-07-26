import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveTl } from "@/server/modules/matflow/tl";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（tl→warehouse）判定；TL≤FL 守卫在 service 内
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveTl(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
