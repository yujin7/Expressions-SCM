import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listJgs } from "@/server/modules/outsource/jg";
import { parseSelectedValues } from "@/server/core/selected-options";

// JG 仅由 WO generateDocs 派生，无手工创建入口
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const woId = Number(searchParams.get("woId")) || undefined;
    const eligible = searchParams.getAll("receiptEligible");
    if (eligible.length > 1 || (eligible.length === 1 && eligible[0] !== "1")) throw new ApiError(400, "receiptEligible 仅支持单个 1");
    return NextResponse.json(
      await listJgs(q, { status: searchParams.get("status") ?? undefined, woId, page, pageSize,
        receiptEligible: eligible[0] === "1", selectedValues: parseSelectedValues(searchParams) }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
