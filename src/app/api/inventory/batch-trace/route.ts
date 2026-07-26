import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { traceBatch } from "@/server/modules/inventory/batch-trace";

/** E4-01 批次追溯（只读）：?sku=编码&batch=批次号 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    return NextResponse.json(await traceBatch(sp.get("sku") ?? "", sp.get("batch") ?? ""));
  } catch (e) {
    return errorResponse(e);
  }
}
