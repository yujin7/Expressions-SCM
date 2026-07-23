// 批次库存参考层放行（非账本，不过账）：别名未认领的行保持未提交并记原因
import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { guardRelease, releaseBatchStocks } from "@/server/modules/release/engine";
import { releasePlainBody } from "@/server/modules/release/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await guardRelease();
    const body = releasePlainBody.parse(await req.json());
    return NextResponse.json(await releaseBatchStocks(user, body));
  } catch (e) {
    return errorResponse(e);
  }
}
