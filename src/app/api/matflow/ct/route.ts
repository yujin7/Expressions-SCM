import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
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
    // Older client schemas strip recovery fields they do not know; refuse before lineage can be lost.
    if (req.headers.get("x-scm-ct-create-contract") !== "2") throw new ApiError(400, "采购退货建单页面版本已更新，请刷新页面后核对原请求再保存；尚未创建单据");
    return NextResponse.json(await createCtRequest(user, await readJson(req)), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
