import { NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getAutoReplenishCandidates } from "@/server/modules/report/auto-replenish";

/** 自动补货候选（守护式，只读）：A/B×X/Y·非覆盖缺口·有生产周期的告急 SKU 列为可自动候选，其余转人工 */
export async function GET() {
  try {
    await guardRead();
    return NextResponse.json(await getAutoReplenishCandidates());
  } catch (e) {
    return errorResponse(e);
  }
}
