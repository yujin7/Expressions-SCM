import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { listCts } from "@/server/modules/matflow/ct";
import { createCtRequest } from "@/server/modules/matflow/ct-create-request";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const poId = Number(searchParams.get("poId")) || undefined;
    return NextResponse.json(
      await listCts(q, { status: searchParams.get("status") ?? undefined, poId, page, pageSize }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 仓管角色校验在 service 内；退货量≤已收数校验含
    return NextResponse.json(await createCtRequest(user, await readJson(req)), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
