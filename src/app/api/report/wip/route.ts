import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { listWip } from "@/server/modules/report/wip";
import { listProcessingCycles } from "@/server/modules/report/processing-cycle";
import { wipQuery } from "@/server/modules/report/wip-query";

/** 委外在制看板（无金额列——全角色可读） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const searchParams = new URL(req.url).searchParams;
    const { supplierId, mode, overdueOnly } = wipQuery(searchParams);
    if (mode === "cycles") {
      return NextResponse.json(await listProcessingCycles({ supplierId }));
    }
    return NextResponse.json(
      await listWip({
        supplierId,
        overdueOnly,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
