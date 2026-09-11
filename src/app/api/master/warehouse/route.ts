import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { createWarehouse, listWarehouses, WAREHOUSE_SORT_KEYS } from "@/server/modules/master/warehouse";
import { parseSelectedValues } from "@/server/core/selected-options";
import { parseMasterListQuery } from "@/server/modules/master/list-query";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const query = parseMasterListQuery(req.url, WAREHOUSE_SORT_KEYS);
    return NextResponse.json(await listWarehouses(query.q, query.page, query.pageSize, parseSelectedValues(query.searchParams), query));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("warehouse");
    // 审计已随写入落在同一事务内（master/warehouse.ts）
    const result = await createWarehouse(await readJson(req), user);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
