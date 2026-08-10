import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { approveStockDoc } from "@/server/modules/inventory/stock-doc";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 体检 #2：审批授权由 approveDoc 按 approval_configs 角色判定（期初=财务，其余=仓管，admin 兜底）
    /* 审批＝写路径，必须回查 DB 新鲜身份（2026-08-03 修）。
       此前用 guardRead()，它只解 JWT——账号被停用/降权后，旧 token 在 8 小时有效期内
       仍能通过审批并触发过账，而其余 11 条审批路由用的都是 guardFreshWrite。
       授权仍由 approveDoc 按 approval_configs 判定，此处只保证「身份是此刻的真身份」。 */
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveStockDoc(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
