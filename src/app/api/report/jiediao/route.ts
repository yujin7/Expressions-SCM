import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getJiediaoReport } from "@/server/modules/report/jiediao";

/** R16 借调对账（月度）；?month=YYYY-MM，缺省=当月（Asia/Shanghai） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { searchParams } = new URL(req.url);
    const month =
      searchParams.get("month") ??
      new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
        .format(new Date())
        .slice(0, 7);
    return NextResponse.json(await getJiediaoReport(month));
  } catch (e) {
    return errorResponse(e);
  }
}
