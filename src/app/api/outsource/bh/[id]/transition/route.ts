import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { transitionBH } from "@/server/modules/outsource/bh";

/**
 * 手工状态流转：完成 / 短关（必须留原因）/ 作废（仅草稿、仅制单人）/ 重开（仅管理员）。
 * 角色与归属由服务层判定；写路径用新鲜身份。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await transitionBH(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
