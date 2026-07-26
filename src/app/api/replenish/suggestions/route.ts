import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getReplenishSuggestions, normalizeReplenishSort } from "@/server/modules/replenish/service";

/** R11 补货建议（只读报表；R13：只呈现，开单走 POST /api/replenish/draft 人工闸） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const coverDaysTarget = Number(searchParams.get("coverDaysTarget")) || undefined;
    const minCoverAlert = Number(searchParams.get("minCoverAlert")) || undefined;
    const sort = normalizeReplenishSort(searchParams.get("sortBy"), searchParams.get("sortOrder"));
    return NextResponse.json(
      await getReplenishSuggestions({ coverDaysTarget, minCoverAlert, q, page, pageSize, ...sort }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
