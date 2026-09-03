import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { closeAlert } from "@/server/modules/alerts/engine";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/**
 * 人工关闭告警（闭环审计 #2）：写路径，回查会话；角色 = 告警 ownerRole 或 admin（service 内校验）。
 * body { reasonCode: fixed|false_positive|wont_fix|superseded|manual, note? }；
 * 同事务写审计 + alert_events(close)。status→resolved、autoResolved=false。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const body = await readJson<{ reasonCode?: unknown; note?: unknown }>(req);
    const db = await getDbAsync();
    const result = await closeAlert(
      user,
      Number(id),
      typeof body?.reasonCode === "string" ? body.reasonCode : "",
      typeof body?.note === "string" ? body.note : null,
      db,
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e, { path: "/api/alerts/[id]/close", method: "POST" });
  }
}
