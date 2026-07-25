// SKU 放行：BOM 块成品+物料建档（baseUom 打标不猜测；SPU 未放行者阻塞）
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRelease, releaseSkus } from "@/server/modules/release/engine";
import { releaseSkusBody } from "@/server/modules/release/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await guardRelease();
    const body = releaseSkusBody.parse(await readJson(req));
    return NextResponse.json(await releaseSkus(user, body));
  } catch (e) {
    return errorResponse(e);
  }
}
