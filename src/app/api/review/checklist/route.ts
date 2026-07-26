import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { bulkDecideReviewItems, guardReviewWrite, listReviewItems } from "@/server/modules/review/checklist";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await listReviewItems({
        q,
        page,
        pageSize,
        category: searchParams.get("category") ?? undefined,
        status: searchParams.get("status") ?? undefined,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

/** 批量改判：{ids, status, note?} */
export async function PATCH(req: NextRequest) {
  try {
    const user = await guardReviewWrite();
    return NextResponse.json(await bulkDecideReviewItems(user, await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
