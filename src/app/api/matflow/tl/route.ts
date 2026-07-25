import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createTl, listTls } from "@/server/modules/matflow/tl";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const jgId = Number(searchParams.get("jgId")) || undefined;
    return NextResponse.json(
      await listTls(q, { status: searchParams.get("status") ?? undefined, jgId, page, pageSize }),
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
