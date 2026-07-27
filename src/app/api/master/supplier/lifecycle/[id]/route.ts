import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardWrite, parseId, readJson } from "@/server/modules/master/common";
import { closeSupplierLifecycleCase } from "@/server/modules/master/supplier-lifecycle";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("supplier");
    const { id } = await ctx.params;
    return NextResponse.json(
      await closeSupplierLifecycleCase(user, parseId(id), await readJson(req)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
