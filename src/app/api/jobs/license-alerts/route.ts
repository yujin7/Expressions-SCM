import { NextResponse } from "next/server";
import { errorResponse, guardRead, todayShanghai } from "@/server/modules/master/common";
import { getDbAsync } from "@/db";
import { runLicenseAlert } from "@/jobs/license-alert";

/** GET /api/jobs/license-alerts → 30 天内到期/已过期的供应商资质提醒（实时计算，无落库） */
export async function GET() {
  try {
    await guardRead();
    return NextResponse.json(await runLicenseAlert(await getDbAsync(), todayShanghai()));
  } catch (e) {
    return errorResponse(e);
  }
}
