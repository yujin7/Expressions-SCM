import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { updateUser } from "@/server/modules/admin/users";

/** 改角色/审批人/停用/重置密码（仅 admin；自锁保护在 service 层） */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await updateUser(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
