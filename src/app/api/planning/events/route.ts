import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { createPlanEvent, listPlanEvents, PLAN_EVENT_KIND_LABELS } from "@/server/modules/planning/plan-events";

/** 运营计划事件（只作上下文展示，不驱动建议量）：GET 列表（受限用户按渠道范围裁剪） */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const num = (k: string): number | undefined => {
      const v = Number(searchParams.get(k));
      return Number.isInteger(v) && v > 0 ? v : undefined;
    };
    const data = await listPlanEvents(user as { roles: string[]; channelScope?: number[] | null }, {
      q,
      skuId: num("skuId"),
      spuId: num("spuId"),
      channelId: num("channelId") ?? null,
      kind: searchParams.get("kind") ?? undefined,
      openOnly: searchParams.get("openOnly") !== "0",
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      page,
      pageSize,
    });
    return NextResponse.json({ ...data, kindLabels: PLAN_EVENT_KIND_LABELS });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST 新建（ops/pmc；admin 兜底；同事务审计） */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(await createPlanEvent(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
