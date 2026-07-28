import { NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  parseListQuery,
  readJson,
} from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  createQualityCase,
  listQualityCases,
} from "@/server/modules/quality/service";

export async function GET(req: NextRequest) {
  try {
    // 案件列表可能包含受限不良事件证据；读取也必须回查当前账号状态和角色，
    // 不能依赖最长 8 小时的旧 JWT 角色。
    const user = await guardFreshWrite();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(await listQualityCases(user, {
      q,
      page,
      pageSize,
      kind: searchParams.get("kind") ?? undefined,
      status: searchParams.get("status") ?? undefined,
    }));
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/cases", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const created = await createQualityCase(user, await readJson(req));
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/cases", method: "POST" });
  }
}
