import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { getPublicElectronicLabel } from "@/server/modules/quality/service";

function protectTokenResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

/** Public electronic-label read model. The service returns an explicit allow-listed DTO. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    const response = NextResponse.json(await getPublicElectronicLabel(token));
    return protectTokenResponse(response);
  } catch (e) {
    return protectTokenResponse(errorResponse(e, { path: "/api/public/e-label/[token]", method: "GET" }));
  }
}
