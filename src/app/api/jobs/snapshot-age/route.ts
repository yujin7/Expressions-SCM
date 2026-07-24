import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, todayShanghai } from "@/server/modules/master/common";
import { getDbAsync } from "@/db";
import { runSnapshotAgeAlert } from "@/jobs/snapshot-age";

/** GET /api/jobs/snapshot-age?threshold=3 → 快照仓数据龄告警（实时计算，无落库；与 license-alerts 同形态） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const raw = new URL(req.url).searchParams.get("threshold");
    const threshold = raw != null && /^\d+$/.test(raw) ? Number(raw) : undefined;
    return NextResponse.json(
      await runSnapshotAgeAlert(await getDbAsync(), { today: todayShanghai(), thresholdDays: threshold }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
