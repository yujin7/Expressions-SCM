import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { createSupplier, listSuppliers, SUPPLIER_SORT_KEYS } from "@/server/modules/master/supplier";
import { parseSelectedValues } from "@/server/core/selected-options";
import { parseMasterListQuery } from "@/server/modules/master/list-query";
import { supplierStatusEnum } from "@/db/schema";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const query = parseMasterListQuery(req.url, SUPPLIER_SORT_KEYS, supplierStatusEnum.enumValues);
    return NextResponse.json(await listSuppliers(query.q, query.page, query.pageSize, parseSelectedValues(query.searchParams), query));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("supplier");
    // 审计已随写入落在同一事务内（master/supplier.ts）
    const result = await createSupplier(await readJson(req), user);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
