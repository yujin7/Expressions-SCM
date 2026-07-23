import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { approveStockDoc } from "@/server/modules/inventory/stock-doc";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // 体检 #2：审批授权由 approveDoc 按 approval_configs 角色判定（期初=财务，其余=仓管，admin 兜底）
    const user = await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(await approveStockDoc(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
