import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listImportJobs } from "@/server/modules/import-review/service";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listImportJobs(page, pageSize));
  } catch (e) {
    return errorResponse(e);
  }
}
