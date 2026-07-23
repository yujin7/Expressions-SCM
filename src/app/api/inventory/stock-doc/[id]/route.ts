import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { getStockDoc } from "@/server/modules/inventory/stock-doc";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(await getStockDoc(parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}
