// 月销量放行：UNIQUE(sku,channel,yearMonth) upsert；未解析别名按类型计数阻塞
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRelease, releaseSalesMonthly } from "@/server/modules/release/engine";
import { releasePlainBody } from "@/server/modules/release/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await guardRelease();
    const body = releasePlainBody.parse(await readJson(req));
    return NextResponse.json(await releaseSalesMonthly(user, body));
  } catch (e) {
    return errorResponse(e);
  }
}
