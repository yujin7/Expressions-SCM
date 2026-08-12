import { NextRequest, NextResponse } from "next/server";

import { errorResponse, guardRead } from "@/server/modules/master/common";
import {
  getDecisionStudio,
  type StudioDimension,
} from "@/server/modules/report/decision-studio";

export async function GET(request: NextRequest) {
  try {
    const user = await guardRead();
    const dimension = request.nextUrl.searchParams.get("dimension") as StudioDimension | null;
    const key = request.nextUrl.searchParams.get("key")?.trim() || undefined;
    // 跨维筛选与分组维度正交：可同时按品牌+渠道收窄，再按任意维度分组
    // （0727 会议要的「NING × 天猫」此前做不到——品牌与渠道是互斥单选）
    const brand = request.nextUrl.searchParams.get("brand")?.trim() || undefined;
    const channel = request.nextUrl.searchParams.get("channel")?.trim() || undefined;
    return NextResponse.json(await getDecisionStudio({
      dimension: dimension ?? undefined,
      key,
      scope: { brand, channel },
    }, undefined, user));
  } catch (error) {
    return errorResponse(error);
  }
}
