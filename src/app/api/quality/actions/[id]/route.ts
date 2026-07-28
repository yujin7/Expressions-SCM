import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { transitionQualityAction } from "@/server/modules/quality/service";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await guardFreshWrite();
    const { id } = await params;
    return NextResponse.json(
      await transitionQualityAction(user, parseId(id), await readJson(req)),
    );
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/actions/[id]", method: "PATCH" });
  }
}
