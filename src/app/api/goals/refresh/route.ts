import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { refreshAutoActuals } from "@/server/modules/goals/service";
import { errorResponse, readJson } from "@/server/modules/master/common";

/** 回填部门目标的 auto 实际值（写路径：审计 action=refresh）。原 GET ?refresh=1 改为 POST（审阅 must-fix）。 */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const body = (await readJson(req).catch(() => ({}))) as { period?: string };
    const result = await refreshAutoActuals(undefined, { period: typeof body.period === "string" ? body.period : undefined, actorId: user.id });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, { path: "/api/goals/refresh", method: "POST" });
  }
}
