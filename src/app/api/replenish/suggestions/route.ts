import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getReplenishSuggestions, normalizeReplenishSort } from "@/server/modules/replenish/service";

/** R11 补货建议（只读报表；R13：只呈现，开单走 POST /api/replenish/draft 人工闸） */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const coverDaysTarget = Number(searchParams.get("coverDaysTarget")) || undefined;
    const minCoverAlert = Number(searchParams.get("minCoverAlert")) || undefined;
    const sort = normalizeReplenishSort(searchParams.get("sortBy"), searchParams.get("sortOrder"));
    // D58/D59：tier / ownership 筛选；C 级默认折叠由页面传 hideTierC=1（服务端裁剪，分页计数才正确）
    const tier = searchParams.get("tier") ?? undefined;
    const ownership = searchParams.get("ownership") ?? undefined;
    const hideTierC = searchParams.get("hideTierC") === "1";
    return NextResponse.json(
      await getReplenishSuggestions({
        coverDaysTarget, minCoverAlert, q, page, pageSize, ...sort, tier, ownership, hideTierC,
        scopeUser: { roles: user.roles, channelScope: (user as { channelScope?: number[] | null }).channelScope ?? null },
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
