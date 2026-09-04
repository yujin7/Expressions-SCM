import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser, maskSensitive } from "@/server/core/dto";
import { AUTO_METRIC_SOURCES, createGoal, getGoalsBlock, listGoals } from "@/server/modules/goals/service";
import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";

/**
 * D61 部门目标。
 *  GET ?period=&deptKey= → 列表（全员可读；D62 受限用户按部门范围裁剪）；?scope=summary → 第 4 屏数据块；
 *  自动实际值回填改为 POST /api/goals/refresh（GET 不得写，审阅 must-fix）；
 *  POST → 新建（admin 或本部门）。
 */
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    if (sp.get("scope") === "summary") {
      const summaryUser = await guardRead();
      return NextResponse.json(maskSensitive(await getGoalsBlock(summaryUser), summaryUser.roles));
    }
    const user = await guardRead();
    const period = sp.get("period") || undefined;
    const list = await listGoals({ period, deptKey: sp.get("deptKey") || undefined }, user);
    // 金额型指标的实际值已在 service 按角色扣住（S1）；maskSensitive 是 R9 唯一收口的兜底，
    // 防止以后往 GoalRow 上挂 SENSITIVE_FIELDS 里的键时漏掉这条出口。
    return NextResponse.json(maskSensitive({
      ...list,
      autoMetrics: AUTO_METRIC_SOURCES.map((s) => ({ metricKey: s.metricKey, label: s.label, defaultDirection: s.defaultDirection })),
    }, user.roles));
  } catch (error) {
    return errorResponse(error, { path: "/api/goals", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(maskSensitive(await createGoal(await readJson(req), user), user.roles), { status: 201 });
  } catch (error) {
    return errorResponse(error, { path: "/api/goals", method: "POST" });
  }
}
