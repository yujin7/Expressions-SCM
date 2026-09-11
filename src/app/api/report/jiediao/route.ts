import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getJiediaoReport } from "@/server/modules/report/jiediao";
import { shanghaiMonthOf } from "@/server/core/business-day";

/** R16 借调对账（月度）；?month=YYYY-MM，缺省=当月（Asia/Shanghai） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { searchParams } = new URL(req.url);
    const month =
      searchParams.get("month") ??
      shanghaiMonthOf(new Date());
    return NextResponse.json(await getJiediaoReport(month));
  } catch (e) {
    return errorResponse(e);
  }
}
