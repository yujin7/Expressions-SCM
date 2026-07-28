import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { createBom, listBoms } from "@/server/modules/master/bom";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(await listBoms(q, page, pageSize, searchParams.get("status") ?? undefined));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("bom");
    const result = await createBom(await readJson(req), user);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
