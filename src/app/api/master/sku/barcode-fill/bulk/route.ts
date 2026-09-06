import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardPlatformIdentityWriter } from "@/server/modules/master/platform-identity-access";
import { fillSkuBarcodesBulk } from "@/server/modules/master/sku-barcode-fill";

/**
 * 批量补齐 SKU 条码（写路径，人工确认后）。
 * 候选来自身份缺口读模型的 barcodeFillHits（财务货品档案 + 聚水潭商品资料镜像，两来源一致、系统空白、未被占用）。
 * 只写空白字段；每行独立事务与审计，单行冲突不拖累其它行。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardPlatformIdentityWriter();
    const result = await fillSkuBarcodesBulk(user, await readJson(req));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/barcode-fill/bulk", method: "POST" });
  }
}
