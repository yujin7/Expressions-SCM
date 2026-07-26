import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFeeRefWrite, updateFeeRef } from "@/server/modules/master/feeref";

/** 更新 feeRate/effectiveDate/note（service 内 writeAudit before/after） */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFeeRefWrite();
    const { id } = await ctx.params;
    const result = await updateFeeRef(user, parseId(id), await readJson(req));
    return NextResponse.json(maskSensitive(result, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
