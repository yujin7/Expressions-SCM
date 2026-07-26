import { NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { countReviewItems } from "@/server/modules/review/checklist";

export async function GET() {
  try {
    await guardRead();
    return NextResponse.json(await countReviewItems());
  } catch (e) {
    return errorResponse(e);
  }
}
