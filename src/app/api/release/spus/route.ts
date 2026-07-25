// SPU 放行（§4.1）：auto 簇/显式 override 建档；review 簇留待人工，绝不代判
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRelease, releaseSpus } from "@/server/modules/release/engine";
import { releaseSpusBody } from "@/server/modules/release/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await guardRelease();
    const body = releaseSpusBody.parse(await readJson(req));
    return NextResponse.json(await releaseSpus(user, body));
  } catch (e) {
    return errorResponse(e);
  }
}
