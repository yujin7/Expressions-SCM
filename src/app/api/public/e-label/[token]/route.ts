import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { getPublicElectronicLabel } from "@/server/modules/quality/service";

/** Public electronic-label read model. The service returns an explicit allow-listed DTO. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    const response = NextResponse.json(await getPublicElectronicLabel(token));
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch (e) {
    return errorResponse(e, { path: "/api/public/e-label/[token]", method: "GET" });
  }
}
