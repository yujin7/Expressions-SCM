import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { ackAlert } from "@/server/modules/alerts/engine";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/** 告警「已知悉」（D56）：写路径，回查会话 + 审计；status 不变，事实闭环仍由看门狗判定。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const body = (await readJson(req).catch(() => ({}))) as { note?: string };
    const db = await getDbAsync();
    const result = await ackAlert(user, Number(id), db, typeof body?.note === "string" ? body.note.slice(0, 200) : undefined);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e, { path: "/api/alerts/[id]/ack", method: "POST" });
  }
}
