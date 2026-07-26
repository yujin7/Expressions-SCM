import { NextRequest, NextResponse } from "next/server";

import { errorResponse, guardRead } from "@/server/modules/master/common";
import {
  getDecisionStudio,
  type StudioDimension,
} from "@/server/modules/report/decision-studio";

export async function GET(request: NextRequest) {
  try {
    await guardRead();
    const dimension = request.nextUrl.searchParams.get("dimension") as StudioDimension | null;
    const key = request.nextUrl.searchParams.get("key")?.trim() || undefined;
    return NextResponse.json(await getDecisionStudio({
      dimension: dimension ?? undefined,
      key,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
