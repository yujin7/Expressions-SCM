import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approvePc } from "@/server/modules/outsource/po";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs（pc→purchasing）判定；
    // jg_fee 通过时同事务更新 JG 现价并插入新费率分段
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approvePc(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
