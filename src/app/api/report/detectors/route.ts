import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getDetectorAlerts, type DetectorKind } from "@/server/modules/report/detectors";

const KINDS = ["sales_stop", "channel_shift", "velocity"] as const;

/** E5-10 异动侦测（只读）：销量骤停 / 渠道结构迁移 / 速度突变三规则命中清单 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const raw = searchParams.get("kind");
    const kind = KINDS.includes(raw as DetectorKind) ? (raw as DetectorKind) : undefined;
    return NextResponse.json(await getDetectorAlerts({ q, kind, page, pageSize }));
  } catch (e) {
    return errorResponse(e);
  }
}
