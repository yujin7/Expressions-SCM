import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId, readJson } from "@/server/modules/master/common";
import { approveCountTask } from "@/server/modules/inventory/count";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 审批授权由 approveDoc 按 approval_configs 判定（盘点=count 域→财务；admin 兜底）
    const user = await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(await approveCountTask(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
