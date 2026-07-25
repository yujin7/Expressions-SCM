import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
import { createSupplier, listSuppliers } from "@/server/modules/master/supplier";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listSuppliers(q, page, pageSize));
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
