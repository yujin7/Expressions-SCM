import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
import { updateSupplier } from "@/server/modules/master/supplier";

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
