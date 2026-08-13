import { NextRequest, NextResponse } from "next/server";

import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { recordDataProductOutcome } from "@/server/modules/report/data-product-outcome";

export async function POST(request: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(await recordDataProductOutcome(user, await readJson(request)), { status: 201 });
  } catch (error) {
    return errorResponse(error, { path: "/api/report/data-product-outcomes", method: "POST" });
  }
}
