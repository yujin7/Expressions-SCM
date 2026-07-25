import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { getMarginReport, upsertSkuCost } from "@/server/modules/report/margin";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/** 毛利视角 v1（只读；手工成本×近3月销量；售价源未接入时留白） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const onlyCosted = searchParams.get("onlyCosted") === "1" || searchParams.get("onlyCosted") === "true";
    const data = await getMarginReport({ q, page, pageSize, onlyCosted });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}

/** 成本录入（finance/admin，新鲜会话回查；service 内校验角色） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await upsertSkuCost(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
