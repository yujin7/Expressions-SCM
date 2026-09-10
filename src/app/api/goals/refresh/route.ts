import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getFreshSessionUser } from "@/server/core/dto";
import { PERIOD_RE, refreshableDeptKeys, refreshAutoActuals } from "@/server/modules/goals/service";
import { ApiError, errorResponse, readJson } from "@/server/modules/master/common";

/** 回填部门目标的 auto 实际值（写路径：审计 action=refresh）。原 GET ?refresh=1 改为 POST（审阅 must-fix）。 */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const { period } = z.object({
      period: z.string().trim().regex(PERIOD_RE, "期间格式须为 YYYY-MM（01–12月）或 YYYY-Q1 至 YYYY-Q4").optional(),
    }).strict().parse(await readJson(req));
    // 与 PATCH 同一前提：只能回填自己可编辑的部门（admin 全部）；无可编辑部门 → 403（审阅修复：原先任何登录用户可全库回填）
    const deptKeys = refreshableDeptKeys(user);
    if (deptKeys && deptKeys.length === 0) throw new ApiError(403, "无可回填的部门目标");
    const result = await refreshAutoActuals(undefined, { period, actorId: user.id, deptKeys });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, { path: "/api/goals/refresh", method: "POST" });
  }
}
