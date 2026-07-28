import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { transitionQualityCase } from "@/server/modules/quality/service";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await guardFreshWrite();
    const { id } = await params;
    return NextResponse.json(
      await transitionQualityCase(user, parseId(id), await readJson(req)),
    );
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/cases/[id]", method: "PATCH" });
  }
}
