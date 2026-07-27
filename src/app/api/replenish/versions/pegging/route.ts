import { NextRequest, NextResponse } from "next/server";

import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getPlanningPegging } from "@/server/modules/replenish/plan-versions";

function positiveInt(value: string | null): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

export async function GET(req: NextRequest) {
  try {
    const versionId = positiveInt(req.nextUrl.searchParams.get("versionId")) ?? Number.NaN;
    const skuId = positiveInt(req.nextUrl.searchParams.get("skuId"));
    const sourceType = req.nextUrl.searchParams.get("sourceType")?.trim() || undefined;
    const sourceRef = req.nextUrl.searchParams.get("sourceRef")?.trim() || undefined;
    return NextResponse.json(await getPlanningPegging(await guardRead(), {
      versionId,
      skuId,
      sourceType,
      sourceRef,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
