import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, parseListQuery, readJson } from "@/server/modules/master/common";
import { canCreateMaterialDoc } from "@/server/modules/matflow/task-actions";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createTl, listTls } from "@/server/modules/matflow/tl";

export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const jgId = searchParams.has("jgId") ? parseId(searchParams.get("jgId") ?? "") : undefined;
    return NextResponse.json(
      { ...await listTls(q, { status: searchParams.get("status") ?? undefined, jgId, page, pageSize }),
        actions: { create: canCreateMaterialDoc(user) } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await createTl(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
