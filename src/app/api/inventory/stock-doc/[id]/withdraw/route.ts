import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardWarehouseWrite, withdrawStockDoc } from "@/server/modules/inventory/stock-doc";

/** 撤回：待审批 → 草稿（制单人或管理员；权限在 service 内强制） */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWarehouseWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await withdrawStockDoc(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e, { path: "/api/inventory/stock-doc/[id]/withdraw", method: "POST" });
  }
}
