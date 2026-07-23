import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { confirmPo } from "@/server/modules/outsource/po";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // 供应商确认代录：采购/PMC/管理员（service 内校验）
    const { id } = await ctx.params;
    return NextResponse.json(await confirmPo(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
