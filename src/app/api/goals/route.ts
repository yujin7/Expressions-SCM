import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { AUTO_METRIC_SOURCES, createGoal, getGoalsBlock, listGoals, refreshAutoActuals } from "@/server/modules/goals/service";
import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";

/**
 * D61 部门目标。
 *  GET ?period=&deptKey= → 列表（全员可读；D62 受限用户按部门范围裁剪）；?scope=summary → 第 4 屏数据块；
 *  GET ?refresh=1 → 先回填 auto 实际值再返回列表（需登录写守卫）；
 *  POST → 新建（admin 或本部门）。
 */
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    if (sp.get("scope") === "summary") return NextResponse.json(await getGoalsBlock(await guardRead()));
    const user = sp.get("refresh") === "1" ? await getFreshSessionUser() : await guardRead();
    const period = sp.get("period") || undefined;
    if (sp.get("refresh") === "1") await refreshAutoActuals(undefined, { period, actorId: user.id });
    const list = await listGoals({ period, deptKey: sp.get("deptKey") || undefined }, user);
    return NextResponse.json({
      ...list,
      autoMetrics: AUTO_METRIC_SOURCES.map((s) => ({ metricKey: s.metricKey, label: s.label, defaultDirection: s.defaultDirection })),
    });
  } catch (error) {
    return errorResponse(error, { path: "/api/goals", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(await createGoal(await readJson(req), user), { status: 201 });
  } catch (error) {
    return errorResponse(error, { path: "/api/goals", method: "POST" });
  }
}
