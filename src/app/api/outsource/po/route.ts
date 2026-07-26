import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listPos } from "@/server/modules/outsource/po";

// PO 本波仅由 WO generateDocs 派生（独立采购创建入口在后续波次），故无 POST
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const woId = Number(searchParams.get("woId")) || undefined;
    return NextResponse.json(
      await listPos(q, { status: searchParams.get("status") ?? undefined, woId, page, pageSize }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
