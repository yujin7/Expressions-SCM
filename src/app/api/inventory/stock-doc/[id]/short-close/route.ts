import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardWarehouseWrite, shortCloseStockDoc } from "@/server/modules/inventory/stock-doc";

/** 短关：已审批/执行中 → 已关闭（必须留原因）。只关剩余，不冲销任何已过账数量。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWarehouseWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await shortCloseStockDoc(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e, { path: "/api/inventory/stock-doc/[id]/short-close", method: "POST" });
  }
}
