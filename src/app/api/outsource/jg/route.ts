import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listJgs } from "@/server/modules/outsource/jg";

// JG 仅由 WO generateDocs 派生，无手工创建入口
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const woId = Number(searchParams.get("woId")) || undefined;
    return NextResponse.json(
      await listJgs(q, { status: searchParams.get("status") ?? undefined, woId, page, pageSize }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
