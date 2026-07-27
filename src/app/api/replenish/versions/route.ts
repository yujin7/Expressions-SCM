import { NextRequest, NextResponse } from "next/server";

import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  capturePlanningVersion,
  listPlanningVersions,
} from "@/server/modules/replenish/plan-versions";

export async function GET() {
  try {
    return NextResponse.json(await listPlanningVersions(await guardRead()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(
      await capturePlanningVersion(user, await readJson(req)),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
