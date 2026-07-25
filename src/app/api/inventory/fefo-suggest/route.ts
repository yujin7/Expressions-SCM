import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { suggestFefoAllocation } from "@/server/modules/inventory/fefo";

/**
 * E2-12 FEFO 出库批次建议：GET ?skuId=&warehouseId=&qty=[&today=]
 * **只读**——给建议，不过账、不写库。由人确认后填进出库单行。
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const skuId = Number(sp.get("skuId"));
    const warehouseId = Number(sp.get("warehouseId"));
    const qty = (sp.get("qty") ?? "").trim();
    if (!Number.isInteger(skuId) || skuId <= 0) {
      return NextResponse.json({ error: "缺少或非法的 skuId" }, { status: 400 });
    }
    if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
      return NextResponse.json({ error: "缺少或非法的 warehouseId" }, { status: 400 });
    }
    if (!/^-?\d+(\.\d+)?$/.test(qty)) {
      return NextResponse.json({ error: "缺少或非法的 qty" }, { status: 400 });
    }
    const today = sp.get("today")?.trim() || undefined;
    const db = await getDbAsync();
    return NextResponse.json(await suggestFefoAllocation(db, { skuId, warehouseId, qty, today }));
  } catch (e) {
    return errorResponse(e, { path: "/api/inventory/fefo-suggest", method: "GET" });
  }
}
