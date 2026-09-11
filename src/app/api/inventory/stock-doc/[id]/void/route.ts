import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardWarehouseWrite, voidStockDoc } from "@/server/modules/inventory/stock-doc";

/** 作废草稿：草稿 → 已作废（制单人或管理员，必须留原因） */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWarehouseWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await voidStockDoc(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e, { path: "/api/inventory/stock-doc/[id]/void", method: "POST" });
  }
}
