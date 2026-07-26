import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getPriceCompare } from "@/server/modules/report/price-compare";

/**
 * E5-08 物料比价：同一物料多供应商基准价横向对比（只读，不开单）。
 * 脱敏：价格为敏感字段，guardRead 拦截未登录；若后续引入更细的价格权限，
 * 需在 server/modules/report/price-compare.ts 接入 maskSensitive（见该文件头注释）。
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    const data = await getPriceCompare({ q, page, pageSize });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
