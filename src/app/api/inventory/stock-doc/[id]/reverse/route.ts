import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardWarehouseWrite, reverseStockDoc } from "@/server/modules/inventory/stock-doc";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWarehouseWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await reverseStockDoc(user, parseId(id), await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
