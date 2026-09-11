import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead } from "@/server/modules/master/common";
import { traceBatch } from "@/server/modules/inventory/batch-trace";

/** E4-01 批次追溯（只读）：?sku=编码&batch=批次号 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const pagination = (key: string, fallback: number) => {
      const values = sp.getAll(key);
      if (!values.length) return fallback;
      if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) throw new ApiError(400, "分页参数无效，请重新选择页码或每页条数");
      return Number(values[0]);
    };
    return NextResponse.json(await traceBatch(sp.get("sku") ?? "", sp.get("batch") ?? "", undefined, { page: pagination("page", 1), pageSize: pagination("pageSize", 30) }));
  } catch (e) {
    return errorResponse(e);
  }
}
