import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { getApprovalBrief } from "@/server/modules/inbox/approval-brief";

/** E3-06 审批简报卡（只读）：?docType=bh&docId=123 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const sp = new URL(req.url).searchParams;
    const docType = sp.get("docType") ?? "";
    const docId = parseId(sp.get("docId") ?? "");
    return NextResponse.json(await getApprovalBrief(docType, docId, undefined, user));
  } catch (e) {
    return errorResponse(e);
  }
}
