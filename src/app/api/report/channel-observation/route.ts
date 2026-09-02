import { NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { loadChannelObservation } from "@/server/modules/report/channel-observation";
import { getDbAsync } from "@/db";

/** 全渠道外部观察（天猫 / 拼多多 / 唯品会 近 30 天 + 天猫宝贝损益）——只读观察口径 */
export async function GET() {
  try {
    await guardRead();
    const db = await getDbAsync();
    const response = NextResponse.json(await loadChannelObservation(db));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/channel-observation", method: "GET" });
  }
}
