import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { deletePlanEvent, updatePlanEvent } from "@/server/modules/planning/plan-events";

/** PATCH 修改运营计划事件（ops/pmc；审计 before/after） */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await updatePlanEvent(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE 删除（ops/pmc；审计留 before） */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await deletePlanEvent(user, parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}
