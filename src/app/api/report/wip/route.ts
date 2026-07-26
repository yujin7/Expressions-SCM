import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { listWip } from "@/server/modules/report/wip";

/** 委外在制看板（无金额列——全角色可读） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const searchParams = new URL(req.url).searchParams;
    return NextResponse.json(
      await listWip({
        supplierId: Number(searchParams.get("supplierId")) || undefined,
        overdueOnly: searchParams.get("overdueOnly") === "1",
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
