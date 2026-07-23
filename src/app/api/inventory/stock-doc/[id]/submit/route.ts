import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardWarehouseWrite, submitStockDoc } from "@/server/modules/inventory/stock-doc";
import { submitStockDocSchema } from "@/server/modules/inventory/schemas";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWarehouseWrite();
    const { id } = await ctx.params;
    const { version } = submitStockDocSchema.parse(await req.json());
    return NextResponse.json(await submitStockDoc(user, parseId(id), version));
  } catch (e) {
    return errorResponse(e);
  }
}
