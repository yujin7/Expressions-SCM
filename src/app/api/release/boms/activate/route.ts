// 批量生效审批（§4.3）：PMC 审批人/admin 且 ≠ 放行操作者（SoD）；逐 BOM 写 approvals；10% 抽样清单
import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { activateReleasedBoms, guardReleaseApprover } from "@/server/modules/release/engine";
import { activateBomsBody } from "@/server/modules/release/schemas";

export async function POST(req: NextRequest) {
  try {
    const approver = await guardReleaseApprover();
    const body = activateBomsBody.parse(await req.json());
    return NextResponse.json(await activateReleasedBoms(approver, body));
  } catch (e) {
    return errorResponse(e);
  }
}
