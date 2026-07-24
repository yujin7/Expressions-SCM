import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { listSpuMembers } from "@/server/modules/master/spu";

/** 本 SPU 当前成员 SKU（归组管理 Drawer 数据源） */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(await listSpuMembers(parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}
