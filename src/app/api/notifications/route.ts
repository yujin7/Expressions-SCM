import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { notificationReads, notifications } from "@/db/schema";
import { ApiError, errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { getFreshSessionUser } from "@/server/core/dto";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  notifyReadWhere,
  notifyUnreadWhere,
  notifyVisibleWhere,
} from "@/server/core/notify-audience";
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
    const user = await getFreshSessionUser();
    const db = await getDbAsync();
    const { page, pageSize: rawPageSize, searchParams } = parseListQuery(req.url);
    const pageSize = Math.min(200, searchParams.get("pageSize") ? rawPageSize : 50);
    const severity = searchParams.get("severity")?.trim() || "";
    const read = searchParams.get("read")?.trim() || ""; // ""=全部 | unread | read
    if (searchParams.getAll("read").length > 1 || searchParams.getAll("severity").length > 1
      || !["", "read", "unread"].includes(read)
      || !["", "critical", "high", "medium", "info"].includes(severity)) {
      throw new ApiError(400, "通知筛选无效，请选择已读状态与严重度");
    }

    const where: (SQL | undefined)[] = [notifyVisibleWhere(user)];
    if (severity) where.push(eq(notifications.severity, severity));
    /* 已读/未读是**逐收件人**的（S6）：判定收口在 core/notify-audience，
       不再读行级 read_at——那个列只对「唯一收件人」的行有意义，
       广播行上它的含义是「某个能看见它的人读过」，据此筛选等于别人替你读了。 */
    if (read === "unread") where.push(notifyUnreadWhere(user));
    if (read === "read") where.push(notifyReadWhere(user));
    const cond = and(...where);

    /* 未读数与工作台「未读通知」徽标**同源同口径**：两处都调 notifyUnreadWhere(user)。
       此前本路由只数 pending/sent/skipped（漏 failed），徽标数全部可见状态——
       同一个人看到两个不同的未读数，正是「学会无视徽标」的成因。 */
    const unreadCond = notifyUnreadWhere(user);

    const [[{ total }], rows, [{ unread }]] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(notifications).where(cond),
      db
        .select({
          notification: notifications,
          /* readAt 下发的是**我自己**的已读时刻（没读过 = null），不是行上那个共享列 */
          myReadAt: sql<Date | null>`(select ${notificationReads.readAt} from ${notificationReads}
            where ${notificationReads.notificationId} = ${notifications.id}
              and ${notificationReads.userId} = ${user.id})`,
        })
        .from(notifications)
        .where(cond)
        .orderBy(desc(notifications.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(unreadCond),
    ]);

    return NextResponse.json({
      rows: rows.map((r) => ({
        ...r.notification,
        readAt: r.myReadAt,
        alertId: alertIdOfNotification(r.notification.dedupeKey),
      })),
      total: Number(total ?? 0),
      page,
      pageSize,
      unread: unread ?? 0,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

const markReadSchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ id: z.number().int().positive(), all: z.literal(false).optional() }).strict(),
]);

/**
 * 标记已读：{ id } 单条，或 { all: true } 全部本人可见。
 *
 * **已读写的是自己那一行**（`notification_reads`，S6）。此前写的是共享行上的
 * `notifications.read_at`：管理员的 `notifyAudienceWhere` 返回 undefined，
 * 于是 `{all:true}` 实际执行 `UPDATE notifications SET read_at = now() WHERE read_at IS NULL`
 * ——一次点击清空全公司每个人的未读队列，连定向给某人、他还没看到的那些也一并抹掉；
 * 传 `{id}` 则能把任意一个人的某条通知标成已读。非管理员同样会替所有人读掉广播行。
 * 现在每个人只写自己的一行，跨用户的影响在结构上就不存在了。
 *
 * 入参也必须校验：`{id:"abc"}` 此前会一路走到 SQL 里，把参数错误变成 500
 * （本仓反复出现的缺陷类，见 scoped-params 的同型修复）。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const db = await getDbAsync();
    const parsed = markReadSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError(400, "请求体须是 { all: true } 或 { id: 正整数 }");
    const body = parsed.data;

    /* 只在**我可见**的通知里挑；不可见的 id 不会命中任何行（不区分「不存在」与「不属于我」，
       否则这个端点会变成一个探测别人通知 id 的口子）。 */
    const scope = "all" in body && body.all
      ? notifyUnreadWhere(user)
      : and(eq(notifications.id, (body as { id: number }).id), notifyVisibleWhere(user));
    const result = await db.transaction(async tx => {
      const targets: { id: number; userId: number | null }[] = await tx
        .select({ id: notifications.id, userId: notifications.userId })
        .from(notifications)
        .where(scope)
        .orderBy(asc(notifications.id));
      if (targets.length === 0) return { ok: true, marked: 0 };

      const now = new Date();
      const inserted = await tx
        .insert(notificationReads)
        .values(targets.map((t) => ({ notificationId: t.id, userId: user.id, readAt: now })))
        .onConflictDoNothing().returning({ notificationId: notificationReads.notificationId });

      /* 兼容保留期判定：housekeeping 按「userId 非空＝唯一收件人，read_at 语义准确」分档清理。
         只有当**我就是这一行唯一的收件人**时才同步写行级 read_at——
         这个 UPDATE 的 where 里带着 user_id = 我，因此结构上碰不到别人的行。 */
      const mine = targets.filter((t) => t.userId === user.id).map((t) => t.id);
      if (mine.length > 0) {
        await tx
          .update(notifications)
          .set({ readAt: now })
          .where(and(
            eq(notifications.userId, user.id),
            inArray(notifications.id, mine),
            isNull(notifications.readAt),
          ));
      }
      return { ok: true, marked: inserted.length };
    });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
