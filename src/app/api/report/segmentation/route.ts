import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getSegmentation } from "@/server/modules/report/segmentation";

/** ABC/XYZ 库存分层（只读；近6月销量单源，销售贡献×需求波动 3×3 矩阵） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const cell = searchParams.get("cell") ?? undefined;
    const data = await getSegmentation({ q, cell, page, pageSize });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
