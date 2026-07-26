import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
import { createSpu, listSpus } from "@/server/modules/master/spu";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listSpus(q, page, pageSize));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("spu");
    const result = await createSpu(await readJson(req));
    await auditFromRoute(user, "spu", (result as { id?: number }).id, "create", result);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
