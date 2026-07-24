import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { decideReviewItem, guardReviewWrite } from "@/server/modules/review/checklist";

/** 单条改判：{status: done|overruled|open, note?} */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardReviewWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await decideReviewItem(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
