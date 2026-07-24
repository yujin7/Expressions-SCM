import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getSkuProjection } from "@/server/modules/replenish/projection";

/** #1 库存未来曲线（只读；?sku=编码或id，?horizon=天） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const sku = sp.get("sku");
    if (!sku) throw new Error("缺少 sku 参数");
    const horizon = Math.min(365, Math.max(14, Number(sp.get("horizon") ?? 120) || 120));
    const idNum = /^\d+$/.test(sku) ? Number(sku) : sku;
    return NextResponse.json(await getSkuProjection(idNum, horizon));
  } catch (e) {
    return errorResponse(e);
  }
}
