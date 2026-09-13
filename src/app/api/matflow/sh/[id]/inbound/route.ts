import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readOptionalJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { confirmInbound } from "@/server/modules/matflow/sh";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    // 检验后入库确认：过账 + SH 完成（单事务；重复入库 409）
    return NextResponse.json(await confirmInbound(user, parseId(id), undefined, await readOptionalJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
