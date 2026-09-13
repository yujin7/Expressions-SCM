import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardWarehouseWrite, listStockDocs } from "@/server/modules/inventory/stock-doc";
import { createStockRequest } from "@/server/modules/inventory/stock-create-request";
import { parseSelectedValues } from "@/server/core/selected-options";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await listStockDocs(q, {
        status: searchParams.get("status") ?? undefined,
        subtype: searchParams.get("subtype") ?? undefined,
        page,
        pageSize,
        selectedValues: parseSelectedValues(searchParams),
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWarehouseWrite();
    return NextResponse.json(await createStockRequest(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
