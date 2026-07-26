import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { confirmJg } from "@/server/modules/outsource/jg";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // 加工厂确认代录：采购/PMC/管理员（service 内校验）
    const { id } = await ctx.params;
    return NextResponse.json(await confirmJg(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
