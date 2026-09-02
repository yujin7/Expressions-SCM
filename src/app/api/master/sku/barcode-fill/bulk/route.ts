import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, readJson } from "@/server/modules/master/common";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { fillSkuBarcodesBulk } from "@/server/modules/master/sku-barcode-fill";

/**
 * 批量补齐 SKU 条码（写路径，人工确认后）。
 * 候选来自身份缺口读模型的 barcodeFillHits（财务货品档案 + 聚水潭商品资料镜像，两来源一致、系统空白、未被占用）。
 * 只写空白字段；每行独立事务与审计，单行冲突不拖累其它行。
 */
export async function POST(req: NextRequest) {
  try {
    let user;
    try {
      user = await getFreshSessionUser();
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    try {
      requireRole(user, "pmc", "purchasing", "warehouse");
    } catch {
      throw new ApiError(403, "无权限补齐条码");
    }
    const result = await fillSkuBarcodesBulk(user, await readJson(req));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/barcode-fill/bulk", method: "POST" });
  }
}
