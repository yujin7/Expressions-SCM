import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { getUserScopes, setUserScopes } from "@/server/modules/admin/user-scopes";

/** 用户数据范围（D62，仅 admin——service 内 guardAdmin 抛 ApiError 403）：GET 当前范围；PUT 整体替换（范围变化即令该用户既有会话失效） */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await getUserScopes(user, parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await setUserScopes(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
