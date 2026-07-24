import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { notifications } from "@/db/schema";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/** #8/func#12 站内通知：按收件人过滤（本人/广播 且 角色匹配）；支持标记已读 */
export async function GET(_req: NextRequest) {
  try {
    const user = await guardRead();
    const db = await getDbAsync();
    const isAdmin = user.roles.includes("admin");
    const audience = isAdmin
      ? undefined
      : and(
          or(isNull(notifications.userId), eq(notifications.userId, user.id)),
          or(isNull(notifications.targetRole), inArray(notifications.targetRole, user.roles.length ? user.roles : ["__none__"])),
        );
    const rows = await db
      .select()
      .from(notifications)
      .where(audience ? and(inArray(notifications.status, ["pending", "sent", "skipped", "failed"]), audience) : inArray(notifications.status, ["pending", "sent", "skipped", "failed"]))
      .orderBy(desc(notifications.id))
      .limit(100);
    const [{ unread }] = await db
      .select({ unread: sql<number>`count(*)::int` })
      .from(notifications)
      .where(audience ? and(isNull(notifications.readAt), inArray(notifications.status, ["pending", "sent", "skipped"]), audience) : and(isNull(notifications.readAt), inArray(notifications.status, ["pending", "sent", "skipped"])));
    return NextResponse.json({ rows, unread: unread ?? 0 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 标记已读：{ id } 单条，或 { all: true } 全部本人可见 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const db = await getDbAsync();
    const body = (await req.json()) as { id?: number; all?: boolean };
    const now = new Date();
    const isAdmin = user.roles.includes("admin");
    const audience = isAdmin
      ? undefined
      : and(
          or(isNull(notifications.userId), eq(notifications.userId, user.id)),
          or(isNull(notifications.targetRole), inArray(notifications.targetRole, user.roles.length ? user.roles : ["__none__"])),
        );
    if (body.all) {
      await db.update(notifications).set({ readAt: now }).where(audience ? and(isNull(notifications.readAt), audience) : isNull(notifications.readAt));
    } else if (body.id) {
      await db.update(notifications).set({ readAt: now }).where(audience ? and(eq(notifications.id, body.id), audience) : eq(notifications.id, body.id));
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
