import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardWarehouseWrite } from "@/server/modules/inventory/stock-doc";
import { updateCounts } from "@/server/modules/inventory/count";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWarehouseWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await updateCounts(user, parseId(id), await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
