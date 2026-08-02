import { NextRequest, NextResponse } from "next/server";
import { listChannels } from "@/server/modules/master/channel";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";

/** SKU 专属渠道选择器的受保护主数据读取面。 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listChannels(q, page, pageSize));
  } catch (error) {
    return errorResponse(error, { path: "/api/master/channel", method: "GET" });
  }
}
