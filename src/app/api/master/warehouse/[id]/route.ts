import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { getWarehouse, updateWarehouse } from "@/server/modules/master/warehouse";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(await getWarehouse(parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("warehouse");
    const { id } = await ctx.params;
    // 审计已随写入落在同一事务内（master/warehouse.ts）
    const result = await updateWarehouse(parseId(id), await readJson(req), user);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
