import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { withdrawPO } from "@/server/modules/outsource/po";

/** 撤回：待审批 → 草稿。仅制单人本人（管理员豁免），由 withdrawDoc 判定；写路径用新鲜身份。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await withdrawPO(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
