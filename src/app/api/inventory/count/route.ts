import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { guardWarehouseWrite } from "@/server/modules/inventory/stock-doc";
import { createCountTask, listCountTasks } from "@/server/modules/inventory/count";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const warehouseId = Number(searchParams.get("warehouseId")) || undefined;
    return NextResponse.json(
      await listCountTasks(q, {
        status: searchParams.get("status") ?? undefined,
        mode: searchParams.get("mode") ?? undefined,
        warehouseId,
        page,
        pageSize,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWarehouseWrite();
    return NextResponse.json(await createCountTask(user, await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
