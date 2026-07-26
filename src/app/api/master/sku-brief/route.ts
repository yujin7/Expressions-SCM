import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getSkuBrief } from "@/server/modules/master/sku-brief";

/** E6-P3 迷你 360 速览：GET ?sku=编码或id（只读、高频，hover 触发） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sku = (new URL(req.url).searchParams.get("sku") ?? "").trim();
    if (!sku) return NextResponse.json({ error: "缺少 sku 参数" }, { status: 400 });
    return NextResponse.json(await getSkuBrief(sku));
  } catch (e) {
    return errorResponse(e, { path: "/api/master/sku-brief", method: "GET" });
  }
}
