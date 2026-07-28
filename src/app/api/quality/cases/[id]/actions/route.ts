import { NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  parseId,
  readJson,
} from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  createQualityAction,
  listQualityActions,
} from "@/server/modules/quality/service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // 完成/验证证据属于受限资料；每次读取按数据库中的新鲜角色裁剪。
    const user = await guardFreshWrite();
    const { id } = await params;
    return NextResponse.json(await listQualityActions(user, parseId(id)));
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/cases/[id]/actions", method: "GET" });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await guardFreshWrite();
    const { id } = await params;
    const created = await createQualityAction(user, parseId(id), await readJson(req));
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/cases/[id]/actions", method: "POST" });
  }
}
