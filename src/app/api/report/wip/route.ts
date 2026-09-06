import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { listWip } from "@/server/modules/report/wip";
import { optionalIntegerQuery } from "@/server/core/query-number";

/** 委外在制看板（无金额列——全角色可读） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const searchParams = new URL(req.url).searchParams;
    const supplierId = optionalIntegerQuery(searchParams, "supplierId", { label: "供应商 ID" });
    return NextResponse.json(
      await listWip({
        supplierId,
        overdueOnly: searchParams.get("overdueOnly") === "1",
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
