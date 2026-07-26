import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getDataHealth } from "@/server/modules/report/data-health";

/** 主数据健康度仪表（只读；逐 SKU 主数据完整度评分 + 缺失清单） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const missing = searchParams.get("missing") ?? undefined;
    const data = await getDataHealth({ q, missing, page, pageSize });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
