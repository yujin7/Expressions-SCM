import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { submitDocSchema } from "@/server/modules/outsource/schemas";
import { submitPo } from "@/server/modules/outsource/po";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // 制单人/采购校验在 service 内
    const { id } = await ctx.params;
    const { version } = submitDocSchema.parse(await req.json());
    // R1：异动 → 自动生成 PC 并 409（PC 已落库），全部通过后重提才放行
    return NextResponse.json(await submitPo(user, parseId(id), version));
  } catch (e) {
    return errorResponse(e);
  }
}
