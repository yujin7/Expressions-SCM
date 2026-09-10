import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { guardWarehouseWrite } from "@/server/modules/inventory/stock-doc";
import { canCreateCountTask, createCountTask, listCountTasks } from "@/server/modules/inventory/count";

export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const warehouseId = Number(searchParams.get("warehouseId")) || undefined;
    return NextResponse.json({
      ...await listCountTasks(q, {
        status: searchParams.get("status") ?? undefined,
        mode: searchParams.get("mode") ?? undefined,
        warehouseId,
        // 盘点期 YYYY-MM：0727 行动项要按「7 月底盘点」这类期间取数
        period: searchParams.get("period") ?? undefined,
        page,
        pageSize,
      }),
      canCreate: canCreateCountTask(user),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWarehouseWrite();
    return NextResponse.json(await createCountTask(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
