import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { getGoal, updateGoal } from "@/server/modules/goals/service";
import { errorResponse, guardRead, parseId, readJson } from "@/server/modules/master/common";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    return NextResponse.json(await getGoal(parseId((await ctx.params).id), user));
  } catch (error) {
    return errorResponse(error, { path: "/api/goals/[id]", method: "GET" });
  }
}

/** PATCH targetValue/direction/note/actualValue(+evidence)；本部门或 admin */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(await updateGoal(parseId((await ctx.params).id), await readJson(req), user));
  } catch (error) {
    return errorResponse(error, { path: "/api/goals/[id]", method: "PATCH" });
  }
}
