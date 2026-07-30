import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listExceptions } from "@/server/modules/import-review/service";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await listExceptions({
        status: searchParams.get("status") ?? "open",
        aliasType: searchParams.get("aliasType") ?? undefined,
        scope: searchParams.get("scope") ?? undefined,
        page,
        pageSize,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
