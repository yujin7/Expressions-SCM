import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getInboundCalendar } from "@/server/modules/report/inbound-calendar";

/**
 * E4-03 到货日历：未结供给（core/supply）按预计到货日分桶（只读，不开单）。
 * 不透出 warehouseId 入参——三个供给源都没有收货仓维度，服务层对该参数直接报 400。
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const from = sp.get("from")?.trim() || undefined;
    const to = sp.get("to")?.trim() || undefined;
    const data = await getInboundCalendar({ from, to });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
