import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { updateJgPlan } from "@/server/modules/outsource/jg";

/** 包材齐套/计划属性维护（PMC；写路径新鲜身份） */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await updateJgPlan(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
