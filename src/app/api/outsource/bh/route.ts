import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { listBhs } from "@/server/modules/outsource/bh";
import { createBhRequest } from "@/server/modules/outsource/bh-create-request";
import { parseSelectedValues } from "@/server/core/selected-options";

export async function GET(req: NextRequest) {
  try {
    // D62：受限 ops 只见本人制单或本渠道制单人的单据（service 内按 user.channelScope 裁剪）
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await listBhs(q, {
        status: searchParams.get("status") ?? undefined,
        // 制单时间窗（全链漏斗回链）
        from: searchParams.get("from") ?? undefined,
        to: searchParams.get("to") ?? undefined,
        page,
        pageSize,
        selectedValues: parseSelectedValues(searchParams),
      }, undefined, user),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 角色（ops）在 service 内校验
    return NextResponse.json(await createBhRequest(user, await readJson(req), "manual"), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
