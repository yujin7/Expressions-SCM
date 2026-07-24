import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { diffBom } from "@/server/modules/master/bom";

/** BOM 版本对比：?againstId=X 缺省取同产品上一版本 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    const raw = new URL(req.url).searchParams.get("againstId");
    const againstId = raw ? parseId(raw) : undefined;
    return NextResponse.json(await diffBom(parseId(id), againstId));
  } catch (e) {
    return errorResponse(e);
  }
}
