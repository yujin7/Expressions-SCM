import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { bindFeishuIdentity, unbindFeishuIdentity } from "@/server/modules/admin/users";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";

/** 绑定 Feishu union_id（仅 admin；身份值不回传）。 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await bindFeishuIdentity(actor, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}

/** 解绑 Feishu union_id（仅 admin；已解绑时幂等成功）。 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await unbindFeishuIdentity(actor, parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}
