import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardWrite, parseId, readJson } from "@/server/modules/master/common";
import { setSupplierCapacity } from "@/server/modules/master/supplier";

/** 供应商产能申报：采购/管理员；审计与写入同事务（master/supplier.ts） */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("supplier");
    const { id } = await ctx.params;
    return NextResponse.json(await setSupplierCapacity(parseId(id), await readJson(req), user));
  } catch (e) {
    return errorResponse(e);
  }
}
