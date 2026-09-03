import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardWrite, parseId, readJson } from "@/server/modules/master/common";
import { setSupplierPaymentTerm } from "@/server/modules/master/supplier";

/** D64 账期登记：采购/管理员；审计与写入同事务（master/supplier.ts） */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("supplier");
    const { id } = await ctx.params;
    return NextResponse.json(await setSupplierPaymentTerm(parseId(id), await readJson(req), user));
  } catch (e) {
    return errorResponse(e);
  }
}
