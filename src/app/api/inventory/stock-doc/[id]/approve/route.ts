import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { approveStockDoc, guardWarehouseWrite } from "@/server/modules/inventory/stock-doc";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWarehouseWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await approveStockDoc(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
