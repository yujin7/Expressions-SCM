import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardWrite, readJson } from "@/server/modules/master/common";
import { setSkuCommercialRoles } from "@/server/modules/master/sku";
import type { CommercialRole } from "@/server/rules/sku-standardization";

/**
 * 批量设置 SKU 业务用途（样品/赠品/试用/内用/正常销售）。
 * 审计随写入落在同一事务内（master/sku.ts），此处不补记——
 * 路由层补记走的是新连接且在服务提交之后，进程挂在中间就会「有数据无审计」。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("sku");
    const body = await readJson(req) as { ids?: unknown; role?: unknown };
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : [];
    const role = String(body?.role ?? "") as CommercialRole;
    return NextResponse.json(await setSkuCommercialRoles(ids, role, user));
  } catch (e) {
    return errorResponse(e);
  }
}
