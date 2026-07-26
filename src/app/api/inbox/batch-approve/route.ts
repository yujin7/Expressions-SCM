import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { batchApprove } from "@/server/modules/inbox/batch-approve";

/** E5-03 批量审批（逐单独立、部分成功可见；权限与幂等复用各单据既有审批服务） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await batchApprove(user, await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
