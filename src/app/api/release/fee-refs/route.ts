// 加工费参考价放行：feeRate 此阶段恒 null（待采购补录），响应中不出现 feeRate 字段
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRelease, releaseFeeRefs } from "@/server/modules/release/engine";
import { releasePlainBody } from "@/server/modules/release/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await guardRelease();
    const body = releasePlainBody.parse(await readJson(req));
    return NextResponse.json(await releaseFeeRefs(user, body));
  } catch (e) {
    return errorResponse(e);
  }
}
