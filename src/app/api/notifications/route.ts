import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { notifications } from "@/db/schema";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { notifyAudienceWhere, notifyVisibleWhere } from "@/server/core/notify-audience";
import { alertIdOfNotification } from "@/lib/notify-links";

/**
 * #8/func#12 站内通知：按收件人过滤（本人/广播 且 角色匹配）；支持标记已读。
 *
 * W2 平台化：此前本路由**恒取最近 100 条、无任何筛选、不返回总数**——
 * 页面于是只能是一条平铺的流水，通知一多就再也翻不到昨天那条告警。
 * 现与其它列表页同口径：severity / read 筛选 + page/pageSize 分页 + total，
 * 收件人判定仍收口在 core/notify-audience（工作台徽标与本页必须同源）。
 *
 * 同时下发 `alertId`：系统告警推送的 dedupeKey 是 `system_alert:<id>[:<role>]`，
 * 而通知的 href 指向的是**处置页**（actionHref），不是告警本身——
 * 于是「这条通知说的是哪条告警、现在关了没有」在站内无从跳转。
 * 解析走 lib/notify-links 唯一权威（与 jobs/system-alert-notify 的 dedupeKey 规则同源；
 * 放 lib 是因为通知中心是客户端组件，禁止值导入 @/server/*）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const db = await getDbAsync();
    const { page, pageSize: rawPageSize, searchParams } = parseListQuery(req.url);
    const pageSize = Math.min(200, searchParams.get("pageSize") ? rawPageSize : 50);
    const severity = searchParams.get("severity")?.trim() || "";
    const read = searchParams.get("read")?.trim() || ""; // ""=全部 | unread | read

    const where: (SQL | undefined)[] = [notifyVisibleWhere(user)];
    if (severity) where.push(eq(notifications.severity, severity));
    if (read === "unread") where.push(isNull(notifications.readAt));
    if (read === "read") where.push(isNotNull(notifications.readAt));
    const cond = and(...where);

    /* 未读数与工作台「未读通知」徽标**同源同口径**：都是 isNull(readAt) + notifyVisibleWhere。
       此前本路由只数 pending/sent/skipped（漏 failed），徽标数全部可见状态——
       同一个人看到两个不同的未读数，正是「学会无视徽标」的成因。 */
    const unreadCond = and(isNull(notifications.readAt), notifyVisibleWhere(user));

    const [[{ total }], rows, [{ unread }]] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(notifications).where(cond),
      db
        .select()
        .from(notifications)
        .where(cond)
        .orderBy(desc(notifications.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(unreadCond),
    ]);

    return NextResponse.json({
      rows: rows.map((r) => ({ ...r, alertId: alertIdOfNotification(r.dedupeKey) })),
      total: Number(total ?? 0),
      page,
      pageSize,
      unread: unread ?? 0,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 标记已读：{ id } 单条，或 { all: true } 全部本人可见 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const db = await getDbAsync();
    const body = (await readJson(req)) as { id?: number; all?: boolean };
    const now = new Date();
    // 收件人判定收口到 core/notify-audience（工作台徽标与本页必须同源）
    const audience = notifyAudienceWhere(user);
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
