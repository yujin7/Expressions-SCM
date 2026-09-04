import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { clearExceptionSnooze, snoozeException } from "@/server/modules/workbench/exception-dismissals";

/**
 * 控制塔例外「打盹 / 取消打盹」（路线图 W9）——写路径：回查会话（guardFreshWrite）+ 角色校验，
 * service 内同事务写 audit_logs。打盹是**全局**的（控制塔全员同一块板），所以不是个人偏好，
 * 只有计划/采购/运营/仓管（及 admin）能按下去。
 *
 * POST body { exceptionKey, until: "YYYY-MM-DD", note }  → 打盹到 until（含当日）
 * DELETE ?key=<exceptionKey>                              → 提前恢复显示
 * 只影响展示：不改任何告警状态、不动待办、不参与记账，**也不会静音推送**——
 * 定时推送（jobs/notify.runExceptionNotify）拿的是未过滤清单（红队审计 A6）。
 */
const SNOOZE_ROLES = ["pmc", "purchasing", "ops", "warehouse"] as const;

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...SNOOZE_ROLES);
    const body = await readJson<{ exceptionKey?: unknown; until?: unknown; note?: unknown }>(req);
    const db = await getDbAsync();
    const result = await snoozeException(user, {
      exceptionKey: typeof body?.exceptionKey === "string" ? body.exceptionKey : "",
      until: typeof body?.until === "string" ? body.until : "",
      note: typeof body?.note === "string" ? body.note : "",
    }, db);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e, { path: "/api/workbench/exceptions/snooze", method: "POST" });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...SNOOZE_ROLES);
    const key = new URL(req.url).searchParams.get("key") ?? "";
    const db = await getDbAsync();
    return NextResponse.json(await clearExceptionSnooze(user, key, db));
  } catch (e) {
    return errorResponse(e, { path: "/api/workbench/exceptions/snooze", method: "DELETE" });
  }
}
