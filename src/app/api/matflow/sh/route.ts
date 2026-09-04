import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createSh } from "@/server/modules/matflow/sh";
import { listShs } from "@/server/modules/matflow/sh-read";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const sourceId = Number(searchParams.get("sourceId")) || undefined;
    return NextResponse.json(
      await listShs(q, {
        status: searchParams.get("status") ?? undefined,
        sourceType: searchParams.get("sourceType") ?? undefined,
        sourceId,
        // 制单时间窗（全链漏斗回链）
        from: searchParams.get("from") ?? undefined,
        to: searchParams.get("to") ?? undefined,
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
    const user = await guardFreshWrite(); // 仓管角色校验在 service 内；jg 源含累计校验
    return NextResponse.json(await createSh(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
