// BOM 放行（§4.3）：歧义块必须携带 resolutions 人工裁决；候选一律 draft，生效走批审
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRelease, releaseBoms } from "@/server/modules/release/engine";
import { releaseBomsBody } from "@/server/modules/release/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await guardRelease();
    const body = releaseBomsBody.parse(await readJson(req));
    return NextResponse.json(await releaseBoms(user, body));
  } catch (e) {
    return errorResponse(e);
  }
}
