import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { ApiError, errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { buildSkuPlanningPolicy, currentPeriod, getPolicy, overrideTier, setPilotFlags } from "@/server/modules/planning/policy";

/** D58/D59 SKU 月度计划策略：GET 某期（缺省最近固化期）分层/权责/试点；无金额字段。 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await getPolicy({
        period: searchParams.get("period") || null,
        q,
        tier: searchParams.get("tier") ?? undefined,
        ownership: searchParams.get("ownership") ?? undefined,
        overriddenOnly: searchParams.get("overriddenOnly") === "1",
        pilotOnly: searchParams.get("pilotOnly") === "1",
        page,
        pageSize,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST { action: "build", period? } 固化本期；{ action: "override", skuId, period, overrideTier, note } 人工覆写；
 * { action: "pilot", period, skuIds, pilot } 试点标记。写守卫：新鲜身份 + service 内 pmc（admin 兜底）。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const body = await readJson<{ action?: string; period?: string }>(req);
    const action = body?.action ?? "override";
    if (action === "build") {
      const period = body.period?.trim() || currentPeriod();
      return NextResponse.json(await buildSkuPlanningPolicy(period, { actor: user }), { status: 201 });
    }
    if (action === "override") return NextResponse.json(await overrideTier(user, body));
    if (action === "pilot") return NextResponse.json(await setPilotFlags(user, body));
    throw new ApiError(400, `未知 action：${action}`);
  } catch (e) {
    return errorResponse(e);
  }
}
