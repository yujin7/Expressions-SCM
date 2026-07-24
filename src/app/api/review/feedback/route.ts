import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { createFeedback } from "@/server/modules/review/checklist";

/** UAT 反馈直录（任何登录用户；入复核清单 uat_feedback 类） */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(await createFeedback(user, await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
