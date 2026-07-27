import { NextRequest, NextResponse } from "next/server";

import { ApiError, errorResponse, guardRead } from "@/server/modules/master/common";
import { comparePlanningVersions } from "@/server/modules/replenish/plan-versions";

function positiveId(value: string | null, name: string, required: boolean): number | undefined {
  if (value == null || value === "") {
    if (required) throw new ApiError(400, `缺少 ${name}`);
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ApiError(400, `${name} 必须为正整数`);
  return parsed;
}

export async function GET(req: NextRequest) {
  try {
    const params = new URL(req.url).searchParams;
    const currentId = positiveId(params.get("currentId"), "currentId", true);
    const baseId = positiveId(params.get("baseId"), "baseId", false);
    return NextResponse.json(
      await comparePlanningVersions(await guardRead(), currentId!, baseId),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
