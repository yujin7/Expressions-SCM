import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listPos } from "@/server/modules/outsource/po";
import { parseSelectedValues } from "@/server/core/selected-options";
import { ApiError } from "@/server/modules/master/common";

// PO 本波仅由 WO generateDocs 派生（独立采购创建入口在后续波次），故无 POST
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const woId = Number(searchParams.get("woId")) || undefined;
    const eligible = searchParams.get("returnEligible");
    if (eligible !== null && eligible !== "1") throw new ApiError(400, "returnEligible 仅支持 1");
    const receipt = searchParams.getAll("receiptEligible");
    if (receipt.length > 1 || (receipt.length === 1 && receipt[0] !== "1")) throw new ApiError(400, "receiptEligible 仅支持单个 1");
    return NextResponse.json(
      await listPos(q, { status: searchParams.get("status") ?? undefined, woId, page, pageSize,
        returnEligible: eligible === "1", receiptEligible: receipt[0] === "1", selectedValues: parseSelectedValues(searchParams) }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
