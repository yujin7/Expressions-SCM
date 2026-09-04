import { NextRequest, NextResponse } from "next/server";
import { createChannel, listChannels } from "@/server/modules/master/channel";
import { errorResponse, guardRead, guardWrite, parseListQuery, readJson } from "@/server/modules/master/common";

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

/**
 * 新建渠道（审计 #11）：此前唯一写入者是 seed，业务新开店/部门只能改 seed 重播。
 * 审计随写入落在同一事务内（master/channel.ts），此处不补记。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("channel");
    return NextResponse.json(await createChannel(await readJson(req), user), { status: 201 });
  } catch (error) {
    return errorResponse(error, { path: "/api/master/channel", method: "POST" });
  }
}
