import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getFulfillmentFunnel } from "@/server/modules/report/funnel";

/** E7-06 全链达成漏斗（只读）：需求→计划→下单→到货→动销 五级量级与级间转化率 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const searchParams = new URL(req.url).searchParams;
    const raw = Number(searchParams.get("months"));
    const months = Number.isFinite(raw) && raw > 0 ? raw : undefined;
    return NextResponse.json(await getFulfillmentFunnel({ months }));
  } catch (e) {
    return errorResponse(e);
  }
}
