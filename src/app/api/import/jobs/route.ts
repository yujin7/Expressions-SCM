import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { listImportJobs } from "@/server/modules/import-review/service";
import { guardFreshWrite } from "@/server/modules/outsource/common";

export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const { page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listImportJobs(user, page, pageSize));
  } catch (e) {
    return errorResponse(e);
  }
}
