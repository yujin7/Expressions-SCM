import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getApprovalBrief } from "@/server/modules/inbox/approval-brief";

/** E3-06 审批简报卡（只读）：?docType=bh&docId=123 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const docType = sp.get("docType") ?? "";
    const docId = Number(sp.get("docId") ?? 0);
    return NextResponse.json(await getApprovalBrief(docType, docId));
  } catch (e) {
    return errorResponse(e);
  }
}
