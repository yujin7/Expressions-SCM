import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import {  guardRead, guardWrite } from "@/server/modules/master/common";
import { createSku, listSkus } from "@/server/modules/master/sku";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(await listSkus(q, page, pageSize, searchParams.get("type")));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("sku");
    // 审计已随写入落在同一事务内（master/sku.ts），此处不再补记——
    // 路由层补记用的是新连接、且在服务提交之后，进程挂在中间就会「有数据无审计」。
    const result = await createSku(await readJson(req), user);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
