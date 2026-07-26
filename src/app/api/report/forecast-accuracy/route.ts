import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getForecastAccuracy } from "@/server/modules/report/forecast-accuracy";

/** E7-05 预测复盘（只读；滚动回测线上 Holt 算法） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await getForecastAccuracy({ q, page, pageSize, onlyReliable: searchParams.get("onlyReliable") === "1" }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
