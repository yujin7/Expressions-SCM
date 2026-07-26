import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { getSupplier, updateSupplier } from "@/server/modules/master/supplier";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getSupplier(parseId(id)), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("supplier");
    const { id } = await ctx.params;
    // 审计已随写入落在同一事务内（master/supplier.ts）
    const result = await updateSupplier(parseId(id), await readJson(req), user);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
