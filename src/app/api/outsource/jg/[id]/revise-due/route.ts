import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { reviseJgDueDate } from "@/server/modules/outsource/jg";

/** 交期修改（历史留痕 revisedDates；PMC/采购） */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await reviseJgDueDate(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
