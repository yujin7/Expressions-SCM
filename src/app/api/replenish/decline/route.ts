import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { declineReplenishSuggestion } from "@/server/modules/replenish/decline";

/** 补货建议「已复核并放弃」留痕（闭环审计 #12）：pmc/admin，新鲜会话回查；只写审计，不开单据（R13） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 角色（pmc/admin）在 service 内校验
    return NextResponse.json(await declineReplenishSuggestion(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e, { path: "/api/replenish/decline", method: "POST" });
  }
}
