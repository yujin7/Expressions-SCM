import { NextRequest, NextResponse } from "next/server";

import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  listProjectionScenarios,
  saveProjectionScenario,
} from "@/server/modules/replenish/scenarios";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sku = new URL(req.url).searchParams.get("sku");
    if (!sku) return NextResponse.json({ error: "缺少 sku 参数" }, { status: 400 });
    return NextResponse.json(await listProjectionScenarios(/^\d+$/.test(sku) ? Number(sku) : sku));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    return NextResponse.json(
      await saveProjectionScenario(await guardFreshWrite(), await readJson(req)),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
