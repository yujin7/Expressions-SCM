import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { getSharedPackaging } from "@/server/modules/master/shared-packaging";

/** 共用包材（D36）：BOM 派生，含实时可用量与共用成品清单 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json({ items: await getSharedPackaging(parseId(id)) });
  } catch (e) {
    return errorResponse(e);
  }
}
